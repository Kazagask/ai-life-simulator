import { describe, expect, it } from "vitest";
import {
  EndingNarrativeOutputSchema,
  EvaluationSummaryOutputSchema,
  EventFlavorOutputSchema,
  type EvaluationRecord,
} from "@life-sim/shared";
import {
  buildEndingNarrativeRequest,
  buildEvaluationSummaryRequest,
  buildEventFlavorRequest,
  resolveEndingNarrative,
  validateNarrativeOutput,
  type NarrativeRequest,
} from "./narrative.js";

/**
 * R2.7 / T-P1 定向测试：只覆盖本轮新增的导出纯函数与既有护栏回归。
 * game-core 全程无 LLM / 网络 / 时间 / 随机依赖。
 */

const record: EvaluationRecord = {
  dimensions: [
    { id: "growth", label: "成长", score: 72, level: "良好", explanation: "经历丰富", evidenceIds: ["h1", "h3"] },
    { id: "bond", label: "羁绊", score: 40, level: "平平", explanation: "少有交集", evidenceIds: ["h2"] },
  ],
  summary: "模板人生总结",
  summarySource: "template",
  overall: 56,
};

const request: NarrativeRequest = {
  templateTitle: "模板标题",
  templateSummary: "模板文本",
  allowedEvidenceIds: ["h1", "h2"],
  facts: { dimensionSummaries: [] },
};

describe("T-P1 · validateNarrativeOutput（strict 校验 + 证据白名单）", () => {
  it("正常路径：合法结局候选通过，data 原样返回", () => {
    const candidate = { title: "新标题", summary: "组织后的叙事", evidenceIds: ["h1"] };
    const result = validateNarrativeOutput(EndingNarrativeOutputSchema, candidate, ["h1", "h2"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual(candidate);
  });

  it("正常路径：不含 evidenceIds 的输出契约（总结 / flavor）不做白名单校验", () => {
    expect(validateNarrativeOutput(EvaluationSummaryOutputSchema, { summary: "精炼总结" }, []).ok).toBe(true);
    expect(validateNarrativeOutput(EventFlavorOutputSchema, { flavor: "雨夜" }, []).ok).toBe(true);
  });

  it("无效输入：strict 拒绝多余字段 / 缺字段 / 篡改结构 ⇒ invalid_schema", () => {
    const cases: unknown[] = [
      { title: "x", summary: "y", evidenceIds: ["h1"], state: { hacked: true } },
      { title: "x" },
      { title: "x", summary: "y", evidenceIds: "h1" },
      { summary: "篡改", score: 999, dimensions: [], state: {} },
      null,
    ];
    for (const candidate of cases) {
      const result = validateNarrativeOutput(EndingNarrativeOutputSchema, candidate, ["h1", "h2"]);
      expect(result.ok, JSON.stringify(candidate)).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid_schema");
    }
  });

  it("无效输入：虚构 evidenceIds（不在 allowedEvidenceIds）⇒ fabricated_evidence", () => {
    const candidate = { title: "x", summary: "y", evidenceIds: ["h1", "ghost"] };
    const result = validateNarrativeOutput(EndingNarrativeOutputSchema, candidate, ["h1", "h2"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("fabricated_evidence");
  });

  it("边界：空 allowedEvidenceIds 时任何 evidenceIds 都判虚构；空数组则通过", () => {
    const empty = validateNarrativeOutput(EndingNarrativeOutputSchema, { title: "x", summary: "y", evidenceIds: [] }, []);
    expect(empty.ok).toBe(true);
    const ghost = validateNarrativeOutput(EndingNarrativeOutputSchema, { title: "x", summary: "y", evidenceIds: ["h1"] }, []);
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.reason).toBe("fabricated_evidence");
  });
});

describe("T-P1 · build*Request 纯函数与只读性", () => {
  it("buildEvaluationSummaryRequest：证据去重、维度摘要、不修改入参、重复调用逐字段相等", () => {
    const before = structuredClone(record);
    const a = buildEvaluationSummaryRequest(record);
    const b = buildEvaluationSummaryRequest(record);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.templateTitle).toBe("人生总结");
    expect(a.templateSummary).toBe("模板人生总结");
    expect([...a.allowedEvidenceIds].sort()).toEqual(["h1", "h2", "h3"]);
    expect(a.facts.dimensionSummaries).toEqual([
      { id: "growth", score: 72, level: "良好" },
      { id: "bond", score: 40, level: "平平" },
    ]);
    expect(record).toEqual(before);
  });

  it("buildEndingNarrativeRequest：只读输入、复制数组（输入后续变异不影响输出）", () => {
    const input = {
      templateTitle: "模板标题",
      templateSummary: "模板文本",
      allowedEvidenceIds: ["h1"],
      dimensionSummaries: [{ id: "growth", score: 72, level: "良好" }],
    };
    const before = structuredClone(input);
    const built = buildEndingNarrativeRequest(input);
    expect(input).toEqual(before);
    expect(built.templateTitle).toBe("模板标题");
    expect(built.allowedEvidenceIds).toEqual(["h1"]);
    expect(built.facts.dimensionSummaries).toEqual([{ id: "growth", score: 72, level: "良好" }]);
    input.allowedEvidenceIds.push("h9");
    expect(built.allowedEvidenceIds).toEqual(["h1"]);
  });

  it("buildEndingNarrativeRequest：dimensionSummaries 缺省为空数组", () => {
    const built = buildEndingNarrativeRequest({ templateTitle: "t", templateSummary: "s", allowedEvidenceIds: [] });
    expect(built.facts.dimensionSummaries).toEqual([]);
  });

  it("buildEventFlavorRequest：只读请求、运行时冻结、不修改入参、同输入同结果", () => {
    const input = { eventId: "e1", title: "雨夜", narrative: "雨落在街头", worldTime: 1440, turnIndex: 3 };
    const before = structuredClone(input);
    const a = buildEventFlavorRequest(input);
    const b = buildEventFlavorRequest(input);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(input).toEqual(before);
    expect(a.eventId).toBe("e1");
    expect(a.narrative).toBe("雨落在街头");
    expect(a.worldTime).toBe(1440);
    expect(a.turnIndex).toBe(3);
  });
});

describe("T-P1 · 既有 resolveEndingNarrative 行为回归（签名/输出不变）", () => {
  it("无 adapter ⇒ template", () => {
    const result = resolveEndingNarrative(request);
    expect(result.narrativeSource).toBe("template");
    expect(result.title).toBe("模板标题");
    expect(result.summary).toBe("模板文本");
    expect(result.diagnostic).toBeNull();
  });

  it("合法候选（evidenceIds ⊆ 白名单）⇒ llm", () => {
    const result = resolveEndingNarrative(request, () => ({ title: "新标题", summary: "新文本", evidenceIds: ["h1"] }));
    expect(result.narrativeSource).toBe("llm");
    expect(result.title).toBe("新标题");
    expect(result.diagnostic).toBeNull();
  });

  it("非法候选（多余字段 / 虚构证据 / adapter 抛错）⇒ fallback 且保留模板文本", () => {
    const cases: Array<() => unknown> = [
      () => ({ title: "x", summary: "y", evidenceIds: ["h1"], state: { hacked: true } }),
      () => ({ title: "x", summary: "y", evidenceIds: ["ghost"] }),
      () => { throw new Error("LLM unavailable"); },
      () => null,
    ];
    for (const adapter of cases) {
      const result = resolveEndingNarrative(request, adapter);
      expect(result.narrativeSource).toBe("fallback");
      expect(result.title).toBe("模板标题");
      expect(result.summary).toBe("模板文本");
      expect(result.diagnostic).not.toBeNull();
    }
  });
});
