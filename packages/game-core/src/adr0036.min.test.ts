import { describe, expect, it, vi } from "vitest";
import type {
  CallLogEntry,
  LlmGateway,
  LlmInvocation,
  Rules,
  WorldStateV2,
  WorldTemplateV2,
} from "@life-sim/shared";
import { WorldStateV2Schema } from "@life-sim/shared";

import { createActiveWorldV2, makeTestTemplate } from "./v2/test-utils.js";
import { createLookup } from "./v2/lookup.js";
import { advanceTurnV2 } from "./v2/turn.js";

/**
 * ADR-0036 回归锁：触发器求值改为**边沿语义**。
 *
 * 被锁的四个不变量：
 * - IO-4：持久条件（`flagSet` 类）连续 N 轮只发 1 次 invocation；
 * - IO-5：条件真→假→真 ⇒ 再发一次（不是"一辈子一次"）；
 * - IO-6：同轮多条命中 ⇒ 只执行声明序第一条，其余 key 仍写 `hit: true`；
 * - IO-7：无 `triggerFireLedger` 的旧档首次求值 ⇒ 至多多发一次，不抛错、不抑制。
 *
 * 模板去掉 `events`：本套测试只关心触发器求值，不让事件呈现占槽干扰连续轮次。
 */

const TEMPLATE: WorldTemplateV2 = { ...makeTestTemplate(), events: [] };
const LOOKUP = createLookup(TEMPLATE);

const FLAG = "took-right";

function freshState(): WorldStateV2 {
  const state = createActiveWorldV2(
    { templateId: "test", playerName: "P", seed: 42 },
    TEMPLATE,
    "w-adr0036",
  );
  state.slot = null;
  return state;
}

function makeRules(triggers: Rules["llmTriggers"]): Rules {
  return {
    llmTriggers: triggers,
    toolProfile: { narrative: ["content.writeNarrative"] },
    knowledgeGrants: [],
    inferenceRules: [],
    fallbackDag: { dagId: "d", version: 1, issuedBy: "template", nodes: [], edges: [] },
  };
}

function trigger(
  reason: string,
  when: Rules["llmTriggers"][number]["when"],
  fireMode?: "edge" | "level",
): Rules["llmTriggers"][number] {
  return {
    ...(fireMode !== undefined ? { fireMode } : {}),
    when,
    invoke: {
      reason,
      perspective: "player",
      targetPerspective: "player",
      contextHints: [],
      toolProfile: "narrative",
    },
  };
}

function countingGateway() {
  const invoke = vi.fn(async (inv: LlmInvocation) => ({
    outcome: "committed" as const,
    invocationId: inv.invocationId,
    traceRef: `trace:${inv.invocationId}`,
  }));
  return { invoke, gateway: { invoke } as unknown as LlmGateway };
}

function runTurn(
  state: WorldStateV2,
  gateway: LlmGateway,
  rules: Rules,
  callLog?: CallLogEntry[],
): void {
  advanceTurnV2(
    state,
    { action: { type: "act", description: "" } },
    TEMPLATE,
    LOOKUP,
    undefined,
    { gateway, rules, ...(callLog !== undefined ? { callLog } : {}) },
  );
}

/** 取 ledger 的读口（函数调用避开 `delete` 之后的控制流收窄）。 */
const ledgerOf = (s: WorldStateV2): WorldStateV2["triggerFireLedger"] => s.triggerFireLedger;

describe("ADR-0036 IO-4：持久条件在 edge 下连续 N 轮只发 1 次", () => {
  it("(a) flag 置真后跑连续 5 轮结算 ⇒ 恰好 1 次网关调用", () => {
    const state = freshState();
    const { invoke, gateway } = countingGateway();
    const rules = makeRules([trigger("flag.fired", [{ flag: FLAG, eq: true }])]);

    // 先跑一轮「flag 为假」：落账 hit:false，作为边沿的起点。
    runTurn(state, gateway, rules);
    expect(invoke).toHaveBeenCalledTimes(0);

    state.flags[FLAG] = true;
    for (let i = 0; i < 5; i += 1) runTurn(state, gateway, rules);

    expect(invoke).toHaveBeenCalledTimes(1);
    // 历史确实落在 state 里（读档后判据可复现），不是内存态。
    expect(state.triggerFireLedger?.[`flag.fired#0`]?.hit).toBe(true);
  });
});

describe("ADR-0036 IO-5：真→假→真 ⇒ 再发一次", () => {
  it("(b) 条件由真转假再转真 ⇒ 第 2 次调用（不是一辈子一次）", () => {
    const state = freshState();
    const { invoke, gateway } = countingGateway();
    const rules = makeRules([trigger("flag.fired", [{ flag: FLAG, eq: true }])]);

    state.flags[FLAG] = true;
    runTurn(state, gateway, rules);
    expect(invoke).toHaveBeenCalledTimes(1);

    // 假值也必须落账，否则下一次真值会被误判成"仍在延续"。
    state.flags[FLAG] = false;
    runTurn(state, gateway, rules);
    expect(state.triggerFireLedger?.[`flag.fired#0`]?.hit).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);

    state.flags[FLAG] = true;
    runTurn(state, gateway, rules);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe("ADR-0036 IO-6：同轮多条命中只执行第一条", () => {
  it("(c) 三条触发器同轮命中 ⇒ 执行 1 条（声明序第一条）+ ledger 3 条 hit:true + callLog 2 条", () => {
    const state = freshState();
    const { invoke, gateway } = countingGateway();
    const callLog: CallLogEntry[] = [];
    const rules = makeRules([
      trigger("first", [{ op: "always", args: {} }]),
      trigger("second", [{ op: "always", args: {} }]),
      trigger("third", [{ op: "always", args: {} }]),
    ]);

    runTurn(state, gateway, rules, callLog);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]?.reason).toBe("first");

    // 所有求值为真的 key 都必须落账，否则下一轮会被当成"刚刚变真"而延迟触发。
    expect(ledgerOf(state)?.["first#0"]?.hit).toBe(true);
    expect(ledgerOf(state)?.["second#1"]?.hit).toBe(true);
    expect(ledgerOf(state)?.["third#2"]?.hit).toBe(true);

    // 被挤掉的两条不得静默：写 callLog（outcome=deferred / budget_exceeded）。
    expect(callLog).toHaveLength(2);
    for (const entry of callLog) {
      expect(entry.tool).toBe("llm.invoke");
      expect(entry.outcome).toBe("deferred");
      expect(entry.code).toBe("budget_exceeded");
    }
    // 记账的是后两条（声明序），不是第一条。
    expect(callLog.map((c) => c.callId)).toHaveLength(2);
    for (const entry of callLog) expect(entry.callId).toMatch(/^inv-\d+-(1|2)$/);
  });
});

describe("ADR-0036 IO-7：旧档无 triggerFireLedger", () => {
  it("(d) 旧档（无该字段）加载并结算 ⇒ 不抛错、至多多发一次，且 schema 仍通过", () => {
    const state = freshState();
    delete state.triggerFireLedger;
    expect(state.triggerFireLedger).toBeUndefined();
    // optional 且不升 schemaVersion：严格 schema 必须接受缺字段的旧档。
    expect(WorldStateV2Schema.safeParse(state).success).toBe(true);

    const { invoke, gateway } = countingGateway();
    const rules = makeRules([trigger("flag.fired", [{ flag: FLAG, eq: true }])]);
    state.flags[FLAG] = true;

    expect(() => runTurn(state, gateway, rules)).not.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(ledgerOf(state)?.[`flag.fired#0`]?.hit).toBe(true);
  });
});

describe("ADR-0036 D1：fireMode level 保持旧行为", () => {
  it("(e) fireMode: level ⇒ 每轮都触发", () => {
    const state = freshState();
    const { invoke, gateway } = countingGateway();
    const rules = makeRules([trigger("narrate.every-turn", [{ op: "always", args: {} }], "level")]);

    for (let i = 0; i < 3; i += 1) runTurn(state, gateway, rules);

    expect(invoke).toHaveBeenCalledTimes(3);
  });
});
