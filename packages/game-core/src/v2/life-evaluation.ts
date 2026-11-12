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
    const score = Math.max(lo, Math.min(hi, Math.round(rawScore(d.id, signals) * 100) / 100));
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
