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

// ---------- R2.7 · 只读请求构造器（导出纯函数，供 apps/server 复用；game-core 不碰 LLM） ----------

/**
 * 人生总结请求的唯一构造入口（原先为私有 `summaryRequest`）。
 * 逐字段只读：不修改入参 `record`，每次返回全新对象；证据集合由维度证据去重得到。
 */
export function buildEvaluationSummaryRequest(record: EvaluationRecord): NarrativeRequest {
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

export interface BuildEndingNarrativeRequestInput {
  templateTitle: string;
  templateSummary: string;
  allowedEvidenceIds: readonly string[];
  dimensionSummaries?: ReadonlyArray<{ id: string; score: number; level: string }>;
}

/** 结局叙事请求：模板文本 + 本局证据白名单（+ 可选维度摘要），不含任何可写状态。 */
export function buildEndingNarrativeRequest(
  input: BuildEndingNarrativeRequestInput,
): NarrativeRequest {
  return {
    templateTitle: input.templateTitle,
    templateSummary: input.templateSummary,
    allowedEvidenceIds: [...input.allowedEvidenceIds],
    facts: { dimensionSummaries: [...(input.dimensionSummaries ?? [])] },
  };
}

export interface EventFlavorRequestInput {
  eventId: string;
  title: string;
  narrative: string;
  worldTime: number;
  turnIndex: number;
}

/**
 * 事件 flavor 请求：只读、不含 evidenceIds（事件文案不做证据白名单）。
 * 返回对象在运行时冻结 —— 内核侧没有任何消费者能借此改写权威状态。
 */
export interface EventFlavorRequest {
  readonly eventId: string;
  readonly title: string;
  readonly narrative: string;
  readonly worldTime: number;
  readonly turnIndex: number;
}

export function buildEventFlavorRequest(input: EventFlavorRequestInput): EventFlavorRequest {
  return Object.freeze({
    eventId: input.eventId,
    title: input.title,
    narrative: input.narrative,
    worldTime: input.worldTime,
    turnIndex: input.turnIndex,
  });
}

/** LLM 请求联合：结局/总结走 `NarrativeRequest`，事件 flavor 走 `EventFlavorRequest`。 */
export type NarrativeInput = NarrativeRequest | EventFlavorRequest;

/**
 * 结构化校验器的最小接口：让 game-core **不直接 import zod**，
 * 又能对任意 Zod schema（其 `safeParse` 返回类型结构上兼容本接口）做校验。
 */
export interface NarrativeOutputSchemaLike {
  safeParse(input: unknown): { success: true; data: unknown } | { success: false };
}

export type ValidateNarrativeOutputResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: "invalid_schema" | "fabricated_evidence" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 校验的**单一事实来源**（R-LLM-04 / R-NAR-01..03）：
 * ① strict `safeParse` 拒额外字段 / 篡改结构；
 * ② 通过后若候选含 `evidenceIds` 数组，逐项校验其 ⊆ `allowedEvidenceIds`，否则判虚构证据。
 * 纯函数：不改入参、不写状态、不吞异常（失败以可区分的 `reason` 返回）。
 */
export function validateNarrativeOutput(
  schema: NarrativeOutputSchemaLike,
  candidate: unknown,
  allowedEvidenceIds: readonly string[],
): ValidateNarrativeOutputResult {
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) return { ok: false, reason: "invalid_schema" };
  const data: unknown = parsed.data;
  if (isRecord(data) && Array.isArray(data.evidenceIds)) {
    const ids: readonly unknown[] = data.evidenceIds;
    const allowed = new Set(allowedEvidenceIds);
    if (!ids.every((id: unknown) => typeof id === "string" && allowed.has(id))) {
      return { ok: false, reason: "fabricated_evidence" };
    }
  }
  return { ok: true, data };
}

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

/**
 * 把评价依据组织成自然语言总结。LLM 只产出 summary；任何分数 / 维度 / 证据 /
 * 状态字段都会被 EvaluationSummaryOutputSchema 的 strict 校验拒绝并回退。
 * 请求构造统一走导出的 `buildEvaluationSummaryRequest`（行为与原先私有函数逐字段一致）。
 */
export function organizeEvaluationSummary(
  record: EvaluationRecord,
  adapter?: NarrativeAdapter,
): SummaryResult {
  const request = buildEvaluationSummaryRequest(record);
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
