import { describe, expect, it } from "vitest";
import { WorldTemplateV2Schema, WorldStateV2Schema, type WorldStateV2, type WorldTemplateV2 } from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { applyEffectsV2, type ConditionContext } from "./engine.js";
import { evaluateDue, type DueDecision } from "./scheduler.js";
import { createRng } from "../rng.js";
import { createActiveWorldV2 } from "./test-utils.js";
import { advanceTurnV2, chooseOptionV2, revalidateSlot, slotEventView, useItemV2 } from "./turn.js";
import { enqueueScheduled } from "./scheduler.js";

/**
 * ADR-0024「呈现前前提复核」的契约测试 —— **按 ADR-0034 单槽模型重写**。
 *
 * 缺口（QA 实测）：事件只在 **fire 时**过一次 `trigger.conditions`，排队期间不再复核。
 * 于是「fire 时活着、settle 前已死」的角色仍会出现在卡片正文与选项里 —— 诈尸。
 *
 * **改写说明（结构删除，不是放宽）**：
 * - `pendingEvents: PendingEvent[]` 与 `revalidatePendingV2` 随 ADR-0034 §5 删除，
 *   复核对象从「待决数组」变成标量槽 ⇒ 唯一入口是 `revalidateSlot(state, lookup)`；
 * - 复核结果分两条通道（ADR-0034 §8-⑪）：
 *   · 槽是 `queueTake` 来源 ⇒ 带 `instanceId` ⇒ **写持久化 `missedEvents`**
 *     （`reason` 复用封闭枚举 `miss_when`，不扩枚举）；
 *   · 槽是 `successor`/`hook`/`opening`/`death` 来源 ⇒ 无队列实例、不得造 id ⇒
 *     只进**非持久化** `droppedPending` 诊断位。
 * - 原 ⑥「链条目被丢弃不伪装成 completed」：`chains[]`/`evaluateChain` 已删，
 *   改为断言「丢弃后 `slot === null`（不等于"已结算"）」+ 事实层零写入（下文注明）。
 */

// ---------- 合成夹具（不依赖任何真实模板内容） ----------

const RAW: Record<string, unknown> = {
  meta: { id: "t-premise", name: "前提复核", description: "d", startYear: 2000, engineProtocol: "v2" },
  time: { defaultStep: { value: 1, unit: "hour" } },
  genders: [{ id: "f", label: "女" }],
  mood: {
    min: 0,
    max: 100,
    defaultValue: 60,
    bands: [{ id: "n", label: "平静", min: 0, max: 100, attributeModifiers: {} }],
  },
  statusBar: [{ id: "sb1", label: "基本", source: "identity" }],
  attributes: { order: ["power"], defaults: { power: 5 } },
  resources: { hp: { base: 100, perLevel: 0 }, mp: { base: 50, perLevel: 0 } },
  regen: { perTurn: { hp: 0, mp: 0 } },
  characters: [
    {
      id: "npc-a",
      isEnemy: false,
      identity: { name: "甲", age: 17, gender: "f" },
      visibility: "public",
      mood: { value: 60 },
      attributes: { power: 4 },
      skills: ["sk-strike"],
      public: {},
      private: {},
      relationship: 10,
    },
    {
      id: "enemy-x",
      isEnemy: true,
      identity: { name: "敌人", age: 0, gender: "f" },
      visibility: "public",
      mood: { value: 50 },
      attributes: { power: 6 },
      skills: ["sk-strike"],
      public: {},
      private: {},
      relationship: -100,
    },
  ],
  playerTemplate: { identity: { gender: "f", age: 16 }, attributes: { power: 10 }, skills: ["sk-strike"] },
  actions: [
    { id: "patrol", label: "巡逻", duration: { value: 1, unit: "hour" } },
    { id: "rest", label: "休息", duration: { value: 1, unit: "hour" } },
  ],
  skills: [
    {
      id: "sk-strike",
      kind: "combat",
      name: "斩击",
      cost: { mp: 0 },
      target: "enemy",
      damage: [{ preset: "fixed", value: 10 }],
      cooldownTurns: 0,
      usableInBattle: true,
    },
  ],
  items: [
    {
      id: "item-heal",
      type: "consumable",
      name: "急救包",
      stackable: true,
      usableInBattle: false,
      usableOutsideBattle: true,
      use: [{ type: "adjustResource", resource: "hp", value: 5 }],
    },
  ],
  statuses: [],
  events: [
    {
      id: "ev-waiting",
      title: "点名甲的场景",
      narrative: "正文点名了甲。",
      // 事件级前提：甲必须在世。这才是「场景成不成立」的表达位置（ADR-0024 决策 1/7）。
      trigger: { source: "action-hook", onActionId: "patrol", probability: 1, conditions: [{ npcState: { npcId: "npc-a", state: "alive" } }] },
      kind: "normal",
      settle: { normal: { options: [{ id: "opt-wait", text: "继续", effects: [] }] } },
    },
    {
      id: "ev-queue",
      title: "队列里的场景",
      narrative: "从延时队列上桌的一条。",
      trigger: {
        source: "schedule",
        // 协议要求 TimeSpec.value > 0；扫描时点只看「start ≤ now」，1 分钟与 0 等价
        window: { start: { value: 1, unit: "minute" } },
        conditions: [{ npcState: { npcId: "npc-a", state: "alive" } }],
      },
      kind: "normal",
      settle: { normal: { options: [{ id: "opt-queue", text: "继续", effects: [] }] } },
    },
    // evaluateDue 判定表用：带 missWhen / conditions / cooldown 的组合
    {
      id: "ev-due",
      title: "判定表",
      narrative: "给 evaluateDue 用的定义。",
      trigger: {
        source: "schedule",
        window: { start: { value: 999, unit: "day" } },
        conditions: [{ npcState: { npcId: "npc-a", state: "alive" } }],
        missWhen: [{ npcState: { npcId: "npc-a", state: "unspawned" } }],
        missLabel: "甲从未登场",
        cooldown: { value: 1, unit: "day" },
      },
      kind: "normal",
      settle: { normal: { options: [{ id: "opt-due", text: "继续", effects: [] }] } },
    },
  ],
  // 可开关的 NPC 自主行动：用来构造 ADR「同一轮内 fire 后立刻失效」的场景。
  // 默认关（killSwitch=false），只有显式打开的那个用例会生效。
  npcActions: [
    {
      id: "npc-kill",
      summary: "{name} 倒下了。",
      trigger: { probability: 1, conditions: [{ flag: "killSwitch", eq: true }] },
      utility: { base: 1 },
      effects: [{ type: "setNpcLifecycle", npcId: "npc-a", state: "inactive", reasonCode: "阵亡" }],
    },
  ],
};

function makeTemplate(): WorldTemplateV2 {
  return WorldTemplateV2Schema.parse(structuredClone(RAW));
}

function setup(worldId: string) {
  const template = makeTemplate();
  const lookup = createLookup(template);
  const state = createActiveWorldV2({ templateId: template.meta.id, playerName: "测试者", seed: 5 }, template, worldId);
  state.player.inventory["item-heal"] = 3;
  // 夹具模板没有 source: pool 事件；ev-queue 是 schedule ⇒ 建世界期已入队。
  // 本文件的多处用例要自己决定槽/队列的形状，故默认清空队列（专项用例会显式入队）。
  state.delayQueue = [];
  state.enqueueSeqCounter = 0;
  return { template, lookup, state };
}

const killA = (state: WorldStateV2, lookup: ReturnType<typeof createLookup>, reasonCode = "阵亡") =>
  applyEffectsV2({ state, lookup, rng: createRng(1), logs: [] }, [
    { type: "setNpcLifecycle", npcId: "npc-a", state: "inactive", reasonCode },
  ]);

/** 让 ev-waiting 上桌（action-hook 命中巡逻 ⇒ 直接写 `hook` 槽，无队列实例）。 */
function fireWaiting(state: WorldStateV2, template: WorldTemplateV2, lookup: ReturnType<typeof createLookup>) {
  advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);
  expect(state.slot).toMatchObject({ eventId: "ev-waiting", from: "hook" });
  // hook 来源没有队列实例 ⇒ 不得造 instanceId（ADR-0034 §8-⑪）
  expect(state.slot?.instanceId).toBeUndefined();
}

/** 让 ev-queue 上桌（队列取出 ⇒ `queueTake` + `instanceId`，可回指）。 */
function takeFromQueue(state: WorldStateV2, template: WorldTemplateV2, lookup: ReturnType<typeof createLookup>) {
  enqueueScheduled({ state, definitionId: "ev-queue", origin: { kind: "effect", id: "ev-queue" } });
  advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
  expect(state.slot).toMatchObject({ eventId: "ev-queue", from: "queueTake" });
  expect(state.slot?.instanceId).toBeDefined();
}

// ---------- ① 上桌后角色死亡 ⇒ 该场景撤下 ----------

describe("ADR-0024 ①：上桌期间角色死亡 ⇒ 该场景撤下", () => {
  it("投影不再呈现失效场景（slotEventView 返回 null），且槽被真的清空", () => {
    const { template, lookup, state } = setup("w-premise-1");
    fireWaiting(state, template, lookup);
    // 前置：上桌时前提为真，所以此刻**确实**在呈现（否则下面的断言可能只是空跑）
    expect(slotEventView(state, lookup)?.eventId).toBe("ev-waiting");

    // 排演期间甲死了（另一条路径的副作用）
    killA(state, lookup);

    // ① 修复前：这里仍会拿到 ev-waiting（诈尸）。
    expect(slotEventView(state, lookup), "失效场景不得继续呈现").toBeNull();

    // 排空也必须真的把槽清掉，否则自由行动会被槽门禁永久拒绝（ADR-0024 决策 2.5 的硬死锁）。
    const res = useItemV2(state, { itemId: "item-heal" }, template, lookup);
    expect(state.slot).toBeNull();
    expect(res.snapshot.slotEvent).toBeNull();
  });

  it("再提交旧 optionId 不可能成功：入口排空后槽已空 ⇒ no_pending_event", () => {
    const { template, lookup, state } = setup("w-premise-2");
    fireWaiting(state, template, lookup);
    killA(state, lookup);
    // 先让某个响应把槽排干净（模拟玩家在别的入口触发了一次规范化）
    useItemV2(state, { itemId: "item-heal" }, template, lookup);
    expect(() => chooseOptionV2(state, { optionId: "opt-wait" }, template, lookup)).toThrow(/no_pending_event/);
  });

  it("同一命令内先丢弃、再提交旧 optionId ⇒ event_premise_invalidated（区别于 option_not_available）", () => {
    const { template, lookup, state } = setup("w-premise-3");
    fireWaiting(state, template, lookup);
    killA(state, lookup);
    // 槽里只有这一个事件；chooseOptionV2 入口复核会先丢弃它，
    // 而 command.optionId 正属于被丢弃的那个事件 ⇒ 专用错误码。
    expect(() => chooseOptionV2(state, { optionId: "opt-wait" }, template, lookup)).toThrow(
      /event_premise_invalidated/,
    );
  });

  it("没有失效时槽照旧：不误删、不误判", () => {
    const { template, lookup, state } = setup("w-premise-4");
    fireWaiting(state, template, lookup);
    expect(revalidateSlot(state, lookup).dropped).toEqual([]);
    expect(state.slot).toMatchObject({ eventId: "ev-waiting", from: "hook" });
    const res = chooseOptionV2(state, { optionId: "opt-wait" }, template, lookup);
    expect(res.snapshot.slotEvent).toBeNull();
    expect(state.slot).toBeNull();
  });
});

// ---------- ①' 失效留痕：两条通道（ADR-0034 §8-⑪） ----------

describe("ADR-0034 §8-⑪：槽路径失效的分类留痕（有 instanceId ⇒ 持久化 miss_when）", () => {
  it("queueTake 槽（有 instanceId）⇒ 写一条持久化 missedEvents，reason 复用 miss_when 且不扩枚举", () => {
    const { template, lookup, state } = setup("w-premise-trace-1");
    takeFromQueue(state, template, lookup);
    const instanceId = state.slot!.instanceId!;
    killA(state, lookup);

    const { dropped } = revalidateSlot(state, lookup);

    expect(dropped).toEqual(["ev-queue"]);
    expect(state.slot).toBeNull();
    expect(state.missedEvents).toEqual([
      {
        eventId: "ev-queue",
        instanceId,
        turnIndex: state.turnIndex,
        worldTime: state.worldTime,
        reason: "miss_when",
      },
    ]);
    // 反作弊（§8-⑪ 末段）：instanceId 是队列身份，不得出现在玩家端投影里
    expect(JSON.stringify(state.slot)).not.toContain(instanceId);
  });

  it("successor/hook 槽（无 instanceId）⇒ 不造 id、不写 missedEvents（只进非持久化 droppedPending）", () => {
    const { template, lookup, state } = setup("w-premise-trace-2");
    fireWaiting(state, template, lookup); // from: "hook"
    killA(state, lookup);

    const before = state.missedEvents.length;
    const { dropped } = revalidateSlot(state, lookup);

    expect(dropped).toEqual(["ev-waiting"]);
    expect(state.slot).toBeNull();
    // 预期行为：没有队列实例就没有可回指的 id，宁可不记，也不臆造 instanceId
    expect(state.missedEvents).toHaveLength(before);
  });

  it("missWhen 命中时 label 一并透传（封闭枚举 reason + 模板自述 label）", () => {
    const { template, lookup, state } = setup("w-premise-trace-3");
    enqueueScheduled({ state, definitionId: "ev-due", origin: { kind: "effect", id: "ev-due" } });
    // 直接构造槽（不改世界时间；ev-due 的 window 在未来，扫描取不到它）
    state.slot = { eventId: "ev-due", from: "queueTake", instanceId: state.delayQueue[0].instanceId };
    applyEffectsV2({ state, lookup, rng: createRng(1), logs: [] }, [
      { type: "setNpcLifecycle", npcId: "npc-a", state: "unspawned" },
    ]);

    expect(revalidateSlot(state, lookup).dropped).toEqual(["ev-due"]);
    expect(state.missedEvents.at(-1)).toMatchObject({ eventId: "ev-due", reason: "miss_when", label: "甲从未登场" });
  });
});

// ---------- ④ 清槽不是结算 ----------

describe("ADR-0024 ④：丢弃不是结算（不占轮次、不写事实）", () => {
  it("丢弃前后 turnIndex/worldTime/age/history/eventFires 长度全不变", () => {
    const { template, lookup, state } = setup("w-premise-5");
    fireWaiting(state, template, lookup);
    killA(state, lookup);

    const before = {
      turnIndex: state.turnIndex,
      worldTime: state.worldTime,
      age: state.player.age,
      history: state.history.length,
      eventFires: state.eventFires.length,
      firedEvents: JSON.stringify(state.firedEvents),
    };
    const { dropped } = revalidateSlot(state, lookup);
    expect(dropped).toEqual(["ev-waiting"]);
    expect({
      turnIndex: state.turnIndex,
      worldTime: state.worldTime,
      age: state.player.age,
      history: state.history.length,
      eventFires: state.eventFires.length,
      firedEvents: JSON.stringify(state.firedEvents),
    }).toEqual(before);
  });

  it("槽清空后自由行动恢复正常推进（不因残留槽被 pending_event_required 拒绝）", () => {
    const { template, lookup, state } = setup("w-premise-6");
    fireWaiting(state, template, lookup);
    killA(state, lookup);
    const t0 = state.turnIndex;
    const res = advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(res.state.turnIndex).toBe(t0 + 1);
    expect(res.snapshot.slotEvent).toBeNull();
  });
});

// ---------- ③ evaluateDue 判定表（等价重构的回归网） ----------

describe("ADR-0024 ③：checkEventPremise 与 evaluateDue 的判定表", () => {
  function dueWith(worldId: string, mutate?: (s: WorldStateV2, l: ReturnType<typeof createLookup>) => void): DueDecision {
    const { lookup, state } = setup(worldId);
    mutate?.(state, lookup);
    const inst = {
      instanceId: "i1",
      definitionId: "ev-due",
      origin: { kind: "schedule-init" as const, id: "ev-due" },
      window: { start: 0 },
      hasEnd: false,
      enqueuedAt: 0,
      enqueueSeq: 0,
      status: "waiting" as const,
    };
    return evaluateDue({ instance: inst, state, lookup, rng: createRng(3) });
  }

  it("前提成立 + 无冷却 ⇒ fire", () => {
    expect(dueWith("w-due-1")).toEqual({ kind: "fire" });
  });

  it("conditions 不满足（甲不在世）⇒ hold（留队重估，不记错失）", () => {
    expect(dueWith("w-due-2", (s, l) => killA(s, l))).toEqual({ kind: "hold" });
  });

  it("missWhen 命中 ⇒ drop(miss_when) 并带 label（先于 conditions）", () => {
    expect(dueWith("w-due-3", (s, l) => l && applyEffectsV2({ state: s, lookup: l, rng: createRng(1), logs: [] }, [{ type: "setNpcLifecycle", npcId: "npc-a", state: "unspawned" }]))).toEqual({
      kind: "drop",
      reason: "miss_when",
      label: "甲从未登场",
    });
  });

  it("前提成立但冷却未过 ⇒ hold", () => {
    expect(
      dueWith("w-due-4", (s) => {
        s.lastFiredIndex["ev-due"] = { turnIndex: 0, worldTime: 0 };
        s.worldTime = 60; // 1 小时 < 1 天
      }),
    ).toEqual({ kind: "hold" });
  });

  it("定义缺失 ⇒ hold（不臆造错失原因）", () => {
    const { lookup, state } = setup("w-due-5");
    const inst = {
      instanceId: "i-miss",
      definitionId: "ev-ghost",
      origin: { kind: "schedule-init" as const, id: "ev-due" },
      window: { start: 0 },
      hasEnd: false,
      enqueuedAt: 0,
      enqueueSeq: 0,
      status: "waiting" as const,
    };
    expect(evaluateDue({ instance: inst, state, lookup, rng: createRng(1) })).toEqual({ kind: "hold" });
  });
});

// ---------- ⑥ 被丢弃的槽内容不得伪装成「已结算」 ----------

describe("ADR-0024 ⑥：槽内容被丢弃 ⇒ 不伪装成已结算（evaluateChain 已删，ADR-0034 §5）", () => {
  /**
   * **失效原因**：原用例断言「链仍为 active，而不是被假装成 completed」，读的是
   * `state.chains[0].status` 与 `evaluateChain(...)`。ADR-0034 §5 删除 `chains[]` 与
   * `evaluateChain`（链退化为 `nextEventId` 边），「链状态」这个可断言对象不存在了。
   *
   * **等价替代断言**（"没被假装成已结算"的可观察形式）：
   * ① 丢弃只清槽 ⇒ `slot === null`，**不产生**结算痕迹（无 `turnIndex` 推进、无 `firedEvents`、
   *    无 history）——即"没演过"这件事在事实层如实可见（这正是旧的"不提前 completed"想表达的）；
   * ② 丢弃后判定链回到「槽空」分支 ⇒ 下一次推进走「扫队列/自由行动」，不会被僵尸槽卡住；
   * ③ 模板图上的这条边没被改：事件定义仍在 `lookup` 里，后继边仍指向同一条（无运行时状态可污染）。
   */
  it("丢弃后 slot 为空、事实层零写入，且模板边不被改写", () => {
    const { template, lookup, state } = setup("w-premise-7");
    state.slot = { eventId: "ev-queue", from: "queueTake", instanceId: "evi-fixture" };
    killA(state, lookup);
    const turnBefore = state.turnIndex;
    const firesBefore = state.eventFires.length;
    const historyBefore = state.history.length;

    expect(revalidateSlot(state, lookup).dropped).toEqual(["ev-queue"]);

    expect(state.slot).toBeNull();
    expect(state.turnIndex).toBe(turnBefore);
    expect(state.eventFires).toHaveLength(firesBefore);
    expect(state.history).toHaveLength(historyBefore);
    expect(state.firedEvents["ev-queue"]).toBeUndefined();
    // 模板边不被运行时污染
    expect(lookup.event("ev-queue")?.trigger.source).toBe("schedule");
    void template;
  });
});

// ---------- ⑧ 载入即清理 ----------

describe("ADR-0024 ⑧：含失效槽的状态载入即规范化", () => {
  it("清掉失效槽、状态仍能通过 schema 校验（零协议变更），且幂等", () => {
    const { lookup, state } = setup("w-premise-8");
    state.slot = { eventId: "ev-waiting", from: "hook" };
    killA(state, lookup, "被宿傩夺舍");

    expect(revalidateSlot(state, lookup).dropped).toEqual(["ev-waiting"]);
    expect(state.slot).toBeNull();
    // 零协议变更：`SlotScene` 是封闭枚举，清槽后的状态照样过 WorldStateV2Schema
    expect(WorldStateV2Schema.safeParse(state).success).toBe(true);
    // 幂等：再跑一次不再产生丢弃
    expect(revalidateSlot(state, lookup).dropped).toEqual([]);
  });

  it("前提为真的槽原样保留（规范化不误伤）", () => {
    const { lookup, state } = setup("w-premise-9");
    state.slot = { eventId: "ev-waiting", from: "queueTake" };
    expect(revalidateSlot(state, lookup).dropped).toEqual([]);
    expect(state.slot).toEqual({ eventId: "ev-waiting", from: "queueTake" });
  });

  it("`revalidateSlot` 只作用于槽：队列里的失效实例不由它处置（那是 scanDelayQueue 的职责）", () => {
    const { lookup, state } = setup("w-premise-9b");
    enqueueScheduled({ state, definitionId: "ev-queue", origin: { kind: "effect", id: "ev-queue" } });
    killA(state, lookup);

    expect(revalidateSlot(state, lookup).dropped).toEqual([]);
    // 条件不满足的队列实例**留队**（ADR-0034 §3-3：不丢弃、不卡队头）
    expect(state.delayQueue[0].status).toBe("waiting");
    expect(state.missedEvents).toEqual([]);
  });
});

// ---------- 诊断位 ----------

describe("ADR-0024 诊断位与附则", () => {
  it("同一轮内「上桌后立刻失效」：不呈现，且该事件从本次 triggeredEvents 里剔除", () => {
    const { template, lookup, state } = setup("w-premise-10");
    // 本轮顺序：action-hook 先写槽（此刻甲还在世）→ 结算后管线的 NPC 行动把甲写死。
    state.flags.killSwitch = true;
    const res = advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);

    // 事实层只追加（此处尚未结算，故只有 NPC 行动的历史）
    expect(state.history.some((h) => h.summary.includes("点名甲的场景"))).toBe(false);
    // 本次响应里不再呈现它，槽也被排空
    expect(res.snapshot.slotEvent).toBeNull();
    expect(state.slot).toBeNull();
    // 附则：同一响应不再报「已失效的场景」（否则 triggeredEvents 与 snapshot 自相矛盾）
    expect(res.triggeredEvents.map((t) => t.id)).not.toContain("ev-waiting");
  });

  it("droppedPending 是模块内诊断位：不进玩家端 API、不进存档（ADR 决策 4）", () => {
    const { template, lookup, state } = setup("w-premise-11");
    state.slot = { eventId: "ev-waiting", from: "hook" };
    enqueueScheduled({ state, definitionId: "ev-queue", origin: { kind: "effect", id: "ev-queue" } });
    killA(state, lookup);
    const res = advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    // 对外契约：V2TurnResult 不带这个字段（它是 TriggerResult 上的非持久化诊断位）
    expect("droppedPending" in res).toBe(false);
    expect(JSON.stringify(state)).not.toContain("droppedPending");
    // 丢弃本身仍然生效：槽被清空；队列那条并未被"顺带清掉"（它不是槽）
    expect(state.slot).not.toMatchObject({ eventId: "ev-waiting" });
    expect(state.delayQueue.some((i) => i.definitionId === "ev-queue" && i.status === "waiting")).toBe(true);
  });
});
