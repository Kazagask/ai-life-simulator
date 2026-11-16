import { describe, expect, it } from "vitest";
import {
  LlmBudgetSchema,
  LlmInvocationSchema,
  type LlmInvocation,
  type ToolDescriptor,
} from "@life-sim/shared";
import { createConditionRegistry, evaluateTriggers } from "@life-sim/game-core";
import { AgentGateway } from "./gateway.js";
import { runAgentLoop } from "./loop.js";
import { MockAgentProvider } from "./providers/index.js";
import type { AgentMessage, ToolCallRequest } from "./tool-registry.js";
import { buildToolDescriptors } from "./tool-registry.js";
import { StubEngine, loadDemoFixture } from "./testing/fixtures.js";
import { completion, ScriptedProvider, toolCall } from "./testing/scripted.js";

/**
 * 分支轮验收（ADR-0038）：**只有结构化白名单才把事件上桌**。
 *
 * 契约：
 * - `inv.context.branchEventIds` 是唯一来源，取 `[0]`，一次 invocation 最多摆一个；
 * - 未声明 / 显式空数组 ⇒ 整轮不摆（「沉默 = 没有分支能力」，空 ≠ 不限制）；
 * - `contextHints` 是自由文本标签通道，**零解释**：裸 `evt:`、`branch:evt:`、
 *   `hint:branch:evt:`、结构化 JSON、`facts[].factRef` 的 `evt:` 引用 —— 全部 0 次。
 *   （旧写法曾把标签当指令：`task.completed` 每轮重新入队 `evt:chance`，
 *   chance → closing → chance 无限交替 ⇒ 409。）
 * - `fact.advanceDag` 永不 emit：`dagNodes` 只有 nodeId + status，补不出 kind / title /
 *   guards / templateRefs / visibility / edges，硬造一份会整份覆盖 state.taskDag。
 *
 * 去重责任边界：mock 无状态（同 invocationId + 同状态 ⇒ 逐字节相同），跨回合不重复入队
 * 靠 core 的 `enqueueEvent` waiting 幂等，内容层靠模板 `missWhen`。
 */

interface ViewOverrides {
  invocationId?: string;
  reason?: string;
  contextHints?: string[];
  branchEventIds?: string[];
  facts?: Array<{ factRef: string; value?: unknown; level?: string }>;
  dagNodes?: Array<{ nodeId: string; status: string }>;
  recentTurns?: unknown[];
}

function makeView(overrides: ViewOverrides = {}): Record<string, unknown> {
  return {
    invocationId: overrides.invocationId ?? "inv-branch",
    reason: overrides.reason ?? "chapter.advance",
    perspective: "player",
    targetPerspective: "player",
    facts: {
      perspective: "player",
      facts: overrides.facts ?? [],
      dagNodes: overrides.dagNodes ?? [],
    },
    recentTurns: overrides.recentTurns ?? [],
    ...(overrides.contextHints !== undefined ? { contextHints: overrides.contextHints } : {}),
    ...(overrides.branchEventIds !== undefined ? { branchEventIds: overrides.branchEventIds } : {}),
  };
}

/** 逐轮驱动 mock（与 loop 的消息回灌形状一致：assistant.toolCalls 追加、无 tool 回执）。 */
async function runRounds(
  view: Record<string, unknown>,
  tools: readonly ToolDescriptor[],
  maxRounds = 5,
): Promise<ToolCallRequest[][]> {
  const provider = new MockAgentProvider();
  let messages: AgentMessage[] = [{ role: "user", content: JSON.stringify(view) }];
  const rounds: ToolCallRequest[][] = [];
  for (let i = 0; i < maxRounds; i += 1) {
    const chat = await provider.chat({ messages, tools: [...tools], timeoutMs: 1000 });
    rounds.push(chat.toolCalls);
    if (chat.toolCalls.length === 0) break;
    messages = [...messages, { role: "assistant", toolCalls: chat.toolCalls }];
  }
  return rounds;
}

const names = (calls: readonly ToolCallRequest[]): string[] => calls.map((call) => call.name);

const branchCalls = (rounds: readonly ToolCallRequest[][]): ToolCallRequest[] =>
  rounds.flatMap((calls) => calls.filter((call) => call.name === "fact.enqueueEvent"));

describe("mock 分支轮：只认结构化白名单 branchEventIds", () => {
  const fixture = loadDemoFixture();
  const tools = buildToolDescriptors(fixture.rules, "narrative");

  it("锁 1：branchEventIds: [\"evt:trial\"] ⇒ 叙事之后、选项之前恰好一次 enqueue", async () => {
    const rounds = await runRounds(
      makeView({ contextHints: ["chapter.tone"], branchEventIds: ["evt:trial"] }),
      tools,
    );

    // ① 叙事
    expect(names(rounds[0]!)).toEqual(["content.writeNarrative"]);
    // ② 分支轮：恰好一条，eventId 逐字取自白名单
    expect(rounds[1]).toHaveLength(1);
    expect(rounds[1]![0]).toMatchObject({
      name: "fact.enqueueEvent",
      arguments: { eventId: "evt:trial" },
    });
    expect(rounds[1]![0]!.id).toBe("inv-branch:call:branch");
    // ③ 选项仍在分支之后
    const options = rounds[2]!;
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options.every((call) => call.name === "content.writeOption")).toBe(true);
    // ④ 提交：blockIds 只收 content 块，分支调用不占 blockId
    const submit = rounds[3]!;
    expect(names(submit)).toEqual(["content.submit"]);
    const blockIds = submit[0]!.arguments.blockIds as string[];
    expect(blockIds).toContain("inv-branch:narrative");
    expect(blockIds.some((id) => id.includes("opt"))).toBe(true);
    expect(blockIds).not.toContain("inv-branch:call:branch");
  });

  it("锁 2：未声明白名单 ⇒ 即使 contextHints 提到 evt:trial 也 0 次", async () => {
    const rounds = await runRounds(makeView({ contextHints: ["chapter.tone", "evt:trial"] }), tools);
    expect(branchCalls(rounds)).toHaveLength(0);
    expect(rounds.flatMap((calls) => names(calls))).toContain("content.submit");
  });

  it("锁 4a：显式空数组 ⇒ 0 次（空 ≠ 不限制）", async () => {
    const rounds = await runRounds(makeView({ branchEventIds: [] }), tools);
    expect(branchCalls(rounds)).toHaveLength(0);
  });

  it("锁 4b：legacy 形态（branch: / hint:branch: / JSON / 两条）一律 0 次", async () => {
    const legacyHintSets: string[][] = [
      ["branch:evt:trial"],
      ["hint:branch:evt:trial"],
      [JSON.stringify({ kind: "enqueueEvent", eventId: "evt:chance" })],
      ["branch:evt:trial", "branch:evt:ambush"],
    ];
    for (const contextHints of legacyHintSets) {
      const rounds = await runRounds(makeView({ contextHints }), tools);
      expect(branchCalls(rounds), `hints=${JSON.stringify(contextHints)}`).toHaveLength(0);
    }
  });

  it("负向：裸 evt: 提示与 facts[].factRef 的 evt 引用都不触发（409 回归锁）", async () => {
    const both = await runRounds(
      makeView({
        contextHints: ["facts", "secrets", "evt:chance"],
        facts: [{ factRef: "evt:trial", value: "初次试炼", level: "known" }],
      }),
      tools,
    );
    expect(branchCalls(both)).toHaveLength(0);

    const factsOnly = await runRounds(
      makeView({ facts: [{ factRef: "evt:chance", value: "偶遇", level: "known" }] }),
      tools,
    );
    expect(branchCalls(factsOnly)).toHaveLength(0);
  });

  it("D7：多条白名单只摆第一条（不按 invocationId 轮转）", async () => {
    const rounds = await runRounds(
      makeView({ branchEventIds: ["evt:trial", "evt:ambush"] }),
      tools,
    );
    const calls = branchCalls(rounds);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.arguments.eventId).toBe("evt:trial");

    // 换一个 invocationId 仍取第一条：确定性，不做内部状态机轮转。
    const other = await runRounds(
      makeView({ invocationId: "inv-other", branchEventIds: ["evt:trial", "evt:ambush"] }),
      tools,
    );
    expect(branchCalls(other)[0]!.arguments.eventId).toBe("evt:trial");
  });

  it("负向：画像是旧的（没有 fact.enqueueEvent）⇒ 即便有白名单也不 emit", async () => {
    const ohneBranch = tools.filter((tool) => tool.name !== "fact.enqueueEvent");
    const rounds = await runRounds(makeView({ branchEventIds: ["evt:trial"] }), ohneBranch);
    expect(branchCalls(rounds)).toHaveLength(0);
    expect(rounds.flatMap((calls) => names(calls))).toContain("content.submit");
  });

  it("单次性：一次 invocation 内恰好一次，且分支调用只带 eventId", async () => {
    const rounds = await runRounds(makeView({ branchEventIds: ["evt:trial"] }), tools);
    expect(branchCalls(rounds)).toHaveLength(1);
    expect(rounds[1]![0]!.arguments).toEqual({ eventId: "evt:trial" });
    const submit = rounds.at(-2)!;
    expect(submit[0]!.arguments.blockIds).not.toContain("inv-branch:call:branch");
  });

  it("确定性：同一 invocationId + 同一状态 ⇒ 逐字节相同", async () => {
    const view = makeView({
      branchEventIds: ["evt:trial"],
      dagNodes: [{ nodeId: "n2.trial", status: "ready" }],
    });
    const first = await runRounds(view, tools);
    const second = await runRounds(view, tools);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("fact.advanceDag 不 emit：dagNodes 信息不足，硬造会整份覆盖模板 DAG", async () => {
    const rounds = await runRounds(
      makeView({
        branchEventIds: ["evt:trial"],
        dagNodes: [
          { nodeId: "n1.awaken", status: "completed" },
          { nodeId: "n2.trial", status: "ready" },
        ],
      }),
      tools,
    );
    expect(rounds.flatMap((callList) => names(callList))).not.toContain("fact.advanceDag");
  });
});

describe("分支轮契约：mock ↔ loop ↔ 真引擎", () => {
  const tools = buildToolDescriptors(undefined, undefined);

  it("锁 3：ScriptedProvider 硬发白名单外 eventId ⇒ unknown_reference 且 queue 逐字段不变", async () => {
    const fixture = loadDemoFixture();
    const invocation: LlmInvocation = LlmInvocationSchema.parse({
      invocationId: "inv-gate-1",
      reason: "chapter.advance",
      context: {
        stablePrefix: "",
        facts: fixture.engine.buildFacts("player"),
        recentTurns: [],
        invocationReason: "chapter.advance",
        branchEventIds: ["evt:trial"],
      },
      tools,
      budget: LlmBudgetSchema.parse({}),
      replyTo: "dispatch",
      perspective: "player",
      targetPerspective: "player",
    });
    const before = JSON.stringify(fixture.state.delayQueue);
    // 只发一次越界调用，随后空回合收尾（`unknown_reference` 在码表里是 retryable，
    // 若让脚本无限重复会连撞 3 次重试额度，测到的就不是"这一次被拒"了）。
    const provider = new ScriptedProvider([
      completion([toolCall("fact.enqueueEvent", { eventId: "evt:chance" }, "c-outside")]),
      completion([]),
    ]);

    const { outcome, trace } = await runAgentLoop(invocation, {
      provider,
      engineApi: fixture.engine,
    });

    const rejected = trace.receipts.filter((receipt) => receipt.outcome === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ code: "unknown_reference", callId: "inv-gate-1:0:0" });
    expect(rejected[0]!.factsHint).toMatchObject({ allowedRefs: ["evt:trial"] });
    // 队列逐字段不变（不是"入队后清掉"）
    expect(JSON.stringify(fixture.state.delayQueue)).toBe(before);
    expect(["committed", "fallback"]).toContain(outcome.outcome);
  });

  it("经 runAgentLoop：白名单那条被 dispatch 且回执 accepted，顺序在叙事与选项之间", async () => {
    const dispatched: string[] = [];
    const engine = new StubEngine((calls) => {
      for (const call of calls) dispatched.push(call.tool);
      return calls.map((call) => ({ callId: call.callId, outcome: "accepted" as const }));
    });
    const invocation = LlmInvocationSchema.parse({
      invocationId: "inv-loop-branch",
      reason: "chapter.advance",
      context: {
        stablePrefix: "",
        facts: { perspective: "player", facts: [], dagNodes: [] },
        recentTurns: [],
        invocationReason: "chapter.advance",
        branchEventIds: ["evt:trial"],
      },
      tools,
      budget: LlmBudgetSchema.parse({}),
      replyTo: "dispatch",
      perspective: "player",
      targetPerspective: "player",
    });

    const { outcome, trace } = await runAgentLoop(invocation, {
      provider: new MockAgentProvider(),
      engineApi: engine,
    });

    expect(outcome.outcome).toBe("committed");
    expect(dispatched.filter((tool) => tool === "fact.enqueueEvent")).toHaveLength(1);
    expect(dispatched.indexOf("fact.enqueueEvent")).toBeGreaterThan(
      dispatched.indexOf("content.writeNarrative"),
    );
    expect(dispatched.indexOf("fact.enqueueEvent")).toBeLessThan(
      dispatched.indexOf("content.writeOption"),
    );
    // 回执按 callId 定位（CallReceipt 不带 tool 字段）
    const branchReceipt = trace.receipts.find(
      (receipt) => receipt.callId === "inv-loop-branch:1:0",
    );
    expect(branchReceipt).toMatchObject({ outcome: "accepted" });
  });

  it("零 key 真引擎：白名单声明 ⇒ evt:trial 真的进 delayQueue 且 committed", async () => {
    const fixture = loadDemoFixture();
    fixture.state.taskDag = {
      ...fixture.rules.fallbackDag,
      nodes: fixture.rules.fallbackDag.nodes.map((node) =>
        node.id === "n1.awaken" ? { ...node, status: "completed" as const } : node,
      ),
    };

    const invocations = evaluateTriggers(
      fixture.state,
      fixture.rules,
      createConditionRegistry(),
      { seed: fixture.state.seed, turnIndex: 1 },
    );
    const invocation = invocations.find((inv) => inv.reason === "chapter.advance");
    expect(invocation).toBeDefined();
    // 白名单来自模板 `invoke.branchEventIds`（core 求值拷贝），不是测试硬塞。
    expect(invocation!.context.branchEventIds).toEqual(["evt:trial"]);

    const queueBefore = fixture.state.delayQueue.length;
    const traces: Array<{ contentBlocks?: Array<{ kind: string }> }> = [];
    const gateway = new AgentGateway({
      provider: new MockAgentProvider(),
      engineApi: fixture.engine,
      templateRef: "demo-agentic@1.0.0",
      rules: fixture.rules,
      toolProfile: "narrative",
      onTrace: (trace) => traces.push(trace),
    });

    const outcome = await gateway.invoke(invocation!);

    expect(outcome.outcome).toBe("committed");
    const enqueued = fixture.state.delayQueue.filter((inst) => inst.definitionId === "evt:trial");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.origin).toMatchObject({ kind: "effect", id: "evt:trial" });
    expect(fixture.state.delayQueue.length).toBe(queueBefore + 1);

    const blocks = traces[0]?.contentBlocks ?? [];
    const kinds = blocks.map((block) => block.kind);
    expect(kinds).toContain("narrative");
    expect(kinds.filter((kind) => kind === "option").length).toBeGreaterThanOrEqual(2);
  });
});
