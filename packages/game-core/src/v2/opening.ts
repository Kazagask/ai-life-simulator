import type {
  ChainStateV2,
  EventInstance,
  OpeningEventPool,
  OpeningPoolEvent,
  OpeningRun,
  OpeningSetup,
  OpeningTemplate,
  WorldStateV2,
} from "@life-sim/shared";
import { createRng, pickWeighted, type Rng } from "../rng.js";
import type { RunnerContext } from "./runner-context.js";
import type { TemplateLookup } from "./lookup.js";
import { applyEffectsV2, checkAllConditions, type ConditionContext } from "./engine.js";
import { createTimeAdapter } from "./time.js";
import { enqueueScheduled, resolveTimeSpec } from "./scheduler.js";

/**
 * 阶段 3 · Opening 开局（design §4 / §6、R-OP-*）。
 * 纯函数 + 注入 RunnerContext；不新建事件栈调度器、不新增 source 枚举。
 * 条件 / 效果只走既有声明式 DSL（checkAllConditions / applyEffectsV2）。
 * R2.5：handoff 的 schedule 事件改为真正入延时队列（state.scheduledEvents），
 * 不再写开局排程标记 flags 占位；实例沿用统一的 ScheduledEventInstance。
 */

/** runOpening 的上下文：RunnerContext + 模板查找器（既有条件 DSL 求值需要）。 */
export interface OpeningRunnerContext extends RunnerContext {
  lookup: TemplateLookup;
}

/** drawOpeningEvents 的上下文：条件求值所需的世界状态 / 查找器 + 注入的 ID 与开局 id。 */
export interface OpeningDrawContext {
  state: WorldStateV2;
  lookup: TemplateLookup;
  idFactory: (prefix: string) => string;
  openingId: string;
}

/**
 * T3-02 事件池抽取。支持 tags / weight / conditions / required / countRange /
 * exclusiveGroup / sequence / seed；effects 与 nextEvents 由 runOpening 按 definitionId
 * 回查定义执行。抽取只走既有声明式条件 DSL 与注入 seed 的 RNG，不接受自由表达式。
 */
export function drawOpeningEvents(
  pool: OpeningEventPool,
  rng: Rng,
  ctx: OpeningDrawContext,
): EventInstance[] {
  // seed：声明了 pool.seed 时派生独立 RNG，保证同 seed 可复现且与外部 rng 流隔离；
  // 未声明时沿用注入的 RNG（由 RunnerContext 的世界 seed 派生）。
  const drawRng: Rng = pool.seed !== undefined ? createRng(pool.seed) : rng;
  const conditionCtx: ConditionContext = { state: ctx.state, lookup: ctx.lookup, rng: drawRng };

  // 1) tags 过滤 + 既有声明式条件 DSL（§12）
  const activeTags = pool.tags ?? [];
  const eligible = pool.events.filter((ev) => {
    const evTags = ev.tags ?? [];
    if (activeTags.length > 0 && evTags.length > 0 && !evTags.some((t) => activeTags.includes(t))) {
      return false;
    }
    return checkAllConditions(ev.conditions, conditionCtx);
  });

  const usedGroups = new Set<string>();
  const selected: OpeningPoolEvent[] = [];

  // 2) required 必出；同 exclusiveGroup 至多命中一个。
  const required = eligible
    .filter((e) => e.required === true)
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  for (const ev of required) {
    const group = ev.exclusiveGroup;
    if (group !== undefined) {
      if (usedGroups.has(group)) continue;
      usedGroups.add(group);
    }
    selected.push(ev);
  }

  // 3) 其余按 weight 加权补齐到 countRange 内的确定性目标数。
  const optional = eligible
    .filter((e) => e.required !== true)
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  let weightedPool = optional.filter(
    (e) => e.exclusiveGroup === undefined || !usedGroups.has(e.exclusiveGroup),
  );

  const [lo, hi] = pool.countRange ?? [0, eligible.length];
  const base = Math.min(hi, Math.max(lo, selected.length));
  const extra = hi > base ? Math.floor(drawRng() * (hi - base + 1)) : 0;
  const target = base + extra;

  while (selected.length < target && weightedPool.length > 0) {
    const chosen = pickWeighted(weightedPool, (e) => e.weight ?? 1, drawRng);
    if (!chosen) break;
    selected.push(chosen);
    const group = chosen.exclusiveGroup;
    if (group !== undefined) {
      usedGroups.add(group);
      weightedPool = weightedPool.filter((e) => e.exclusiveGroup !== group);
    } else {
      weightedPool = weightedPool.filter((e) => e !== chosen);
    }
  }

  // 4) sequence 决定输出顺序；产出实例级元数据（origin 为 opening + openingId）。
  selected.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  return selected.map((ev): EventInstance => ({
    instanceId: ctx.idFactory("evi"),
    definitionId: ev.id,
    origin: { kind: "opening", id: ctx.openingId },
    status: "pending",
    visibility: "known",
  }));
}

function applySetup(
  state: WorldStateV2,
  setup: OpeningSetup,
  lookup: TemplateLookup,
  rng: Rng,
): void {
  if (setup.flags) {
    for (const [key, value] of Object.entries(setup.flags)) {
      state.flags[key] = value;
    }
  }
  if (setup.effects) {
    applyEffectsV2({ state, lookup, rng, logs: [] }, setup.effects);
  }
}

/**
 * T3-03 初始化编排 + T3-04 事件接入。纯函数：返回新状态与 OpeningRun，不改入参。
 * 角色 / NPC / 关系 / 信息权限 / 目标 / 装备全部来自模板，经既有声明式效果 DSL 落地；
 * 关系必须带 source；未声明关系的 NPC 置 unknown 且不建立关系条目。
 */
export function runOpening(
  state: WorldStateV2,
  tpl: OpeningTemplate,
  ctx: OpeningRunnerContext,
): { state: WorldStateV2; run: OpeningRun } {
  const next = structuredClone(state);
  const { rng, lookup, idFactory } = ctx;

  applySetup(next, tpl.characterSetup, lookup, rng);
  applySetup(next, tpl.worldSetup, lookup, rng);
  applySetup(next, tpl.objectives, lookup, rng);
  applySetup(next, tpl.choices, lookup, rng);

  // 关系：默认所有 NPC 为 unknown 且无关系条目；仅模板声明者建立带 source 的关系。
  for (const npc of next.npcs) {
    next.flags[`infoVisibility:${npc.id}`] = "unknown";
  }
  for (const [npcId, level] of Object.entries(tpl.npcSetup.visibility ?? {})) {
    next.flags[`infoVisibility:${npcId}`] = level;
  }
  for (const rel of tpl.npcSetup.relations ?? []) {
    const npc = next.npcs.find((n) => n.id === rel.npcId);
    if (!npc) continue;
    npc.relationship = rel.value;
    next.flags[`relationSource:${rel.npcId}`] = rel.source;
    next.flags[`infoVisibility:${rel.npcId}`] = "known";
  }

  // 事件池抽取 + effects / nextEvents 执行（按 definitionId 回查定义，实例不复制定义）。
  const instances: EventInstance[] = [];
  const pendingEventIds: string[] = [];
  for (const pool of tpl.eventPools) {
    const drawn = drawOpeningEvents(pool, rng, {
      state: next,
      lookup,
      idFactory,
      openingId: tpl.openingId,
    });
    instances.push(...drawn);
    for (const inst of drawn) {
      const def = pool.events.find((e) => e.id === inst.definitionId);
      if (!def) continue;
      if (def.effects) applyEffectsV2({ state: next, lookup, rng, logs: [] }, def.effects);
      if (def.nextEvents) pendingEventIds.push(...def.nextEvents);
    }
  }
  pendingEventIds.push(...tpl.handoff.pendingEvents);

  // 即时未完成事件：解析其归属的事件链（连续事件接现有 chains）。
  const seen = new Set<string>();
  const pendingEvents = pendingEventIds
    .filter((id) => (seen.has(id) ? false : (seen.add(id), true)))
    .map((eventId) => {
      const chainId = lookup.template.chains?.find((c) => c.steps.some((s) => s.eventId === eventId))?.id;
      return chainId ? { eventId, chainId } : { eventId };
    });

  // 未来/条件事件：引用既有 source: schedule 定义，生成带 origin 的实例。
  for (const s of tpl.handoff.schedule) {
    const inst: EventInstance = {
      instanceId: idFactory("evi"),
      definitionId: s.eventId,
      origin: { kind: "opening", id: tpl.openingId },
      ...(s.at ? { scheduledTime: s.at } : {}),
      status: "scheduled",
      visibility: "known",
    };
    instances.push(inst);
  }

  const completed = checkAllConditions(tpl.completionConditions, { state: next, lookup, rng });

  const run: OpeningRun = {
    openingId: tpl.openingId,
    executedSteps: tpl.steps.map((s) => s.id),
    choiceRecords: [],
    seed: state.seed,
    startedAt: ctx.now(),
    completedAt: ctx.now(),
    completed,
    instances,
    pendingEvents,
    scheduledEvents: tpl.handoff.schedule.map((s) => ({ ...s })),
  };
  return { state: next, run };
}

/**
 * T3-05 交接。completionConditions 满足后把未完成即时事件送入现有 pendingEvents
 * （带 chainId 者接入现有 chains）、未来事件**真正入队**到 state.scheduledEvents，
 * 并置 openingCompleted = true。纯函数，返回新状态；不设阶段枚举、不新建调度器。
 *
 * `lookup` 可选：提供时交接实例沿用事件定义 window.start 作为窗口起点；
 * 未提供时退化为 `s.at ?? 0`，保证旧调用方（2 参）编译与行为可用。
 */
export function handoff(state: WorldStateV2, run: OpeningRun, lookup?: TemplateLookup): WorldStateV2 {
  if (!run.completed) {
    throw new Error("[opening_not_complete] completionConditions 未满足，拒绝交接");
  }
  const next = structuredClone(state);

  // 1) 未完成即时事件 → 现有 pendingEvents；带 chainId 者接入现有 chains。
  for (const p of run.pendingEvents) {
    next.pendingEvents.push(
      p.chainId ? { eventId: p.eventId, chainId: p.chainId } : { eventId: p.eventId },
    );
    if (p.chainId && !next.chains.some((c) => c.id === p.chainId)) {
      const chainState: ChainStateV2 = {
        id: p.chainId,
        stepIndex: 0,
        status: "active",
        startedTurn: next.turnIndex,
      };
      next.chains.push(chainState);
    }
  }

  // 2) 未来/条件事件 → 延时队列（R-EV-08 / M5 修复）：真正产生 ScheduledEventInstance，
  //    由 drainScheduledEvents 在到期时统一判定，取代旧的 flags 占位标记。
  //    createWorldV2 已为全部 source: schedule 定义入队 schedule-init 实例；开局若重复声明
  //    同一事件，以开局为准：把旧的 waiting 实例标 cancelled，避免同一事件触发两次。
  //    opening 条目上的 conditions 属配置域声明，旧实现也从未消费（M3「写而不读」），
  //    且实例不得复制配置字段（R-EV-15）——出队终判读事件定义现值，此处不复制。
  for (const s of run.scheduledEvents) {
    for (const existing of next.scheduledEvents) {
      if (existing.status === "waiting" && existing.definitionId === s.eventId) {
        existing.status = "cancelled";
      }
    }
    // s.at / 定义 window.start 都是「相对世界起始」的偏移（世界初始化 now=0 入队等价表达），
    // 而 TimeSpec 默认相对入队时刻（#37）；交接可能发生在 advanceTo 之后，故按绝对量固化。
    // R2.6（ADR-0013）：字符串字面量 / year-month 量经适配器换算；基准 0 = 相对世界起始。
    const startSpec = s.at ?? lookup?.event(s.eventId)?.trigger.window?.start;
    const handoffCalendar = lookup ? createTimeAdapter(lookup.template) : undefined;
    enqueueScheduled({
      state: next,
      definitionId: s.eventId,
      origin: { kind: "opening", id: run.openingId },
      ...(startSpec !== undefined
        ? { absoluteStart: resolveTimeSpec(startSpec, 0, handoffCalendar) }
        : { start: { value: 0, unit: "minute" } }),
    });
  }

  // 3) 交接标记（ADR-0004 / R-TM-02）。
  next.openingCompleted = true;
  return next;
}

/**
 * R-OP-01：模板提供多个开局时按 `openingId` 选择；未指定时取加载顺序首个。
 * 纯函数，不改动入参。指定但找不到时返回 `undefined`，由调用方决定错误语义
 * （server 路由据此返回 404，store 层再做一次防御性拒绝）。
 */
export function selectOpeningTemplate(
  openings: readonly OpeningTemplate[],
  openingId?: string,
): OpeningTemplate | undefined {
  if (openingId === undefined) return openings[0];
  return openings.find((o) => o.openingId === openingId);
}

/** 模板未提供 opening.yaml 时的最小默认开局：无自定义步骤，直接满足交接条件。 */
export function createDefaultOpeningTemplate(openingId = "default"): OpeningTemplate {
  return {
    openingId,
    name: "默认开局",
    description: "模板未提供 opening.yaml 时的最小开局：无自定义步骤，直接完成交接。",
    entryConditions: [],
    steps: [],
    characterSetup: {},
    worldSetup: {},
    npcSetup: {},
    eventPools: [],
    objectives: {},
    choices: {},
    // 空条件数组 => checkAllConditions 恒真；该模板由引擎内部构造，不经 YAML 加载器校验。
    completionConditions: [],
    handoff: { pendingEvents: [], schedule: [] },
  };
}
