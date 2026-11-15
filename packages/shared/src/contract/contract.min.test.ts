import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import { FactCallSchema, DIAGNOSTIC_CODES } from "./engine-api.js";
import { KnowledgeEntrySchema } from "./visibility.js";
import { TaskNodeSchema } from "./task-dag.js";
import { LlmBudgetSchema } from "./llm-invocation.js";
import { LlmTraceSchema } from "./trace.js";
import { ContentBlockSchema } from "./content-layer.js";
import { AssetDescriptorSchema } from "./asset-manifest.js";
import { RulesTemplateSchema } from "./rules.js";
import { ViewModelSchema } from "./view-model.js";

/** 9 个契约：各 1 个合法样例 parse 成功 + 1 个「多一个未知键必失败」反例。 */
const cases: Array<{ name: string; schema: ZodTypeAny; valid: unknown }> = [
  {
    name: "engine-api",
    schema: FactCallSchema,
    valid: { callId: "c1", tool: "fact.setKnowledge", args: {} },
  },
  {
    name: "visibility",
    schema: KnowledgeEntrySchema,
    valid: { factRef: "f1", level: "known", source: "witness", sinceTurn: 0 },
  },
  {
    name: "task-dag",
    schema: TaskNodeSchema,
    valid: {
      id: "t1",
      kind: "main",
      title: "任务",
      status: "draft",
      guards: [],
      completion: [],
      templateRefs: [],
      visibility: "public",
    },
  },
  {
    name: "llm-invocation",
    schema: LlmBudgetSchema,
    valid: {},
  },
  {
    name: "trace",
    schema: LlmTraceSchema,
    valid: {
      invocationId: "inv1",
      turnIndex: 0,
      worldTime: 0,
      reason: "test",
      contextHash: "h",
      toolProfile: "p",
      callsHash: "h",
      receipts: [],
      diagnostics: [],
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      outcome: "committed",
      templateRef: "tpl",
    },
  },
  {
    name: "content-layer",
    schema: ContentBlockSchema,
    valid: {
      blockId: "b1",
      kind: "narrative",
      text: "一段叙事",
      refs: [],
      visibility: "public",
      targetPerspective: { kind: "world" },
    },
  },
  {
    name: "asset-manifest",
    schema: AssetDescriptorSchema,
    valid: { assetId: "a1", path: "/a.png", kind: "portrait", tags: [], visibility: "public" },
  },
  {
    name: "rules",
    schema: RulesTemplateSchema,
    valid: {
      llmTriggers: [],
      toolProfiles: [],
      knowledgeGrants: [],
      inferenceRules: [],
      fallbackDag: { dagId: "d", version: 0, issuedBy: "template", nodes: [], edges: [] },
    },
  },
  {
    name: "view-model",
    schema: ViewModelSchema,
    valid: {
      player: { id: "p", name: "P" },
      npcs: [],
      slot: null,
      evaluation: { summary: "" },
      media: [],
      content: [],
    },
  },
];

describe("contract strict schemas (9)", () => {
  for (const c of cases) {
    it(`${c.name}: valid sample parses`, () => {
      expect(c.schema.safeParse(c.valid).success).toBe(true);
    });
    it(`${c.name}: unknown key rejected (strict)`, () => {
      expect(c.schema.safeParse({ ...(c.valid as object), __unknown: 1 }).success).toBe(false);
    });
  }
});

describe("DiagnosticCode closed set", () => {
  it("has exactly 13 unique members", () => {
    expect(DIAGNOSTIC_CODES.length).toBe(13);
    expect(new Set(DIAGNOSTIC_CODES).size).toBe(13);
  });
});
