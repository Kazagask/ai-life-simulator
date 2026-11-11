import {
  EndingNarrativeOutputSchema,
  EvaluationSummaryOutputSchema,
  type EvaluationRecord,
  type NarrativeSource,
} from "@life-sim/shared";

/**
 * 结局叙事 / 人生总结的可注入 adapter（协议 §10、R-EN-06 / R-EV-05 / R-NFR-03）。
 * game-core 是确定性内核：不引入任何 LLM SDK、不发起网络调用；这里只暴露一个
 * 纯函数接口，接收只读请求、返回**待校验**的结构化候选，由本模块用 Zod 校验，
 * 失败/虚构事实/试图写状态一律回退模板文本。
 */

/** 只读请求：不含可写世界状态，adapter 无法借此改写权威状态。 */
export interface NarrativeRequest {
  templateTitle: string;
  templateSummary: string;
  /** 本局允许引用的证据 id 集合（虚构事实判定依据） */
  allowedEvidenceIds: readonly string[];
  facts: {
    dimensionSummaries: ReadonlyArray<{ id: string; score: number; level: string }>;
  };
}

/** 可注入的叙事函数：返回值是未校验候选，由调用方经本模块校验。 */
export type NarrativeAdapter = (request: NarrativeRequest) => unknown;

export interface EndingNarrativeResult {
  title: string;
  summary: string;
  narrativeSource: NarrativeSource;
  /** 回退原因；template / llm 正常路径为 null（错误可诊断，不静默忽略） */
  diagnostic: string | null;
}

function endingTemplate(request: NarrativeRequest): EndingNarrativeResult {
  return {
    title: request.templateTitle,
    summary: request.templateSummary,
    narrativeSource: "template",
    diagnostic: null,
  };
}

function endingFallback(request: NarrativeRequest, reason: string): EndingNarrativeResult {
  return {
    title: request.templateTitle,
    summary: request.templateSummary,
    narrativeSource: "fallback",
    diagnostic: reason,
  };
}

/**
 * 三来源：无 adapter=template；校验通过=llm；校验失败 / 虚构证据 / 含额外字段=fallback。
 * 模板文本是唯一可信回退，adapter 输出永远不写回任何状态。
 */
export function resolveEndingNarrative(
  request: NarrativeRequest,
  adapter?: NarrativeAdapter,
): EndingNarrativeResult {
  if (!adapter) return endingTemplate(request);
  let candidate: unknown;
  try {
    candidate = adapter(request);
  } catch (err) {
    return endingFallback(request, `叙事 adapter 不可用：${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = EndingNarrativeOutputSchema.safeParse(candidate);
  if (!parsed.success) {
    return endingFallback(request, "叙事输出未通过结构校验（含虚构字段或试图写状态）");
  }
  const allowed = new Set(request.allowedEvidenceIds);
  if (!parsed.data.evidenceIds.every((id) => allowed.has(id))) {
    return endingFallback(request, "叙事引用了未在本局发生的证据（虚构事实）");
  }
  return {
    title: parsed.data.title,
    summary: parsed.data.summary,
    narrativeSource: "llm",
    diagnostic: null,
  };
}

export interface SummaryResult {
  summary: string;
  summarySource: NarrativeSource;
  diagnostic: string | null;
}

function summaryRequest(record: EvaluationRecord): NarrativeRequest {
  const allowed = new Set<string>();
  for (const d of record.dimensions) {
    for (const id of d.evidenceIds) allowed.add(id);
  }
  return {
    templateTitle: "人生总结",
    templateSummary: record.summary,
    allowedEvidenceIds: [...allowed],
    facts: {
      dimensionSummaries: record.dimensions.map((d) => ({ id: d.id, score: d.score, level: d.level })),
    },
  };
}

/**
 * 把评价依据组织成自然语言总结。LLM 只产出 summary；任何分数 / 维度 / 证据 /
 * 状态字段都会被 EvaluationSummaryOutputSchema 的 strict 校验拒绝并回退。
 */
export function organizeEvaluationSummary(
  record: EvaluationRecord,
  adapter?: NarrativeAdapter,
): SummaryResult {
  const request = summaryRequest(record);
  if (!adapter) {
    return { summary: record.summary, summarySource: "template", diagnostic: null };
  }
  let candidate: unknown;
  try {
    candidate = adapter(request);
  } catch (err) {
    return {
      summary: record.summary,
      summarySource: "fallback",
      diagnostic: `总结 adapter 不可用：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = EvaluationSummaryOutputSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      summary: record.summary,
      summarySource: "fallback",
      diagnostic: "总结输出未通过结构校验（疑似篡改分数 / 维度 / 证据或写状态）",
    };
  }
  return { summary: parsed.data.summary, summarySource: "llm", diagnostic: null };
}

/** 只替换 summary / summarySource；维度、分数、证据、overall 逐字段保持不变。 */
export function finalizeEvaluationSummary(
  record: EvaluationRecord,
  adapter?: NarrativeAdapter,
): EvaluationRecord {
  const organized = organizeEvaluationSummary(record, adapter);
  return { ...record, summary: organized.summary, summarySource: organized.summarySource };
}
