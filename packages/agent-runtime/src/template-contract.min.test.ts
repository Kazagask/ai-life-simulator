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

  it("画像收窄生效，但保留 submit / writeOption 常驻通道（模板漏列 writeOption）", () => {
    const descriptors = buildToolDescriptors(fixture.rules, "narrative");
    const names = descriptors.map((tool) => tool.name);
    expect(names).toContain("content.writeNarrative");
    expect(names).toContain("content.submit");
    // 产品裁决「点击为主」：模板画像没有 writeOption，本包按常驻工具补齐。
    expect(names).toContain("content.writeOption");
    expect(names).not.toContain("content.writeMemory");
  });

  it("writeOption 的工具描述显式要求 2-3 个可点击动作", () => {
    const descriptor = buildToolDescriptors(fixture.rules, "narrative").find(
      (tool) => tool.name === "content.writeOption",
    );
    const description = descriptor?.description ?? "";
    expect(description).toContain("点击");
    expect(description).toContain("2-3");
    expect(description).toContain("第二人称");
  });

  it("画像不得列出引擎未注册的工具（契约漂移不变量）", () => {
    // 2026-11-16 修：原稿画像列了 `fact.enqueueEvent`，而 game-core 的 defaultToolRegistry 没有
    // 该工具 ⇒ 模型一 emit 就吃 unknown_tool（FATAL，不消耗重试，且不产生任何回执给模型重生成）。
    // 该工具已从 rules.yaml 的 narrative 画像移除，本断言由「钉住缺陷」转为「不变量」：
    // 画像 ∩ 未注册工具 == ∅。再有人往画像里加不存在的工具，这里立刻红。
    expect(unknownProfileTools(fixture.rules, "narrative")).toEqual([]);
  });

  it("画像含 content.writeOption（点击为主的交互承载）", () => {
    // 用户裁决「点击为主 打字输入为辅」：整轮只有散文没有任何可点动作 = 坏回合。
    const descriptors = buildToolDescriptors(fixture.rules, "narrative");
    expect(descriptors.map((tool) => tool.name)).toContain("content.writeOption");
  });
});
