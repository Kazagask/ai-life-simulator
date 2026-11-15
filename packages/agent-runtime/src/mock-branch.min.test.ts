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
 * 契约（R3 修订，起因见 server-impl-2 的 409 事故）：
 * - **只有显式指令**才触发 `fact.enqueueEvent`：
 *   ① `branch:evt:xxx`  ② `hint:branch:evt:xxx`  ③ `{"kind":"enqueueEvent","eventId":"evt:xxx"}`
 * - **裸 `evt:xxx` 提示不触发**。`contextHints` 的语义是「标签」，不是「本轮指令」；
 *   旧实现把标签当指令，`task.completed` 的 `evt:chance` 每轮重新入队，
 *   chance → closing → chance 无限交替，最终 409 `pending_event_required`。
 * - **`facts[].factRef` 里的 `evt:` 不触发**：那是「这条事实可见」，不是「把它做成事件」。
 * - `fact.advanceDag` 不 emit：`dagNodes` 只有 nodeId + status，补不出 kind / title / guards /
 *   templateRefs / visibility / edges，硬造一份会**整份覆盖** state.taskDag（毁掉模板分支）。
 * - 跨回合去重**不归 mock**：mock 无状态（同 invocationId + 同状态 ⇒ 逐字节相同），
 *   队列层的重复上桌由 core 的 `enqueueEvent` waiting 幂等兜底，内容层由模板 `missWhen` 兜底。
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

const branchCalls = (rounds: readonly ToolCallRequest[][]): ToolCallRequest[] =>
  rounds.flatMap((calls) => calls.filter((call) => call.name === "fact.enqueueEvent"));

describe("mock 分支轮：只有显式 `branch:` 指令才把事件上桌", () => {
  const fixture = loadDemoFixture();
  const tools = buildToolDescriptors(fixture.rules, "narrative");

  it("`branch:evt:trial` ⇒ 叙事之后、选项之前发出一次 fact.enqueueEvent", async () => {
    const rounds = await runRounds(makeView({ contextHints: ["chapter.tone", "branch:evt:trial"] }), tools);

    // ① 叙事
    expect(names(rounds[0]!)).toEqual(["content.writeNarrative"]);
    // ② 分支轮：恰好一条，且 eventId 逐字取自提示（不是编造的）
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

  it("`hint:branch:evt:trial` 与结构化 JSON 是等价显式形态", async () => {
    const prefixed = await runRounds(makeView({ contextHints: ["hint:branch:evt:trial"] }), tools);
    expect(branchCalls(prefixed).map((call) => call.arguments.eventId)).toEqual(["evt:trial"]);

    const structured = await runRounds(
      makeView({ contextHints: [JSON.stringify({ kind: "enqueueEvent", eventId: "evt:chance" })] }),
      tools,
    );
    expect(branchCalls(structured).map((call) => call.arguments.eventId)).toEqual(["evt:chance"]);
  });

  it("负向：裸 `evt:` 提示不触发（409 事故回归锁）", async () => {
    const rounds = await runRounds(makeView({ contextHints: ["facts", "secrets", "evt:chance"] }), tools);
    expect(branchCalls(rounds)).toHaveLength(0);
    expect(names(rounds[1]!)).toContain("content.writeOption");
    expect(names(rounds[2]!)).toEqual(["content.submit"]);
  });

  it("负向：facts[].factRef 里的 `evt:` 引用同样不是合法来源", async () => {
    const rounds = await runRounds(
      makeView({ facts: [{ factRef: "evt:chance", value: "偶遇", level: "known" }] }),
      tools,
    );
    expect(branchCalls(rounds)).toHaveLength(0);
    expect(names(rounds[0]!)).toEqual(["content.writeNarrative"]);
  });

  it("负向：裸 `evt:` 提示与 facts 里 `evt:` 引用同时存在，两路都不触发（双保险）", async () => {
    const rounds = await runRounds(
      makeView({
        contextHints: ["evt:trial"],
        facts: [
          { factRef: "evt:trial", value: "初次试炼", level: "known" },
          { factRef: "fact:gate-location", value: "北门", level: "known" },
        ],
        dagNodes: [{ nodeId: "n2.trial", status: "ready" }],
      }),
      tools,
    );
    expect(branchCalls(rounds)).toHaveLength(0);
    expect(names(rounds[2]!)).toEqual(["content.submit"]);
  });

  it("负向：`branch:` 但目标不带 `evt:` 前缀 ⇒ 不触发（防洗成任意字符串）", async () => {
    const rounds = await runRounds(makeView({ contextHints: ["branch:chance"] }), tools);
    expect(branchCalls(rounds)).toHaveLength(0);
  });

  it("负向：结构化 JSON 的 kind 不是 enqueueEvent ⇒ 不触发", async () => {
    const rounds = await runRounds(
      makeView({ contextHints: [JSON.stringify({ kind: "advanceDag", eventId: "evt:trial" })] }),
      tools,
    );
    expect(branchCalls(rounds)).toHaveLength(0);
  });

  it("负向：画像是旧的（没有 fact.enqueueEvent）⇒ 即便有显式指令也不 emit", async () => {
    const ohneBranch = tools.filter((tool) => tool.name !== "fact.enqueueEvent");
    const rounds = await runRounds(makeView({ contextHints: ["branch:evt:trial"] }), ohneBranch);
    expect(branchCalls(rounds)).toHaveLength(0);
    expect(rounds.flatMap((calls) => names(calls))).toContain("content.submit");
  });

  it("单次性：一次 invocation 内 fact.enqueueEvent 恰好出现一次，且不占 blockId", async () => {
    const rounds = await runRounds(makeView({ contextHints: ["branch:evt:trial"] }), tools);
    expect(branchCalls(rounds)).toHaveLength(1);
    const submit = rounds.at(-2)!;
    expect(names(submit)).toEqual(["content.submit"]);
    const blockIds = submit[0]!.arguments.blockIds as string[];
    expect(blockIds).not.toContain("inv-branch:call:branch");
    // 分支调用只带 eventId：没有 blockId 可被 submit 收走。
    expect(rounds[1]![0]!.arguments).toEqual({ eventId: "evt:trial" });
  });

  it("确定性：同一 invocationId + 同一状态 ⇒ 逐字节相同（含分支轮）", async () => {
    const view = makeView({
      contextHints: ["branch:evt:trial"],
      dagNodes: [{ nodeId: "n2.trial", status: "ready" }],
    });
    const first = await runRounds(view, tools);
    const second = await runRounds(view, tools);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("fact.advanceDag 不 emit：dagNodes 信息不足，硬造会整份覆盖模板 DAG", async () => {
    const rounds = await runRounds(
      makeView({
        contextHints: ["branch:evt:trial"],
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
  it("显式分支提示 ⇒ evt:trial 真的进了 delayQueue 且 committed", async () => {
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

    /**
     * 就地覆写 contextHints：rules.yaml 目前仍写裸 `evt:trial`（模板侧待改），
     * 而 mock 只认显式指令。测试不依赖模板拼写 —— 用例自己声明「本轮该上桌什么」，
     * 模板怎么改都不影响这条端到端。
     */
    invocation!.context.contextHints = ["chapter.tone", "branch:evt:trial"];

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
