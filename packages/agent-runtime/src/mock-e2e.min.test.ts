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
    const narrative = (trace.contentBlocks ?? []).filter((block) => block.kind === "narrative");
    expect(narrative.length).toBeGreaterThan(0);
    const text = narrative[0]!.text ?? "";
    expect(text.length).toBeGreaterThan(10);
    expect(CJK.test(text)).toBe(true);
    expect(narrative[0]!.targetPerspective).toBe("player");

    // F3：正文唯一落点是 trace；存档只留 traceRef。
    expect(fixture.state.traceRef).toBe("trace:inv-mock-e2e");
    const keys = stateKeys(fixture.state);
    for (const forbidden of NARRATIVE_KEYS) expect(keys).not.toContain(forbidden);
    expect(JSON.stringify(fixture.state)).not.toContain(text);

    // content.* 不改事实：player 窗口条目数不变。
    expect(fixture.engine.buildFacts("player").facts.length).toBe(factsBefore);
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
