import { describe, expect, it } from "vitest";
import { RulesSchema } from "@life-sim/shared";
import { buildToolDescriptors, unknownProfileTools } from "./tool-registry.js";
import { loadDemoFixture } from "./testing/fixtures.js";

describe("demo-agentic 规则模板可用性（契约核对）", () => {
  const fixture = loadDemoFixture();

  it("rules.yaml 顶层恰为 5 个键，且触发 / 画像 / 授予 / 推断 / 兜底 DAG 齐备", () => {
    const raw = RulesSchema.parse(fixture.rules);
    expect(Object.keys(raw).sort()).toEqual([
      "fallbackDag",
      "inferenceRules",
      "knowledgeGrants",
      "llmTriggers",
      "toolProfile",
    ]);
    expect(raw.llmTriggers.length).toBeGreaterThan(0);
    expect(raw.fallbackDag.nodes.length).toBeGreaterThan(0);
  });

  it("三个触发器都给出可构造 invocation 的 reason / perspective / toolProfile", () => {
    for (const trigger of fixture.rules.llmTriggers) {
      expect(trigger.invoke.reason.length).toBeGreaterThan(0);
      expect(["world", "player"]).toContain(trigger.invoke.perspective);
      expect(trigger.invoke.toolProfile.length).toBeGreaterThan(0);
      expect(fixture.rules.toolProfile[trigger.invoke.toolProfile]).toBeDefined();
    }
  });

  it("画像收窄生效，但保留 content.submit 控制通道", () => {
    const descriptors = buildToolDescriptors(fixture.rules, "narrative");
    const names = descriptors.map((tool) => tool.name);
    expect(names).toContain("content.writeNarrative");
    expect(names).toContain("content.submit");
    expect(names).not.toContain("content.writeMemory");
  });

  it("画像里列了引擎未注册的工具（契约漂移点，需上游修模板）", () => {
    // REPORT：rules.yaml 的 narrative 画像列了 `fact.enqueueEvent`，game-core 注册表没有该工具。
    expect(unknownProfileTools(fixture.rules, "narrative")).toEqual(["fact.enqueueEvent"]);
  });
});
