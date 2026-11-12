import type {
  BattleCommand,
  ChooseOptionCommand,
  CombatSkill,
  EndingConfig,
  EquipmentInstance,
  EvaluationConfig,
  EventV2,
  HistoryEntryV2,
  HistoryVisibility,
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
import { evaluateLifeV2 } from "./life-evaluation.js";
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
import { nextInstanceId } from "./equipment.js";
import { runNpcActionsV2 } from "./npc.js";
import type { TemplateLookup } from "./lookup.js";
import { projectSnapshotV2 } from "./projection.js";
import { playerVisibleHistory, pushHistory } from "./history.js";
import {
  alignChainStep,
  drainScheduledEvents,
  enqueueCandidate,
  enqueueScheduled,
  evaluateChain,
  hasFired,
  onCooldown,
  recordFire,
  specToMinutes,
} from "./scheduler.js";
import {
  applyDeathRoute,
  assertActive,
  createDefaultEndingConfig,
  terminateWithEnding,
  type TerminationSignal,
} from "./ending.js";

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
  // 初始装备（协议 §19 equipment.initialEquipment；槽位/类型/类别已由 Schema 加载期校验）。
  // 这是**独立的穿戴授予**，不从背包扣除（ADR-0008）：模板若同时在 playerTemplate.items
  // 写了同一 itemId，玩家得到「1 件穿戴 + 1 件备用」。卸下时按职业常规回流到背包。
  const initialEquipment: EquipmentInstance[] = [];
  for (const init of template.equipment?.initialEquipment ?? []) {
    const def = template.items.find((i) => i.id === init.itemId);
    if (!def || def.type !== "equipment" || !def.slot) continue;
    initialEquipment.push({
      instanceId: nextInstanceId(initialEquipment, init.itemId),
      itemId: init.itemId,
      ownerId: "player",
      slot: def.slot,
    });
  }
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
    equipment: initialEquipment,
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
    // R2.6 / ADR-0014：初始关系边由 characters[].relations 声明（from=该角色）。
    // visibility 缺省 unknown（R-OP-05 默认不认识）；npc.relationship 标量保留独立
    // 兼容字段，不自动生成 known 边。
    relations: template.characters.flatMap((c) =>
      (c.relations ?? []).map((r) => ({
        from: c.id,
        to: r.to,
        kind: r.kind,
        source: "template" as const,
        visibility: r.visibility ?? ("unknown" as const),
        ...(r.value !== undefined ? { value: r.value } : {}),
        ...(r.gap !== undefined ? { gap: r.gap } : {}),
      })),
    ),
    flags: {},
    firedEvents: {},
    // R2.5 实例层 / 事实层：全部由 createWorldV2 显式初始化，存档 strict 校验逐字段要求存在。
    scheduledEvents: [],
    enqueueSeqCounter: 0,
    missedEvents: [],
    eventFires: [],
    lastFiredIndex: {},
    chains: [],
    pendingEvents: [],
    battle: null,
    lastWheel: null,
    // D-03：当轮转盘结果列表（每轮起点清空）；单槽 lastWheel 保留兼容
    lastWheels: [],
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
  // R-EV-08：全部 source: schedule 事件在**世界初始化**（now=0）即入队，
  // 不再每轮扫描 template.events。window 在入队时一次性换算成绝对分钟固化。
  // R2.6（ADR-0013）：TimeSpec 换算经历法适配器（字符串字面量 / year-month 量）。
  const initCalendar = createTimeAdapter(template);
  for (const event of template.events) {
    if (event.trigger.source !== "schedule") continue;
    enqueueScheduled({
      state,
      definitionId: event.id,
      origin: { kind: "schedule-init", id: event.id },
      start: event.trigger.window?.start ?? { value: 0, unit: "minute" },
      ...(event.trigger.window?.end !== undefined ? { end: event.trigger.window.end } : {}),
      calendar: initCalendar,
    });
  }
  return state;
}

/** 历史条目 id：附加本局历史长度后缀，保证事件结算轮下仍严格唯一（R-EV-14）。 */
function historyId(state: WorldStateV2, base: string): string {
  return `${base}-${state.history.length}`;
}

// ---------- 事件触发路由 ----------

interface TriggerResult {
  triggered: Array<{ id: string; title: string; narrative: string }>;
  wheelResult: WheelResultView | null;
  /** 效果推进时间 / 新入队 ⇒ 请求在安全边界再 drain 一轮（§3.4.5 断链保护） */
  drainRequested?: boolean;
}

/** 效果可在 onFire 内推进时间或再入队；每轮整体结束后才开启下一轮，避免在 drain 循环内递归。 */
const MAX_DRAIN_PASSES = 8;

/**
 * drain 的唯一接线点：回调内 triggerEventV2 负责 recordFire（战斗并发冲突时整条跳过、不写事实）。
 * 单轮遍历的是排序快照；onFire 中新入队/推进时间的实例由「下一轮 pass」取出，
 * 仍在同一安全边界内完成，不递归、不受插入顺序影响 ⇒ 确定性保持。
 */
function drainDue(
  state: WorldStateV2,
  lookup: TemplateLookup,
  rng: Rng,
  result: TriggerResult,
): void {
  const calendar = createTimeAdapter(lookup.template);
  for (let pass = 0; pass < MAX_DRAIN_PASSES; pass++) {
    result.drainRequested = false;
    drainScheduledEvents(
      state,
      lookup,
      rng,
      (inst, def) => {
        triggerEventV2(state, def, lookup, rng, 0, result, inst.chainId);
      },
      calendar,
    );
    if (!result.drainRequested) break;
    // 没有「已到期且仍 waiting」的实例时立即收敛，避免空转（同 seed 行为恒定）。
    if (!state.scheduledEvents.some((i) => i.status === "waiting" && i.window.start <= state.worldTime)) break;
  }
  result.drainRequested = false;
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
  recordFire(state, event.id);
  result.triggered.push({ id: event.id, title: event.title, narrative: event.narrative });
  pushHistory(state, lookup.template, {
    id: historyId(state, `t${state.turnIndex}-e-${event.id}`),
    type: "event",
    summary: `${event.title}：${event.narrative}`,
    // 事件无隐藏语义（OPEN_QUESTIONS #33）：进轮次调度即公开
    visibility: "public",
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
      // D-16：标题随结果持久化 —— 刷新后前端不再依赖本次响应的 triggeredEvents 反查，
      // 双转盘卡片的标题也不会回落成「随机事件」。
      title: event.title,
      label: seg.label,
      segments: wheel.segments.map((s) => ({ label: s.label, weight: Math.max(0, s.weight) })),
    };
    // 单槽保留「最后一个」（既有消费者 + D-09 刷新回放），列表承接「当轮全部」（D-03）：
    // 同一轮结算两个 kind: random 事件时不再互相覆盖玩家可见的转盘结果。
    state.lastWheel = result.wheelResult;
    (state.lastWheels ??= []).push(result.wheelResult);
    const segCtx: EffectContextV2 = { state, lookup, rng, logs: [] };
    applyEffectsV2(segCtx, seg.effects);
    // 效果推进世界时间 / enqueueEvent 入队：只置标记，由 drainDue 在本轮整体结束后
    // 开新一轮 pass 消费（§3.4.5 断链保护，不在 onFire 内递归 drain）。
    if (segCtx.timeAdvanced || (segCtx.enqueued?.length ?? 0) > 0) result.drainRequested = true;
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

/**
 * 链事件结算后的推进（R-EV-10 / M4）：
 * - stepIndex 一律经 scheduler.alignChainStep 单一规则对齐，杜绝「效果 +1 与结算对齐」双写漂移；
 * - 目标步声明 delay/window 时**不入 pendingEvents**，立即 enqueueScheduled 并保留链 active
 *   （evaluateChain 靠队列 waiting 实例判断链未断），到期 drain 时按 chainId 回归链优先级。
 */
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
  if (idx < 0) {
    chainState.status = "completed";
    const next = lookup.event(nextEventId);
    if (next) triggerEventV2(state, next, lookup, rng, depth + 1, result);
    return;
  }
  alignChainStep(state, chainState.id, lookup, nextEventId);
  const step = def!.steps[idx];
  const next = lookup.event(nextEventId);
  if (!next) {
    chainState.status = "completed";
    return;
  }
  const delayed = step.delay ?? next.trigger.delay ?? next.trigger.window?.start;
  if (delayed !== undefined) {
    enqueueScheduled({
      state,
      definitionId: next.id,
      origin: { kind: "effect", id: chainState.id },
      chainId: chainState.id,
      start: delayed,
      ...(next.trigger.window?.end !== undefined ? { end: next.trigger.window.end } : {}),
      calendar: createTimeAdapter(lookup.template),
    });
    return;
  }
  triggerEventV2(state, next, lookup, rng, depth + 1, result, chainState.id);
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

/**
 * pool = 抽取器（R-EV-08/13）：六策略在**候选产生时**决定门控，
 * 通过者只经 enqueueCandidate 进延时队列（delay 缺省 = 相对 0 分钟），不得立即呈现。
 * 门控失败不产生实例、不记错失；probability 逐事件掷骰 + weight 加权抽一的 RNG 次序沿用旧管线。
 * 【同 seed 序列变更】旧实现抽中即 triggerEventV2；本实现抽出后由管线末端 drain 触发。
 */
function resolvePoolV2(state: WorldStateV2, template: WorldTemplateV2, lookup: TemplateLookup, rng: Rng): void {
  const ctx: ConditionContext = { state, lookup, rng };
  const calendar = createTimeAdapter(template);
  const pool = template.events
    .filter((e) => e.trigger.source === "pool")
    .filter((e) => e.kind !== "combat") // 加载期已拒，抽取期防御
    .filter((e) => !(e.trigger.once && hasFired(state, e.id)))
    .filter((e) => !onCooldown(state, e.id, e.trigger.cooldown, calendar))
    .filter((e) => checkAllConditions(e.trigger.conditions, ctx))
    .sort((a, b) => (b.trigger.priority ?? 0) - (a.trigger.priority ?? 0));

  // probability 事件：独立掷骰；weight 事件：从同轮合格者中按权重抽一个
  const weighted: EventV2[] = [];
  const enqueue = (event: EventV2): void => {
    enqueueCandidate({
      state,
      definition: event,
      origin: { kind: "pool", id: event.id },
      lookup,
      rng,
      calendar,
      preGated: true, // 六策略已在上面消费，门控不得重复扣减 once / probability / conditions
    });
  };
  for (const event of pool) {
    const t = event.trigger;
    if (t.probability !== undefined) {
      if (rng() < t.probability) enqueue(event);
    } else if (t.weight !== undefined) {
      weighted.push(event);
    }
  }
  const chosen = pickWeighted(weighted, (e) => e.trigger.weight ?? 1, rng);
  if (chosen) enqueue(chosen);
}

/**
 * action-hook 保留旧名：未声明 window/delay ⇒ 立即触发；声明了 ⇒ 入延时队列。
 * 六策略仍在命中行动时求值（配置域只读），preGated 避免门控重复扣减。
 */
function resolveHooksV2(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  rng: Rng,
  actionId: string,
  result: TriggerResult,
): void {
  const ctx: ConditionContext = { state, lookup, rng };
  const calendar = createTimeAdapter(template);
  for (const event of template.events) {
    const t = event.trigger;
    if (t.source !== "action-hook" || t.onActionId !== actionId) continue;
    if (t.once && hasFired(state, event.id)) continue;
    if (onCooldown(state, event.id, t.cooldown, calendar)) continue;
    if (!checkAllConditions(t.conditions, ctx)) continue;
    if (t.probability !== undefined && rng() >= t.probability) continue;
    if (t.window !== undefined || t.delay !== undefined) {
      enqueueCandidate({
        state,
        definition: event,
        origin: { kind: "effect", id: actionId },
        lookup,
        rng,
        calendar,
        preGated: true,
      });
    } else {
      triggerEventV2(state, event, lookup, rng, 0, result);
    }
  }
}

/** Q-R25-06 裁决 A：保留 nextTurn（槽位语义，不是时间量）；延时步一律走队列。 */
function advanceNextTurnChains(state: WorldStateV2, lookup: TemplateLookup, rng: Rng, result: TriggerResult): void {
  for (const chainState of state.chains) {
    if (chainState.status !== "active") continue;
    const def = lookup.chain(chainState.id);
    if (!def) continue;
    // R-EV-10：队列仍有该链 waiting 实例时不得推进 / 断链
    if (state.scheduledEvents.some((i) => i.chainId === chainState.id && i.status === "waiting")) continue;
    if (evaluateChain(state, lookup, chainState.id) !== "active") {
      chainState.status = "completed";
      continue;
    }
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
    alignChainStep(state, chainState.id, lookup, nextStep.eventId);
    if (nextStep.delay !== undefined) {
      enqueueScheduled({
        state,
        definitionId: nextEvent.id,
        origin: { kind: "effect", id: chainState.id },
        chainId: chainState.id,
        start: nextStep.delay,
        calendar: createTimeAdapter(lookup.template),
      });
      continue;
    }
    triggerEventV2(state, nextEvent, lookup, rng, 0, result, chainState.id);
  }
}

// ---------- 轮次推进 ----------

/**
 * 可选管线配置（阶段 4 遗留接线）：不传时行为与接线前逐字段一致——
 * 无 endings.yaml ⇒ 零终止条件 ⇒ 永不终止；评价用引擎默认配置。
 * 由调用方（apps/server）注入模板分域配置，内核不自行读文件。
 */
export interface TurnPipelineConfig {
  endingConfig?: EndingConfig;
  evaluationConfig?: EvaluationConfig;
}

/**
 * 终止判定边界：命中条件时在**同一状态快照**上决胜结局并写入 termination。
 * 只原地写 termination 一个字段（turn 管线全链路以可变 state 传递）。
 */
function applyEndingBoundary(
  state: WorldStateV2,
  lookup: TemplateLookup,
  rng: Rng,
  pipeline: TurnPipelineConfig | undefined,
  signal: TerminationSignal,
): void {
  const cfg = pipeline?.endingConfig;
  if (!cfg || cfg.terminationConditions.length === 0) return;
  if (state.termination !== null) return;
  const ctx: ConditionContext = { state, lookup, rng };
  const outcome = terminateWithEnding(
    state,
    cfg.terminationConditions,
    signal,
    cfg.endings,
    ctx,
    cfg.fallback !== undefined ? { fallbackId: cfg.fallback } : {},
  );
  if (outcome.decision !== null && outcome.state.termination !== null) {
    state.termination = outcome.state.termination;
  }
}

/**
 * 战败死亡路径接线（§9.3）。只在战败边界调用；applyDeathRoute 返回克隆状态，
 * 这里只回写可能变化的四个字段，保持管线的可变 state 语义。
 */
function applyDeathRouteInPlace(
  state: WorldStateV2,
  lookup: TemplateLookup,
  rng: Rng,
  pipeline: TurnPipelineConfig | undefined,
  battleDefeat: boolean,
): void {
  const cfg = pipeline?.endingConfig;
  const route = cfg?.deathRoute;
  if (!cfg || !route || !battleDefeat) return;
  if (state.termination !== null) return;
  const ctx: ConditionContext = { state, lookup, rng };
  const res = applyDeathRoute(
    state,
    route,
    { battleDefeat },
    cfg.endings,
    ctx,
    cfg.fallback !== undefined ? { fallbackId: cfg.fallback } : {},
  );
  if (res.outcome.kind === "none") return;
  // 克隆路径产生的所有事实/索引必须一起回写（recordFire 三处写入口保持一致）
  state.firedEvents = res.state.firedEvents;
  state.lastFiredIndex = res.state.lastFiredIndex;
  state.eventFires = res.state.eventFires;
  state.missedEvents = res.state.missedEvents;
  state.history = res.state.history;
  state.pendingEvents = res.state.pendingEvents;
  state.termination = res.state.termination;
}

/**
 * 共享的「结算后管线」（R-EV-14「事件轮跑完整管线」）：
 * NPC 自主行动 → pool 门控抽取 → drain 延时队列 → 终止/结局边界。
 * advanceTurnV2（自由行动轮）与 chooseOptionV2（事件结算轮）**都走这里**，保证「轮」语义单一。
 * 回复/补正 tick 等模拟域结算只在自由行动轮执行（既有语义，本轮不改）。
 */
function runTurnTail(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  rng: Rng,
  result: TriggerResult,
  pipeline: TurnPipelineConfig | undefined,
  signal: TerminationSignal,
): void {
  const npcResult = runNpcActionsV2(state, lookup, rng);
  if (npcResult.startedChains.length > 0) {
    triggerChainStarts(state, npcResult.startedChains, lookup, rng, result);
  }
  resolvePoolV2(state, template, lookup, rng);
  // drain 入口 3：pool 的无窗口实例（start = now）、效果 enqueueEvent 的已到期实例在此出队。
  // 也不会与步骤 3 的 drain 冲突：非 waiting 条目直接跳过。
  drainDue(state, lookup, rng, result);
  applyEndingBoundary(state, lookup, rng, pipeline, signal);
}

/** 投影 + 评价：评价是唯一事实来源（T4-04），每次投影按当前状态重算。 */
function projectWithConfig(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  pipeline: TurnPipelineConfig | undefined,
): V2Snapshot {
  const evaluation = evaluateLifeV2(state, pipeline?.evaluationConfig);
  return projectSnapshotV2(state, template, lookup, evaluation, pipeline?.endingConfig?.endings);
}

export function advanceTurnV2(
  state: WorldStateV2,
  /** endLife=true 表示玩家主动结束这一生（边界信号 playerRequested） */
  command: { action: { type: string; description?: string }; mode?: "single" | "fast"; endLife?: boolean },
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  ctx?: RunnerContext,
  pipeline?: TurnPipelineConfig,
): V2TurnResult {
  assertActive(state);
  // #34 槽位守卫（收窄语义）：待决事件占住本轮槽位时拒绝提交新的自由行动；
  // 事件结算本身已在 chooseOptionV2 / battleActionV2 里推进过 turnIndex，不再拦「结算」。
  if (state.pendingEvents.length > 0) throw new Error("pending_event_required");
  if (state.battle && !state.battle.over) throw new Error("battle_in_progress");
  // 清理上一场已结束的战斗（结果已回写）
  state.battle = null;
  // 「当轮」语义（D-03）：转盘结果列表在**轮次起点**清空，只保留本轮触发的转盘。
  // 放在全部守卫之后，被拒的指令不会清掉上一轮的可见结果。
  state.lastWheels = [];

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
  // ADR-0010：系统轮次计数不再写进 flags（≡ turnIndex），模板条件改用 time DSL。

  const result: TriggerResult = { triggered: [], wheelResult: null };

  // 1. 玩家行动效果（改变状态；startChain / advanceTo 等副作用标记由路由层按优先级消费）
  const actionCtx: EffectContextV2 = { state, lookup, rng, logs: [] };
  applyEffectsV2(actionCtx, action?.effects);
  pushHistory(state, template, {
    id: `t${state.turnIndex}-p`,
    type: "player_action",
    summary: action ? `${action.label}：${command.action.description || action.description || ""}` : command.action.description || "自由行动",
    visibility: "public",
  });

  // 2. 事件链（chain）——最高优先级，先抢占战斗槽位，保证主线不被随机遭遇挤掉
  triggerChainStarts(state, actionCtx.startedChains, lookup, rng, result);
  advanceNextTurnChains(state, lookup, rng, result);

  // 3. 延时队列 drain（入口 1）——次高；位置不变，保持「链 > 时间触发」优先级。
  //    行动效果的 advanceTo/advanceBy 已在步骤 1 推进 worldTime，此处统一出队，
  //    不再全模板扫描 resolveScheduleV2（T1-04）。
  drainDue(state, lookup, rng, result);

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

  // 8–10. 共享结算后管线（NPC 行动 → pool 门控入队 → drain → 终止边界）。
  //       advanceTurnV2 与 chooseOptionV2 走同一函数，保证「轮」语义单一（R-EV-14）。
  const requested = command.endLife === true;
  runTurnTail(state, template, lookup, rng, result, pipeline, {
    atBoundary: true,
    boundary: requested ? "playerRequested" : "afterTimeAdvance",
    playerRequested: requested,
  });

  const snapshot = projectWithConfig(state, template, lookup, pipeline);
  return {
    state,
    snapshot,
    elapsed,
    triggeredEvents: result.triggered,
    wheelResult: result.wheelResult,
    // 先过滤再截断（R-VS-02 / design §2.3）：hidden 条目不占 20 条窗口
    playerVisibleHistory: playerVisibleHistory(state, 20),
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

// ---------- 玩家选项 ----------

export function chooseOptionV2(
  state: WorldStateV2,
  command: ChooseOptionCommand,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  pipeline?: TurnPipelineConfig,
): V2TurnResult {
  assertActive(state);
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

  // 「当轮」语义（D-03）：事件结算轮起点清空转盘列表（守卫全部通过后才清）
  state.lastWheels = [];
  state.pendingEvents.shift();

  // ---- #34 结算轮：事件结算推进 turnIndex（占槽），并按事件级 timeCost 推进世界时间 ----
  // 触发事实已在 triggerEventV2 内经 recordFire 三处索引一次写齐；结算不是「再次触发」，
  // 故此处不再散写 firedEvents / 追加 eventFires（避免重复事实）。
  // R2.6（ADR-0013）：timeCost 换算经历法适配器（字符串字面量 / year-month 量）。
  const settleAdapter = createTimeAdapter(template);
  const costMinutes = event.trigger.timeCost === undefined ? 0 : specToMinutes(event.trigger.timeCost, settleAdapter);
  state.turnIndex += 1;
  state.worldTime += costMinutes;
  const elapsed: TimeAmount = minutesToAmount(costMinutes);
  if (costMinutes > 0) {
    state.player.age = state.playerAgeAtStart + settleAdapter.elapsedYears(state.worldTime);
  }

  pushHistory(state, template, {
    id: historyId(state, `t${state.turnIndex}-c-${event.id}-${option.id}`),
    type: "event",
    summary: `${event.title}：你选择了「${option.text}」`,
    visibility: "public",
  });

  const result: TriggerResult = { triggered: [], wheelResult: null };
  const optionCtx: EffectContextV2 = { state, lookup, rng, logs: [] };
  applyEffectsV2(optionCtx, option.effects);
  // drain 入口 2/3：效果推进世界时间或 enqueueEvent 入队（相对 0 分钟即已到期）。
  if (optionCtx.timeAdvanced || (optionCtx.enqueued?.length ?? 0) > 0) {
    drainDue(state, lookup, rng, result);
  }
  triggerChainStarts(state, optionCtx.startedChains, lookup, rng, result);
  advanceChainOnSettle(state, event, option.nextEventId, lookup, rng, 0, result);

  // 事件轮跑完整管线（NPC 行动 / pool 门控 / drain / 终止边界），世界不因事件暂停。
  runTurnTail(state, template, lookup, rng, result, pipeline, {
    atBoundary: true,
    boundary: "afterEventSettle",
  });

  const snapshot = projectWithConfig(state, template, lookup, pipeline);
  return {
    state,
    snapshot,
    elapsed,
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
  pipeline?: TurnPipelineConfig,
): V2TurnResult {
  assertActive(state);
  const battle = state.battle;
  if (!battle || battle.over) throw new Error("battle_not_active");
  const rng = createRng(deriveTurnSeed(state.seed + 13, state.turnIndex * 100 + battle.round));

  performBattleAction(state, command, lookup, rng);

  const result: TriggerResult = { triggered: [], wheelResult: null };
  if (battle.over) {
    // #34：战斗结束算一次结算轮（战果占槽），推进 turnIndex；战斗回合内不推进（ADR-0001）。
    // 战果本身即本轮槽位内容，不再额外跑 NPC/pool 尾管线，避免把新事件塞进同一个槽位。
    state.turnIndex += 1;
    // 「当轮」语义（D-03）：结算轮起点清空转盘列表（战斗回合内不动，避免白丢本轮结果）
    state.lastWheels = [];
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
      // drain 入口 2：战斗结果效果推进时间 / enqueueEvent 入队后统一出队。
      if (outcomeCtx.timeAdvanced || (outcomeCtx.enqueued?.length ?? 0) > 0) {
        drainDue(state, lookup, rng, result);
      }
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

    // 战败边界：先走死亡路径（具体），再走终止条件（一般）。
    // 判死只看 battleDefeat 信号，不读取 HP 数值（R-EN-07 / P9）。
    applyDeathRouteInPlace(state, lookup, rng, pipeline, outcome === "defeat");
    applyEndingBoundary(state, lookup, rng, pipeline, {
      atBoundary: true,
      boundary: "afterBattleSettle",
      battleDefeat: outcome === "defeat",
    });
  }

  const snapshot = projectWithConfig(state, template, lookup, pipeline);
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
  pipeline?: TurnPipelineConfig,
): V2TurnResult {
  assertActive(state);
  if (state.battle && !state.battle.over) throw new Error("battle_in_progress");
  const item = lookup.item(command.itemId);
  if (!item) throw new Error("item_not_found");
  if (!item.usableOutsideBattle) throw new Error("item_not_usable");
  if ((state.player.inventory[item.id] ?? 0) <= 0) throw new Error("item_not_owned");

  const rng = createRng(deriveTurnSeed(state.seed + 29, state.turnIndex));
  // 用物品是**轮外操作**（不推进 turnIndex、不占槽位），故不清空 lastWheels：
  // 它属于「本轮已发生的转盘」，本轮尚未结束（D-03「当轮」语义）。
  state.player.inventory[item.id] -= 1;
  if (state.player.inventory[item.id] <= 0) delete state.player.inventory[item.id];
  const logs: string[] = [];
  const result: TriggerResult = { triggered: [], wheelResult: null };
  const itemCtx: EffectContextV2 = { state, lookup, rng, logs };
  applyEffectsV2(itemCtx, item.use);
  // #34：用物品是轮外操作，不推进 turnIndex；但时间推进 / enqueueEvent 仍需在安全边界 drain。
  if (itemCtx.timeAdvanced || (itemCtx.enqueued?.length ?? 0) > 0) {
    drainDue(state, lookup, rng, result);
  }
  triggerChainStarts(state, itemCtx.startedChains, lookup, rng, result);
  pushHistory(state, template, {
    id: `t${state.turnIndex}-i-${item.id}`,
    type: "player_action",
    summary: `使用了「${item.name}」${logs.length > 0 ? `：${logs.join("；")}` : ""}`,
    visibility: "public",
  });

  // 物品效果结算完成 → 终止边界（部分物品会推进时间）
  applyEndingBoundary(state, lookup, rng, pipeline, {
    atBoundary: true,
    boundary: "afterEventSettle",
  });

  const snapshot = projectWithConfig(state, template, lookup, pipeline);
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
