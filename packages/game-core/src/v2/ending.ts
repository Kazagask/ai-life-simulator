import type {
  DeathRoute,
  EndingCondition,
  EndingConfig,
  EndingRecord,
  EndingTemplate,
  HistoryEntryV2,
  TerminationRecord,
  TerminationSource,
  WorldStateV2,
} from "@life-sim/shared";
import { checkAllConditions, checkCondition, type ConditionContext } from "./engine.js";
import { recordFire } from "./scheduler.js";
import { createTimeAdapter } from "./time.js";
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
      ? declared.length > 0 && declared.some((c) => checkCondition(c, ctx))
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

/** 固化 EndingRecord（独立类型，不写入 WorldStateV2）。 */
export function resolveEnding(
  state: WorldStateV2,
  templates: readonly EndingTemplate[],
  ctx: ConditionContext,
  options: EndingResolveOptions = {},
): EndingRecord {
  const ranked = selectEndingTemplates(state, templates, ctx);
  const fallbackEnding =
    templates.find((t) => t.endingId === options.fallbackId) ??
    templates.find((t) => t.fallback) ??
    templates[templates.length - 1];
  const chosen = ranked[0] ?? fallbackEnding;
  const evidenceIds = state.history.map((h) => h.id);
  const base: EndingRecord = chosen
    ? {
        endingId: chosen.endingId,
        evidenceIds,
        title: chosen.narrativeConfig.title ?? chosen.name,
        summary: chosen.narrativeConfig.summary ?? chosen.description,
        narrativeSource: "template",
      }
    : {
        endingId: "unresolved",
        evidenceIds,
        title: "旅程收束",
        summary: "本局到此结束。",
        narrativeSource: "template",
      };
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

// ---------- 战败死亡路径（T4-02 / §9.3） ----------

export type DeathRouteOutcome =
  | { kind: "none" }
  | { kind: "event"; deathEventId: string }
  | { kind: "direct" };

/**
 * 战败（over=defeat）且死亡条件满足时按 deathMode 选择路径；
 * 条件不满足、或世界已终止/归档时返回 none（模拟继续）。
 */
export function resolveDeathRoute(
  state: WorldStateV2,
  route: DeathRoute,
  signal: { battleDefeat: boolean },
  ctx: ConditionContext,
): DeathRouteOutcome {
  if (!signal.battleDefeat) return { kind: "none" };
  if (state.termination !== null || state.archived === true) return { kind: "none" };
  if (!checkAllConditions(route.conditions, ctx)) return { kind: "none" };
  if (route.deathMode === "event") {
    return { kind: "event", deathEventId: route.deathEventId ?? "" };
  }
  return { kind: "direct" };
}

export interface DeathRouteResult {
  state: WorldStateV2;
  ending: EndingRecord | null;
  termination: TerminationRecord | null;
  outcome: DeathRouteOutcome;
}

/**
 * 两条路径统一走 markTerminated()：
 * event —— 登记模板死亡事件（既有 source 类型与待决队列）后触发结局；
 * direct —— 直接触发结局。两者都不改写资源、不新增事件来源枚举。
 */
export function applyDeathRoute(
  state: WorldStateV2,
  route: DeathRoute,
  signal: { battleDefeat: boolean },
  templates: readonly EndingTemplate[],
  ctx: ConditionContext,
  options: EndingResolveOptions = {},
): DeathRouteResult {
  const outcome = resolveDeathRoute(state, route, signal, ctx);
  if (outcome.kind === "none") {
    return { state, ending: null, termination: state.termination, outcome };
  }
  const next = structuredClone(state);
  let deathEntry: HistoryEntryV2 | null = null;
  if (outcome.kind === "event") {
    const id = outcome.deathEventId;
    // R-LM-03：触发事实只经 recordFire 一处写齐（firedEvents / lastFiredIndex / eventFires）。
    recordFire(next, id);
    deathEntry = {
      id: `t${next.turnIndex}-death-${id}`,
      turnIndex: next.turnIndex,
      worldTime: next.worldTime,
      formattedTime: createTimeAdapter(ctx.lookup.template).format(next.worldTime),
      type: "event",
      summary: `死亡结局事件：${id}`,
      // 先按事件来源公开入史（需进 evidenceIds）；结局决胜后按掩码回填（协议 §21.1）
      visibility: "public",
    };
    next.history.push(deathEntry);
    // 复用既有待决队列 / 事件链结算路径，不新增事件来源枚举
    next.pendingEvents.push({ eventId: id });
  }
  const ending = resolveEnding(next, templates, ctx, options);
  if (deathEntry) {
    const chosen = templates.find((t) => t.endingId === ending.endingId);
    // 隐藏结局（narrativeConfig.masked，ADR-0006）触发的死亡事件条目继承 hidden
    deathEntry.visibility = chosen?.narrativeConfig.masked ? "hidden" : "public";
  }
  const rec: TerminationRecord = {
    reason: outcome.kind === "event" ? "战败死亡事件结算后触发结局" : "战败直接触发结局",
    worldTime: next.worldTime,
    turnIndex: next.turnIndex,
    source: "battleDefeat",
    endingId: ending.endingId,
  };
  const terminated = markTerminated(next, rec);
  return {
    state: terminated,
    ending,
    termination: terminated.termination,
    outcome,
  };
}
