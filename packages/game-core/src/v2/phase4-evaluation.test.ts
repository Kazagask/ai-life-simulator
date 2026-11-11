import { describe, expect, it } from "vitest";
import {
  EndingTemplateSchema,
  type EndingTemplate,
  type EvaluationConfig,
  type EvaluationRecord,
  type HistoryEntryV2,
  type WorldStateV2,
  type WorldTemplateV2,
} from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import type { ConditionContext } from "./engine.js";
import { createActiveWorldV2 } from "./test-utils.js";
import { projectSnapshotV2 } from "./projection.js";
import { resolveEnding } from "./ending.js";
import {
  finalizeEvaluationSummary,
  organizeEvaluationSummary,
  resolveEndingNarrative,
  type NarrativeAdapter,
  type NarrativeRequest,
} from "./narrative.js";
import { collectEvidence, createDefaultEvaluationConfig, evaluateLifeV2 } from "./life-evaluation.js";

// ---------- 夹具 ----------

function makeTemplate(): WorldTemplateV2 {
  return {
    meta: { id: "t", name: "阶段4测试", description: "d", startYear: 2000, engineProtocol: "v2" },
    time: { defaultStep: { value: 1, unit: "day" } },
    genders: [{ id: "f", label: "女" }],
    mood: {
      min: 0,
      max: 100,
      defaultValue: 60,
      bands: [{ id: "normal", label: "平静", min: 0, max: 100, attributeModifiers: {} }],
    },
    statusBar: [{ id: "sb1", label: "基本", source: "identity" }],
    attributes: { order: ["str"], defaults: { str: 5 } },
    resources: { hp: { base: 100, perLevel: 0 }, mp: { base: 50, perLevel: 0 } },
    regen: { perTurn: { hp: 0, mp: 0 } },
    characters: [],
    skills: [],
    items: [],
    statuses: [],
    events: [],
  };
}

function makeActive(worldId = "w1"): WorldStateV2 {
  return createActiveWorldV2({ templateId: "t", playerName: "测试者", seed: 1 }, makeTemplate(), worldId);
}

function makeCtx(state: WorldStateV2): ConditionContext {
  return { state, lookup: createLookup(makeTemplate()), rng: () => 0.5 };
}

function pushHistory(state: WorldStateV2, id: string, type: HistoryEntryV2["type"] = "event"): void {
  state.history.push({ id, turnIndex: 0, worldTime: 0, formattedTime: "", type, summary: "经历" });
}

function endingTemplateWithNarrative(): EndingTemplate {
  return EndingTemplateSchema.parse({
    endingId: "end-a",
    name: "结局",
    narrativeConfig: { source: "llm", title: "模板标题", summary: "模板文本" },
  });
}

// ---------- T4-03 · 结局叙事 adapter 三来源 ----------

describe("T4-03 · 结局叙事三来源与非法输出回退", () => {
  const request: NarrativeRequest = {
    templateTitle: "模板标题",
    templateSummary: "模板文本",
    allowedEvidenceIds: ["h1", "h2"],
    facts: { dimensionSummaries: [] },
  };

  it("无 adapter=template；合法结构化输出=llm", () => {
    const template = resolveEndingNarrative(request);
    expect(template.narrativeSource).toBe("template");
    expect(template.title).toBe("模板标题");
    const ok: NarrativeAdapter = () => ({ title: "新标题", summary: "组织后的叙事", evidenceIds: ["h1"] });
    const llm = resolveEndingNarrative(request, ok);
    expect(llm.narrativeSource).toBe("llm");
    expect(llm.title).toBe("新标题");
    expect(llm.summary).toBe("组织后的叙事");
  });

  it("结构校验失败 / 含虚构事实 / 试图写状态 / adapter 抛错 一律回退模板文本", () => {
    const cases: Array<[string, NarrativeAdapter]> = [
      ["缺字段", () => ({ title: "x" })],
      ["虚构证据", () => ({ title: "x", summary: "y", evidenceIds: ["ghost"] })],
      ["额外状态字段", () => ({ title: "x", summary: "y", evidenceIds: ["h1"], state: { hacked: true } })],
      ["null 输出", () => null],
      ["adapter 抛错", () => { throw new Error("LLM timeout"); }],
    ];
    for (const [label, adapter] of cases) {
      const result = resolveEndingNarrative(request, adapter);
      expect(result.narrativeSource, label).toBe("fallback");
      expect(result.title, label).toBe("模板标题");
      expect(result.summary, label).toBe("模板文本");
      expect(result.diagnostic, label).not.toBeNull();
    }
  });

  it("注入非法 LLM 输出后最终状态逐字段不变，文案为模板回退版本（R-EN-06）", () => {
    const state = makeActive();
    pushHistory(state, "h1");
    const before = structuredClone(state);
    const bad: NarrativeAdapter = () => ({
      title: "伪造结局",
      summary: "虚构了一场未发生的战斗",
      evidenceIds: ["ghost"],
      state: { hacked: true },
    });
    const record = resolveEnding(state, [endingTemplateWithNarrative()], makeCtx(state), {
      narrativeAdapter: bad,
    });
    expect(record.narrativeSource).toBe("fallback");
    expect(record.title).toBe("模板标题");
    expect(record.summary).toBe("模板文本");
    expect(state).toEqual(before);
  });
});

// ---------- T4-04 · 基于过程的确定性评分 ----------

describe("T4-04 · evaluateLifeV2 过程评分", () => {
  it("同结局类型、不同过程 ⇒ 至少一项维度得分不同（R-EV-01）", () => {
    const plain = makeActive("a");
    const rich = makeActive("b");
    for (let i = 0; i < 6; i++) pushHistory(rich, `h${i}`, i % 2 === 0 ? "player_action" : "event");
    // 结局类型只作背景（不参与评分）：两者都不带结局信息
    const rp = evaluateLifeV2(plain);
    const rr = evaluateLifeV2(rich);
    expect(rr.dimensions.map((d) => d.score)).not.toEqual(rp.dimensions.map((d) => d.score));
  });

  it("相同过程、不同结局类型背景 ⇒ 评分可相近（逐字段相等，结局仅作背景）", () => {
    const base = makeActive("c");
    pushHistory(base, "h0", "player_action");
    pushHistory(base, "h1", "event");
    const hero = structuredClone(base);
    hero.flags.endingType = "triumph";
    const tragic = structuredClone(base);
    tragic.flags.endingType = "sacrifice";
    const rh = evaluateLifeV2(hero);
    const rt = evaluateLifeV2(tragic);
    expect(rt.dimensions.map((d) => d.score)).toEqual(rh.dimensions.map((d) => d.score));
    expect(rt.overall).toBe(rh.overall);
  });

  it("模板可增 / 删 / 改名 / 调权：输出维度集合严格等于模板声明", () => {
    const state = makeActive();
    pushHistory(state, "h0", "player_action");
    const cfg: EvaluationConfig = {
      dimensions: [
        { id: "renown", label: "名望", weight: 2, ranges: [0, 50], explainRules: [] },
        { id: "relationships", label: "人际", weight: 1.5, ranges: [0, 100], explainRules: [] },
      ],
      worldSpecificDimensions: [
        { id: "exploration", label: "探索", weight: 0.5, ranges: [0, 80], explainRules: [] },
      ],
    };
    const rec = evaluateLifeV2(state, cfg);
    expect(rec.dimensions.map((d) => d.id)).toEqual(["renown", "relationships", "exploration"]);
    expect(rec.dimensions.some((d) => d.id === "achievements")).toBe(false); // 已删
    expect(rec.dimensions[0].score).toBeLessThanOrEqual(50); // ranges 生效
    expect(rec.dimensions[2].score).toBeLessThanOrEqual(80);
  });

  it("默认配置含协议 §18 六通用维度 id", () => {
    expect(createDefaultEvaluationConfig().dimensions.map((d) => d.id)).toEqual([
      "relationships", "achievements", "choices", "growth", "influence", "regrets",
    ]);
  });

  it("投影移除现算评价：4 参调用中性文案、5 参取 evaluation.summary，canonDeviation 不变", () => {
    const state = makeActive();
    state.flags.canonDeviation = 7;
    const template = makeTemplate();
    const lookup = createLookup(template);
    const four = projectSnapshotV2(state, template, lookup);
    expect(four.evaluation.summary).toBe("本局评价尚未生成。");
    expect(four.evaluation.summary).not.toContain("咒力"); // 无世界观专名
    expect(four.evaluation.canonDeviation).toBe(7);

    const rec = evaluateLifeV2(state);
    const five = projectSnapshotV2(state, template, lookup, rec);
    expect(five.evaluation.summary).toBe(rec.summary);
    expect(five.evaluation.canonDeviation).toBe(7);
    // 传 null 也退回中性文案
    expect(projectSnapshotV2(state, template, lookup, null).evaluation.summary).toBe("本局评价尚未生成。");
  });
});

// ---------- T4-05 · 证据、总结编排、归档只读 ----------

describe("T4-05 · 证据可解析 / 篡改分数被拒 / 只读", () => {
  it("每维度 evidenceIds 可在本局 history 中解析（P6）", () => {
    const state = makeActive();
    pushHistory(state, "h-choice-1", "event");
    pushHistory(state, "h-player-1", "player_action");
    pushHistory(state, "h-npc-1", "npc_action");
    const rec = evaluateLifeV2(state);
    const ids = new Set(state.history.map((h) => h.id));
    for (const d of rec.dimensions) {
      expect(d.evidenceIds.length).toBeGreaterThan(0);
      for (const id of d.evidenceIds) expect(ids.has(id)).toBe(true);
    }
    // collectEvidence 返回可解析引用
    for (const ref of collectEvidence(state, "relationships")) expect(ids.has(ref.id)).toBe(true);
  });

  it("空历史时 evidenceIds 为空数组（无不可解析条目）", () => {
    const rec = evaluateLifeV2(makeActive());
    for (const d of rec.dimensions) expect(d.evidenceIds).toEqual([]);
  });

  it("篡改分数 / 改写维度 / 写状态的 LLM 输出被结构校验拒绝并回退（summarySource=fallback）", () => {
    const state = makeActive();
    pushHistory(state, "h1");
    const rec = evaluateLifeV2(state);
    const tamper: NarrativeAdapter = () => ({ summary: "篡改后的总结", score: 999, dimensions: [], state: {} });
    const organized = organizeEvaluationSummary(rec, tamper);
    expect(organized.summarySource).toBe("fallback");
    expect(organized.summary).toBe(rec.summary);

    const finalized = finalizeEvaluationSummary(rec, tamper);
    expect(finalized.summarySource).toBe("fallback");
    expect(finalized.dimensions).toEqual(rec.dimensions); // 维度/分数/证据逐字段不变
    expect(finalized.overall).toBe(rec.overall);
  });

  it("合法总结输出只替换 summary，不决定分数、不改写维度或证据", () => {
    const state = makeActive();
    pushHistory(state, "h1");
    const rec: EvaluationRecord = evaluateLifeV2(state);
    const before = structuredClone(state);
    const ok: NarrativeAdapter = () => ({ summary: "一段精炼的人生总结" });
    const organized = organizeEvaluationSummary(rec, ok);
    expect(organized.summarySource).toBe("llm");
    expect(organized.summary).toBe("一段精炼的人生总结");
    const finalized = finalizeEvaluationSummary(rec, ok);
    expect(finalized.dimensions).toEqual(rec.dimensions);
    expect(finalized.overall).toBe(rec.overall);
    // 评价过程不回写世界状态
    expect(state).toEqual(before);
  });

  it("无 adapter 时 summarySource=template；归档后的世界评价结果不回写", () => {
    const state = makeActive();
    const rec = evaluateLifeV2(state);
    expect(organizeEvaluationSummary(rec).summarySource).toBe("template");
    expect(finalizeEvaluationSummary(rec).summarySource).toBe("template");
  });
});
