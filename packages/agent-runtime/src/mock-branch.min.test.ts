import { describe, expect, it } from "vitest";
import type { LlmInvocation, ToolDescriptor } from "@life-sim/shared";
import { createConditionRegistry, evaluateTriggers } from "@life-sim/game-core";
import { AgentGateway } from "./gateway.js";
import { MockAgentProvider } from "./providers/index.js";
import type { AgentMessage, ToolCallRequest } from "./tool-registry.js";
import { buildToolDescriptors } from "./tool-registry.js";
import { loadDemoFixture } from "./testing/fixtures.js";

/**
 * 分支轮验收（设计 §3.4 (b)）：mock 不只写散文 + 选项，还要**把 DAG 分支上的事件上桌**。
 *
 * 硬约束：
 * - eventId 只能取自调用上下文里已有的 `evt:xxx` 引用；取不到 ⇒ 整轮不 emit（负向用例）。
 * - `fact.advanceDag` 不 emit：`dagNodes` 只有 nodeId + status，补不出 kind / title / guards /
 *   templateRefs / visibility / edges，硬造一份会**整份覆盖** state.taskDag（毁掉模板分支）。
 */

interface ViewOverrides {
  invocationId?: string;
  reason?: string;
  contextHints?: string[];
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
    const completion = await provider.chat({ messages, tools: [...tools], timeoutMs: 1000 });
    rounds.push(completion.toolCalls);
    if (completion.toolCalls.length === 0) break;
    messages = [...messages, { role: "assistant", toolCalls: completion.toolCalls }];
  }
  return rounds;
}

const names = (calls: readonly ToolCallRequest[]): string[] => calls.map((call) => call.name);

describe("mock 分支轮：把 DAG 分支上的事件上桌", () => {
  const fixture = loadDemoFixture();
  const tools = buildToolDescriptors(fixture.rules, "narrative");

  it("上下文有 evt 引用 ⇒ 叙事之后、选项之前发出一次 fact.enqueueEvent", async () => {
    const rounds = await runRounds(makeView({ contextHints: ["chapter.tone", "evt:trial"] }), tools);

    // ① 叙事
    expect(names(rounds[0]!)).toEqual(["content.writeNarrative"]);
    // ② 分支轮：恰好一条，且 eventId 逐字取自 hint（不是编造的）
    expect(rounds[1]).toHaveLength(1);
    expect(rounds[1]![0]).toMatchObject({
      name: "fact.enqueueEvent",
      arguments: { eventId: "evt:trial" },
    });
    expect(rounds[1]![0]!.id).toBe("inv-branch:call:branch");
    // ③ 选项：分支轮之后仍有可点击动作
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

  it("facts[].factRef 里的 evt 引用同样是合法来源", async () => {
    const rounds = await runRounds(
      makeView({ facts: [{ factRef: "evt:chance", value: "偶遇", level: "known" }] }),
      tools,
    );
    expect(rounds[1]).toHaveLength(1);
    expect(rounds[1]![0]!.arguments.eventId).toBe("evt:chance");
  });

  it("确定性：同一 invocationId + 同一状态 ⇒ 逐字节相同（含分支轮）", async () => {
    const view = makeView({ contextHints: ["evt:trial"], dagNodes: [{ nodeId: "n2.trial", status: "ready" }] });
    const first = await runRounds(view, tools);
    const second = await runRounds(view, tools);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("负向：上下文没有任何 evt 引用 ⇒ 整轮不 emit（回到叙事 → 选项 → 提交）", async () => {
    const rounds = await runRounds(
      makeView({
        contextHints: ["chapter.tone", "facts"],
        facts: [{ factRef: "fact:gate-location", value: "北门", level: "known" }],
        dagNodes: [{ nodeId: "n2.trial", status: "ready" }],
      }),
      tools,
    );
    const all = rounds.flatMap((callList) => names(callList));
    expect(all).not.toContain("fact.enqueueEvent");
    expect(rounds[0]!.every((call) => call.name === "content.writeNarrative")).toBe(true);
    expect(rounds[1]!.every((call) => call.name === "content.writeOption")).toBe(true);
    expect(names(rounds[2]!)).toEqual(["content.submit"]);
  });

  it("负向：画像是旧的（没有 fact.enqueueEvent）⇒ 即便有 evt 引用也不 emit", async () => {
    const ohneBranch = tools.filter((tool) => tool.name !== "fact.enqueueEvent");
    const rounds = await runRounds(makeView({ contextHints: ["evt:trial"] }), ohneBranch);
    const all = rounds.flatMap((callList) => names(callList));
    expect(all).not.toContain("fact.enqueueEvent");
    expect(all).toContain("content.submit");
  });

  it("fact.advanceDag 不 emit：dagNodes 信息不足，硬造会整份覆盖模板 DAG", async () => {
    const rounds = await runRounds(
      makeView({
        contextHints: ["evt:trial"],
        dagNodes: [
          { nodeId: "n1.awaken", status: "completed" },
          { nodeId: "n2.trial", status: "ready" },
        ],
      }),
      tools,
    );
    const all = rounds.flatMap((callList) => names(callList));
    expect(all).not.toContain("fact.advanceDag");
  });
});

describe("零 key 端到端：真触发器 + 真引擎 + mock 分支轮", () => {
  it("nodeCompleted(n1.awaken) 命中 ⇒ evt:trial 真的进了 delayQueue 且 committed", async () => {
    const fixture = loadDemoFixture();
    // 把 n1.awaken 结掉，让 rules.yaml 的 nodeCompleted 触发器真的命中。
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
    const invocation: LlmInvocation | undefined = invocations.find(
      (inv) => inv.reason === "chapter.advance",
    );
    expect(invocation).toBeDefined();
    // 规则把「本轮可上桌的分支事件」写进 contextHints，mock 才取得到合法 eventId。
    expect(invocation!.context.contextHints).toContain("evt:trial");

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
    // 分支事件真的入队了（只入队、不占槽）：origin.kind === "effect"。
    const enqueued = fixture.state.delayQueue.filter((inst) => inst.definitionId === "evt:trial");
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.origin).toMatchObject({ kind: "effect", id: "evt:trial" });
    expect(fixture.state.delayQueue.length).toBe(queueBefore + 1);

    // 一次 invocation 内三件事都发生了：叙事 / 分支上桌 / 可点选项。
    const blocks = traces[0]?.contentBlocks ?? [];
    const kinds = blocks.map((block) => block.kind);
    expect(kinds).toContain("narrative");
    expect(kinds.filter((kind) => kind === "option").length).toBeGreaterThanOrEqual(2);
  });
});
