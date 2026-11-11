import type {
  CombatSkill,
  CombatStyleProfile,
  PublicConditionContext,
  StatusInstance,
} from "@life-sim/shared";
import type { TemplateLookup } from "./lookup.js";

/**
 * 分层战斗 AI（协议 V2.1 §20 / R-CA-01..06 / P1 / P7）。
 *
 * 五步决策，每步可单独测试：
 * ① collectCandidates —— 规则约束（控制语义 / MP / CD / 非法 actionId 过滤）
 * ② filterCandidates —— 风格 candidateFilters（声明式参数，引擎不按风格名分支）
 * ③ scoreCandidates  —— scoreWeights + 条件化 prefer 加权（可选注入 RNG 扰动）
 * ④ selectAction     —— 最高分，平局按候选稳定顺序
 * ⑤ decide           —— 返回决定，交回 v2/battle.ts 既有 executeSkill 路径结算
 *
 * 硬约束：
 * - decide() 的输入只有「候选集 + 风格画像 + PublicConditionContext」，绝不是完整
 *   WorldStateV2（R-CA-06）；AI 不自行写状态（R-CA-05）。
 * - 条件求值的唯一输入是 PublicConditionContext（公有字段）；私有提示
 *   combatHints.skillWeights 不会被包装进条件求值（R-CA-06 / P7）。
 * - 引擎内没有风格名常量或分支；不依赖 LLM；同 seed + 同状态 + 同模板决策一致
 *   （R-CA-02 / R-CA-04）。
 */

// ---------- ① 规则约束 → 候选集 ----------

/** 决策对象的战斗侧快照（由调用方从战斗镜像提取，不含世界状态）。 */
export interface CandidateSource {
  mp: number;
  skills: string[];
  skillCooldowns: Record<string, number>;
  statuses: StatusInstance[];
}

export interface CombatCandidate {
  actionId: string;
  skill: CombatSkill;
}

function hasControl(statuses: StatusInstance[], semantic: string, lookup: TemplateLookup): boolean {
  return statuses.some((inst) => {
    const control = lookup.status(inst.statusId)?.combat?.control as string[] | undefined;
    return control?.includes(semantic) ?? false;
  });
}

function isAttackSkill(skill: CombatSkill): boolean {
  return (skill.damage?.length ?? 0) > 0;
}

/** ① 规则约束：cannot_act 全排除；cannot_attack 排除攻击技；MP/CD/未注册 actionId 过滤。 */
export function collectCandidates(source: CandidateSource, lookup: TemplateLookup): CombatCandidate[] {
  if (hasControl(source.statuses, "cannot_act", lookup)) return [];
  const cannotAttack = hasControl(source.statuses, "cannot_attack", lookup);
  return source.skills
    .map((id) => lookup.skill(id))
    .filter((s): s is CombatSkill => !!s && s.kind === "combat")
    .filter((s) => source.mp >= s.cost.mp && (source.skillCooldowns[s.id] ?? 0) <= 0)
    .filter((s) => !cannotAttack || !isAttackSkill(s))
    .map((skill) => ({ actionId: skill.id, skill }));
}

// ---------- ② 风格过滤 ----------

/** ② 候选集过滤：逐条 candidateFilters（AND）；参数不匹配的候选被剔除。 */
export function filterCandidates(candidates: CombatCandidate[], profile: CombatStyleProfile): CombatCandidate[] {
  let out = candidates;
  for (const filter of profile.candidateFilters) {
    out = out.filter((c) => {
      if (filter.includeTargets && !filter.includeTargets.includes(c.skill.target)) return false;
      if (filter.excludeTargets && filter.excludeTargets.includes(c.skill.target)) return false;
      if (filter.includeActionIds && !filter.includeActionIds.includes(c.actionId)) return false;
      if (filter.excludeActionIds && filter.excludeActionIds.includes(c.actionId)) return false;
      return true;
    });
  }
  return out;
}

// ---------- ③ 评分 ----------

/** 条件化 prefer 的加权增量（远大于常规权重，保证命中即优先；与风格名无关）。 */
export const PREFER_BOOST = 1000;

const WHEN_KEYS = [
  "actorHpRatio",
  "actorMpRatio",
  "publicPlayerHpRatio",
  "publicPlayerMpRatio",
  "round",
  "publicAliveAllies",
  "publicAliveFoes",
] as const;

type WhenOps = { gte?: number; lte?: number; gt?: number; lt?: number };

function matchesWhen(when: Record<string, WhenOps | undefined>, pub: PublicConditionContext): boolean {
  for (const key of WHEN_KEYS) {
    const ops = when[key];
    if (!ops) continue;
    const value = pub[key];
    if (ops.gte !== undefined && value < ops.gte) return false;
    if (ops.lte !== undefined && value > ops.lte) return false;
    if (ops.gt !== undefined && value <= ops.gt) return false;
    if (ops.lt !== undefined && value >= ops.lt) return false;
  }
  return true;
}

export interface ScoredCandidate {
  candidate: CombatCandidate;
  score: number;
}

/** ③ 评分：scoreWeights 基础权重 + 条件化 prefer 加权；可选注入 RNG 扰动（确定性由调用方保证）。 */
export function scoreCandidates(
  candidates: CombatCandidate[],
  profile: CombatStyleProfile,
  pub: PublicConditionContext,
  perturb?: () => number,
): ScoredCandidate[] {
  return candidates.map((candidate) => {
    let score = profile.scoreWeights[candidate.actionId] ?? 1;
    for (const cond of profile.conditions) {
      if (cond.prefer.includes(candidate.actionId) && matchesWhen(cond.when as Record<string, WhenOps | undefined>, pub)) {
        score += PREFER_BOOST;
      }
    }
    if (perturb) score += perturb();
    return { candidate, score };
  });
}

// ---------- ④ 选择 ----------

/** ④ 最高分选择；平局按候选稳定顺序（先出现者胜）。 */
export function selectAction(scored: ScoredCandidate[]): CombatCandidate | null {
  let best: ScoredCandidate | null = null;
  for (const entry of scored) {
    if (!best || entry.score > best.score) best = entry;
  }
  return best?.candidate ?? null;
}

// ---------- ⑤ 决策 ----------

export interface CombatAiInput {
  /** ① 产出的候选集（已过规则约束） */
  candidates: CombatCandidate[];
  /** 风格画像（模板数据；引擎不含风格名分支） */
  profile: CombatStyleProfile;
  /** 条件求值唯一输入（公有字段） */
  pub: PublicConditionContext;
}

export type CombatDecision = { actionId: string } | { actionId: null; reason: "no_candidate" };

/**
 * ⑤ 完整决策：② 过滤 → ③ 评分 → ④ 选择。非法/缺失一律回退空决定，
 * 由调用方走「跳过回合」路径（可诊断，不抛异常炸掉战斗，R-CA-04/05）。
 */
export function decide(input: CombatAiInput, perturb?: () => number): CombatDecision {
  const filtered = filterCandidates(input.candidates, input.profile);
  const scored = scoreCandidates(filtered, input.profile, input.pub, perturb);
  const chosen = selectAction(scored);
  if (!chosen) return { actionId: null, reason: "no_candidate" };
  return { actionId: chosen.actionId };
}

// ---------- PublicConditionContext 构建（世界状态 → 条件求值的唯一入口） ----------

export interface PublicSideSnapshot {
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
}

export interface PublicBattleSnapshot {
  /** 行动方（自身战斗镜像，公有语义：HP/MP 在战斗面板对玩家可见） */
  actor: PublicSideSnapshot;
  /** 玩家（投影可见字段） */
  player: PublicSideSnapshot;
  round: number;
  /** 行动方同阵营存活数（含行动方自身） */
  aliveAllies: number;
  /** 对面阵营存活数 */
  aliveFoes: number;
}

const ratio = (value: number, max: number): number => Math.max(0, Math.min(1, value / Math.max(1, max)));

/** 唯一允许把战斗状态喂给条件求值的入口（design §6）；产出经 Zod 形状校验。 */
export function buildPublicConditionContext(snapshot: PublicBattleSnapshot): PublicConditionContext {
  return {
    actorHpRatio: ratio(snapshot.actor.hp, snapshot.actor.maxHp),
    actorMpRatio: ratio(snapshot.actor.mp, snapshot.actor.maxMp),
    publicPlayerHpRatio: ratio(snapshot.player.hp, snapshot.player.maxHp),
    publicPlayerMpRatio: ratio(snapshot.player.mp, snapshot.player.maxMp),
    round: snapshot.round,
    publicAliveAllies: snapshot.aliveAllies,
    publicAliveFoes: snapshot.aliveFoes,
  };
}
