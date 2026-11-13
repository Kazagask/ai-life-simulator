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
  SlotEventView,
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
import { amountToMinutes, birthTimeFromAge, createTimeAdapter, minutesToAmount } from "./time.js";
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
import { createBattle, finishBattle, performBattleAction, resolveCombatRefs } from "./battle.js";
import { nextInstanceId } from "./equipment.js";
import { runNpcActionsV2 } from "./npc.js";
import type { TemplateLookup } from "./lookup.js";
import { projectSnapshotV2 } from "./projection.js";
import { playerVisibleHistory, pushHistory } from "./history.js";
import {
  checkEventPremise,
  enqueueCandidate,
  enqueueScheduled,
  hasFired,
  onCooldown,
  recordFire,
  scanDelayQueue,
  specToMinutes,
  ZERO_SPEC,
} from "./scheduler.js";
import {
  applyDeathRoute,
  assertActive,
  createDefaultEndingConfig,
  terminateWithEnding,
  type TerminationSignal,
} from "./ending.js";

/**
 * 扫描 / 呈现前求值的**独立派生流**盐（ADR-0034 §3-5，沿用 ADR-0024 的 `seed + 37` 先例）。
 * 队列扫描会每轮对同一实例重复求值；若条件里写了 `random`，用主轮流会变成"每轮多扣一次骰"，
 * 污染主轮序列。独立盐 ⇒ 确定性不变、扫描成本不记到主轮账上。
 */
const SCAN_RNG_SALT = 37;

/** `nextTurn` 判定链的最大自旋次数（只防实现 bug 变成死循环；正常路径 1–3 圈）。 */
const MAX_NEXT_TURN_SPINS = 32;

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
  // 历法适配器在建世界期就要用（广播 birthTime 反推 + 下方 schedule 窗口换算），故提前构造。
  // 纯函数、无副作用，位置变化不改变任何行为。
  const initCalendar = createTimeAdapter(template);
  // ADR-0022：配置层刷新规则 → 实例层队列。规则指向的角色在出生前不进世界（unspawned），
  // 由事件效果 spawnNpc 建出。实例只记引用，不复制配置域定义。
  const spawnRuleInstances = (template.npcSpawnRules ?? []).map((rule) => ({
    ruleId: rule.id,
    characterRef: rule.characterRef,
    status: "pending" as const,
    spawnedTurn: 0,
    spawnedWorldTime: 0,
  }));
  const spawnRuleByCharacter = new Map(spawnRuleInstances.map((r) => [r.characterRef, r.ruleId]));
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
        // ADR-0021 决策 4.1：age 降级为「起始年龄快照」，仅供 birthTime 反推兜底与旧档兼容
        age: c.identity.age,
        // 出生分钟由起始年龄按整年回溯（negative 分钟，ADR-0021 决策 4.3 已支持）；
        // 此后「当前年龄」由投影按 ageAt(birthTime, worldTime) 现算，不再回写 age。
        birthTime: birthTimeFromAge(c.identity.age, initCalendar),
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
        // ADR-0022：由刷新规则管辖的角色，世界创建时处于 unspawned（尚未出生/登场）
        ...(spawnRuleByCharacter.has(c.id) ? { spawnRuleId: spawnRuleByCharacter.get(c.id) } : {}),
        // ADR-0012 决策 1 / ADR-0020：缺省在世；模板可在 characters[].lifecycle 声明初始态
        lifecycle: {
          state: spawnRuleByCharacter.has(c.id) ? "unspawned" : (c.lifecycle?.state ?? "alive"),
          ...(c.lifecycle?.reasonCode ? { reasonCode: c.lifecycle.reasonCode } : {}),
          sinceTurn: 0,
          sinceWorldTime: 0,
        },
      })),
    // ADR-0022：规则实例队列 + 空的出生事实（append-only，只由 spawnNpc 追加）
    spawnRules: spawnRuleInstances,
    spawnLog: [],
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
    delayQueue: [],
    enqueueSeqCounter: 0,
    missedEvents: [],
    eventFires: [],
    lastFiredIndex: {},
    slot: null,
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

// ---------- 呈现槽与事件结算（ADR-0034 §2） ----------

/**
 * 一次轮次结算的累加器（引擎内部类型）。
 *
 * **不是**存档 / 投影 / 玩家端 API 的一部分（ADR-0021 决策 1.4 / ADR-0034 §5）：
 * 它只在一次轮次内被填充，随后被裁成 `V2TurnResult`。导出仅为让测试断言诊断位。
 */
export interface TriggerResult {
  triggered: Array<{ id: string; title: string; narrative: string }>;
  wheelResult: WheelResultView | null;
  /** 本条触发被跳过的原因（当前唯一取值见 `SKIP_ALL_ENEMIES_INACTIVE`，非持久化） */
  skipped?: string;
  /**
   * 本轮因**前提失效**被清出槽的事件 id（ADR-0024 决策 4 的可诊断性补偿，非持久化）。
   * 与 `skipped` 分开是刻意的：`skipped` 是单槽，两者写同一个字段会互相覆盖。
   */
  droppedPending?: string[];
}

/** combat 事件的全部敌人过滤后为空 ⇒ 整条触发跳过（取值被测试断言，只写这一处）。 */
export const SKIP_ALL_ENEMIES_INACTIVE = "all_enemies_inactive";

/** 扫描 / 呈现前求值用的独立派生流（ADR-0034 §3-5）：与主轮 RNG 完全分开。 */
function scanStream(state: WorldStateV2): Rng {
  return createRng(deriveTurnSeed(state.seed + SCAN_RNG_SALT, state.turnIndex));
}

/**
 * **呈现前前提复核**（ADR-0034 §3-4：求值固定在真正上桌那一刻）。
 *
 * 与 ADR-0024 的 `revalidatePendingV2` 同一口径，只是作用对象从 `pendingEvents` 换成 `slot`：
 * 前提不成立 ⇒ **静默清槽**（不推 `turnIndex`、不写 history、不记错失、不动 `eventFires`）。
 * 记错失在这里结构上不可能：`MissedEventRecord` 需要 `instanceId`，而槽里只有 `eventId`。
 *
 * RNG 用独立派生流（`scanStream`）：复核会随每次呈现重复求值，不得记账到主轮流。
 */
export function revalidateSlot(state: WorldStateV2, lookup: TemplateLookup): { dropped: string[] } {
  if (state.slot === null) return { dropped: [] };
  const scene = state.slot;
  const def = lookup.event(scene.eventId);
  // 定义缺失：加载期完整性错误 ⇒ 不越权删除语义（与 ADR-0024 一致），但槽不能拿去呈现。
  if (!def) return { dropped: [] };
  const ctx: ConditionContext = { state, lookup, rng: scanStream(state) };
  const premise = checkEventPremise(def, ctx);
  if (premise.ok) return { dropped: [] };

  // ADR-0034 §8-⑪：「失效必须留痕」在槽路径上要尽量写进**持久化**的 missedEvents；
  // 但 `MissedEventRecord` 需要 `instanceId`，只有 `queueTake` 出来的槽有 ⇒
  //   • 有实例 id：写 missedEvents（reason 复用既有枚举：missWhen ⇒ miss_when；条件失效同样按
  //     永久失效处理，因为槽已把事件摘除）；
  //   • 无实例 id（successor/hook/opening/death）：**不造 id**，退化为非持久化 `droppedPending`。
  if (scene.instanceId !== undefined) {
    state.missedEvents.push({
      eventId: def.id,
      instanceId: scene.instanceId,
      turnIndex: state.turnIndex,
      worldTime: state.worldTime,
      reason: "miss_when",
      ...(premise.ok === false && premise.missWhen && premise.label !== undefined ? { label: premise.label } : {}),
    });
  }
  const dropped = [def.id];
  state.slot = null;
  return { dropped };
}

function recordDroppedPending(result: TriggerResult, dropped: string[]): void {
  if (dropped.length === 0) return;
  result.droppedPending = [...(result.droppedPending ?? []), ...dropped];
}

/** 被清出槽的事件里是否有 `command.optionId` 所属的那一个（决定抛哪个错误码，ADR-0024 决策 8）。 */
function droppedEventOwnsOption(dropped: readonly string[], optionId: string, lookup: TemplateLookup): boolean {
  for (const eventId of dropped) {
    const def = lookup.event(eventId);
    if (def?.kind !== "normal") continue;
    if (def.settle.normal.options.some((o) => o.id === optionId)) return true;
  }
  return false;
}

/** 事件的「后继」是否有时间账：声明了 `delay` / `window.start` ⇒ 入队；否则直接占槽。 */
function enqueueSuccessor(state: WorldStateV2, lookup: TemplateLookup, nextEventId: string): boolean {
  const next = lookup.event(nextEventId);
  if (!next) return false; // 悬空 nextEventId：加载期校验会拦，这里保守当"无后继"
  const startSpec = next.trigger.window?.start ?? next.trigger.delay;
  if (startSpec === undefined) return false;
  enqueueScheduled({
    state,
    definitionId: next.id,
    origin: { kind: "effect", id: next.id },
    start: startSpec,
    ...(next.trigger.window?.end !== undefined ? { end: next.trigger.window.end } : {}),
    calendar: createTimeAdapter(lookup.template),
  });
  return true;
}

/** 结算后的「占槽判定」（ADR-0034 §2 步 4）：**唯一**能写 `slot` 的后继路径。 */
function applySuccessor(state: WorldStateV2, lookup: TemplateLookup, settledId: string, nextEventId?: string): void {
  if (nextEventId === undefined) {
    state.slot = null;
    return;
  }
  if (enqueueSuccessor(state, lookup, nextEventId)) {
    state.slot = null; // 有延迟 ⇒ 进队列，不占槽（ADR §10-4）
    return;
  }
  state.slot = { eventId: nextEventId, from: "successor", fromEventId: settledId };
}

/** 链条起点（`startChain` 效果 / NPC 自主行动）⇒ 只入队，绝不直接写 `slot`（ADR-0034 §4 R3）。 */
function enqueueChainStarts(
  state: WorldStateV2,
  lookup: TemplateLookup,
  chainIds: string[] | undefined,
): void {
  if (!chainIds || chainIds.length === 0) return;
  for (const chainId of chainIds) {
    const def = lookup.chain(chainId);
    if (!def) continue;
    enqueueScheduled({
      state,
      definitionId: def.startEventId,
      origin: { kind: "effect", id: chainId },
      start: ZERO_SPEC,
      calendar: createTimeAdapter(lookup.template),
    });
  }
}

/**
 * 结算一个**已在槽中**的事件（ADR-0034 §2 步 3）。
 *
 * 顺序固定：应用效果 → `turnIndex += 1` → `recordFire` → 写历史 → 占槽判定。
 * `turnIndex` 后移到内容落地之后，是 S2「槽内事件未结算前轮次不前进」的落点；
 * `recordFire` 必须在 `turnIndex += 1` **之后**，否则事实日志会记到上一轮。
 */
function settleSlotEvent(input: {
  state: WorldStateV2;
  template: WorldTemplateV2;
  lookup: TemplateLookup;
  result: TriggerResult;
  def: EventV2;
  applyEffects: () => void;
  choiceText?: string;
  optionId?: string;
  nextEventId?: string;
}): void {
  const { state, template, lookup, result, def } = input;
  input.applyEffects();
  state.turnIndex += 1;
  recordFire(state, def.id);
  result.triggered.push({ id: def.id, title: def.title, narrative: def.narrative });
  pushHistory(state, template, {
    id: historyId(state, `t${state.turnIndex}-e-${def.id}`),
    type: "event",
    summary: `${def.title}：${def.narrative}`,
    visibility: "public",
  });
  if (input.choiceText !== undefined) {
    pushHistory(state, template, {
      id: historyId(state, `t${state.turnIndex}-c-${def.id}-${input.optionId ?? ""}`),
      type: "event",
      summary: `${def.title}：你选择了「${input.choiceText}」`,
      visibility: "public",
    });
  }
  applySuccessor(state, lookup, def.id, input.nextEventId);
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
 * **呈现**槽内的 `random`（转盘）事件：只掷骰、只记录呈现结果，**不结算**。
 *
 * 为什么不呈现即结算：ADR-0034 §2 步 2 把「转盘确认」列为**输入**，步 3 才是结算。
 * 若呈现即结算，一次调用会连续结算「上一事件 + 转盘」两个事件 ⇒ 直接违反 S1（一轮只结算一个）
 * 与 G1-3（净 `turnIndex` 增量 = 1）。
 *
 * 掷骰用**扫描派生流**（`scanStream`）而不是主轮流：呈现可能被重复调用（刷新/重取快照），
 * 用主轮流会把"看一次"变成"多扣一次骰"。同一 `(seed, turnIndex, state)` 必然得到同一格。
 * 结果写进 `lastWheel(s)`（本轮呈现记录，本来就是呈现态的载体），确认时按同一 label 找回。
 */
function presentRandomSlot(
  state: WorldStateV2,
  lookup: TemplateLookup,
  result: TriggerResult,
  def: EventV2,
): void {
  if (def.kind !== "random") return;
  const existing = (state.lastWheels ?? []).find((w) => w.eventId === def.id);
  if (existing !== undefined) {
    result.wheelResult = existing; // 重复呈现：复用已掷出的那一格（幂等）
    state.lastWheel = existing;
    return;
  }
  const wheel = def.settle.random.wheel;
  const eff = playerEffectiveAttributes(state, lookup);
  const weights = wheel.segments.map((seg) => {
    let w = seg.weight;
    for (const [attr, coef] of Object.entries(seg.weightBy ?? {})) w += (eff[attr] ?? 0) * coef;
    return Math.max(0, w);
  });
  const idx = pickIndex(weights, scanStream(state));
  const seg = wheel.segments[idx];
  const view: WheelResultView = {
    eventId: def.id,
    title: def.title,
    label: seg.label,
    segments: wheel.segments.map((s) => ({ label: s.label, weight: Math.max(0, s.weight) })),
  };
  result.wheelResult = view;
  state.lastWheel = view;
  (state.lastWheels ??= []).push(view);
}

/** 槽内 `random` 的**确认结算**（`advanceTurnV2` 在 random 槽上即"转盘确认"输入）。 */
function settleRandomSlot(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  rng: Rng,
  result: TriggerResult,
  def: EventV2,
): void {
  if (def.kind !== "random") return;
  const wheel = def.settle.random.wheel;
  // 呈现在**上一个**轮次（`presentRandomSlot` 写 `lastWheel(s)`）；确认这一轮必须**按呈现的那一格**结算：
  // 先查本轮呈现集，再退回单槽 `lastWheel`（单槽在 `presentRandomSlot` 写入且不被轮次起点清空）。
  const shown =
    (state.lastWheels ?? []).find((w) => w.eventId === def.id) ??
    (state.lastWheel !== null && state.lastWheel.eventId === def.id ? state.lastWheel : undefined);
  // **不得静默兜底**（团队裁决）：找不回"呈现的那一格"说明呈现/确认链路断了，
  // 悄悄取 `segments[0]` 会让玩家看到的与结算的永久错位，且测试看不出来。
  if (shown === undefined) {
    throw new Error(`wheel_confirm_without_presentation: ${def.id}（槽来源 ${state.slot?.from ?? "?"}）没有已呈现的扇区`);
  }
  const seg = wheel.segments.find((s) => s.label === shown.label);
  if (seg === undefined) {
    throw new Error(`wheel_segment_missing: ${def.id} 呈现的「${shown.label}」在模板 segments 里找不到`);
  }
  // 回填：确认这一轮的响应仍要能展示"这一格是什么"
  result.wheelResult = shown;
  if (!(state.lastWheels ?? []).some((w) => w.eventId === def.id)) {
    (state.lastWheels ??= []).push(shown);
  }
  settleSlotEvent({
    state,
    template,
    lookup,
    result,
    def,
    applyEffects: () => {
      const segCtx: EffectContextV2 = { state, lookup, rng, logs: [] };
      applyEffectsV2(segCtx, seg.effects);
      enqueueChainStarts(state, lookup, segCtx.startedChains);
    },
    ...(seg.nextEventId !== undefined ? { nextEventId: seg.nextEventId } : {}),
  });
}

/** pool 抽取阈值（ADR-0034 §3-6 / §10）：只决定"摇不摇"，不决定"占不占槽"。 */
function poolDrawConfig(template: WorldTemplateV2): { skipWhenSlotOccupied: boolean; maxQueueLength: number } {
  const cfg = template.eventFlow?.poolDraw;
  return {
    skipWhenSlotOccupied: cfg?.skipWhenSlotOccupied ?? true,
    maxQueueLength: cfg?.maxQueueLength ?? 3,
  };
}

/**
 * pool = 抽取器（R-EV-08/13）。**只写 `delayQueue`、没有写 `slot` 的权限**（ADR-0034 §10）：
 * 与「取队列实例 → 写 slot」是两个不同函数，结构上保证"摇出事件"这个判断不占槽。
 * 阈值 = `slot !== null`（可按配置关掉）或 `delayQueue.length >= N` ⇒ 本轮不摇。
 */
function resolvePoolV2(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  rng: Rng,
): void {
  const draw = poolDrawConfig(template);
  if (draw.skipWhenSlotOccupied && state.slot !== null) return;
  const queued = state.delayQueue.filter((i) => i.status === "waiting").length;
  if (queued >= draw.maxQueueLength) return;

  const ctx: ConditionContext = { state, lookup, rng };
  const calendar = createTimeAdapter(template);
  const pool = template.events
    .filter((e) => e.trigger.source === "pool")
    .filter((e) => e.kind !== "combat") // 加载期已拒，抽取期防御
    .filter((e) => !(e.trigger.once && hasFired(state, e.id)))
    .filter((e) => !onCooldown(state, e.id, e.trigger.cooldown, calendar))
    .filter((e) => checkAllConditions(e.trigger.conditions, ctx))
    .sort((a, b) => (b.trigger.priority ?? 0) - (a.trigger.priority ?? 0));

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
 * action-hook（行动触发）：声明了 `window` / `delay` ⇒ 入队；否则**写 `hook` 槽**。
 * 槽已被占（例如同轮第一个钩子已占）⇒ 改造入队，绝不覆盖（`slot` 是标量，覆盖即丢事件）。
 */
function resolveHooksV2(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  rng: Rng,
  actionId: string,
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
    } else if (state.slot === null) {
      state.slot = { eventId: event.id, from: "hook" };
    } else {
      // 槽已被同轮其它钩子占用 ⇒ 入队等下一轮（不覆盖、不丢弃）
      enqueueScheduled({
        state,
        definitionId: event.id,
        origin: { kind: "effect", id: actionId },
        start: ZERO_SPEC,
        calendar,
      });
    }
  }
}

/**
 * 结算后的「其他判定」（ADR-0034 §2 步 5，顺序固定：NPC 自主行动 → pool 摇一个）。
 * `missWhen` 的处置在队列扫描里（`scanDelayQueue`），不在这里。
 */
function postSettleJudgements(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  rng: Rng,
): void {
  const npcResult = runNpcActionsV2(state, lookup, rng);
  enqueueChainStarts(state, lookup, npcResult.startedChains);
  resolvePoolV2(state, template, lookup, rng);
}

/**
 * **`nextTurn` 判定链**（ADR-0034 §2，全模型唯一的推进入口）。
 *
 * ```
 * 槽有 ⇒ 只处理它；random **只呈现不结算**（等 `/turns` 的转盘确认）；combat 建战斗后等战斗命令；normal 等选择
 * 槽空 ⇒ 扫队列，取出即写 slot（from: "queueTake"）再处理
 * 都没有 ⇒ 返回（空槽 = 可自由行动）
 * ```
 *
 * 自旋上限 `MAX_NEXT_TURN_SPINS` 只防实现 bug；正常路径 1–3 圈。
 */
function nextTurn(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  rng: Rng,
  result: TriggerResult,
): void {
  for (let spin = 0; spin < MAX_NEXT_TURN_SPINS; spin += 1) {
    if (state.slot !== null) {
      const def = lookup.event(state.slot.eventId);
      if (!def) {
        state.slot = null; // 加载期完整性错误：清槽，不臆造错失
        continue;
      }
      // 呈现前前提复核（§3-4）：失效即静默清槽，然后继续判定（可能还有排队事件）
      const { dropped } = revalidateSlot(state, lookup);
      if (dropped.length > 0) {
        recordDroppedPending(result, dropped);
        continue;
      }
      if (def.kind === "random") {
        presentRandomSlot(state, lookup, result, def);
        return; // 停在呈现，等「转盘确认」（ADR-0034 §2 步 2）
      }
      if (def.kind === "combat") {
        if (state.battle === null || state.battle.over) {
          if (resolveCombatRefs(def.settle.combat, state, lookup).enemiesExhausted) {
            // ADR-0021 决策 1.2：敌人全部确知非在世 ⇒ 战斗不成立，整条跳过（不记火、不写历史）
            result.skipped = SKIP_ALL_ENEMIES_INACTIVE;
            state.slot = null;
            continue;
          }
          state.battle = createBattle(def.id, def.settle.combat, state, lookup);
          state.battle.log.push(def.narrative);
        }
        return; // 战斗命令由 battleActionV2 接
      }
      return; // normal：等玩家选择
    }

    const scanned = scanDelayQueue(state, lookup, scanStream(state), createTimeAdapter(template));
    if (scanned.kind === "taken") {
      // ADR-0034 §8-⑪：**只有**队列取出这条路带实例 id（其余四个来源没有队列实例，不得造 id）
      state.slot = {
        eventId: scanned.definition.id,
        from: "queueTake",
        instanceId: scanned.instance.instanceId,
      };
      continue;
    }
    return; // 空槽
  }
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

/** 任何返回给玩家的 `snapshot` 之前复核一次槽前提（ADR-0034 §3-4），保证响应里没有幽灵场景。 */
function revalidateThenProject(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  pipeline: TurnPipelineConfig | undefined,
  result: TriggerResult,
): V2Snapshot {
  recordDroppedPending(result, revalidateSlot(state, lookup).dropped);
  return projectWithConfig(state, template, lookup, pipeline);
}

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
  state.slot = res.state.slot;
  state.termination = res.state.termination;
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
  // ADR-0024 决策 2.5 的**排空通道**必须排在门禁之前：槽内事件前提已假 ⇒ 先静默清槽，
  // 否则 `pending_event_required` 会把玩家永久挡在自由行动之外（前端看到 `slotEvent === null`
  // 却提交不了任何行动 = 硬死锁）。
  const droppedAtEntry = revalidateSlot(state, lookup).dropped;
  // 槽被占 ⇒ 必须先处理槽内事件（ADR-0034 §5：`pending_event_required` 语义重述，不新增错误码）。
  // 例外：槽内是 `random` ⇒ 本次调用即**「转盘确认」**（ADR-0034 §2 步 2 明确把"转盘确认"列为输入，
  // 而服务端没有也不该新增专用路由）。此时不消耗行动、不推时间，只把已呈现的那一格结算掉。
  const confirmingWheel =
    state.slot !== null && lookup.event(state.slot.eventId)?.kind === "random";
  if (state.slot !== null && !confirmingWheel) throw new Error("pending_event_required");
  if (state.battle !== null && !state.battle.over) throw new Error("battle_in_progress");
  // 清理上一场已结束的战斗（战斗是槽的内部过程，会话不该跨轮残留）
  state.battle = null;

  const rng = ctx?.rng ?? createRng(deriveTurnSeed(state.seed, state.turnIndex + 1));
  const adapter = createTimeAdapter(template);
  const action = lookup.action(command.action.type);
  const lifeStage = adapter.resolveLifeStage(state.player.age);

  // ---- 0. 转盘确认：槽内是 random ⇒ 结算它，然后照常走"其他判定 → nextTurn" ----
  if (confirmingWheel) {
    const wheelEvent = lookup.event(state.slot!.eventId)!;
    const wheelResult: TriggerResult = {
      triggered: [],
      wheelResult: null,
      ...(droppedAtEntry.length > 0 ? { droppedPending: [...droppedAtEntry] } : {}),
    };
    settleRandomSlot(state, template, lookup, rng, wheelResult, wheelEvent);
    postSettleJudgements(state, template, lookup, rng);
    nextTurn(state, template, lookup, rng, wheelResult);
    applyEndingBoundary(state, lookup, rng, pipeline, {
      atBoundary: true,
      boundary: "afterEventSettle",
    });
    const wheelSnapshot = revalidateThenProject(state, template, lookup, pipeline, wheelResult);
    return {
      state,
      snapshot: wheelSnapshot,
      elapsed: { value: 0, unit: "minute" },
      triggeredEvents: wheelResult.triggered,
      wheelResult: wheelResult.wheelResult,
      playerVisibleHistory: [],
    };
  }
  // 本轮呈现集在**轮次起点**清空（D-03）：被拒的指令不会清掉上一轮的可见结果。
  // ⚠ 必须放在「转盘确认」分支**之后**：确认本身就是一轮，它要读的是**上一轮呈现、
  // 本轮确认**的那一格；提前清空会让确认拿不到自己演的是哪一段（确定性取 segments[0]）。
  state.lastWheels = [];

  // ---- 1. 时间账（自由行动的时间在行动本身，不在轮次） ----
  let elapsed: TimeAmount;
  if (action?.advanceTo) {
    const delta = Math.max(0, amountToMinutes(action.advanceTo) - state.worldTime);
    state.worldTime += delta;
    elapsed = minutesToAmount(delta);
  } else {
    elapsed = adapter.resolveStep(lifeStage, action?.duration);
    state.worldTime += amountToMinutes(elapsed);
  }
  state.player.age = state.playerAgeAtStart + adapter.elapsedYears(state.worldTime);

  const result: TriggerResult = {
    triggered: [],
    wheelResult: null,
    ...(droppedAtEntry.length > 0 ? { droppedPending: [...droppedAtEntry] } : {}),
  };

  // ---- 2. 行动效果（`startChain` 只入队，绝不直接占槽） ----
  const actionCtx: EffectContextV2 = { state, lookup, rng, logs: [] };
  applyEffectsV2(actionCtx, action?.effects);
  enqueueChainStarts(state, lookup, actionCtx.startedChains);

  // ---- 3. 结算：轮次推进在内容落地之后（ADR-0034 §2 步 3 / §4 S2） ----
  state.turnIndex += 1;
  pushHistory(state, template, {
    id: `t${state.turnIndex}-p`,
    type: "player_action",
    summary: action ? `${action.label}：${command.action.description || action.description || ""}` : command.action.description || "自由行动",
    visibility: "public",
  });

  // ---- 4. 占槽判定：行动钩子可产生 `hook` 槽（唯一能写 slot 的自由行动路径） ----
  resolveHooksV2(state, template, lookup, rng, command.action.type);

  // ---- 5. 模拟域结算（只在自由行动轮执行） ----
  const bonus = template.regen.actions?.[command.action.type];
  const hpRegen = template.regen.perTurn.hp + (bonus?.hp ?? 0);
  const mpRegen = template.regen.perTurn.mp + (bonus?.mp ?? 0);
  state.player.hp = Math.min(maxHp(state.player, template), state.player.hp + hpRegen);
  state.player.mp = Math.min(maxMp(state.player, template), state.player.mp + mpRegen);
  tickSimulationStatuses(state, lookup, command.action.type === "rest");
  state.player.mood = Math.max(template.mood.min, Math.min(template.mood.max, state.player.mood));

  // ---- 6. 其他判定：NPC 自主行动 → pool（pool 只入队；槽已被占时天然跳过） ----
  postSettleJudgements(state, template, lookup, rng);

  // ---- 7. nextTurn：槽有则呈现、槽空则扫队列 ----
  nextTurn(state, template, lookup, rng, result);

  // ---- 8. 终止边界 ----
  const requested = command.endLife === true;
  applyEndingBoundary(state, lookup, rng, pipeline, {
    atBoundary: true,
    boundary: requested ? "playerRequested" : "afterTimeAdvance",
    playerRequested: requested,
  });

  const snapshot = revalidateThenProject(state, template, lookup, pipeline, result);
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
  // ADR-0024 决策 2.3 #2（权威门）：即便状态被外部改坏 / 旧档残留，也绝不允许结算前提已假的事件。
  const droppedAtEntry = revalidateSlot(state, lookup).dropped;
  if (droppedEventOwnsOption(droppedAtEntry, command.optionId, lookup)) {
    // 决策 8：与 option_not_available 分开 —— 客户端据此提示「状态已过期，请重取快照」。
    throw new Error("event_premise_invalidated");
  }
  if (state.battle !== null && !state.battle.over) throw new Error("battle_in_progress");
  const scene = state.slot;
  if (scene === null) throw new Error("no_pending_event");
  const event = lookup.event(scene.eventId);
  if (!event || event.kind !== "normal") throw new Error("event_not_normal");

  const rng = createRng(deriveTurnSeed(state.seed + 7, state.turnIndex));
  const ctx: ConditionContext = { state, lookup, rng };
  const option = event.settle.normal.options.find(
    (o) => o.id === command.optionId && checkAllConditions(o.visibleWhen, ctx),
  );
  if (!option) throw new Error("option_not_available");

  // 「本轮呈现集」在轮次起点清空（D-03）：守卫全部通过后才清
  state.lastWheels = [];

  // 事件级时间账（`timeCost`，缺省 0）：结算轮可以推进 turnIndex 而世界时间不动
  const settleAdapter = createTimeAdapter(template);
  const costMinutes = event.trigger.timeCost === undefined ? 0 : specToMinutes(event.trigger.timeCost, settleAdapter);
  if (costMinutes > 0) {
    state.worldTime += costMinutes;
    state.player.age = state.playerAgeAtStart + settleAdapter.elapsedYears(state.worldTime);
  }

  const result: TriggerResult = {
    triggered: [],
    wheelResult: null,
    ...(droppedAtEntry.length > 0 ? { droppedPending: [...droppedAtEntry] } : {}),
  };

  settleSlotEvent({
    state,
    template,
    lookup,
    result,
    def: event,
    applyEffects: () => {
      const optionCtx: EffectContextV2 = { state, lookup, rng, logs: [] };
      applyEffectsV2(optionCtx, option.effects);
      // B-36 接线：选项结算的 `log` 旁白此前被收集后丢弃（29 处模板文本从未展示给玩家）。
      // 与 `useItemV2` 同口径：拼进本次结算的历史摘要。
      if (optionCtx.logs !== undefined && optionCtx.logs.length > 0) {
        pushHistory(state, template, {
          id: historyId(state, `t${state.turnIndex}-l-${event.id}`),
          type: "event",
          summary: optionCtx.logs.join("；"),
          visibility: "public",
        });
      }
      enqueueChainStarts(state, lookup, optionCtx.startedChains);
    },
    choiceText: option.text,
    optionId: option.id,
    ...(option.nextEventId !== undefined ? { nextEventId: option.nextEventId } : {}),
  });

  postSettleJudgements(state, template, lookup, rng);
  nextTurn(state, template, lookup, rng, result);

  const snapshot = revalidateThenProject(state, template, lookup, pipeline, result);
  return {
    state,
    snapshot,
    elapsed: minutesToAmount(costMinutes),
    triggeredEvents: result.triggered,
    wheelResult: result.wheelResult,
    playerVisibleHistory: [],
  };
}

// ---------- 战斗行动 ----------

/**
 * 战斗命令（ADR-0034 §8-⑦）：**整场战斗是 `slot` 的内部过程，不额外推进轮次**。
 * 战斗结束即该事件"结算完成"，此后才做占槽判定与其他判定。
 */
export function battleActionV2(
  state: WorldStateV2,
  command: BattleCommand,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  pipeline?: TurnPipelineConfig,
): V2TurnResult {
  assertActive(state);
  const droppedAtEntry = revalidateSlot(state, lookup).dropped;
  const battle = state.battle;
  if (!battle || battle.over) throw new Error("battle_not_active");
  const rng = createRng(deriveTurnSeed(state.seed + 13, state.turnIndex * 100 + battle.round));

  performBattleAction(state, command, lookup, rng);

  const result: TriggerResult = {
    triggered: [],
    wheelResult: null,
    ...(droppedAtEntry.length > 0 ? { droppedPending: [...droppedAtEntry] } : {}),
  };

  if (battle.over) {
    const event = lookup.event(battle.eventId);
    const outcome = battle.over;
    const outcomeLabel = outcome === "victory" ? "胜利" : outcome === "defeat" ? "败北" : "撤离";
    state.lastWheels = [];
    if (event && event.kind === "combat") {
      const settle = event.settle.combat;
      const outcomeDef =
        outcome === "victory" ? settle.onVictory : outcome === "defeat" ? settle.onDefeat : settle.onFlee;
      // 先回写战斗镜像（补正转换/资源），再结算结果效果，避免镜像覆写结果补正
      finishBattle(state, lookup);
      // 战斗结束立即清会话：它是槽的内部过程，清得比任何触发都早 ⇒ 不会误伤后继 combat 事件
      state.battle = null;
      settleSlotEvent({
        state,
        template,
        lookup,
        result,
        def: event,
        applyEffects: () => {
          const outcomeCtx: EffectContextV2 = { state, lookup, rng, logs: [] };
          applyEffectsV2(outcomeCtx, outcomeDef?.effects);
          enqueueChainStarts(state, lookup, outcomeCtx.startedChains);
        },
        ...(outcomeDef?.nextEventId !== undefined ? { nextEventId: outcomeDef.nextEventId } : {}),
      });
    } else {
      // 定义缺失兜底：战斗会话照样结束，槽清空并推进一轮（否则玩家永久卡在战斗门禁上）
      finishBattle(state, lookup);
      state.battle = null;
      state.slot = null;
      state.turnIndex += 1;
    }
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

    postSettleJudgements(state, template, lookup, rng);
    nextTurn(state, template, lookup, rng, result);

    // 战败边界：先走死亡路径（具体），再走终止条件（一般）。
    // 判死只看 battleDefeat 信号，不读取 HP 数值（R-EN-07 / P9）。
    applyDeathRouteInPlace(state, lookup, rng, pipeline, outcome === "defeat");
    applyEndingBoundary(state, lookup, rng, pipeline, {
      atBoundary: true,
      boundary: "afterBattleSettle",
      battleDefeat: outcome === "defeat",
    });
  }

  const snapshot = revalidateThenProject(state, template, lookup, pipeline, result);
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
  // ADR-0034 §5：用物品**不受槽占用限制**（用户原话「不占槽、独立于轮次结算」）。
  // 战斗进行中仍然拒绝：物品的 `usableOutsideBattle` 语义没有变。
  if (state.battle !== null && !state.battle.over) throw new Error("battle_in_progress");
  const item = lookup.item(command.itemId);
  if (!item) throw new Error("item_not_found");
  if (!item.usableOutsideBattle) throw new Error("item_not_usable");
  if ((state.player.inventory[item.id] ?? 0) <= 0) throw new Error("item_not_owned");

  const rng = createRng(deriveTurnSeed(state.seed + 29, state.turnIndex));
  // 用物品是**轮外操作**（不推进 turnIndex、不占槽），故不清空 lastWheels：
  // 它属于「本轮已发生的转盘」，本轮尚未结束（D-03「当轮」语义）。
  state.player.inventory[item.id] -= 1;
  if (state.player.inventory[item.id] <= 0) delete state.player.inventory[item.id];
  const logs: string[] = [];
  const result: TriggerResult = { triggered: [], wheelResult: null };
  const itemCtx: EffectContextV2 = { state, lookup, rng, logs };
  applyEffectsV2(itemCtx, item.use);
  // ADR-0034 §2 R1：轮外入口**不跑 nextTurn**（不扫队列、不呈现新事件）。
  // `enqueueEvent` 产生的实例留在 `delayQueue`，等下一次「推进轮次的入口」才可能被取出。
  enqueueChainStarts(state, lookup, itemCtx.startedChains);
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

  const snapshot = revalidateThenProject(state, template, lookup, pipeline, result);
  return {
    state,
    snapshot,
    elapsed: { value: 0, unit: "minute" },
    triggeredEvents: result.triggered,
    wheelResult: result.wheelResult,
    playerVisibleHistory: [],
  };
}

// ---------- 呈现槽视图（选项按 visibleWhen 过滤） ----------

/**
 * 槽的呈现视图（ADR-0034 §5 / §8-⑩）：**效果未应用、`turnIndex` 不变**。
 *
 * `kind` 是前端的**行为开关**：`normal` 呈现选项、`random` 呈现已掷出的那一格并等待"确认"、
 * `combat` 走战斗面板。空槽返回 `null`。
 */
export function slotEventView(state: WorldStateV2, lookup: TemplateLookup): SlotEventView | null {
  const scene = state.slot;
  if (scene === null) return null;
  const event = lookup.event(scene.eventId);
  if (!event) return null;
  // ADR-0024 决策 2.3 #6（只读防御）：前提已假 ⇒ 不呈现（正常流程已在呈现前复核过）。
  const premiseRng = scanStream(state);
  if (!checkEventPremise(event, { state, lookup, rng: premiseRng }).ok) return null;

  if (event.kind === "normal") {
    const rng = createRng(deriveTurnSeed(state.seed + 7, state.turnIndex));
    const ctx: ConditionContext = { state, lookup, rng };
    return {
      eventId: event.id,
      from: scene.from,
      kind: "normal",
      title: event.title,
      narrative: event.narrative,
      options: event.settle.normal.options
        .filter((o) => checkAllConditions(o.visibleWhen, ctx))
        .map((o) => ({ id: o.id, text: o.text })),
    };
  }
  if (event.kind === "random") {
    // 呈现时已掷出（`presentRandomSlot` 写入 `lastWheels`）；这里只读出来给前端演。
    const shown = (state.lastWheels ?? []).find((w) => w.eventId === event.id);
    return {
      eventId: event.id,
      from: scene.from,
      kind: "random",
      title: event.title,
      narrative: event.narrative,
      ...(shown !== undefined ? { wheel: shown } : {}),
    };
  }
  return { eventId: event.id, from: scene.from, kind: "combat", title: event.title, narrative: event.narrative };
}

/**
 * @deprecated 旧前端过渡包装：只保留 `normal` 子集（= `slotEvent` 去掉 kind/from/wheel）。
 * 前端切换完成后连同 `V2Snapshot.pendingEvent` 一起删除。
 */
export function pendingEventView(state: WorldStateV2, lookup: TemplateLookup): PendingEventView | null {
  const view = slotEventView(state, lookup);
  if (view === null || view.kind !== "normal") return null;
  return {
    eventId: view.eventId,
    title: view.title,
    narrative: view.narrative,
    options: view.options ?? [],
  };
}
