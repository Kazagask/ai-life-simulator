import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import { FactCallSchema, DIAGNOSTIC_CODES, DispatchContextSchema } from "./engine-api.js";
import type { EngineApiHandle } from "./engine-api.js";
import { KnowledgeEntrySchema } from "./perspective.js";
import { TaskNodeSchema } from "./task-dag.js";
import { LlmBudgetSchema, LlmOutcomeSchema } from "./llm-invocation.js";
import { LlmTraceSchema } from "./trace.js";
import { ContentBlockSchema } from "./content-ref.js";
import { AssetDescriptorSchema } from "./asset-manifest.js";
import { RulesSchema } from "./rules.js";
import { ViewModelSchema } from "./view-model.js";

/** 9 个契约：各 1 个合法样例 parse 成功 + 1 个「多一个未知键必失败」反例。 */
const cases: Array<{ name: string; schema: ZodTypeAny; valid: unknown }> = [
  {
    name: "engine-api",
    schema: FactCallSchema,
    valid: { callId: "c1", tool: "fact.setKnowledge", args: {} },
  },
  {
    name: "perspective",
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
    name: "content-ref",
    schema: ContentBlockSchema,
    valid: {
      blockId: "b1",
      kind: "narrative",
      text: "一段叙事",
      refs: [],
      visibility: "public",
      targetPerspective: "world",
      maskText: "某未公开的计划",
    },
  },
  {
    name: "asset-manifest",
    schema: AssetDescriptorSchema,
    valid: { assetId: "a1", path: "/a.png", kind: "portrait", tags: [], visibility: "public" },
  },
  {
    name: "rules",
    schema: RulesSchema,
    valid: {
      llmTriggers: [],
      toolProfile: {},
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

/** v2 §3.5 :260-310 片段（ criterion 6 回归断言）。 */
const V2_RULES_SNIPPET = {
  llmTriggers: [
    {
      when: [{ op: "nodeCompleted", args: { nodeId: "n1.awaken" } }],
      invoke: {
        reason: "chapter.advance",
        perspective: "world",
        targetPerspective: "player",
        contextHints: ["facts"],
        toolProfile: "narrative",
      },
    },
  ],
  toolProfile: { narrative: ["content.writeNarrative"] },
  knowledgeGrants: [
    {
      when: [{ op: "always", args: {} }],
      grant: {
        observers: ["player"],
        factRefs: ["fact:trial-result"],
        level: "known",
        source: "witness",
      },
    },
  ],
  inferenceRules: [],
  fallbackDag: {
    dagId: "demo-agentic.fallback.v1",
    version: 1,
    issuedBy: "template",
    nodes: [
      {
        id: "n1.awaken",
        kind: "opening",
        title: "苏醒",
        status: "ready",
        guards: [],
        completion: [{ op: "always", args: {} }],
        templateRefs: ["evt:awaken"],
        visibility: "public",
      },
    ],
    edges: [],
  },
};

describe("RulesSchema v2 §3.5 shape regression", () => {
  it("parses the v2 §3.5 snippet", () => {
    expect(RulesSchema.safeParse(V2_RULES_SNIPPET).success).toBe(true);
  });
  it("unknown top-level key rejected (strict)", () => {
    expect(RulesSchema.safeParse({ ...V2_RULES_SNIPPET, __unknown: 1 }).success).toBe(false);
  });
  it("rejects legacy toolProfiles / grant shape", () => {
    const legacyGrant = {
      subject: "player",
      refs: [] as string[],
      tier: "known",
    };
    expect(
      RulesSchema.safeParse({
        llmTriggers: [],
        toolProfiles: [],
        knowledgeGrants: [legacyGrant],
        inferenceRules: [],
        fallbackDag: { dagId: "d", version: 0, issuedBy: "template", nodes: [], edges: [] },
      }).success,
    ).toBe(false);
  });
});

// ---------- 阶段 A 追加门禁（F3 / F4 / 同步 dispatch）----------

describe("F3: LlmTrace.contentBlocks carries full narrative body", () => {
  it("parses a trace with contentBlocks[0].text (read-back source)", () => {
    const trace = {
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
      contentBlocks: [
        {
          blockId: "b1",
          kind: "narrative",
          text: "刷新后仍可读回的叙事正文",
          refs: [],
          visibility: "public",
          targetPerspective: "player",
          maskText: "某未公开的计划",
        },
      ],
    };
    const parsed = LlmTraceSchema.safeParse(trace);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.contentBlocks?.[0].text).toBe("刷新后仍可读回的叙事正文");
      expect(parsed.data.contentBlocks?.[0].maskText).toBe("某未公开的计划");
    }
  });
});

describe("F3: LlmOutcome committed/fallback carry traceRef", () => {
  it("committed / fallback parse with traceRef; missing traceRef rejected", () => {
    expect(
      LlmOutcomeSchema.safeParse({
        outcome: "committed",
        invocationId: "i",
        receipts: [],
        traceRef: "trace:1",
      }).success,
    ).toBe(true);
    expect(
      LlmOutcomeSchema.safeParse({
        outcome: "fallback",
        invocationId: "i",
        traceRef: "trace:1",
      }).success,
    ).toBe(true);
    // 缺 traceRef ⇒ 存档拿不到引用 ⇒ 必失败
    expect(
      LlmOutcomeSchema.safeParse({ outcome: "committed", invocationId: "i", receipts: [] })
        .success,
    ).toBe(false);
  });
});

describe("F4: DispatchContext.targetPerspective is authoritative & required", () => {
  it("missing targetPerspective rejected; present parses", () => {
    expect(DispatchContextSchema.safeParse({ turnIndex: 0, worldTime: 0 }).success).toBe(false);
    expect(
      DispatchContextSchema.safeParse({
        turnIndex: 0,
        worldTime: 0,
        targetPerspective: "player",
      }).success,
    ).toBe(true);
  });
});

describe("v2 §2.3: EngineApiHandle.dispatch is synchronous (compile-time)", () => {
  it("dispatch return type contains no Promise member", () => {
    type DispatchReturn = ReturnType<EngineApiHandle["dispatch"]>;
    // 元组包裹避免分布式条件类型；Extract 出任何 Promise 成员都使 IsSync=false。
    type IsNever<T> = [T] extends [never] ? true : false;
    type IsSync = IsNever<Extract<DispatchReturn, Promise<unknown>>>;
    const _syncProof: IsSync = true; // 若 dispatch 返回 Promise 联合 ⇒ IsSync=false ⇒ 编译失败
    expect(_syncProof).toBe(true);
  });
});
