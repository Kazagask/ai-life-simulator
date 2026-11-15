import { describe, expect, it, vi } from "vitest";
import type { DispatchContext, LlmGateway, LlmInvocation, WorldStateV2 } from "@life-sim/shared";

import { createActiveWorldV2, makeTestTemplate } from "./v2/test-utils.js";
import { createLookup } from "./v2/lookup.js";
import { CROSS_TURN_CODE, RpgEngineAPI, isRetryable } from "./api/engine-api.js";

/**
 * ADR-0035 回归锁：**结构写入必须与创作轮同一事务**。
 *
 * 这里锁的是两件互不替代的事：
 * ① `deferInvocation` —— 结算 tail 不再 fire-and-forget，执行权交编排层；
 * ② IO-1（`crossTurnViolation`）—— 晚到的结构写入一律拒绝，不许落账。
 *
 * 主理人给出的两个反例之所以致命，是因为它们在**触发时刻的状态上完全一样**：
 *   A. 事件晚到 ⇒ 已死 npc 作为"活着"登场（诈尸）
 *   B. 加 missWhen ⇒ 本该在 A+1 发生的事件被判定成"过期"（静默的错误错过）
 * 任何基于触发时刻的判据都分不开二者，所以只能从事务边界下手。
 */

const TEMPLATE = makeTestTemplate();
const LOOKUP = createLookup(TEMPLATE);

function freshState(): WorldStateV2 {
  const state = createActiveWorldV2(
    { templateId: "test", playerName: "P", seed: 42 },
    TEMPLATE,
    "w-adr0035",
  );
  // 结算后必然是空槽，测试直接从这个前提出发。
  state.slot = null;
  return state;
}

function api(state: WorldStateV2): RpgEngineAPI {
  return new RpgEngineAPI({
    state,
    perspective: "world",
    targetPerspective: "player",
  });
}

/** 创作轮的上下文：turnIndex 固定，模拟 agent loop 起始处抓取的那一份。 */
function ctxAt(turnIndex: number, worldTime: number): DispatchContext {
  return {
    turnIndex,
    worldTime,
    perspective: "world",
    targetPerspective: "player",
    invocationId: `inv-${turnIndex}-0`,
  };
}

function enqueueCall(eventId: string) {
  return {
    callId: `c-${eventId}`,
    tool: "fact.enqueueEvent" as const,
    args: { eventId },
  };
}

describe("ADR-0035 IO-1：结构写入不得跨回合", () => {
  it("同轮 ⇒ fact.enqueueEvent 正常入队，且时间锚取 ctx.worldTime", () => {
    const state = freshState();
    state.turnIndex = 5;
    state.worldTime = 5000;
    const before = state.delayQueue.length;

    // 关键：state.worldTime 与 ctx.worldTime 故意设成不同值，
    // 断言锚点来自 ctx 而不是 state —— 两者相等时这条测试会假绿。
    const result = api(state).dispatch(
      [enqueueCall("evt:trial")],
      ctxAt(5, 777),
    );

    expect(result.receipts[0]?.outcome).toBe("accepted");
    expect(state.delayQueue.length).toBe(before + 1);
    expect(state.delayQueue[state.delayQueue.length - 1]?.window.start).toBe(777);
  });

  it("反例 A：世界已推进到下一轮 ⇒ 入队被拒，队列不变，且不可重试", () => {
    const state = freshState();
    state.turnIndex = 6; // 世界已经走到 A+1
    state.worldTime = 6000;
    const before = state.delayQueue.length;
    const beforeSeq = state.enqueueSeqCounter;

    const result = api(state).dispatch(
      [enqueueCall("evt:trial")],
      ctxAt(5, 5000), // 创作轮是 A
    );

    const receipt = result.receipts[0];
    expect(receipt?.outcome).toBe("rejected");
    // 必须是码表里本身不可重试的码：loop 读的是 isRetryable(receipt.code)，
    // 回执上没有 retryable 字段，覆盖它等于没写（见 engine-api.ts 的 CROSS_TURN_CODE 注释）。
    expect(receipt?.code).toBe(CROSS_TURN_CODE);
    expect(isRetryable(CROSS_TURN_CODE)).toBe(false);
    expect(state.delayQueue.length).toBe(before);
    expect(state.enqueueSeqCounter).toBe(beforeSeq);
  });

  it("advanceDag 跨回合同样被拒（整份覆盖写，破坏性比事件更大）", () => {
    const state = freshState();
    state.turnIndex = 9;
    const before = structuredClone(state.taskDag);

    const result = api(state).dispatch(
      [
        {
          callId: "c-dag",
          tool: "fact.advanceDag" as const,
          args: {
            dag: {
              dagId: "late.branch",
              version: 1,
              issuedBy: "llm",
              nodes: state.taskDag.nodes.map((n) => ({ ...n, status: "completed" as const })),
              edges: [],
            },
          },
        },
      ],
      ctxAt(8, 8000),
    );

    expect(result.receipts[0]?.outcome).toBe("rejected");
    expect(result.receipts[0]?.code).toBe(CROSS_TURN_CODE);
    expect(isRetryable(CROSS_TURN_CODE)).toBe(false);
    // DAG 逐字段不变（不是"看起来没变"，是全等比较）
    expect(state.taskDag).toEqual(before);
  });

  it("setKnowledge 跨回合同样被拒（观察者窗口不得与事实时间错位）", () => {
    const state = freshState();
    state.turnIndex = 4;
    const before = structuredClone(state.observationLedger);

    const result = api(state).dispatch(
      [
        {
          callId: "c-know",
          tool: "fact.setKnowledge" as const,
          args: {
            observer: "player",
            factRef: "fact:late",
            level: "known",
            source: "witness",
            sinceTurn: 3,
          },
        },
      ],
      ctxAt(3, 3000),
    );

    expect(result.receipts[0]?.outcome).toBe("rejected");
    expect(result.receipts[0]?.code).toBe(CROSS_TURN_CODE);
    expect(state.observationLedger).toEqual(before);
  });

  it("非结构写入（content.*）不受 IO-1 约束：正文晚到只是补上，不改世界", () => {
    const state = freshState();
    state.turnIndex = 12;

    const result = api(state).dispatch(
      [
        {
          callId: "c-prose",
          tool: "content.writeNarrative" as const,
          args: {
            blockId: "b-late",
            kind: "narrative",
            text: "这段正文晚到了，但它不改世界。",
            refs: [],
            visibility: "public",
            targetPerspective: "player",
          },
        },
      ],
      ctxAt(9, 9000),
    );

    // 正文进 sink 不进 state ⇒ 跨回合无害，正当放行。
    expect(result.receipts[0]?.outcome).toBe("accepted");
  });
});

describe("ADR-0035 D2：deferInvocation 只提案不执行", () => {
  const rules = {
    llmTriggers: [
      {
        when: [{ op: "always", args: {} }],
        invoke: {
          reason: "test.always",
          perspective: "player" as const,
          targetPerspective: "player" as const,
          contextHints: [],
          toolProfile: "narrative",
        },
      },
    ],
    toolProfile: { narrative: ["content.writeNarrative", "content.submit"] },
    knowledgeGrants: [],
    inferenceRules: [],
    fallbackDag: { dagId: "d", version: 1, issuedBy: "template" as const, nodes: [], edges: [] },
  };

  it("deferInvocation: true ⇒ gateway.invoke 一次都不被调用，但 pendingInvocation 已落账", async () => {
    const state = freshState();
    const invoke = vi.fn(async (_inv: LlmInvocation) => ({
      outcome: "committed" as const,
      invocationId: "x",
      traceRef: "trace:x",
    }));
    const gateway = { invoke } as unknown as LlmGateway;

    const { advanceTurnV2 } = await import("./v2/turn.js");
    advanceTurnV2(
      state,
      { action: { type: "act", description: "" } },
      TEMPLATE,
      LOOKUP,
      undefined,
      { gateway, rules, deferInvocation: true },
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(state.pendingInvocation).toBeDefined();
  });
});
