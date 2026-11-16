import { describe, expect, it } from "vitest";
import type { LlmInvocation, LlmTrace, WorldStateV2 } from "@life-sim/shared";
import { createConditionRegistry, evaluateTriggers } from "@life-sim/game-core";
import { AgentGateway } from "./gateway.js";
import type { AgentMessage } from "./tool-registry.js";
import { buildToolDescriptors } from "./tool-registry.js";
import { createAgentProvider, MockAgentProvider } from "./providers/index.js";
import { loadDemoFixture, makeInvocation } from "./testing/fixtures.js";

const CJK = /[\u4e00-\u9fff]/;

const NARRATIVE_KEYS = ["narrative", "contentBlocks", "contentLayer", "narrativeText"];

function stateKeys(state: WorldStateV2): string[] {
  return Object.keys(state as unknown as Record<string, unknown>);
}

describe("零 key 端到端：真引擎 + mock provider", () => {
  it("跑通 committed，叙事只进 trace.contentBlocks，权威状态不长叙事字段", async () => {
    const fixture = loadDemoFixture();
    const factsBefore = fixture.engine.buildFacts("player").facts.length;
    const traces: LlmTrace[] = [];
    const gateway = new AgentGateway({
      provider: createAgentProvider(),
      engineApi: fixture.engine,
      templateRef: "demo-agentic@1.0.0",
      rules: fixture.rules,
      toolProfile: "narrative",
      history: [{ title: "苏醒" }],
      onTrace: (trace) => traces.push(trace),
    });

    const outcome = await gateway.invoke(makeInvocation(fixture, { invocationId: "inv-mock-e2e" }));

    expect(outcome.outcome).toBe("committed");
    expect(traces).toHaveLength(1);
    const trace = traces[0]!;
    const blocks = trace.contentBlocks ?? [];
    const narrative = blocks.filter((block) => block.kind === "narrative");
    expect(narrative.length).toBeGreaterThan(0);
    const text = narrative[0]!.text ?? "";
    expect(text.length).toBeGreaterThan(10);
    expect(CJK.test(text)).toBe(true);
    expect(narrative[0]!.targetPerspective).toBe("player");

    // 重设计（2026-11-16）：选项不再由 LLM 写（`content.writeOption` 已从函数层删除）。
    // 想给玩家选择，必须 `story.submitBranch` 提交带 options 的事件块，由引擎呈现。
    const kinds = blocks.map((block) => block.kind);
    expect(kinds[0]).toBe("narrative");
    expect(kinds).not.toContain("option");

    // F3：正文唯一落点是 trace；存档只留 traceRef。
    expect(fixture.state.traceRef).toBe("trace:inv-mock-e2e");
    const keys = stateKeys(fixture.state);
    for (const forbidden of NARRATIVE_KEYS) expect(keys).not.toContain(forbidden);
    expect(JSON.stringify(fixture.state)).not.toContain(text);

    // content.* 不改事实：player 窗口条目数不变。
    expect(fixture.engine.buildFacts("player").facts.length).toBe(factsBefore);
  });

  it("每一回合都有正文：叙事在场且不再由 LLM 产出选项（含 random.flavor）", async () => {
    const fixture = loadDemoFixture();
    const traces: LlmTrace[] = [];
    const gateway = new AgentGateway({
      provider: new MockAgentProvider(),
      engineApi: fixture.engine,
      templateRef: "demo-agentic@1.0.0",
      rules: fixture.rules,
      toolProfile: "narrative",
      onTrace: (trace) => traces.push(trace),
    });

    const outcome = await gateway.invoke(
      makeInvocation(fixture, { invocationId: "inv-flavor", reason: "random.flavor" }),
    );
    expect(outcome.outcome).toBe("committed");

    const blocks = traces[0]!.contentBlocks ?? [];
    const narrativeIndex = blocks.findIndex((block) => block.kind === "narrative");
    expect(narrativeIndex).toBe(0);

    // 重设计：LLM 不再产选项块（选项属于事件块）。这一轮只应有叙事（+ 可选旁注）。
    expect(blocks.filter((block) => block.kind === "option")).toEqual([]);

    // 正文仍只活在 trace：权威状态里没有任何叙事文本。
    const narrativeText = blocks[narrativeIndex]!.text ?? "";
    expect(narrativeText.length).toBeGreaterThan(0);
    expect(JSON.stringify(fixture.state)).not.toContain(narrativeText);
    for (const forbidden of NARRATIVE_KEYS) expect(stateKeys(fixture.state)).not.toContain(forbidden);
  });

  /**
   * 直接喂 mock 一份 facts 视图（绕过引擎窗口），精确控制「脏数据」的形状：
   * 第一轮取叙事，第二轮取选项，返回全部玩家可见文本。
   */
  async function mockTextsFromFacts(
    facts: Array<{ factRef: string; value?: unknown; level?: string }>,
  ): Promise<string[]> {
    const provider = new MockAgentProvider();
    const tools = buildToolDescriptors(loadDemoFixture().rules, "narrative");
    const view = {
      invocationId: "inv-direct",
      reason: "chapter.advance",
      perspective: "player",
      targetPerspective: "player",
      facts: { perspective: "player", facts, dagNodes: [] },
      recentTurns: [],
    };
    const messages: AgentMessage[] = [{ role: "user", content: JSON.stringify(view) }];
    const first = await provider.chat({ messages, tools, timeoutMs: 1000 });
    const withRound: AgentMessage[] = [
      ...messages,
      { role: "assistant", toolCalls: first.toolCalls },
    ];
    const second = await provider.chat({ messages: withRound, tools, timeoutMs: 1000 });
    const texts: string[] = [];
    for (const call of [...first.toolCalls, ...second.toolCalls]) {
      const text = call.arguments.text;
      if (typeof text === "string") texts.push(text);
    }
    return texts;
  }

  it("事实值为 unknown 哨兵时，任何输出字符串都不含 unknown", async () => {
    const texts = await mockTextsFromFacts([
      { factRef: "fact:gate-location", value: "unknown", level: "known" },
      { factRef: "flag:took-right", value: true, level: "known" },
    ]);
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text.toLowerCase()).not.toContain("unknown");
      expect(CJK.test(text)).toBe(true);
    }
  });

  it("factRef / value 是机器 id 时，正文不含机器 id 前缀", async () => {
    const texts = await mockTextsFromFacts([
      { factRef: "infoVisibility:npc-mentor", value: "infoVisibility:npc-mentor", level: "known" },
      { factRef: "flag:took-right", value: true, level: "known" },
      { factRef: "dag:n1.awaken", value: "n1.awaken", level: "known" },
    ]);
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text).not.toContain("infoVisibility");
      expect(text).not.toContain("npc-");
      expect(text).not.toMatch(/(fact|dag|secret|flag|asset|inv|node):/);
      expect(text).not.toContain("unknown");
      expect(CJK.test(text)).toBe(true);
    }
  });

  it("有真实可读值时优先使用它（不退回 reason 兜底句）", async () => {
    const texts = await mockTextsFromFacts([
      { factRef: "fact:mentor-name", value: "引路人", level: "known" },
    ]);
    expect(texts.some((text) => text.includes("引路人"))).toBe(true);
  });

  it("叙事不泄漏机器 id / 哨兵值（unknown 旗标不进正文）", async () => {
    const fixture = loadDemoFixture();
    // 复刻真实存档里的噪声：world.yaml 把初始旗标写成字符串 "unknown"，键是机器 id。
    fixture.state.flags["infoVisibility:npc-mentor"] = "unknown";
    fixture.state.flags["took-right"] = true;
    const ledger = fixture.state.observationLedger.player ?? [];
    ledger.push({
      factRef: "flag:infoVisibility:npc-mentor",
      level: "known",
      source: "rule",
      sinceTurn: 0,
    });
    ledger.push({ factRef: "flag:took-right", level: "known", source: "rule", sinceTurn: 0 });
    fixture.state.observationLedger.player = ledger;

    const traces: LlmTrace[] = [];
    const gateway = new AgentGateway({
      provider: new MockAgentProvider(),
      engineApi: fixture.engine,
      templateRef: "demo-agentic@1.0.0",
      rules: fixture.rules,
      toolProfile: "narrative",
      onTrace: (trace) => traces.push(trace),
    });

    const outcome = await gateway.invoke(
      makeInvocation(fixture, { invocationId: "inv-no-leak", reason: "task.completed" }),
    );
    expect(outcome.outcome).toBe("committed");

    const texts = (traces[0]!.contentBlocks ?? []).map((block) => block.text ?? "");
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text.toLowerCase()).not.toContain("unknown");
      expect(text).not.toContain("infoVisibility");
      expect(text).not.toContain("took-right");
      // 任何 `fact:` / `flag:` / `dag:` / `secret:` / `asset:` 前缀都不该出现在玩家文本里。
      expect(text).not.toMatch(/(fact|flag|dag|secret|asset):/);
      expect(CJK.test(text)).toBe(true);
    }
    // 引用 id 仍然完整保留在 refs[] 里，只是不进正文。
    const refs = (traces[0]!.contentBlocks ?? []).flatMap((block) => block.refs);
    expect(refs).toContain("flag:infoVisibility:npc-mentor");
  });

  it("叙事确定性：同一 invocationId 逐字复现，不同上下文不逐字重复", async () => {
    // 原用例验的是"选项组合"的确定性；选项已不再由 LLM 产生，改为验正文。
    const run = async (invocationId: string, history: Array<{ title: string }>): Promise<string[]> => {
      const fixture = loadDemoFixture();
      const traces: LlmTrace[] = [];
      const gateway = new AgentGateway({
        provider: new MockAgentProvider(),
        engineApi: fixture.engine,
        templateRef: "demo-agentic@1.0.0",
        rules: fixture.rules,
        toolProfile: "narrative",
        history,
        onTrace: (trace) => traces.push(trace),
      });
      const outcome = await gateway.invoke(makeInvocation(fixture, { invocationId }));
      expect(outcome.outcome).toBe("committed");
      return (traces[0]!.contentBlocks ?? [])
        .filter((block) => block.kind === "narrative")
        .map((block) => block.text ?? "");
    };

    const a1 = await run("inv-narr-same", [{ title: "苏醒" }]);
    const a2 = await run("inv-narr-same", [{ title: "苏醒" }]);
    expect(a1.length).toBeGreaterThan(0);
    expect(a2).toEqual(a1);

    // 上下文不同 ⇒ 正文不应逐字重复。
    expect(await run("inv-narr-a", [{ title: "初次试炼" }])).not.toEqual(a1);
  });

  it("同一 seed / 同一上下文 ⇒ 同一段叙事（确定性）", async () => {
    const run = async (): Promise<string> => {
      const fixture = loadDemoFixture();
      const traces: LlmTrace[] = [];
      const gateway = new AgentGateway({
        provider: new MockAgentProvider(),
        engineApi: fixture.engine,
        templateRef: "demo-agentic@1.0.0",
        rules: fixture.rules,
        toolProfile: "narrative",
        history: [{ title: "苏醒" }],
        onTrace: (trace) => traces.push(trace),
      });
      const outcome = await gateway.invoke(makeInvocation(fixture, { invocationId: "inv-determinism" }));
      expect(outcome.outcome).toBe("committed");
      return (traces[0]!.contentBlocks ?? []).map((block) => `${block.kind}:${block.text ?? ""}`).join("|");
    };

    const first = await run();
    const second = await run();
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  it("没有 provider 配置时 createAgentProvider 回落到 mock", () => {
    expect(createAgentProvider().id).toBe("mock");
    expect(createAgentProvider({ apiKey: "sk-secret" }).id).toBe("mock");
  });
});

/**
 * 分支轮的**真引擎**端到端：证明 `fact.enqueueEvent` 经 dispatch 真的落到 delayQueue。
 * 放在本文件（模板耦合的 e2e）而不是 mock-branch：mock-branch 只验 provider ↔ loop 契约，
 * 模板在并行改动期间不该把它拖红。
 */
describe("分支轮 × 真引擎：分支事件真的上桌", () => {
  it("显式白名单 ⇒ evt:rumor 进 delayQueue（origin.kind=effect）且 committed", async () => {
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
    // ADR-0038：上桌能力由结构化白名单声明（`branchEventIds`），且提示通道里不得再出现事件 id。
    // ADR-0037 §13 D16：白名单必须指向**链边绝不会放置**的事件 —— rumor 无 pool、无
    // nextEventId、无 missWhen，所以「它入队」本身就是分支轮生效的证据（trial 满足不了这点）。
    expect(invocation!.context.branchEventIds).toEqual(["evt:rumor"]);
    expect(invocation!.context.contextHints ?? []).not.toContainEqual(
      expect.stringMatching(/^evt:/),
    );

    const queueBefore = fixture.state.delayQueue.length;
    const traces: LlmTrace[] = [];
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
    // rumor 没有任何其它上桌路径 ⇒ 这条断言同时锁住 D16（观察点不与因果源重合）。
    const enqueued = fixture.state.delayQueue.filter((inst) => inst.definitionId === "evt:rumor");
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.origin).toMatchObject({ kind: "effect", id: "evt:rumor" });
    expect(fixture.state.delayQueue.length).toBe(queueBefore + 1);

    // 一次 invocation 内两件事：叙事 + 分支上桌。选项来自事件块，不再由 LLM 写。
    const blocks = traces[0]?.contentBlocks ?? [];
    const kinds = blocks.map((block) => block.kind);
    expect(kinds).toContain("narrative");
    expect(kinds).not.toContain("option");
  });
});
