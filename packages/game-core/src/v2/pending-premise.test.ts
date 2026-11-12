import { describe, expect, it } from "vitest";
import { WorldTemplateV2Schema, WorldStateV2Schema, type WorldStateV2, type WorldTemplateV2 } from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { applyEffectsV2, type ConditionContext } from "./engine.js";
import { evaluateChain, evaluateDue, type DueDecision } from "./scheduler.js";
import { createRng } from "../rng.js";
import { createActiveWorldV2 } from "./test-utils.js";
import { advanceTurnV2, chooseOptionV2, pendingEventView, revalidatePendingV2, useItemV2 } from "./turn.js";

/**
 * ADR-0024「待决事件的呈现前前提复核」的契约测试。
 *
 * 缺口（QA 实测）：`pendingEvents` 只在 **fire 时**过一次 `trigger.conditions`，排队期间不再复核。
 * 于是「fire 时活着、settle 前已死」的角色仍会出现在卡片正文与选项里 —— 诈尸。
 *
 * 本文件按 ADR §八 的验证要点组织：① 排队期间死亡 ⇒ 不再呈现且不能结算（修复前必须为红）、
 * ③ 未失效 ⇒ 行为不变 + `evaluateDue` 的判定表等价、④ 槽位让位不吞轮次、
 * ⑥ 链条目被丢弃不伪装成 completed、⑧ 旧档含失效队首 ⇒ 载入即清理。
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
      id: "ev-chain-step",
      title: "链上的一步",
      narrative: "链事件也点名了甲。",
      trigger: { source: "chain", conditions: [{ npcState: { npcId: "npc-a", state: "alive" } }] },
      kind: "normal",
      settle: { normal: { options: [{ id: "opt-chain", text: "继续", effects: [] }] } },
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
  chains: [{ id: "chain-x", startEventId: "ev-chain-step", steps: [{ eventId: "ev-chain-step", advanceWhen: "onSettle" }] }],
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
  return { template, lookup, state };
}

const killA = (state: WorldStateV2, lookup: ReturnType<typeof createLookup>, reasonCode = "阵亡") =>
  applyEffectsV2({ state, lookup, rng: createRng(1), logs: [] }, [
    { type: "setNpcLifecycle", npcId: "npc-a", state: "inactive", reasonCode },
  ]);

/** 让 ev-waiting 入队（action-hook 命中巡逻）。 */
function fireWaiting(state: WorldStateV2, template: WorldTemplateV2, lookup: ReturnType<typeof createLookup>) {
  advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);
  expect(state.pendingEvents.map((p) => p.eventId)).toEqual(["ev-waiting"]);
}

// ---------- ① 排队期间死亡 ⇒ 不再呈现、也不能结算（修复前必须为红） ----------

describe("ADR-0024 ①：排队期间角色死亡 ⇒ 该场景撤下", () => {
  it("投影不再呈现失效队首（pendingEventView 返回 null，且队列里也不再留着它）", () => {
    const { template, lookup, state } = setup("w-premise-1");
    fireWaiting(state, template, lookup);
    // 前置：fire 时前提为真，所以此刻**确实**在呈现（否则下面的断言可能只是空跑）
    expect(pendingEventView(state, lookup)?.eventId).toBe("ev-waiting");

    // 排队期间甲死了（另一条路径的副作用）
    killA(state, lookup);

    // ① 修复前：这里仍会拿到 ev-waiting（诈尸）。
    expect(pendingEventView(state, lookup), "失效队首不得继续呈现").toBeNull();

    // 排空也必须真的把它从队列里摘掉，否则自由行动会被槽位守卫永久拒绝（ADR 决策 2.5 的硬死锁）。
    const res = useItemV2(state, { itemId: "item-heal" }, template, lookup);
    expect(state.pendingEvents).toEqual([]);
    expect(res.snapshot.pendingEvent).toBeNull();
  });

  it("再提交旧 optionId 不可能成功：入口排空后队列已空 ⇒ no_pending_event", () => {
    const { template, lookup, state } = setup("w-premise-2");
    fireWaiting(state, template, lookup);
    killA(state, lookup);
    // 先让某个响应把队列排干净（模拟玩家在别的入口触发了一次规范化）
    useItemV2(state, { itemId: "item-heal" }, template, lookup);
    expect(() => chooseOptionV2(state, { optionId: "opt-wait" }, template, lookup)).toThrow(/no_pending_event/);
  });

  it("同一命令内先丢弃、再提交旧 optionId ⇒ event_premise_invalidated（区别于 option_not_available）", () => {
    const { template, lookup, state } = setup("w-premise-3");
    fireWaiting(state, template, lookup);
    killA(state, lookup);
    // 队列里只有这一个事件；chooseOptionV2 入口复核会先丢弃它，
    // 而 command.optionId 正属于被丢弃的那个事件 ⇒ 专用错误码。
    expect(() => chooseOptionV2(state, { optionId: "opt-wait" }, template, lookup)).toThrow(
      /event_premise_invalidated/,
    );
  });

  it("没有失效时队列照旧：不误删、不误判", () => {
    const { template, lookup, state } = setup("w-premise-4");
    fireWaiting(state, template, lookup);
    expect(revalidatePendingV2(state, lookup).dropped).toEqual([]);
    expect(state.pendingEvents.map((p) => p.eventId)).toEqual(["ev-waiting"]);
    const res = chooseOptionV2(state, { optionId: "opt-wait" }, template, lookup);
    expect(res.snapshot.pendingEvent).toBeNull();
    expect(state.pendingEvents).toEqual([]);
  });
});

// ---------- ④ 槽位让位不吞轮次 ----------

describe("ADR-0024 ④：丢弃不是结算（不占轮次、不写事实）", () => {
  it("丢弃前后 turnIndex/worldTime/age/history/eventFires/missedEvents 长度全不变", () => {
    const { template, lookup, state } = setup("w-premise-5");
    fireWaiting(state, template, lookup);
    killA(state, lookup);

    const before = {
      turnIndex: state.turnIndex,
      worldTime: state.worldTime,
      age: state.player.age,
      history: state.history.length,
      eventFires: state.eventFires.length,
      missedEvents: state.missedEvents.length,
      firedEvents: JSON.stringify(state.firedEvents),
    };
    const { dropped } = revalidatePendingV2(state, lookup);
    expect(dropped).toEqual(["ev-waiting"]);
    expect({
      turnIndex: state.turnIndex,
      worldTime: state.worldTime,
      age: state.player.age,
      history: state.history.length,
      eventFires: state.eventFires.length,
      missedEvents: state.missedEvents.length,
      firedEvents: JSON.stringify(state.firedEvents),
    }).toEqual(before);
  });

  it("队列清空后自由行动恢复正常推进（不因残留队首被 pending_event_required 拒绝）", () => {
    const { template, lookup, state } = setup("w-premise-6");
    fireWaiting(state, template, lookup);
    killA(state, lookup);
    const t0 = state.turnIndex;
    const res = advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(res.state.turnIndex).toBe(t0 + 1);
    expect(res.snapshot.pendingEvent).toBeNull();
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

// ---------- ⑥ 链条目被丢弃不伪装成 completed ----------

describe("ADR-0024 ⑥：链条目被丢弃 ⇒ 僵尸链如实暴露（不提前 completed）", () => {
  it("链仍为 active，而不是被假装成 completed", () => {
    const { lookup, state } = setup("w-premise-7");
    state.chains = [{ id: "chain-x", stepIndex: 0, status: "active", startedTurn: 0 }];
    state.pendingEvents = [{ eventId: "ev-chain-step", chainId: "chain-x" }];
    killA(state, lookup);

    const { dropped } = revalidatePendingV2(state, lookup);
    expect(dropped).toEqual(["ev-chain-step"]);
    // 决策 6：不处置链 —— stepIndex 不动、status 不动，evaluateChain 仍返回 active。
    expect(state.chains[0]).toMatchObject({ id: "chain-x", stepIndex: 0, status: "active" });
    expect(evaluateChain(state, lookup, "chain-x")).toBe("active");
  });
});

// ---------- ⑧ 旧档载入即清理 ----------

describe("ADR-0024 ⑧：旧档含失效队首 ⇒ 载入规范化", () => {
  it("一次性清掉所有失效条目，且状态仍能通过 schema 校验（零协议变更）", () => {
    const { lookup, state } = setup("w-premise-8");
    // 手工构造一个「旧档」：队列里塞两个失效条目 + 一个有效条目
    state.chains = [{ id: "chain-x", stepIndex: 0, status: "active", startedTurn: 0 }];
    state.pendingEvents = [
      { eventId: "ev-waiting" },
      { eventId: "ev-chain-step", chainId: "chain-x" },
    ];
    killA(state, lookup, "被宿傩夺舍");

    const { dropped } = revalidatePendingV2(state, lookup);
    expect(dropped).toEqual(["ev-waiting", "ev-chain-step"]); // 保序
    expect(state.pendingEvents).toEqual([]);
    // 零协议变更：PendingEvent 形状没改、schema 仍通过
    expect(WorldStateV2Schema.safeParse(state).success).toBe(true);
    // 幂等：再跑一次不再产生丢弃
    expect(revalidatePendingV2(state, lookup).dropped).toEqual([]);
  });

  it("前提为真的旧档条目原样保留（规范化不误伤）", () => {
    const { lookup, state } = setup("w-premise-9");
    state.pendingEvents = [{ eventId: "ev-waiting" }];
    expect(revalidatePendingV2(state, lookup).dropped).toEqual([]);
    expect(state.pendingEvents).toEqual([{ eventId: "ev-waiting" }]);
  });
});

// ---------- 诊断位 ----------

describe("ADR-0024 诊断位与附则", () => {
  it("同一轮内「fire 后立刻失效」：不呈现，且该事件从本次 triggeredEvents 里剔除", () => {
    const { template, lookup, state } = setup("w-premise-10");
    // 本轮顺序：action-hook 先 fire（此刻甲还在世）→ 结算后管线的 NPC 行动把甲写死。
    state.flags.killSwitch = true;
    const res = advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);

    // fire 事实照旧存在（事实层只追加，ADR 决策 3 第 3 条）
    expect(state.eventFires.some((f) => f.eventId === "ev-waiting")).toBe(true);
    // 但本次响应里不再呈现它，队列也被排空
    expect(res.snapshot.pendingEvent).toBeNull();
    expect(state.pendingEvents).toEqual([]);
    // 附则：同一响应不再报「已失效的场景」（否则 triggeredEvents 与 snapshot 自相矛盾）
    expect(res.triggeredEvents.map((t) => t.id)).not.toContain("ev-waiting");
  });

  it("droppedPending 是模块内诊断位：不进玩家端 API、不进存档（ADR 决策 4）", () => {
    const { template, lookup, state } = setup("w-premise-11");
    state.pendingEvents = [
      { eventId: "ev-waiting" },
      { eventId: "ev-chain-step", chainId: "chain-x" },
    ];
    killA(state, lookup);
    const res = advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    // 对外契约：V2TurnResult 不带这个字段（它是 TriggerResult 上的非持久化诊断位）
    expect("droppedPending" in res).toBe(false);
    expect(JSON.stringify(state)).not.toContain("droppedPending");
    // 丢弃本身仍然生效：两个条目都被排空（保序由 revalidatePendingV2 的返回值保证）
    expect(state.pendingEvents).toEqual([]);
  });
});
