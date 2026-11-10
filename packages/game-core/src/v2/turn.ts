import type {
  BattleCommand,
  ChooseOptionCommand,
  CombatSkill,
  EventV2,
  HistoryEntryV2,
  PendingEventView,
  TimeAmount,
  UseItemCommand,
  V2Snapshot,
  V2TurnResult,
  WheelResultView,
  WorldStateV2,
  WorldTemplateV2,
} from "@life-sim/shared";
import { createRng, deriveTurnSeed, pickWeighted, type Rng } from "../rng.js";
import type { RunnerContext } from "./runner-context.js";
import { amountToMinutes, createTimeAdapter, minutesToAmount } from "./time.js";
import {
  applyEffectsV2,
  checkAllConditions,
  checkCondition,
  computeMax,
  maxHp,
  maxMp,
  playerEffectiveAttributes,
  type ConditionContext,
  type EffectContextV2,
} from "./engine.js";
import { createBattle, finishBattle, performBattleAction } from "./battle.js";
import { runNpcActionsV2 } from "./npc.js";
import type { TemplateLookup } from "./lookup.js";
import { projectSnapshotV2 } from "./projection.js";
import { assertActive } from "./ending.js";

const MAX_TRIGGER_DEPTH = 8;

// ---------- 创建世界 ----------

export function createWorldV2(
  input: { templateId: string; playerName: string; seed?: number },
  template: WorldTemplateV2,
  worldId: string,
  ctx?: RunnerContext,
): WorldStateV2 {
  // 保持公开签名兼容：不传 ctx 时沿用原有默认；传入时用注入 rng 派生确定性 seed。
  const seed = input.seed ?? (ctx ? Math.floor(ctx.rng() * 0xffffffff) : Math.floor(Math.random() * 0xffffffff));
  const pt = template.playerTemplate;
  const playerAge = pt?.identity.age ?? 16;
  const mood = pt?.mood ?? template.mood.defaultValue;
  const player = {
    id: "player",
    name: input.playerName,
    gender: pt?.identity.gender ?? template.genders[0]?.id ?? "",
    age: playerAge,
    // 玩家属性 = 世界 defaults 与 playerTemplate 的合并（后者覆盖前者）：
    // 模板作者只需在 playerTemplate 里写差异项，新增自定义属性不会因遗漏而取 0
    attributes: { ...template.attributes.defaults, ...(pt?.attributes ?? {}) },
    hp: 0,
    mp: 0,
    mood,
    statuses: [],
    skillCooldowns: {},
    inventory: {} as Record<string, number>,
    skills: [...(pt?.skills ?? [])],
    growthLevel: 0,
  };
  const state: WorldStateV2 = {
    id: worldId,
    templateId: template.meta.id,
    seed,
    turnIndex: 0,
    worldTime: 0,
    playerAgeAtStart: playerAge,
    player,
    npcs: template.characters
      .filter((c) => !c.isEnemy)
      .map((c) => ({
        id: c.id,
        name: c.identity.name,
        gender: c.identity.gender,
        age: c.identity.age,
        attributes: { ...c.attributes },
        hp: 1,
        mp: 1,
        mood: c.mood.value,
        statuses: (c.statuses ?? []).map((id) => ({ statusId: id, stacks: 1, appliedTurn: 0 })),
        skillCooldowns: {},
        inventory: {},
        skills: [...(c.skills ?? [])],
        relationship: c.relationship,
        personality: c.public.personality ?? "",
        knownGoals: [...(c.public.knownGoals ?? [])],
        goals: [...(c.private.goals ?? [])],
        traits: [...(c.private.traits ?? [])],
        knowledge: [...(c.private.knowledge ?? [])],
        secrets: [...(c.private.secrets ?? [])],
        lastActedAtTurn: 0,
        isEnemy: false,
      })),
    flags: {},
    firedEvents: {},
    chains: [],
    pendingEvents: [],
    battle: null,
    lastWheel: null,
    history: [],
    openingCompleted: false,
    termination: null,
    archived: false,
  };
  state.player.hp = maxHp(state.player, template);
  state.player.mp = maxMp(state.player, template);
  // NPC 模拟域占位资源 = 完整公式上限（模拟域暂无资源结算，仅保证正数）
  for (const npc of state.npcs) {
    npc.hp = computeMax(template.resources.hp, 0, npc.attributes, 1);
    npc.mp = computeMax(template.resources.mp, 0, npc.attributes, 0);
  }
  for (const item of pt?.items ?? []) {
    state.player.inventory[item.itemId] = (state.player.inventory[item.itemId] ?? 0) + item.count;
  }
  return state;
}

// ---------- 事件触发路由 ----------

interface TriggerResult {
  triggered: Array<{ id: string; title: string; narrative: string }>;
  wheelResult: WheelResultView | null;
}

/**
 * 事件源优先级（数值越小越优先）：事件链 > 时间触发 > 行动触发 > 事件池。
 * combat 并发由轮次管线的 resolver 顺序体现（先触发者抢占战斗槽位）；
 * normal 并发由待决队列的排序体现，二者同源，保证玩家先遇到主线/剧情再遇到日常/随机事件。
 */
const EVENT_SOURCE_PRIORITY: Record<EventV2["trigger"]["source"], number> = {
  chain: 0,
  schedule: 1,
  "action-hook": 2,
  pool: 3,
};

/** 归属某条事件链的待决事件一律按「事件链」处理（最高优先级）。 */
function pendingEventPriority(event: EventV2, chainId?: string): number {
  return chainId !== undefined ? EVENT_SOURCE_PRIORITY.chain : EVENT_SOURCE_PRIORITY[event.trigger.source];
}

/**
 * normal 事件入待决队列：高优先级插在低优先级之前，同优先级保持触发先后（稳定 FIFO）。
 * 队列本身有序，故 pendingEventView 取队首、chooseOptionV2 shift 即按优先级呈现，
 * 与 combat 的抢占顺序保持一致；normal 不丢弃，仅决定呈现先后。
 */
function enqueuePendingEvent(
  state: WorldStateV2,
  event: EventV2,
  lookup: TemplateLookup,
  chainId?: string,
): void {
  const priority = pendingEventPriority(event, chainId);
  let insertAt = state.pendingEvents.length;
  for (let i = 0; i < state.pendingEvents.length; i++) {
    const queued = state.pendingEvents[i];
    const def = lookup.event(queued.eventId);
    const queuedPriority = def ? pendingEventPriority(def, queued.chainId) : EVENT_SOURCE_PRIORITY.pool;
    if (queuedPriority > priority) {
      insertAt = i;
      break;
    }
  }
  state.pendingEvents.splice(insertAt, 0, { eventId: event.id, chainId });
}

/**
 * 触发单个事件并按 kind 路由：
 * normal → 入待决队列；random → 服务端立即结算转盘；combat → 建战斗会话。
 * nextEventId 串联触发（深度限制防环）。
 */
function triggerEventV2(
  state: WorldStateV2,
  event: EventV2,
  lookup: TemplateLookup,
  rng: Rng,
  depth: number,
  result: TriggerResult,
  chainId?: string,
): void {
  if (depth > MAX_TRIGGER_DEPTH) return;
  // combat 事件：同一时刻至多一场。已有进行中战斗时整条跳过——不写 firedEvents/triggered/history，
  // 避免「战斗并未发生，却留下触发提示、历史记录并消耗 once/冷却」的不一致（事件冲突议题见 OPEN_QUESTIONS）。
  if (event.kind === "combat" && state.battle && !state.battle.over) return;
  state.firedEvents[event.id] = state.turnIndex;
  result.triggered.push({ id: event.id, title: event.title, narrative: event.narrative });
  pushHistory(state, lookup.template, {
    id: `t${state.turnIndex}-e-${event.id}`,
    type: "event",
    summary: `${event.title}：${event.narrative}`,
  });

  if (event.kind === "normal") {
    enqueuePendingEvent(state, event, lookup, chainId);
    return;
  }
  if (event.kind === "random") {
    const wheel = event.settle.random.wheel;
    const eff = playerEffectiveAttributes(state, lookup);
    const weights = wheel.segments.map((seg) => {
      let w = seg.weight;
      for (const [attr, coef] of Object.entries(seg.weightBy ?? {})) {
        w += (eff[attr] ?? 0) * coef;
      }
      return Math.max(0, w);
    });
    const idx = pickIndex(weights, rng);
    const seg = wheel.segments[idx];
    result.wheelResult = {
      eventId: event.id,
      label: seg.label,
      segments: wheel.segments.map((s) => ({ label: s.label, weight: Math.max(0, s.weight) })),
    };
    state.lastWheel = result.wheelResult;
    const segCtx: EffectContextV2 = { state, lookup, rng, logs: [] };
    applyEffectsV2(segCtx, seg.effects);
    if (segCtx.timeAdvanced) resolveScheduleV2(state, lookup.template, lookup, rng, result);
    triggerChainStarts(state, segCtx.startedChains, lookup, rng, result);
    advanceChainOnSettle(state, event, seg.nextEventId, lookup, rng, depth, result);
    return;
  }
  // combat（并发检查已提前到函数入口，此处 battle 必然为空或已结束）
  state.battle = createBattle(event.id, event.settle.combat, state, lookup);
  state.battle.log.push(`${event.narrative}`);
}

function pickIndex(weights: number[], rng: { (): number }): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return Math.floor(rng() * weights.length);
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return i;
  }
  return weights.length - 1;
}

/** 链事件结算后的推进：nextEventId 在链内则推进 stepIndex，否则链完结。 */
function advanceChainOnSettle(
  state: WorldStateV2,
  settled: EventV2 | undefined,
  nextEventId: string | undefined,
  lookup: TemplateLookup,
  rng: Rng,
  depth: number,
  result: TriggerResult,
): void {
  const chainState = settled
    ? state.chains.find((c) => {
        const def = lookup.chain(c.id);
        return def?.steps.some((s) => s.eventId === settled.id);
      })
    : undefined;
  if (!chainState || !settled) {
    if (nextEventId) {
      const next = lookup.event(nextEventId);
      if (next) triggerEventV2(state, next, lookup, rng, depth + 1, result);
    }
    return;
  }
  if (!nextEventId) {
    chainState.status = "completed";
    return;
  }
  const def = lookup.chain(chainState.id);
  const idx = def?.steps.findIndex((s) => s.eventId === nextEventId) ?? -1;
  chainState.stepIndex = idx >= 0 ? idx : chainState.stepIndex;
  chainState.status = idx >= 0 ? "active" : "completed";
  const next = lookup.event(nextEventId);
  if (next) triggerEventV2(state, next, lookup, rng, depth + 1, result, idx >= 0 ? chainState.id : undefined);
}

/** 链注册后，按起点事件 kind 立即路由触发（normal 入队 / random 即时结算 / combat 建战斗）。 */
function triggerChainStarts(
  state: WorldStateV2,
  startedChains: string[] | undefined,
  lookup: TemplateLookup,
  rng: Rng,
  result: TriggerResult,
): void {
  if (!startedChains || startedChains.length === 0) return;
  for (const chainId of startedChains) {
    const def = lookup.chain(chainId);
    if (!def) continue;
    const start = lookup.event(def.startEventId);
    if (start) triggerEventV2(state, start, lookup, rng, 0, result, chainId);
  }
}

// ---------- 事件池结算 ----------

function resolvePoolV2(state: WorldStateV2, template: WorldTemplateV2, lookup: TemplateLookup, rng: Rng, result: TriggerResult): void {
  const ctx: ConditionContext = { state, lookup, rng };
  const pool = template.events
    .filter((e) => e.trigger.source === "pool")
    .filter((e) => !(e.trigger.once && state.firedEvents[e.id] !== undefined))
    .filter((e) => !onCooldown(state, e.id, e.trigger.cooldownTurns))
    .filter((e) => checkAllConditions(e.trigger.conditions, ctx))
    .sort((a, b) => (b.trigger.priority ?? 0) - (a.trigger.priority ?? 0));

  // probability 事件：独立掷骰；weight 事件：从同轮合格者中按权重抽一个
  const weighted: EventV2[] = [];
  for (const event of pool) {
    const t = event.trigger;
    if (t.probability !== undefined) {
      if (rng() < t.probability) {
        triggerEventV2(state, event, lookup, rng, 0, result);
      }
    } else if (t.weight !== undefined) {
      weighted.push(event);
    }
  }
  const chosen = pickWeighted(weighted, (e) => e.trigger.weight ?? 1, rng);
  if (chosen) triggerEventV2(state, chosen, lookup, rng, 0, result);
}

function resolveHooksV2(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  rng: Rng,
  actionId: string,
  result: TriggerResult,
): void {
  const ctx: ConditionContext = { state, lookup, rng };
  for (const event of template.events) {
    const t = event.trigger;
    if (t.source !== "action-hook" || t.onActionId !== actionId) continue;
    if (t.once && state.firedEvents[event.id] !== undefined) continue;
    if (onCooldown(state, event.id, t.cooldownTurns)) continue;
    if (!checkAllConditions(t.conditions, ctx)) continue;
    if (t.probability !== undefined && rng() >= t.probability) continue;
    triggerEventV2(state, event, lookup, rng, 0, result);
  }
}

function resolveScheduleV2(state: WorldStateV2, template: WorldTemplateV2, lookup: TemplateLookup, rng: Rng, result: TriggerResult): void {
  for (const event of template.events) {
    const t = event.trigger;
    if (t.source !== "schedule") continue;
    if (t.once && state.firedEvents[event.id] !== undefined) continue;
    const due = (t.atTurn !== undefined && t.atTurn === state.turnIndex) || (t.atWorldTime !== undefined && state.worldTime >= amountToMinutes(t.atWorldTime));
    if (!due) continue;
    triggerEventV2(state, event, lookup, rng, 0, result);
  }
}

function advanceNextTurnChains(state: WorldStateV2, lookup: TemplateLookup, rng: Rng, result: TriggerResult): void {
  for (const chainState of state.chains) {
    if (chainState.status !== "active") continue;
    const def = lookup.chain(chainState.id);
    if (!def) continue;
    const currentStep = def.steps[chainState.stepIndex];
    if (!currentStep || currentStep.advanceWhen !== "nextTurn") continue;
    const nextStep = def.steps[chainState.stepIndex + 1];
    if (!nextStep) {
      chainState.status = "completed";
      continue;
    }
    const nextEvent = lookup.event(nextStep.eventId);
    if (!nextEvent) {
      chainState.status = "completed";
      continue;
    }
    chainState.stepIndex += 1;
    triggerEventV2(state, nextEvent, lookup, rng, 0, result, chainState.id);
  }
}

function onCooldown(state: WorldStateV2, eventId: string, cooldownTurns: number | undefined): boolean {
  const fired = state.firedEvents[eventId];
  if (fired === undefined || cooldownTurns === undefined) return false;
  return state.turnIndex - fired < cooldownTurns;
}

// ---------- 轮次推进 ----------

export function advanceTurnV2(
  state: WorldStateV2,
  command: { action: { type: string; description?: string }; mode?: "single" | "fast" },
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  ctx?: RunnerContext,
): V2TurnResult {
  assertActive(state);
  if (state.pendingEvents.length > 0) throw new Error("pending_event_required");
  if (state.battle && !state.battle.over) throw new Error("battle_in_progress");
  // 清理上一场已结束的战斗（结果已回写）
  state.battle = null;

  // 未注入 ctx 时沿用原有按轮派生 seed（行为逐字段不变）；
  // 注入时用 RunnerContext 的确定性 rng，供同 seed 全链路回放复用。
  const rng = ctx?.rng ?? createRng(deriveTurnSeed(state.seed, state.turnIndex + 1));
  const adapter = createTimeAdapter(template);
  const action = lookup.action(command.action.type);
  const lifeStage = adapter.resolveLifeStage(state.player.age);

  // 绝对推进目标（剧情节点）优先于相对步长：直接推进到目标时间，不倒退
  let elapsed: TimeAmount;
  if (action?.advanceTo) {
    const delta = Math.max(0, amountToMinutes(action.advanceTo) - state.worldTime);
    state.turnIndex += 1;
    state.worldTime += delta;
    elapsed = minutesToAmount(delta);
  } else {
    elapsed = adapter.resolveStep(lifeStage, action?.duration);
    state.turnIndex += 1;
    state.worldTime += amountToMinutes(elapsed);
  }
  state.flags.turnsPlayed = state.turnIndex;

  const result: TriggerResult = { triggered: [], wheelResult: null };

  // 1. 玩家行动效果（改变状态；startChain / advanceTo 等副作用标记由路由层按优先级消费）
  const actionCtx: EffectContextV2 = { state, lookup, rng, logs: [] };
  applyEffectsV2(actionCtx, action?.effects);
  pushHistory(state, template, {
    id: `t${state.turnIndex}-p`,
    type: "player_action",
    summary: action ? `${action.label}：${command.action.description || action.description || ""}` : command.action.description || "自由行动",
  });

  // 2. 事件链（chain）——最高优先级，先抢占战斗槽位，保证主线不被随机遭遇挤掉
  triggerChainStarts(state, actionCtx.startedChains, lookup, rng, result);
  advanceNextTurnChains(state, lookup, rng, result);

  // 3. 时间触发（schedule）——次高（含行动效果 advanceTo/advanceBy 推进时间后的剧情节点）
  resolveScheduleV2(state, template, lookup, rng, result);

  // 4. 行动触发（action-hook）——再次
  resolveHooksV2(state, template, lookup, rng, command.action.type, result);

  // 5. 回复（行动附加回复 + 每轮自然回复）
  const bonus = template.regen.actions?.[command.action.type];
  const hpRegen = template.regen.perTurn.hp + (bonus?.hp ?? 0);
  const mpRegen = template.regen.perTurn.mp + (bonus?.mp ?? 0);
  state.player.hp = Math.min(maxHp(state.player, template), state.player.hp + hpRegen);
  state.player.mp = Math.min(maxMp(state.player, template), state.player.mp + mpRegen);

  // 6. 心情/补正模拟域结算
  tickSimulationStatuses(state, lookup, command.action.type === "rest");
  state.player.mood = Math.max(template.mood.min, Math.min(template.mood.max, state.player.mood));

  // 7. 年龄推进（由时间适配器按历法计算经过年数）
  state.player.age = state.playerAgeAtStart + adapter.elapsedYears(state.worldTime);

  // 8. NPC 自主行动（触发式 + 效用评分 + 兜底随机）；NPC 触发的链同属"事件链"
  const npcResult = runNpcActionsV2(state, lookup, rng);
  if (npcResult.startedChains.length > 0) {
    triggerChainStarts(state, npcResult.startedChains, lookup, rng, result);
  }

  // 9. 事件池（pool）——最低优先级
  resolvePoolV2(state, template, lookup, rng, result);

  const snapshot = projectSnapshotV2(state, template, lookup);
  return {
    state,
    snapshot,
    elapsed,
    triggeredEvents: result.triggered,
    wheelResult: result.wheelResult,
    playerVisibleHistory: state.history.slice(-20),
  };
}

function tickSimulationStatuses(state: WorldStateV2, lookup: TemplateLookup, isRest: boolean): void {
  const remaining: typeof state.player.statuses = [];
  for (const inst of state.player.statuses) {
    const def = lookup.status(inst.statusId);
    if (!def) continue;
    const sim = def.simulation;
    if (sim?.moodDeltaPerTurn) {
      state.player.mood += sim.moodDeltaPerTurn * inst.stacks;
    }
    // restTurns 治疗
    const restCure = def.cureConditions?.find((c) => "restTurns" in c);
    if (restCure && "restTurns" in restCure) {
      inst.restProgress = (inst.restProgress ?? 0) + (isRest ? 1 : 0);
      if (inst.restProgress >= restCure.restTurns) continue; // 痊愈
    }
    // duration.turns 每模拟轮递减（turnsLeft 为实例副本，模板不可变）
    if ("turns" in def.duration) {
      inst.turnsLeft = (inst.turnsLeft ?? def.duration.turns) - 1;
      if (inst.turnsLeft <= 0) continue; // 自然消退
    }
    remaining.push(inst);
  }
  state.player.statuses = remaining;
}

function pushHistory(
  state: WorldStateV2,
  template: WorldTemplateV2,
  entry: Omit<HistoryEntryV2, "turnIndex" | "worldTime" | "formattedTime">,
): void {
  state.history.push({
    ...entry,
    turnIndex: state.turnIndex,
    worldTime: state.worldTime,
    formattedTime: createTimeAdapter(template).format(state.worldTime),
  });
}

// ---------- 玩家选项 ----------

export function chooseOptionV2(
  state: WorldStateV2,
  command: ChooseOptionCommand,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
): V2TurnResult {
  if (state.battle && !state.battle.over) throw new Error("battle_in_progress");
  const pending = state.pendingEvents[0];
  if (!pending) throw new Error("no_pending_event");
  const event = lookup.event(pending.eventId);
  if (!event || event.kind !== "normal") throw new Error("event_not_normal");

  const rng = createRng(deriveTurnSeed(state.seed + 7, state.turnIndex));
  const ctx: ConditionContext = { state, lookup, rng };
  const option = event.settle.normal.options.find(
    (o) => o.id === command.optionId && checkAllConditions(o.visibleWhen, ctx),
  );
  if (!option) throw new Error("option_not_available");

  state.pendingEvents.shift();
  state.firedEvents[event.id] = state.turnIndex;
  pushHistory(state, template, {
    id: `t${state.turnIndex}-c-${event.id}-${option.id}`,
    type: "event",
    summary: `${event.title}：你选择了「${option.text}」`,
  });

  const result: TriggerResult = { triggered: [], wheelResult: null };
  const optionCtx: EffectContextV2 = { state, lookup, rng, logs: [] };
  applyEffectsV2(optionCtx, option.effects);
  if (optionCtx.timeAdvanced) resolveScheduleV2(state, template, lookup, rng, result);
  triggerChainStarts(state, optionCtx.startedChains, lookup, rng, result);
  advanceChainOnSettle(state, event, option.nextEventId, lookup, rng, 0, result);

  const snapshot = projectSnapshotV2(state, template, lookup);
  return {
    state,
    snapshot,
    elapsed: { value: 0, unit: "minute" },
    triggeredEvents: result.triggered,
    wheelResult: result.wheelResult,
    playerVisibleHistory: [],
  };
}

// ---------- 战斗行动 ----------

export function battleActionV2(
  state: WorldStateV2,
  command: BattleCommand,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
): V2TurnResult {
  const battle = state.battle;
  if (!battle || battle.over) throw new Error("battle_not_active");
  const rng = createRng(deriveTurnSeed(state.seed + 13, state.turnIndex * 100 + battle.round));

  performBattleAction(state, command, lookup, rng);

  const result: TriggerResult = { triggered: [], wheelResult: null };
  if (battle.over) {
    // 结算战斗结果效果 → 后续事件
    const event = lookup.event(battle.eventId);
    const outcome = battle.over;
    const outcomeLabel = outcome === "victory" ? "胜利" : outcome === "defeat" ? "败北" : "撤离";
    if (event && event.kind === "combat") {
      const settle = event.settle.combat;
      const outcomeDef =
        outcome === "victory" ? settle.onVictory : outcome === "defeat" ? settle.onDefeat : settle.onFlee;
      // 先回写战斗镜像（补正转换/资源），再结算结果效果，避免镜像覆写结果补正
      finishBattle(state, lookup);
      const outcomeCtx: EffectContextV2 = { state, lookup, rng, logs: [] };
      applyEffectsV2(outcomeCtx, outcomeDef?.effects);
      if (outcomeCtx.timeAdvanced) resolveScheduleV2(state, template, lookup, rng, result);
      triggerChainStarts(state, outcomeCtx.startedChains, lookup, rng, result);
      // 战斗结束立即清除会话：结果已回写并记入 history，前端据此回到常规行动界面，
      // 避免残留的 over 会话与待决事件并存时「离开战场」被 pending_event_required 卡死。
      state.battle = null;
      if (outcomeDef?.nextEventId) {
        const next = lookup.event(outcomeDef.nextEventId);
        if (next) triggerEventV2(state, next, lookup, rng, 0, result);
      }
    } else {
      finishBattle(state, lookup);
      state.battle = null;
    }
    advanceChainOnSettle(state, event, undefined, lookup, rng, 0, result);
    // 战斗结果作为可展示事件返回，前端在结果区呈现胜负
    result.triggered.push({
      id: `battle-${battle.eventId}`,
      title: `战斗${outcomeLabel}`,
      narrative:
        outcome === "victory"
          ? "你击溃了敌人，尘埃落定。"
          : outcome === "defeat"
            ? "你身负重伤，勉强脱离了危险。"
            : "你趁隙脱离了战斗。",
    });
  }

  const snapshot = projectSnapshotV2(state, template, lookup);
  return {
    state,
    snapshot,
    elapsed: { value: 0, unit: "minute" },
    triggeredEvents: result.triggered,
    wheelResult: result.wheelResult,
    playerVisibleHistory: [],
  };
}

// ---------- 战斗外用物品 ----------

export function useItemV2(
  state: WorldStateV2,
  command: UseItemCommand,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
): V2TurnResult {
  if (state.battle && !state.battle.over) throw new Error("battle_in_progress");
  const item = lookup.item(command.itemId);
  if (!item) throw new Error("item_not_found");
  if (!item.usableOutsideBattle) throw new Error("item_not_usable");
  if ((state.player.inventory[item.id] ?? 0) <= 0) throw new Error("item_not_owned");

  const rng = createRng(deriveTurnSeed(state.seed + 29, state.turnIndex));
  state.player.inventory[item.id] -= 1;
  if (state.player.inventory[item.id] <= 0) delete state.player.inventory[item.id];
  const logs: string[] = [];
  const result: TriggerResult = { triggered: [], wheelResult: null };
  const itemCtx: EffectContextV2 = { state, lookup, rng, logs };
  applyEffectsV2(itemCtx, item.use);
  if (itemCtx.timeAdvanced) resolveScheduleV2(state, template, lookup, rng, result);
  triggerChainStarts(state, itemCtx.startedChains, lookup, rng, result);
  pushHistory(state, template, {
    id: `t${state.turnIndex}-i-${item.id}`,
    type: "player_action",
    summary: `使用了「${item.name}」${logs.length > 0 ? `：${logs.join("；")}` : ""}`,
  });

  const snapshot = projectSnapshotV2(state, template, lookup);
  return {
    state,
    snapshot,
    elapsed: { value: 0, unit: "minute" },
    triggeredEvents: result.triggered,
    wheelResult: result.wheelResult,
    playerVisibleHistory: [],
  };
}

// ---------- 待决事件视图（选项按 visibleWhen 过滤） ----------

export function pendingEventView(state: WorldStateV2, lookup: TemplateLookup): PendingEventView | null {
  const pending = state.pendingEvents[0];
  if (!pending) return null;
  const event = lookup.event(pending.eventId);
  if (!event || event.kind !== "normal") return null;
  const rng = createRng(deriveTurnSeed(state.seed + 7, state.turnIndex));
  const ctx: ConditionContext = { state, lookup, rng };
  return {
    eventId: event.id,
    title: event.title,
    narrative: event.narrative,
    options: event.settle.normal.options
      .filter((o) => checkAllConditions(o.visibleWhen, ctx))
      .map((o) => ({ id: o.id, text: o.text })),
  };
}

export { maxHp, maxMp, playerEffectiveAttributes, checkCondition };
