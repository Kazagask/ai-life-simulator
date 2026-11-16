import { describe, expect, it } from "vitest";
import {
  ALL_TOOL_NAMES,
  FACT_TOOL_NAMES,
  buildToolDescriptors,
  resolveToolNames,
  validateToolCall,
} from "./tool-registry.js";

/**
 * 工具面完整性：**引擎注册了什么，runtime 就必须能把它送到模型手里**。
 *
 * 回归背景（ADR-0037 D4）：`fact.upsertDagBranch` 先在 game-core 的
 * `defaultToolRegistry()` 注册，而本包的 `FACT_TOOL_NAMES` / `FACT_DESCRIPTORS` /
 * `validateToolCall` 三处都漏了它。后果是**静默**的：
 * `resolveToolNames` 用 `ALL_TOOL_NAMES` 过滤画像，漏列 = 画像里写了也被丢弃，
 * `buildToolDescriptors` 直接跳过 ⇒ 模型既看不到描述符、调用也会被判 `unknown_tool`。
 * 模板一旦把 `advanceDag` 换成它，画像里就一个 DAG 写工具都不剩（只剩散文）。
 */

const VALID_NODE = {
  id: "n9.rumor",
  kind: "branch",
  title: "巷口的传闻",
  status: "ready",
  guards: [],
  completion: [],
  templateRefs: ["evt:rumor"],
  visibility: "public",
};

const VALID_EDGE = { from: "n1.awaken", to: "n9.rumor", kind: "unlocks" };

describe("工具面：fact.upsertDagBranch 必须在 runtime 侧可见", () => {
  it("出现在 ALL_TOOL_NAMES / FACT_TOOL_NAMES", () => {
    expect(FACT_TOOL_NAMES).toContain("fact.upsertDagBranch");
    expect(ALL_TOOL_NAMES).toContain("fact.upsertDagBranch");
  });

  it("画像列了它 ⇒ resolveToolNames 不会静默过滤，描述符能生成", () => {
    const rules = {
      llmTriggers: [],
      toolProfile: { narrative: ["narrative.write", "fact.upsertDagBranch"] },
      knowledgeGrants: [],
      inferenceRules: [],
      fallbackDag: { dagId: "d", version: 1, issuedBy: "t", nodes: [], edges: [] },
    } as never;

    expect(resolveToolNames(rules, "narrative")).toContain("fact.upsertDagBranch");
    const descriptors = buildToolDescriptors(rules, "narrative");
    const descriptor = descriptors.find((tool) => tool.name === "fact.upsertDagBranch");
    expect(descriptor).toBeDefined();
    // 描述语必须讲清「增量」而不是「整份覆盖」——否则模型会按 advanceDag 的语义调用
    expect(descriptor!.description).toContain("增量");
    expect(descriptor!.parameters).toMatchObject({ type: "object" });
  });

  it("合法增量入参通过第 1 层校验（nodes / edges / version 都可省）", () => {
    const allowed = new Set<string>(["fact.upsertDagBranch"]);
    const cases = [
      {},
      { nodes: [VALID_NODE] },
      { edges: [VALID_EDGE] },
      { nodes: [VALID_NODE], edges: [VALID_EDGE], version: 2 },
    ];
    for (const args of cases) {
      const verdict = validateToolCall({ id: "c", name: "fact.upsertDagBranch", arguments: args }, allowed);
      expect(verdict.ok, JSON.stringify(args)).toBe(true);
    }
  });

  it("非法形状在进入 dispatch 之前就被拒（不消耗引擎那一趟）", () => {
    const allowed = new Set<string>(["fact.upsertDagBranch"]);
    const bad = [
      { nodes: "not-an-array" },
      { edges: {} },
      { nodes: [{ id: "x" }] }, // 缺必填字段 ⇒ TaskNodeSchema 不过
      { edges: [{ from: "a" }] },
      { version: -1 },
      { version: 1.5 },
    ];
    for (const args of bad) {
      const verdict = validateToolCall({ id: "c", name: "fact.upsertDagBranch", arguments: args }, allowed);
      expect(verdict, JSON.stringify(args)).toMatchObject({ ok: false, code: "invalid_arguments" });
    }
  });
});
