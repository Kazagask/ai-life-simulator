import { describe, expect, it } from "vitest";
import type { LlmTrace, WorldStateV2 } from "@life-sim/shared";
import { AgentGateway } from "./gateway.js";
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

    // 产品裁决「点击为主」：决策点必须给出 2-3 个可点击选项，且排在叙事之后。
    const kinds = blocks.map((block) => block.kind);
    expect(kinds[0]).toBe("narrative");
    const optionIndex = kinds.indexOf("option");
    expect(optionIndex).toBeGreaterThan(0);
    const options = blocks.filter((block) => block.kind === "option");
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options.length).toBeLessThanOrEqual(3);
    for (const option of options) {
      expect((option.text ?? "").length).toBeGreaterThan(3);
      expect(CJK.test(option.text ?? "")).toBe(true);
      // 第二人称、动词开头的动作短语，而不是「选项 A」这类描述。
      expect(option.text ?? "").toMatch(/^(向|按|先|径直|转身|走上前|走近|循着|放慢|继续)/);
      expect(option.refs.length).toBeGreaterThan(0);
    }

    // F3：正文唯一落点是 trace；存档只留 traceRef。
    expect(fixture.state.traceRef).toBe("trace:inv-mock-e2e");
    const keys = stateKeys(fixture.state);
    for (const forbidden of NARRATIVE_KEYS) expect(keys).not.toContain(forbidden);
    expect(JSON.stringify(fixture.state)).not.toContain(text);

    // content.* 不改事实：player 窗口条目数不变。
    expect(fixture.engine.buildFacts("player").facts.length).toBe(factsBefore);
  });

  it("每一回合都有点击面：叙事之后必有 ≥2 个可点选项（含 random.flavor）", async () => {
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

    const options = blocks.filter((block) => block.kind === "option");
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options.length).toBeLessThanOrEqual(3);
    // 每个选项都必须排在第一段叙事之后，且文案非空、可点击。
    const firstOptionIndex = blocks.findIndex((block) => block.kind === "option");
    expect(firstOptionIndex).toBeGreaterThan(narrativeIndex);
    for (const option of options) {
      expect((option.text ?? "").trim().length).toBeGreaterThan(3);
      expect(CJK.test(option.text ?? "")).toBe(true);
      expect(blocks.indexOf(option)).toBeGreaterThan(narrativeIndex);
    }

    // 正文仍只活在 trace：权威状态里没有任何叙事文本。
    const narrativeText = blocks[narrativeIndex]!.text ?? "";
    expect(narrativeText.length).toBeGreaterThan(0);
    expect(JSON.stringify(fixture.state)).not.toContain(narrativeText);
    for (const forbidden of NARRATIVE_KEYS) expect(stateKeys(fixture.state)).not.toContain(forbidden);
  });

  it("叙事与选项不泄漏机器 id / 哨兵值（unknown 旗标不进正文）", async () => {
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

  it("选项确定性：同一 invocationId 逐字复现，不同 invocationId 不逐字重复", async () => {
    const run = async (invocationId: string): Promise<string[]> => {
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
      const outcome = await gateway.invoke(makeInvocation(fixture, { invocationId }));
      expect(outcome.outcome).toBe("committed");
      return (traces[0]!.contentBlocks ?? [])
        .filter((block) => block.kind === "option")
        .map((block) => block.text ?? "");
    };

    const a1 = await run("inv-opt-same");
    const a2 = await run("inv-opt-same");
    expect(a1).toHaveLength(3);
    expect(a2).toEqual(a1);

    // 连续回合不应逐字重复：扫若干 id，至少出现两种不同的选项组合。
    const variants = new Set<string>();
    for (const id of ["inv-opt-a", "inv-opt-b", "inv-opt-c", "inv-opt-d", "inv-opt-e"]) {
      variants.add((await run(id)).join("|"));
    }
    expect(variants.size).toBeGreaterThan(1);
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
      return traces[0]!.contentBlocks?.[0]?.text ?? "";
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
