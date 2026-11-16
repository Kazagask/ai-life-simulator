import { describe, expect, it } from "vitest";
import {
  LlmBudgetSchema,
  LlmInvocationSchema,
  type ApiCall,
  type DispatchContext,
  type EngineApiHandle,
  type LlmInvocation,
  type LlmTrace,
  type Perspective,
} from "@life-sim/shared";
import { createContentSink } from "@life-sim/game-core";
import { buildLlmContext } from "./context.js";
import { AgentGateway } from "./gateway.js";
import { BRANCH_PROMPT_LEAD, runAgentLoop } from "./loop.js";
import { MockAgentProvider } from "./providers/index.js";
import { buildToolDescriptors } from "./tool-registry.js";
import { StubEngine, loadDemoFixture } from "./testing/fixtures.js";
import { completion, ScriptedProvider } from "./testing/scripted.js";

/**
 * ADR-0038 纵切回归锁（5-8）。provider 层锁 1/2/3/4 在 `mock-branch.min.test.ts`。
 *
 * 这里锁的是**跨模块**的三件事：
 * - IO-15 / R9：`contextHints` 是自由文本标签，任何取值都不得产生行为差异（含 `asset:`）；
 * - D6′ / R6：`branchEventIds` 必须被 `LlmContext` 的**两个**构造点覆盖
 *   （`context.ts` 的重建 + `loop` 的透传），且差异对 `contextHash` 敏感；
 * - R8 / R10：白名单要进 prompt；content 拒绝不得复制正文。
 */

function invocationWith(
  fixture: ReturnType<typeof loadDemoFixture>,
  overrides: {
    invocationId: string;
    branchEventIds?: string[];
    contextHints?: string[];
    facts?: Array<{ factRef: string; value?: unknown; level?: string }>;
  },
): LlmInvocation {
  const base = fixture.engine.buildFacts("player");
  return LlmInvocationSchema.parse({
    invocationId: overrides.invocationId,
    reason: "chapter.advance",
    context: {
      stablePrefix: "",
      facts:
        overrides.facts === undefined
          ? base
          : { ...base, facts: [...base.facts, ...overrides.facts] },
      recentTurns: [],
      invocationReason: "chapter.advance",
      ...(overrides.contextHints !== undefined ? { contextHints: overrides.contextHints } : {}),
      ...(overrides.branchEventIds !== undefined
        ? { branchEventIds: overrides.branchEventIds }
        : {}),
    },
    tools: buildToolDescriptors(undefined, undefined),
    budget: LlmBudgetSchema.parse({}),
    replyTo: "dispatch",
    perspective: "player",
    targetPerspective: "player",
  });
}

/** 记录 dispatch 过的工具名（CallReceipt 不带 tool 字段，只能在这一层取证）。 */
function spyEngine(inner: ReturnType<typeof loadDemoFixture>["engine"]): {
  engine: EngineApiHandle;
  tools: string[];
} {
  const tools: string[] = [];
  const engine: EngineApiHandle = {
    dispatch: (calls, ctx) => {
      for (const call of calls) tools.push(call.tool);
      return inner.dispatch(calls, ctx);
    },
    snapshot: () => inner.snapshot(),
    buildFacts: (perspective) => inner.buildFacts(perspective),
  };
  return { engine, tools };
}

/** 跑一次 gateway，返回 trace 与状态快照。 */
async function runOnce(
  inv: LlmInvocation,
  engine: EngineApiHandle,
  fixtureState: unknown,
): Promise<{ trace: LlmTrace; stateJson: string; outcome: string }> {
  const traces: LlmTrace[] = [];
  const gateway = new AgentGateway({
    provider: new MockAgentProvider(),
    engineApi: engine,
    templateRef: "demo-agentic@1.0.0",
    toolProfile: "narrative",
    onTrace: (trace) => traces.push(trace),
  });
  const outcome = await gateway.invoke(inv);
  return {
    trace: traces[0]!,
    stateJson: JSON.stringify(fixtureState),
    outcome: outcome.outcome,
  };
}

describe("锁 5（IO-15 / R9）：contextHints 任意取值都不得产生行为差异", () => {
  const HINTS_VARIANTS: string[][] = [
    [],
    ["asset:whatever"],
    ["evt:trial"],
    ["branch:evt:trial"],
    ["hint:branch:evt:chance"],
    ["毫不相干", "also-unrelated"],
  ];

  it("receipts 序列 / blockId 序列 / state 全等，且从不发 referenceAsset", async () => {
    const baselineFixture = loadDemoFixture();
    const baselineSpy = spyEngine(baselineFixture.engine);
    const baseline = await runOnce(
      invocationWith(baselineFixture, { invocationId: "inv-io15" }),
      baselineSpy.engine,
      baselineFixture.state,
    );

    expect(baseline.outcome).toBe("committed");
    const baselineCodes = baseline.trace.receipts.map(
      (receipt) => `${receipt.outcome}:${receipt.code ?? "-"}`,
    );
    const baselineBlockIds = (baseline.trace.contentBlocks ?? []).map((block) => block.blockId);
    expect(new Set(baselineBlockIds).size).toBe(baselineBlockIds.length);

    for (const contextHints of HINTS_VARIANTS) {
      const fixture = loadDemoFixture();
      const spy = spyEngine(fixture.engine);
      const run = await runOnce(
        invocationWith(fixture, { invocationId: "inv-io15", contextHints }),
        spy.engine,
        fixture.state,
      );

      const label = `hints=${JSON.stringify(contextHints)}`;
      // ① receipts 的 (outcome, code) 序列逐项相同
      expect(
        run.trace.receipts.map((receipt) => `${receipt.outcome}:${receipt.code ?? "-"}`),
        label,
      ).toEqual(baselineCodes);
      // ② blockId 序列相同且无重复
      const blockIds = (run.trace.contentBlocks ?? []).map((block) => block.blockId);
      expect(blockIds, label).toEqual(baselineBlockIds);
      expect(new Set(blockIds).size, label).toBe(blockIds.length);
      // ③ state 逐字段相同（含 traceRef：同一 invocationId）
      expect(run.stateJson, label).toBe(baseline.stateJson);
      // ④ 「根本没发过」而不是「发了被拒」——不依赖 engine 的窗口判定
      expect(spy.tools.filter((tool) => tool === "content.referenceAsset"), label).toHaveLength(0);
    }
  });
});

describe("锁 6（D6′ / R6）：contextHash 覆盖 branchEventIds", () => {
  it("B1′：第二个构造点 context.ts 重建后仍带白名单", () => {
    const fixture = loadDemoFixture();
    const inv = invocationWith(fixture, {
      invocationId: "inv-hash-a",
      branchEventIds: ["evt:trial"],
    });
    const built = buildLlmContext(inv, { engineApi: fixture.engine });
    expect(built.context.branchEventIds).toEqual(["evt:trial"]);

    const without = invocationWith(fixture, { invocationId: "inv-hash-a" });
    const builtWithout = buildLlmContext(without, { engineApi: fixture.engine });
    expect(builtWithout.context.branchEventIds).toBeUndefined();
  });

  it("B2-a：仅 branchEventIds 不同 ⇒ context.ts 的 contextHash 不同（输入必须不同）", () => {
    const fixture = loadDemoFixture();
    const a = buildLlmContext(
      invocationWith(fixture, { invocationId: "inv-hash-a", branchEventIds: ["evt:trial"] }),
      { engineApi: fixture.engine },
    );
    const b = buildLlmContext(
      invocationWith(fixture, { invocationId: "inv-hash-a", branchEventIds: ["evt:chance"] }),
      { engineApi: fixture.engine },
    );
    expect(a.contextHash).not.toBe(b.contextHash);
  });

  it("B2-b：网关端到端 ⇒ 写进 trace 的 contextHash 随白名单变化", async () => {
    const fixture = loadDemoFixture();
    const traces: LlmTrace[] = [];
    const gateway = new AgentGateway({
      provider: new MockAgentProvider(),
      engineApi: new StubEngine(),
      onTrace: (trace) => traces.push(trace),
    });
    await gateway.invoke(
      invocationWith(fixture, { invocationId: "inv-hash-g1", branchEventIds: ["evt:trial"] }),
    );
    await gateway.invoke(
      invocationWith(fixture, { invocationId: "inv-hash-g2", branchEventIds: ["evt:chance"] }),
    );
    expect(traces).toHaveLength(2);
    expect(traces[0]!.contextHash).not.toBe(traces[1]!.contextHash);
  });
});

describe("锁 7（R8）：白名单必须进 prompt", () => {
  const engine = new StubEngine();

  it("声明了白名单 ⇒ user 消息含固定引导语与事件 id", async () => {
    const fixture = loadDemoFixture();
    const provider = new ScriptedProvider([completion([])]);
    await runAgentLoop(
      invocationWith(fixture, { invocationId: "inv-prompt-y", branchEventIds: ["evt:trial"] }),
      { provider, engineApi: engine },
    );
    const payload = JSON.stringify(provider.requests[0]!.messages);
    expect(payload).toContain(BRANCH_PROMPT_LEAD);
    expect(payload).toContain("evt:trial");
  });

  it("未声明白名单 ⇒ prompt 不含该引导语（但 facts 段的 evt: ref 不受影响）", async () => {
    const fixture = loadDemoFixture();
    const provider = new ScriptedProvider([completion([])]);
    await runAgentLoop(invocationWith(fixture, { invocationId: "inv-prompt-n" }), {
      provider,
      engineApi: engine,
    });
    const payload = JSON.stringify(provider.requests[0]!.messages);
    expect(payload).not.toContain(BRANCH_PROMPT_LEAD);
  });
});

/**
 * 锁 8（R10）原用例测的是「`content.referenceAsset` 被拒后不得复制正文」。
 * `referenceAsset` 已从函数层删除（AGENTIC-GM 重构：媒体挂载不是叙事），
 * 该场景不再存在，故整条下线。R10 的语义（拒绝后不得重复写同一 blockId）
 * 仍由 loop 的重试路径覆盖，见 T-04 分支①。
 */
