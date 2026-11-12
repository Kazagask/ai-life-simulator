import type {
  EvaluationConfig,
  EvaluationDimension,
  EvaluationDimensionResult,
  EvaluationRecord,
  WorldStateV2,
} from "@life-sim/shared";

/**
 * 阶段 4 · 人生评价（design §4 / §6、协议 §18、R-EV-01..05）。
 * 基于**过程**（history / 选择 / 关系变化 / 目标 / 属性成长 / 影响）确定性评分；
 * 结局类型仅作背景，不参与任何分数计算。本模块是评价的唯一事实来源。
 */

/** 协议 §18 权威六通用维度 id（中文 label 可由模板覆写）。 */
export const DEFAULT_DIMENSION_IDS = [
  "relationships",
  "achievements",
  "choices",
  "growth",
  "influence",
  "regrets",
] as const;

/** 模板未提供 evaluation.yaml 时引擎使用的最小默认配置。 */
export function createDefaultEvaluationConfig(): EvaluationConfig {
  const dim = (id: string, label: string, weight: number): EvaluationDimension => ({
    id,
    label,
    weight,
    ranges: [0, 100],
    explainRules: [id],
  });
  return {
    dimensions: [
      dim("relationships", "羁绊", 1.0),
      dim("achievements", "成就", 1.2),
      dim("choices", "抉择", 1.0),
      dim("growth", "成长", 1.0),
      dim("influence", "影响", 1.0),
      dim("regrets", "遗憾", 0.8),
    ],
    worldSpecificDimensions: [],
  };
}

/** 本局过程信号：全部来自 history / 选择记录 / 关系 / 属性 / flag，不含结局类型。 */
export interface ProcessSignals {
  historyIds: string[];
  playerActionIds: string[];
  eventIds: string[];
  npcActionIds: string[];
  battleIds: string[];
  milestoneIds: string[];
  choiceIds: string[];
  relationAvg: number;
  attributeSum: number;
  milestoneFlags: number;
  battleDefeats: number;
}

export function collectProcessSignals(state: WorldStateV2): ProcessSignals {
  const history = state.history;
  const ofType = (type: string) => history.filter((h) => h.type === type).map((h) => h.id);
  const relations = state.npcs.map((n) => n.relationship);
  return {
    historyIds: history.map((h) => h.id),
    playerActionIds: ofType("player_action"),
    eventIds: ofType("event"),
    npcActionIds: ofType("npc_action"),
    battleIds: ofType("battle"),
    milestoneIds: ofType("milestone"),
    // 选择记录：选项结算写入的 event 历史，id 带 -c- 标记
    choiceIds: history.filter((h) => h.type === "event" && h.id.includes("-c-")).map((h) => h.id),
    relationAvg: relations.length > 0 ? relations.reduce((a, b) => a + b, 0) / relations.length : 0,
    attributeSum: Object.values(state.player.attributes).reduce((a, b) => a + b, 0),
    milestoneFlags: Object.entries(state.flags).filter(
      ([key, value]) => key.startsWith("milestone:") && value === true,
    ).length,
    battleDefeats: history.filter((h) => h.type === "battle" && h.summary.includes("败北")).length,
  };
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** 每维度证据只取自本局 history id；无相关记录时回退到首条历史（P6：每条都可解析）。 */
function dimensionEvidence(dimensionId: string, s: ProcessSignals): string[] {
  let ids: string[];
  switch (dimensionId) {
    case "relationships":
      ids = [...s.npcActionIds, ...s.eventIds];
      break;
    case "achievements":
      ids = [...s.milestoneIds, ...s.eventIds];
      break;
    case "choices":
      ids = [...s.choiceIds, ...s.playerActionIds];
      break;
    case "growth":
      ids = [...s.playerActionIds, ...s.eventIds];
      break;
    case "influence":
      ids = [...s.battleIds, ...s.npcActionIds];
      break;
    case "regrets":
      ids = [...s.battleIds, ...s.eventIds];
      break;
    default:
      // 世界观专属维度：回退到通用过程记录
      ids = [...s.eventIds, ...s.playerActionIds, ...s.npcActionIds];
  }
  const picked = unique(ids);
  if (picked.length === 0 && s.historyIds.length > 0) return [s.historyIds[0]];
  return picked;
}

/** 证据引用（design §6）：id 一律来自本局 history，kind 为历史条目类型。 */
export interface EvidenceRef {
  id: string;
  kind: string;
}

export function collectEvidence(state: WorldStateV2, dimensionId: string): EvidenceRef[] {
  const typeById = new Map(state.history.map((h) => [h.id, h.type]));
  return dimensionEvidence(dimensionId, collectProcessSignals(state)).map((id) => ({
    id,
    kind: typeById.get(id) ?? "unknown",
  }));
}

/** 确定性原始分：仅由过程信号决定，结局类型不在输入中。 */
function rawScore(dimensionId: string, s: ProcessSignals): number {
  switch (dimensionId) {
    case "relationships":
      return 40 + s.relationAvg / 2 + s.npcActionIds.length * 4;
    case "achievements":
      return s.milestoneFlags * 12 + s.milestoneIds.length * 8 + s.eventIds.length * 3;
    case "choices":
      return s.choiceIds.length * 9 + s.playerActionIds.length * 3;
    case "growth":
      return s.attributeSum + s.playerActionIds.length * 2;
    case "influence":
      return s.battleIds.length * 10 + s.npcActionIds.length * 3;
    case "regrets":
      return s.battleDefeats * 15 + s.battleIds.length * 4;
    default:
      return s.eventIds.length * 3 + s.playerActionIds.length * 2 + s.attributeSum / 4;
  }
}

/**
 * 有界饱和的尺度常数（D-06）：k = SATURATION_K_RATIO × (hi − lo)。
 *
 * 为什么需要：rawScore 对多数维度是**线性增长**（growth = attributeSum + actions×2、
 * 其余维度 = events×3 + actions×2 + attributeSum/4），长局必然远超 hi，
 * 旧实现 `min(hi, raw)` 直接把五维全钉在 100 —— 4 个模板专属维度还共用 default 规则，
 * 于是「满年局 5 维全 100、overall≈100」，评价失去区分度（QA D-06）。
 *
 * 采用 `score = lo + (hi − lo) · x / (x + k)`（x = raw − lo 的正部，Michaelis-Menten 型）：
 * - 单调递增 ⇒ 过程越好分越高，不引入随机；
 * - 严格小于 hi（x/(x+k) < 1 ∀x<∞）⇒ 永不顶到上限，长局之间仍有差；
 * - k 是**常数**而非本局最大值 ⇒ 不同长度的局仍可比（禁止按本局归一）。
 *
 * k 的标定依据（2026-11-12 实测，jjk-2006 + playthrough.test.ts 的 6 个种子）：
 * 满年局（走完一年、36–45 轮）各维 x 中位数 = 291（growth 166，四个 default 维度 271.5–325.75），
 * 而各维区间宽度均为 150 ⇒ 中位局 x ≈ 1.94 × 区间宽度。
 * 若取 k = x_med（半饱和点落在中位局），满年局只映射到区间 50%（≈25 分），偏低；
 * 目标是让满年局落在区间 70–90，取中位局 = 区间的 ~86.7% 反解：
 * k = x_med × (1 − 0.867) / 0.867 = x_med / 6.5 ≈ 45 ≈ **0.3 × 区间宽度**。
 * 故落成与模板绝对分数无关的形式 k = 0.3 × (hi − lo)：模板声明窄区间时 k 自动等比缩小。
 */
const SATURATION_K_RATIO = 0.3;

/**
 * 原始分 → 区间分（有界饱和）。刻意**不使用**本局最大值/历史极值做归一，
 * 否则两局长度不同即不可比（D-06 要求）。
 */
function saturatedScore(raw: number, lo: number, hi: number): number {
  if (!(hi > lo)) return lo; // 退化的零点区间：只可能是 lo
  const x = Math.max(0, raw - lo);
  const k = SATURATION_K_RATIO * (hi - lo);
  const score = lo + ((hi - lo) * x) / (x + k);
  // 理论上 score ∈ [lo, hi)，clamp 只做数值兜底（round 只在距上限 5e-3 内才可能触顶）
  return Math.round(Math.max(lo, Math.min(hi, score)) * 100) / 100;
}

/** 基于过程的确定性评分；输出维度集合严格等于模板声明集合。 */
export function evaluateLifeV2(
  state: WorldStateV2,
  cfg: EvaluationConfig = createDefaultEvaluationConfig(),
): EvaluationRecord {
  const signals = collectProcessSignals(state);
  const all = [...cfg.dimensions, ...cfg.worldSpecificDimensions];
  const dimensions: EvaluationDimensionResult[] = all.map((d) => {
    const evidence = dimensionEvidence(d.id, signals);
    const [lo, hi] = d.ranges;
    const score = saturatedScore(rawScore(d.id, signals), lo, hi);
    const ratio = hi > lo ? (score - lo) / (hi - lo) : 0;
    const level = ratio < 1 / 3 ? "低" : ratio < 2 / 3 ? "中" : "高";
    return {
      id: d.id,
      // 中文名来自模板 evaluation.yaml 的 label；玩家端投影直接透出，前端不自备映射表
      label: d.label,
      score,
      level,
      explanation: `基于 ${evidence.length} 条过程记录与维度规则确定性评分。`,
      evidenceIds: evidence,
    };
  });
  const weightSum = all.reduce((a, d) => a + d.weight, 0);
  const overall =
    weightSum > 0
      ? Math.round((dimensions.reduce((a, r, i) => a + r.score * all[i].weight, 0) / weightSum) * 100) / 100
      : 0;
  return {
    dimensions,
    summary: `本局共记录 ${signals.historyIds.length} 条经历，${dimensions.length} 项维度已评分。`,
    summarySource: "template",
    overall,
  };
}
