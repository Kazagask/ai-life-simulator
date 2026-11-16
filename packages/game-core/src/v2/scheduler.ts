import type {
  EventInstanceOrigin,
  EventV2,
  MissReason,
  ScheduledEventInstance,
  TimeSpec,
  WorldStateV2,
} from "@life-sim/shared";
import type { Rng } from "../rng.js";
import { amountToMinutes, type CalendarAdapter } from "./time.js";
import { checkAllConditions, type ConditionContext } from "./engine.js";
import { selfIdOf } from "./actors.js";
import type { TemplateLookup } from "./lookup.js";

/**
 * R2.5 调度器（design §3.3–3.9 / ADR-0010/0011）：**唯一**的延时队列写入口。
 *
 * 分层纪律：
 * - 配置层（template.events）只在「候选产生」与「条件求值」时经 lookup 读取现值；
 *   drain **不遍历 template.events**，只遍历 state.scheduledEvents；
 * - 实例层（scheduledEvents）有 id / status / 固化窗口，**不复制任何配置域字段**；
 * - 事实层（eventFires / missedEvents）只追加；lastFiredIndex 是可重建的派生索引。
 *
 * 确定性：instanceId 由 state.enqueueSeqCounter 派生；无 Date / Math.random；
 * 排序键只用世界分钟与入队序号；窗口在入队时一次性换算固化（R3 时间回拨 seam）。
 *
 * RNG 消耗顺序（§3.4.5，与 R2.4b 相比「同 seed 序列变更」）：
 * 1) enqueueCandidate 门控：非 preGated 候选按模板顺序，每个带 probability 的事件恰好 1 次骰；
 * 2) pool 抽取（turn.ts）：probability 逐事件掷骰 → weight 加权抽一，顺序沿用旧管线；
 *    pool 的六策略已在抽取阶段消费，传给 enqueueCandidate 时标 preGated，不重复扣减；
 * 3) drain：不再掷 probability 骰；只有条件 DSL 内的 random 条件可能消耗 RNG，
 *    按 sortScheduled 的固定顺序消耗；hold / drop 本身不消耗 RNG。
 *
 * 本模块**不 import turn.ts**（避免循环依赖）：事件触发通过 drain 的 onFire 回调注入。
 */

/** 历法适配器子集（R2.6 已接线）：字符串字面量与 year/month 量换算经此注入。 */
export type TimeSpecCalendar = Pick<CalendarAdapter, "parseTimeSpec" | "toMinutes">;

export const ZERO_SPEC: TimeSpec = { value: 0, unit: "minute" };

/**
 * TimeSpec → 绝对世界分钟。**默认相对入队时刻**（OQ-#37）：now + amount。
 * R2.6（ADR-0013）：
 * - 字符串字面量（复合时长 / 历法日期）必须经 CalendarAdapter.parseTimeSpec 解析；
 *   无适配器注入时抛错（approx 适配器只支持复合时长，日期字面量在运行期抛错）。
 * - year/month 量经 CalendarAdapter.toMinutes 换算（gregorian/custom 按真实月长推进，
 *   如 1 月从 1-31 起是 1-31→2-28 的日历增量）；其余单位与时历结构无关。
 * 一切换算仍在**入队时**一次性固化成绝对量存实例，drain 时不再重算（R3 时间回拨 seam）。
 */
export function resolveTimeSpec(spec: TimeSpec, now: number, calendar?: TimeSpecCalendar): number {
  if (typeof spec === "string") {
    if (!calendar) {
      throw new Error(`TimeSpec 字符串字面量「${spec}」需要历法适配器（time.calendar）`);
    }
    return calendar.parseTimeSpec(spec, now);
  }
  if (calendar) return now + calendar.toMinutes(spec, now);
  return now + amountToMinutes(spec);
}

/** 时长 → 分钟（用于冷却等「相对量」，基准取 0）。 */
export function specToMinutes(spec: TimeSpec, calendar?: TimeSpecCalendar): number {
  return resolveTimeSpec(spec, 0, calendar);
}

/**
 * 三键稳定排序（§3.3）：window.start asc → hasEnd(false = +∞，排后) → window.end asc → enqueueSeq asc。
 * enqueueSeq 全局唯一 ⇒ 比较函数不可能返回 0 ⇒ 全序严格、幂等、与插入历史无关。
 * 纯函数：返回新数组，不改入参。
 */
export function sortScheduled(
  events: readonly ScheduledEventInstance[],
): ScheduledEventInstance[] {
  return [...events].sort((a, b) => {
    if (a.window.start !== b.window.start) return a.window.start - b.window.start;
    if (a.hasEnd !== b.hasEnd) return a.hasEnd ? -1 : 1;
    if (a.hasEnd && a.window.end !== b.window.end) {
      return (a.window.end ?? 0) - (b.window.end ?? 0);
    }
    return a.enqueueSeq - b.enqueueSeq;
  });
}

// ---------- 入队 ----------

export interface EnqueueScheduledInput {
  state: WorldStateV2;
  definitionId: string;
  origin: EventInstanceOrigin;
  /** 相对入队时刻的窗口起点；缺省 = 相对 0 分钟（OQ-#38） */
  start?: TimeSpec;
  /**
   * 绝对世界分钟窗口起点，优先于 `start`。
   * 仅供 opening.handoff 使用：OpeningScheduledEventSchema.at 的语义是「相对世界起始」，
   * 与 TimeSpec 的「默认相对入队时刻」不同（#37），交接时按绝对量固化，避免被交接时刻二次平移。
   */
  absoluteStart?: number;
  /** 相对入队时刻的窗口终点；缺省 = 无限期（hasEnd=false，不用数值哨兵） */
  end?: TimeSpec;
  chainId?: string;
  calendar?: TimeSpecCalendar;
}

/**
 * 入队即换算：TimeSpec 一次性变成绝对世界分钟固化进实例 window。
 * instanceId 由 enqueueSeqCounter 派生（design §3.3 写 RunnerContext.idFactory；
 * 本轮改用状态内计数器，原因是 id 必须进存档且不能依赖调用方注入的上下文——偏差已记录）。
 * 队列始终保持排序键序，drain 只需顺序遍历。
 */
export function enqueueScheduled(input: EnqueueScheduledInput): ScheduledEventInstance {
  const { state } = input;
  const now = state.worldTime;
  const start = input.absoluteStart ?? resolveTimeSpec(input.start ?? ZERO_SPEC, now, input.calendar);
  const end = input.end === undefined ? undefined : resolveTimeSpec(input.end, now, input.calendar);
  const seq = state.enqueueSeqCounter;
  const inst: ScheduledEventInstance = {
    instanceId: `evi-${seq}`,
    definitionId: input.definitionId,
    origin: input.origin,
    ...(input.chainId !== undefined ? { chainId: input.chainId } : {}),
    window: end === undefined ? { start } : { start, end },
    hasEnd: end !== undefined,
    enqueuedAt: now,
    enqueueSeq: seq,
    status: "waiting",
  };
  state.enqueueSeqCounter = seq + 1;
  state.delayQueue.push(inst);
  state.delayQueue = sortScheduled(state.delayQueue);
  return inst;
}

export interface EnqueueCandidateInput {
  state: WorldStateV2;
  definition: EventV2;
  origin: EventInstanceOrigin;
  lookup: TemplateLookup;
  rng: Rng;
  /** pool 抽取阶段已消费六策略（含 probability 骰），门控内不重复扣减（R-EV-08/13） */
  preGated?: boolean;
  /** 显式延时覆盖（enqueueEvent 效果 / chain 延时步）；优先于定义上的 window.start / delay */
  delay?: TimeSpec;
  chainId?: string;
  calendar?: TimeSpecCalendar;
}

/**
 * 两段式判定的第一段：**入队门控**（候选产生时）。门控失败不产生实例、不记错失。
 * 六字段只在配置域读取现值，判定可以读运行时状态（firedEvents/turnIndex/flags/RNG）。
 * weight / priority / onActionId 不在门控消费：前两者只在 pool 抽取阶段，后者在行动命中时。
 */
export function enqueueCandidate(input: EnqueueCandidateInput): ScheduledEventInstance | undefined {
  const { state, definition, origin, lookup, rng, calendar } = input;
  const trigger = definition.trigger;

  if (input.preGated !== true) {
    // 1) once：读事实派生索引（过渡期兼容 firedEvents 数值索引）
    if (trigger.once && hasFired(state, definition.id)) return undefined;
    // 2) probability：每候选恰好一次骰；门控失败即止，不产生实例
    if (trigger.probability !== undefined && rng() >= trigger.probability) return undefined;
    // 3) pool 的 conditions 在候选产生时求值（其余来源留给出队终判，R-EV-06）
    if (origin.kind === "pool" && !checkAllConditions(trigger.conditions, { state, lookup, rng })) {
      return undefined;
    }
  }
  // 4) 战斗不入池：加载期已拒，此处为抽取期防御（R-EV-13）
  if (origin.kind === "pool" && definition.kind === "combat") return undefined;

  // window.start > trigger.delay > 显式 delay > 0；end 只来自 window.end
  const startSpec = input.delay ?? trigger.window?.start ?? trigger.delay ?? ZERO_SPEC;
  return enqueueScheduled({
    state,
    definitionId: definition.id,
    origin,
    start: startSpec,
    end: trigger.window?.end,
    ...(input.chainId !== undefined ? { chainId: input.chainId } : {}),
    calendar,
  });
}

// ---------- 事实写入（唯一入口） ----------

/**
 * 触发事实的**唯一**写入口：三处索引/日志一次写齐，禁止散写（§3.6 / R-LM-03）。
 * 【过渡期双索引偏差】firedEvents 保留为 O(1)「最近触发轮次」（ending.ts 的 eventOccurred、
 * turn.ts 的 once 判定与 27 处既有消费/测试仍读它）；eventFires 是 append-only 事实日志，
 * lastFiredIndex 带 worldTime 承接时间维度冷却。R2.6 可收敛掉 firedEvents。
 */
export function recordFire(state: WorldStateV2, eventId: string): void {
  const turnIndex = state.turnIndex;
  const worldTime = state.worldTime;
  state.firedEvents[eventId] = turnIndex;
  state.lastFiredIndex[eventId] = { turnIndex, worldTime };
  state.eventFires.push({ eventId, turnIndex, worldTime });
}

/** once 判定：过渡期同时认两种索引，避免测试夹具里只写 firedEvents 的旧状态被误判。 */
export function hasFired(state: WorldStateV2, eventId: string): boolean {
  return state.lastFiredIndex[eventId] !== undefined || state.firedEvents[eventId] !== undefined;
}

/** 时间维度冷却：worldTime - lastFiredIndex[id].worldTime < cooldown 分钟。 */
export function onCooldown(
  state: WorldStateV2,
  eventId: string,
  cooldown: TimeSpec | undefined,
  calendar?: TimeSpecCalendar,
): boolean {
  if (cooldown === undefined) return false;
  const last = state.lastFiredIndex[eventId];
  if (last === undefined) return false;
  return state.worldTime - last.worldTime < specToMinutes(cooldown, calendar);
}

// ---------- 出队判定 ----------

export type DueDecision =
  | { kind: "fire" }
  | { kind: "hold" }
  | { kind: "drop"; reason: MissReason; label?: string };

/**
 * 事件前提的复核结论（ADR-0024 决策 2.1）。
 *
 * `missWhen` 与 `conditions` 的**判据**是同一件事（「这个场景现在成不成立」），
 * 但两者的**处置**不同：`missWhen` 命中 ⇒ 永久失效（drop + 记错失），
 * `conditions` 不满足 ⇒ 窗口内还可能变真（hold 留队）。
 * 因此谓词返回判别对象而不是裸 boolean —— 若压成 boolean，`evaluateDue` 就得再求值一次
 * 才能分辨两种处置，而条件里的 `random` 每求值一次都消耗 RNG，会破坏确定性。
 * 需要 boolean 的调用方读 `.ok` 即可。
 */
export type EventPremiseVerdict =
  | { ok: true }
  | { ok: false; missWhen: true; label?: string }
  | { ok: false; missWhen: false };

/**
 * **事件前提求值的唯一处**（ADR-0024 决策 2.1；与 `evaluateDue` 同域）。
 *
 * 判据 = 事件级 `trigger.conditions` + `missWhen`，顺序固定（missWhen 先），**每个条件数组恰好求值一次**。
 * 消费方：
 * - `evaluateDue`（出队终判，区分 drop / hold）；
 * - `revalidatePendingV2`（待决队列的呈现前复核，两种失败都等价于「前提不成立」）。
 *
 * 明确**不**复核的东西（ADR 决策 1）：`cooldown` / `window` / `probability` / `once` / `weight`
 * —— 它们已在入队门控消费，pending 期间再判会把玩家已看到的场景判成不合法。
 */
/**
 * 角色是否"在场"：`player` 恒真；NPC 看 `lifecycle.state === "alive"`。
 * 未知 id ⇒ 视为不在场（宁可少演一幕，也不让不存在的人出现在正文里）。
 *
 * ⚠ 精确口径：引擎里**没有独立的"死亡"状态**（只有 alive / inactive / unspawned，
 * 死亡由模板通过 `reasonCode` 表达）。所以这里判的是"在场且 active"——
 * 死亡、离场、未登场一视同仁，都会让事件错失。要区分"已故"请用 `mentions`。
 */
function isActorPresent(state: WorldStateV2, actorId: string): boolean {
  // 玩家节点 id 走 `selfIdOf`（A 期 seam），不写死字面量
  if (actorId === selfIdOf(state)) return true;
  const npc = state.npcs.find((n) => n.id === actorId);
  return npc !== undefined && npc.lifecycle.state === "alive";
}

export function checkEventPremise(def: EventV2, ctx: ConditionContext): EventPremiseVerdict {
  const trigger = def.trigger;
  // 序 1：触发前提永久失效（模板显式声明，引擎不隐式推断）
  if (trigger.missWhen && trigger.missWhen.length > 0 && checkAllConditions(trigger.missWhen, ctx)) {
    return { ok: false, missWhen: true, ...(trigger.missLabel ? { label: trigger.missLabel } : {}) };
  }
  // 序 2：场景条件（读定义现值）
  if (!checkAllConditions(trigger.conditions, ctx)) return { ok: false, missWhen: false };
  /**
   * 序 3：**参与角色活性复核**（2026-11-16 补）。
   *
   * 这是诈尸的结构防线：事件定义声明 `actors`，出队前逐个核对"还在、还活着"。
   * 不满足 ⇒ 判 `missWhen`（进 `missedEvents` 留痕，不静默丢弃）。
   *
   * 为什么不交给作者写 `missWhen`：生成分支写这一幕时 NPC 还活着，几轮之后可能已经死了，
   * 作者根本不知道未来会死谁 —— 靠自觉写守卫等于没有防线。
   */
  if (def.actors !== undefined && def.actors.length > 0) {
    const missing = def.actors.find((id) => !isActorPresent(ctx.state, id));
    if (missing !== undefined) {
      return { ok: false, missWhen: true, label: `参与角色已不在场：${missing}` };
    }
  }
  return { ok: true };
}

export interface EvaluateDueInput {
  instance: ScheduledEventInstance;
  state: WorldStateV2;
  lookup: TemplateLookup;
  rng: Rng;
  calendar?: TimeSpecCalendar;
}

/**
 * 纯判定函数（无状态写入）。顺序**固定不得重排**：
 * missWhen（drop，记 miss_when）→ conditions 终判（hold）→ cooldown（hold）→ fire。
 * 门控类（once / probability）已在入队前消费，失败根本不产生实例，故不构成错失。
 *
 * ADR-0024 决策 2.1：序 1/序 2 合并到 `checkEventPremise` 一次求值（**逐字节等价重构**，
 * 判定结果与求值次数都不变），两种失败按 `missWhen` 标志分派到原有处置。
 */
export function evaluateDue(input: EvaluateDueInput): DueDecision {
  const { instance, state, lookup, rng, calendar } = input;
  const def = lookup.event(instance.definitionId);
  if (!def) return { kind: "hold" }; // 定义缺失由 drain 标 cancelled，不臆造错失原因
  const ctx: ConditionContext = { state, lookup, rng };

  const premise = checkEventPremise(def, ctx);
  if (!premise.ok) {
    // 序 1：模板声明的永久失效 ⇒ drop（记 miss_when）
    if (premise.missWhen) {
      return { kind: "drop", reason: "miss_when", ...(premise.label !== undefined ? { label: premise.label } : {}) };
    }
    // 序 2：#36 窗口内不满足 ⇒ hold 留队、每轮重估、零错失记录
    return { kind: "hold" };
  }
  // 序 3：冷却未过 ⇒ hold
  if (onCooldown(state, def.id, def.trigger.cooldown, calendar)) return { kind: "hold" };
  return { kind: "fire" };
}

/**
 * 队列扫描结果（ADR-0034 §2 ② / §3）。
 * `taken` ⇒ 调用方**必须立刻把它写成 `slot`（`from: "queueTake"`）再处理**；
 * `none` ⇒ 队列里此刻没有可上桌的实例（空、未到期、或条件不满足）。
 */
export type QueueScanResult =
  | { kind: "taken"; instance: ScheduledEventInstance; definition: EventV2 }
  | { kind: "none" };

/**
 * **唯一**的队列扫描（ADR-0034 §3，全部按死结论实现）：
 *
 * - 排序键 `start → hasEnd → end → enqueueSeq`（`sortScheduled`，全序、不可能相等）；
 * - `window.start > now` ⇒ **停**（有序队列，后面只会更晚；R3 时间回拨下须降级为 continue，当前不做，见 ADR §8-⑧）；
 * - 定义缺失 ⇒ `cancelled`（加载期完整性问题，不算错失）；
 * - `worldTime > window.end` ⇒ `expired` + 记 `window_expired`，**出队**；
 * - `missWhen` 命中 ⇒ `expired` + 记 `miss_when`，**出队**；
 * - 条件不满足 / 冷却未过 ⇒ **留在队列、继续扫下一个**（ADR §3-3：不得丢弃、不得卡队头）；
 * - 否则 ⇒ 取出：**标 `fired` 并返回**，由调用方写 `slot` 后按状态机处理。
 *
 * 求值时点 = **被取出那一刻**（ADR §3-4）；此前的入队门控只消费 once/probability（配置域）。
 * 调用方须传入**独立派生流**（`seed + 37`）作 `rng`：扫描会每轮重复求值，若条件含 `random`
 * 不得扰动主轮流（ADR §3-5）。
 */
export function scanDelayQueue(
  state: WorldStateV2,
  lookup: TemplateLookup,
  rng: Rng,
  calendar?: TimeSpecCalendar,
): QueueScanResult {
  const ordered = sortScheduled(state.delayQueue);
  for (const inst of ordered) {
    if (inst.status !== "waiting") continue;
    const now = state.worldTime;
    if (inst.window.start > now) break;

    const def = lookup.event(inst.definitionId);
    if (!def) {
      inst.status = "cancelled"; // 定义缺失属加载期完整性错误，不是「错失」
      continue;
    }

    if (inst.hasEnd && inst.window.end !== undefined && now > inst.window.end) {
      inst.status = "expired";
      state.missedEvents.push({
        eventId: inst.definitionId,
        instanceId: inst.instanceId,
        turnIndex: state.turnIndex,
        worldTime: now,
        reason: "window_expired",
      });
      continue;
    }

    const decision = evaluateDue({ instance: inst, state, lookup, rng, calendar });
    if (decision.kind === "hold") continue; // 留在队列、继续扫下一个（不卡队头）
    if (decision.kind === "drop") {
      inst.status = "expired";
      state.missedEvents.push({
        eventId: inst.definitionId,
        instanceId: inst.instanceId,
        turnIndex: state.turnIndex,
        worldTime: now,
        reason: decision.reason,
        ...(decision.label !== undefined ? { label: decision.label } : {}),
      });
      continue;
    }
    inst.status = "fired";
    return { kind: "taken", instance: inst, definition: def };
  }
  return { kind: "none" };
}

/*
 * ADR-0034 §5：`chains[]` / `ChainStateV2` / `evaluateChain` / `alignChainStep` **已删除**。
 * 「链」现在只是模板图上的 `nextEventId` 边：「下一个是谁」由结算处的占槽判定直接决定
 * （`slot = successor`），不再有运行时链状态、也不存在 stepIndex 对齐问题。
 */
