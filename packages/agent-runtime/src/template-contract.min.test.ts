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

  it("画像收窄生效：叙事只剩 write / flavor，工具面里没有提交动词", () => {
    const descriptors = buildToolDescriptors(fixture.rules, "narrative");
    const names = descriptors.map((tool) => tool.name);
    expect(names).toContain("narrative.write");
    // 终止是运行时责任：模型工具面里**没有**提交动词。
    expect(names).not.toContain("agent.submit");
    // 2026-11-16 重设计：`content.writeOption` 从函数层删除（选项属于事件块的 options），
    // 不再作为常驻工具补进任何画像。
    expect(names).not.toContain("content.writeOption");
    expect(names).not.toContain("content.writeMemory");
    expect(names).not.toContain("content.referenceAsset");
  });

  it("已删除的写结构工具不再出现在工具面上", () => {
    // 这一条是"删除清单"的可执行形态：模型不该有任何"直接动引擎结构"的入口。
    const names = buildToolDescriptors(fixture.rules, "narrative").map((tool) => tool.name);
    for (const retired of [
      "content.writeOption",
      "content.writeMemory",
      "content.referenceAsset",
    ]) {
      expect(names).not.toContain(retired);
    }
  });

  it("画像不得列出引擎未注册的工具（契约漂移不变量）", () => {
    // 画像里出现未注册的工具 ⇒ 模型一 emit 就吃 unknown_tool（FATAL）。
    // 断言由「钉住缺陷」转为「不变量」：画像 ∩ 未注册工具 == ∅。
    expect(unknownProfileTools(fixture.rules, "narrative")).toEqual([]);
  });

  it("叙事工具名走 narrative 命名空间，不再是 content.*", () => {
    const names = buildToolDescriptors(fixture.rules, "narrative").map((tool) => tool.name);
    expect(names.filter((n) => n.startsWith("content."))).toEqual([]);
  });
});
