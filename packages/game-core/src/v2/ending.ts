import type {
  BattlePredicate,
  BattleResult,
  BattleSideName,
  DeathAction,
  DeathRoute,
  EndingCondition,
  EndingConfig,
  EndingRecord,
  EndingTemplate,
  TerminationRecord,
  TerminationSource,
  WorldStateV2,
} from "@life-sim/shared";
import { checkAllConditions, type ConditionContext } from "./engine.js";
import { resolveEndingNarrative, type NarrativeAdapter } from "./narrative.js";

/**
 * 阶段 4 · 终止、结局与死亡路径（design §3 / §6 / §9.3、协议 §17）。
 * 纯函数：终止事实唯一由 markTerminated() 写入；判定只在模拟边界发生。
 * 战败信号来自 battle.over，不读取任何资源数值作为判死依据（R-EN-07 / P9）。
 */

// ---------- 门禁与终止写入（T2-01 既有能力） ----------

/** 门禁拒绝码：可诊断、可据以分支处理。 */
export type EndingGuardCode = "NOT_ACTIVE" | "TERMINATED";

export class EndingGuardError extends Error {
  readonly code: EndingGuardCode;

  constructor(code: EndingGuardCode, detail: string) {
    super(`[${code}] ${detail}`);
    this.name = "EndingGuardError";
    this.code = code;
  }
}

/**
 * 轮次 / 写入门禁。只读检查：任何拒绝路径都不改变 state 的任一字段。
 */
export function assertActive(state: WorldStateV2): void {
  if (state.openingCompleted === false) {
    throw new EndingGuardError(
      "NOT_ACTIVE",
      "开局尚未交接（openingCompleted=false），拒绝普通轮次推进",
    );
  }
  if (state.termination !== null || state.archived === true) {
    throw new EndingGuardError(
      "TERMINATED",
      "本局已终止或已归档，拒绝继续写入状态",
    );
  }
}

/**
 * 终止写入唯一入口。纯函数：不修改入参 state，返回携带 termination 的新状态。
 * 幂等且不可逆：已有 termination 时原样返回入参 state（逐字段不变）。
 * worldTime / turnIndex 一律取自传入 state，不读取真实时间、不使用随机数。
 */
export function markTerminated(
  state: WorldStateV2,
  rec: TerminationRecord,
): WorldStateV2 {
  if (state.termination !== null) {
    return state;
  }
  const record: TerminationRecord = {
    reason: rec.reason,
    worldTime: state.worldTime,
    turnIndex: state.turnIndex,
    source: rec.source,
    ...(rec.endingId !== undefined ? { endingId: rec.endingId } : {}),
  };
  return { ...state, termination: record };
}

// ---------- 终止条件检查（T4-01） ----------

/** 模板未提供 endings.yaml 时引擎使用的最小默认配置：不声明任何终止条件 / 结局 / 死亡路径。 */
export function createDefaultEndingConfig(): EndingConfig {
  return { terminationConditions: [], endings: [] };
}

/** 模拟边界信号：终止判定只在明确边界发生，结算中途不调用（R-EN-02）。 */
export interface TerminationSignal {
  /** false=结算中途：即便条件临时满足也不判定，避免误触发 */
  atBoundary: boolean;
  boundary: "afterEventSettle" | "afterTimeAdvance" | "playerRequested" | "afterBattleSettle";
  /** 玩家主动结束请求（playerRequested 类条件） */
  playerRequested?: boolean;
  /** 战斗以 defeat 结束（battleDefeat 类条件）；由边界提供，不读取战斗镜像资源 */
  battleDefeat?: boolean;
}

export interface TerminationDecision {
  condition: EndingCondition;
  mode: "immediate" | "afterSettle";
  reason: string;
  source: TerminationSource;
}

function sourceOf(condition: EndingCondition): TerminationSource {
  switch (condition.type) {
    case "playerRequested":
      return "player";
    case "battleDefeat":
      return "battleDefeat";
    case "eventOccurred":
      return "event";
    default:
      return "condition";
  }
}

/** 单条终止条件是否命中：声明式条件按 combinator 组合，信号类条件叠加边界信号。 */
function conditionMatches(
  state: WorldStateV2,
  condition: EndingCondition,
  signal: TerminationSignal,
  ctx: ConditionContext,
): boolean {
  const declared = condition.params.conditions;
  const baseOk =
    condition.combinator === "OR"
      ? declared.length > 0 && declared.some((c) => checkAllConditions([c], ctx))
      : checkAllConditions(declared, ctx);
  switch (condition.type) {
    case "playerRequested":
      return signal.playerRequested === true && baseOk;
    case "battleDefeat":
      return signal.battleDefeat === true && baseOk;
    case "eventOccurred": {
      const ids = condition.params.eventIds ?? [];
      const allFired = ids.every((id) => state.firedEvents[id] !== undefined);
      return baseOk && allFired;
    }
    default:
      return baseOk;
  }
}

/**
 * 七类条件检查。仅在 atBoundary=true 且世界仍在运行时判定；
 * 多条终止条件之间为 OR（任一命中即终止），命中取声明顺序首个，保证结果稳定。
 */
export function checkTermination(
  state: WorldStateV2,
  conditions: readonly EndingCondition[],
  signal: TerminationSignal,
  ctx: ConditionContext,
): TerminationDecision | null {
  if (!signal.atBoundary) return null;
  if (state.termination !== null || state.archived === true) return null;
  for (const condition of conditions) {
    if (!conditionMatches(state, condition, signal, ctx)) continue;
    return {
      condition,
      mode: condition.terminationMode,
      reason: `终止条件命中：${condition.type}（${condition.combinator}）`,
      source: sourceOf(condition),
    };
  }
  return null;
}

/**
 * 终止写入编排（R-TM-01 / R-EN-02 / R-EN-03）。
 * 入参 settled 必须是「当前事件完整结算后」的状态：判定命中时用 markTerminated()
 * 一次性固化，返回的新状态同时携带完整结算效果与 termination，不产生半更新态。
 * immediate 与 afterSettle 都走此处，差别只在 decision.mode 供调用方决定边界窗口。
 */
export function applyTermination(
  settled: WorldStateV2,
  conditions: readonly EndingCondition[],
  signal: TerminationSignal,
  ctx: ConditionContext,
): { state: WorldStateV2; decision: TerminationDecision | null } {
  const decision = checkTermination(settled, conditions, signal, ctx);
  if (!decision) return { state: settled, decision: null };
  const rec: TerminationRecord = {
    reason: decision.reason,
    worldTime: settled.worldTime,
    turnIndex: settled.turnIndex,
    source: decision.source,
  };
  return { state: markTerminated(settled, rec), decision };
}

export interface TerminationOutcome {
  state: WorldStateV2;
  decision: TerminationDecision | null;
  ending: EndingRecord | null;
}

/**
 * 边界编排（终止判定 → 结局决胜 → 一次性写入）。
 *
 * 存在的理由：applyTermination() 只写 termination 而不决胜结局，而 markTerminated() 幂等——
 * 先写 termination 再补 endingId 会被幂等 guard 丢掉。故由本函数在**同一状态快照**上
 * 先 resolveEnding() 拿到 endingId，再一次写入，避免「已终止但无结局」的半更新态。
 *
 * 未命中任何终止条件时原样返回入参（逐字段不变，不产生副本）。
 */
export function terminateWithEnding(
  settled: WorldStateV2,
  conditions: readonly EndingCondition[],
  signal: TerminationSignal,
  templates: readonly EndingTemplate[],
  ctx: ConditionContext,
  options: EndingResolveOptions = {},
): TerminationOutcome {
  const decision = checkTermination(settled, conditions, signal, ctx);
  if (!decision) {
    return { state: settled, decision: null, ending: null };
  }
  const ending = resolveEnding(settled, templates, ctx, options);
  const rec: TerminationRecord = {
    reason: decision.reason,
    worldTime: settled.worldTime,
    turnIndex: settled.turnIndex,
    source: decision.source,
    endingId: ending.endingId,
  };
  return { state: markTerminated(settled, rec), decision, ending };
}

// ---------- 结局筛选与决胜（T4-02） ----------

/**
 * 按 triggerConditions / unlockConditions / exclusiveGroup / priority 决胜，返回排序后的候选。
 * 任意结局的非空 unlockConditions 必须满足才进候选集（ADR-0006）；同一互斥组只保留优先级最高者。
 */
export function selectEndingTemplates(
  state: WorldStateV2,
  templates: readonly EndingTemplate[],
  ctx: ConditionContext,
): EndingTemplate[] {
  void state;
  const candidates = templates.filter((t) => {
    if (!checkAllConditions(t.unlockConditions, ctx)) return false;
    return checkAllConditions(t.triggerConditions, ctx);
  });
  candidates.sort(
    (a, b) => b.priority - a.priority || (a.endingId < b.endingId ? -1 : a.endingId > b.endingId ? 1 : 0),
  );
  const usedGroups = new Set<string>();
  return candidates.filter((t) => {
    if (t.exclusiveGroup !== undefined) {
      if (usedGroups.has(t.exclusiveGroup)) return false;
      usedGroups.add(t.exclusiveGroup);
    }
    return true;
  });
}

export interface EndingResolveOptions {
  /** 无专属命中时的兜底结局 id */
  fallbackId?: string;
  /** 可注入的叙事 adapter；不传时叙事来源为 template */
  narrativeAdapter?: NarrativeAdapter;
}

function endingRecordOf(state: WorldStateV2, chosen: EndingTemplate): EndingRecord {
  return {
    endingId: chosen.endingId,
    evidenceIds: state.history.map((h) => h.id),
    title: chosen.narrativeConfig.title ?? chosen.name,
    summary: chosen.narrativeConfig.summary ?? chosen.description,
    narrativeSource: "template",
  };
}

/**
 * 按 id 直接取结局记录（ADR-075 §5.1）。
 *
 * 死亡路由**不跑** `triggerConditions / unlockConditions / priority / exclusiveGroup` ——
 * 那些是"决胜"，死亡已经由路由决完了。这里只做记录与叙事；隐藏结局的 `masked`
 * 仍由投影/服务端按模板声明处理。
 */
export function resolveEndingById(
  state: WorldStateV2,
  templates: readonly EndingTemplate[],
  endingId: string,
): EndingRecord | undefined {
  const chosen = templates.find((t) => t.endingId === endingId);
  return chosen === undefined ? undefined : endingRecordOf(state, chosen);
}

/** 固化 EndingRecord（独立类型，不写入 WorldStateV2）。 */
export function resolveEnding(
  state: WorldStateV2,
  templates: readonly EndingTemplate[],
  ctx: ConditionContext,
  options: EndingResolveOptions = {},
): EndingRecord {
  /**
   * 已固化的 `termination.endingId` 优先（ADR-075 §5）：死亡路由直接引用结局 id，
   * 后续的展示 / 归档不能再跑一次 triggerConditions 把它换成别的结局。
   */
  const forced =
    state.termination?.endingId !== undefined
      ? resolveEndingById(state, templates, state.termination.endingId)
      : undefined;
  const ranked = selectEndingTemplates(state, templates, ctx);
  const fallbackEnding =
    templates.find((t) => t.endingId === options.fallbackId) ??
    templates.find((t) => t.fallback) ??
    templates[templates.length - 1];
  const chosen =
    state.termination?.endingId !== undefined
      ? (templates.find((t) => t.endingId === state.termination!.endingId) ?? ranked[0] ?? fallbackEnding)
      : (ranked[0] ?? fallbackEnding);
  const evidenceIds = state.history.map((h) => h.id);
  const base: EndingRecord =
    forced ??
    (chosen
      ? endingRecordOf(state, chosen)
      : {
          endingId: "unresolved",
          evidenceIds,
          title: "旅程收束",
          summary: "本局到此结束。",
          narrativeSource: "template",
        });
  if (!options.narrativeAdapter || !chosen) return base;
  const narrated = resolveEndingNarrative(
    {
      templateTitle: base.title,
      templateSummary: base.summary,
      allowedEvidenceIds: evidenceIds,
      facts: { dimensionSummaries: [] },
    },
    options.narrativeAdapter,
  );
  return {
    ...base,
    title: narrated.title,
    summary: narrated.summary,
    narrativeSource: narrated.narrativeSource,
  };
}

// ---------- 死亡路由（ADR-075 §5） ----------

/** 死亡从哪来：由**边界**给，不由效果自己写（`playerDeath` 只落信号）。 */
export type DeathCause = "battle" | "event" | "world";

export interface DeathRouteHit {
  route: DeathRoute;
  action: DeathAction;
}

function withinRange(value: number, range: { gte?: number; lte?: number }): boolean {
  if (range.gte !== undefined && value < range.gte) return false;
  if (range.lte !== undefined && value > range.lte) return false;
  return true;
}

function sideValue(result: BattleResult, side: BattleSideName): number {
  switch (side) {
    case "player":
      return result.sides.player;
    case "ally":
      return result.sides.ally;
    case "enemy":
      return result.sides.enemy;
    case "neutral":
      return result.sides.neutral;
    case "playerSide":
      return result.sides.player + result.sides.ally;
    case "opposition":
      return result.sides.enemy + result.sides.neutral;
  }
}

/** 除零规则（ADR-075 §4.4）：右 0 左正 ⇒ +∞；两侧都 0 ⇒ 1。 */
function ratioOf(left: number, right: number): number {
  if (right > 0) return left / right;
  return left > 0 ? Number.POSITIVE_INFINITY : 1;
}

function killerMatches(result: BattleResult, pred: NonNullable<BattlePredicate["killer"]>): boolean {
  const killer = result.killer;
  if (killer === undefined) return false;
  if (typeof pred === "string") return killer.ref === pred;
  if (pred.ref !== undefined && killer.ref !== pred.ref) return false;
  if (pred.tier !== undefined && killer.tier !== pred.tier) return false;
  if (pred.summonedByPlayer !== undefined && killer.summonedByPlayer !== pred.summonedByPlayer) return false;
  return true;
}

function battlePredicateMet(pred: BattlePredicate, result: BattleResult): boolean {
  if (pred.stake !== undefined && result.stake !== pred.stake) return false;
  if (pred.defeatState !== undefined && result.defeatState !== pred.defeatState) return false;
  if (pred.killer !== undefined && !killerMatches(result, pred.killer)) return false;
  if (pred.damageTo !== undefined) {
    const enemy = result.enemies.find((e) => e.ref === pred.damageTo!.ref);
    if (enemy === undefined) return false;
    if (!withinRange(enemy.damageByPlayer, pred.damageTo)) return false;
  }
  if (pred.playerPower !== undefined && !withinRange(result.sides.player, pred.playerPower)) return false;
  if (pred.ratio !== undefined) {
    const value = ratioOf(sideValue(result, pred.ratio.left), sideValue(result, pred.ratio.right));
    if (!withinRange(value, pred.ratio)) return false;
  }
  if (pred.grade !== undefined && result.grade !== pred.grade) return false;
  if (pred.rounds !== undefined && !withinRange(result.rounds, pred.rounds)) return false;
  return true;
}

/**
 * 单条死亡条件。`battle` 只在 `cause === "battle"` 时成立（其它原因没有战果上下文）；
 * 其余形状复用模拟域条件 DSL（flag / attribute / npcState / relation / time…）。
 */
function deathConditionMet(
  cond: NonNullable<DeathRoute["when"]>[number],
  state: WorldStateV2,
  ctx: ConditionContext,
  cause: DeathCause,
  result: BattleResult | undefined,
): boolean {
  if ("battle" in cond) {
    return cause === "battle" && result !== undefined && battlePredicateMet(cond.battle, result);
  }
  if ("cause" in cond) return cond.cause === cause;
  if ("deathDepth" in cond) return withinRange(state.deathDepth ?? 0, cond.deathDepth);
  return checkAllConditions([cond], ctx);
}

/**
 * 死亡路由决胜：声明顺序，首个命中；**必须有 `when: []` 兜底**（加载期已校验）。
 *
 * 没有命中时不"猜一个结局"—— 直接抛错，让模板作者看到"路由没兜住"。
 * 这正是用户裁决的"引擎不兜底"：兜底是模板声明出来的那一行，不是引擎写死的。
 */
export function resolveDeathRoute(
  state: WorldStateV2,
  routes: readonly DeathRoute[],
  ctx: ConditionContext,
  cause: DeathCause,
  result: BattleResult | undefined,
): DeathRouteHit {
  for (const route of routes) {
    if (route.when.every((cond) => deathConditionMet(cond, state, ctx, cause, result))) {
      return { route, action: route.then };
    }
  }
  throw new Error(`death_route_missing: cause=${cause}（模板必须声明 when: [] 兜底）`);
}

