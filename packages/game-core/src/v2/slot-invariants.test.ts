import { describe, expect, it } from "vitest";
import {
  WorldTemplateV2Schema,
  type WorldStateV2,
  type WorldTemplateV2,
} from "@life-sim/shared";
import { createLookup, type TemplateLookup } from "./lookup.js";
import { enqueueScheduled, scanDelayQueue } from "./scheduler.js";
import { advanceTurnV2, battleActionV2, chooseOptionV2, slotEventView, useItemV2 } from "./turn.js";
import { createActiveWorldV2 } from "./test-utils.js";
import { createRng } from "../rng.js";

/**
 * ADR-0034 §7 的 **G1 / G2 可断言用例**（六条，一一对应表格行）：
 *
 * | # | 现象 | 本文件的用例 |
 * |---|---|---|
 * | G1-1 | 后继被日常插队 | ① 事件 A 结算产生无延迟后继 B、队列里有到期的日常 C ⇒ `slot.eventId === B` 且 C 留队 |
 * | G1-2 | 战斗期间上桌日常 | ② combat 槽 ⇒ 战斗回合只接受战斗命令，normal 事件进不了槽 |
 * | G1-3 | 一轮结算多个事件 | ③ 任意入口返回后净 `turnIndex` 增量 ∈ {0, 1} |
 * | G1-4 | 摇出的随机支线被后续事件打断 | ④ pool 摇出（槽仍空）→ 取出占槽 → 结算后继 S ⇒ `slot.eventId === S` |
 * | G2-1 | 角色已死仍呈现其事件 | ⑤ 条件含「甲在世」的实例在甲退场后**仍在队列**，且不卡队头 |
 * | G2-2 | 上桌那一刻才判定 | ⑥ 条件成立时入队、失效后才到期 ⇒ 取出时求值为不可触发 |
 *
 * 这些用例断言的是 ADR 声称的**结构保证**，不是实现细节：改动内核若破坏 S1/S2/S4/S5，
 * 本文件必红。夹具全部合成，不依赖任何真实模板内容。
 */

// ---------- 合成夹具 ----------

const REST = { action: { type: "rest", description: "" } };
const PATROL = { action: { type: "patrol", description: "" } };

const RAW: Record<string, unknown> = {
  meta: { id: "t-slot", name: "槽不变量", description: "d", startYear: 2000, engineProtocol: "v2" },
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
      // 只用「轻拍」：让玩家能在战斗里活过多轮（战斗回合的 0 增量才可观察）
      skills: ["sk-tap"],
      public: {},
      private: { combatHints: { skillWeights: { "sk-tap": 1 } } },
      relationship: -100,
    },
  ],
  playerTemplate: { identity: { gender: "f", age: 16 }, attributes: { power: 10 }, skills: ["sk-strike"] },
  actions: [
    { id: "rest", label: "休息", duration: { value: 1, unit: "hour" } },
    { id: "patrol", label: "巡逻", duration: { value: 1, unit: "hour" } },
  ],
  skills: [
    {
      id: "sk-strike",
      kind: "combat",
      name: "斩击",
      cost: { mp: 0 },
      target: "enemy",
      damage: [{ preset: "fixed", value: 999 }],
      cooldownTurns: 0,
      usableInBattle: true,
    },
    {
      id: "sk-tap",
      kind: "combat",
      name: "轻拍",
      cost: { mp: 0 },
      target: "enemy",
      damage: [{ preset: "fixed", value: 1 }],
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
  events: [],
};

const EV = {
  /** A：结算后产生**无时间账**的后继 B。 */
  a: {
    id: "ev-a",
    title: "事件 A",
    narrative: "A 的正文。",
    trigger: { source: "chain" },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-a", text: "继续", nextEventId: "ev-b" }] } },
  },
  /** B：A 的后继（无 delay ⇒ 直接占槽）。 */
  b: {
    id: "ev-b",
    title: "事件 B",
    narrative: "B 的正文。",
    trigger: { source: "chain" },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  },
  /** C：队列里「已到期的日常」，没有任何写槽权限。 */
  c: {
    id: "ev-c",
    title: "日常 C",
    narrative: "C 的正文。",
    trigger: { source: "chain" },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  },
  /** P：pool 摇出的支线起点；带 1 天窗口 ⇒ 摇出当轮**不会**被取出（可观察"摇出不写槽"）。 */
  p: {
    id: "ev-p",
    title: "随机支线 P",
    narrative: "P 的正文。",
    trigger: { source: "pool", probability: 1, priority: 50, once: true, window: { start: { value: 1, unit: "day" } } },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-p", text: "继续", nextEventId: "ev-s" }] } },
  },
  /** S：P 结算后的无延迟后继。 */
  s: {
    id: "ev-s",
    title: "支线后继 S",
    narrative: "S 的正文。",
    trigger: { source: "chain" },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  },
  /** 条件含「甲在世」的实例（G2-1）。 */
  gated: {
    id: "ev-gated",
    title: "点名甲的场景",
    narrative: "正文点名了甲。",
    trigger: { source: "chain", conditions: [{ npcState: { npcId: "npc-a", state: "alive" } }] },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  },
  /** 无条件的队尾实例：用来证明「失效实例不卡队头」（G2-1）。 */
  free: {
    id: "ev-free",
    title: "无前提的场景",
    narrative: "无需前提。",
    trigger: { source: "chain" },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  },
  /** 条件在入队时成立、到期时可能已失效（G2-2）。 */
  dueCond: {
    id: "ev-due-cond",
    title: "到期的条件场景",
    narrative: "到期时才判定条件。",
    trigger: { source: "chain", window: { start: { value: 1, unit: "day" } }, conditions: [{ flag: "ready", eq: true }] },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  },
  /** 战斗事件（G1-2 / G1-3）。 */
  combat: {
    id: "ev-combat",
    title: "遭遇战",
    narrative: "敌人出现。",
    trigger: { source: "action-hook", onActionId: "patrol", probability: 1 },
    kind: "combat",
    settle: { combat: { enemies: [{ ref: "enemy-x", levelScale: 1 }], onVictory: { effects: [] } } },
  },
} as const;

function template(events: unknown[]): WorldTemplateV2 {
  return WorldTemplateV2Schema.parse({ ...structuredClone(RAW), events });
}

function world(events: unknown[], worldId: string, seed = 3): {
  state: WorldStateV2;
  template: WorldTemplateV2;
  lookup: TemplateLookup;
} {
  const tpl = template(events);
  const lookup = createLookup(tpl);
  const state = createActiveWorldV2({ templateId: "t-slot", playerName: "测试者", seed }, tpl, worldId);
  state.player.inventory["item-heal"] = 3;
  return { state, template: tpl, lookup };
}

/** 把「已到期」的实例放进队列（`start` 用当前世界时间 ⇒ 立刻可取）。 */
function enqueueDue(state: WorldStateV2, definitionId: string): void {
  enqueueScheduled({ state, definitionId, origin: { kind: "effect", id: definitionId } });
}

const killA = (state: WorldStateV2): void => {
  const npc = state.npcs.find((n) => n.id === "npc-a")!;
  npc.lifecycle = { state: "inactive", reasonCode: "阵亡", sinceTurn: state.turnIndex, sinceWorldTime: state.worldTime };
};

// ---------- G1-1 ----------

describe("G1-1 · 后继不被日常插队（结构保证 S4：日常没有写槽的入口）", () => {
  it("A 结算产生无延迟后继 B、队列里有到期的日常 C ⇒ slot.eventId === B 且 C 仍在 delayQueue", () => {
    const { state, template: tpl, lookup } = world([EV.a, EV.b, EV.c], "w-g11");
    enqueueDue(state, "ev-c"); // C 已到期、就在队列里
    state.slot = { eventId: "ev-a", from: "queueTake" };

    chooseOptionV2(state, { optionId: "opt-a" }, tpl, lookup);

    // 后继直接占槽，且可审计地指回上一事件
    expect(state.slot).toEqual({ eventId: "ev-b", from: "successor", fromEventId: "ev-a" });
    // 日常 C 一条都没被消费：仍在队列、状态 waiting、不产生错失
    const c = state.delayQueue.filter((i) => i.definitionId === "ev-c");
    expect(c).toHaveLength(1);
    expect(c[0].status).toBe("waiting");
    expect(state.missedEvents).toEqual([]);
  });
});

// ---------- G1-2 ----------

describe("G1-2 · 战斗期间任何 normal 事件不得进入槽（结构保证 S1/S4）", () => {
  it("combat 槽 ⇒ 战斗回合只接受战斗命令；已到期的 normal 事件留在队列、碰不到槽", () => {
    const { state, template: tpl, lookup } = world([EV.combat, EV.c], "w-g12");
    advanceTurnV2(state, PATROL, tpl, lookup);
    expect(state.slot).toMatchObject({ eventId: "ev-combat", from: "hook" });
    expect(slotEventView(state, lookup)).toMatchObject({ eventId: "ev-combat", kind: "combat" });

    // 队列里放一条已到期的 normal：它没有写槽的入口（槽是标量，且战斗占着）
    enqueueDue(state, "ev-c");
    // 拉高敌人血量，保证这一回合**打不完**（战斗未结束才是「战斗回合 0 增量」的场景）
    state.battle!.enemies[0].hp = 100000;
    state.battle!.enemies[0].maxHp = 100000;
    const before = state.turnIndex;

    // 战斗回合：只接受战斗命令，且**不推进轮次**（战斗是槽的内部过程，§8-⑦）
    battleActionV2(state, { type: "skill", skillId: "sk-strike" }, tpl, lookup);
    expect(state.battle, "战斗会话在结束前必须仍在").not.toBeNull();
    expect(state.battle!.over).toBeNull();
    expect(state.turnIndex).toBe(before); // 战斗未结束 ⇒ 0 增量
    // normal 事件仍未上桌
    expect(state.slot?.eventId).toBe("ev-combat");
    expect(state.delayQueue.find((i) => i.definitionId === "ev-c")?.status).toBe("waiting");
  });
});

// ---------- G1-3 ----------

describe("G1-3 · 任何入口返回后净 turnIndex 增量 ∈ {0, 1}（结构保证 S2）", () => {
  it("自由行动 / 结算 / 战斗回合 / 战斗结算 / 转盘确认 / 轮外物品 / 被拒调用 全部落在 {0,1} 且没有 2", () => {
    const { state, template: tpl, lookup } = world([EV.combat, EV.a, EV.b], "w-g13");
    const deltas: Array<{ entry: string; delta: number }> = [];
    const record = (entry: string, fn: () => void): void => {
      const before = state.turnIndex;
      fn();
      deltas.push({ entry, delta: state.turnIndex - before });
    };

    // ① 自由行动：+1
    record("advanceTurnV2(free)", () => advanceTurnV2(state, PATROL, tpl, lookup));
    // ② 战斗回合（未结束）：0
    if (state.slot?.eventId === "ev-combat") {
      record("battleActionV2(mid)", () => battleActionV2(state, { type: "skill", skillId: "sk-strike" }, tpl, lookup));
      // ③ 战斗结算（结束）：+1
      while (state.battle !== null && !state.battle.over) {
        record("battleActionV2(round)", () =>
          battleActionV2(state, { type: "skill", skillId: "sk-strike" }, tpl, lookup),
        );
      }
    }
    // ④ 轮外物品：0
    record("useItemV2", () => useItemV2(state, { itemId: "item-heal" }, tpl, lookup));
    // ⑤ 结算一条槽内事件：+1
    state.slot = { eventId: "ev-a", from: "queueTake" };
    record("chooseOptionV2", () => chooseOptionV2(state, { optionId: "opt-a" }, tpl, lookup));
    // ⑥ 后继 B 的结算：+1
    record("chooseOptionV2(successor)", () => chooseOptionV2(state, { optionId: "opt-ok" }, tpl, lookup));
    // ⑦ 被拒调用（槽空时提交选项）：0
    record("chooseOptionV2(rejected)", () => {
      expect(() => chooseOptionV2(state, { optionId: "opt-ok" }, tpl, lookup)).toThrow("no_pending_event");
    });

    // 断言：每条都在 {0,1}，绝无 2（"一轮结算两个事件"的旧缺陷形态）
    for (const d of deltas) {
      expect([0, 1], `入口 ${d.entry} 的净增量应为 0 或 1，实为 ${d.delta}`).toContain(d.delta);
    }
    // 覆盖面自检：至少真的观测到了 0 与 1 两种增量（否则上面的循环可能是空跑）
    expect(deltas.some((d) => d.delta === 0)).toBe(true);
    expect(deltas.some((d) => d.delta === 1)).toBe(true);
    // 全流程累计 ≤ 入口次数（没有一次调用偷偷翻两轮）
    expect(state.turnIndex).toBeLessThanOrEqual(deltas.length);
  });
});

// ---------- G1-4 ----------

describe("G1-4 · pool 摇出的支线可以连续占槽（§10 裁决：来源只影响「能否直接占槽」）", () => {
  it("摇出（槽仍 null）→ 被取出占槽（from: queueTake）→ 结算产生后继 S ⇒ slot.eventId === S", () => {
    const { state, template: tpl, lookup } = world([EV.p, EV.s], "w-g14");

    // ① 摇出：pool 只写队列。P 带 1 天窗口 ⇒ 摇出当轮扫不到它 ⇒ 槽仍为 null
    advanceTurnV2(state, REST, tpl, lookup);
    expect(state.slot, "摇出动作本身不得写槽").toBeNull();
    const queuedP = state.delayQueue.filter((i) => i.definitionId === "ev-p");
    expect(queuedP).toHaveLength(1);
    expect(queuedP[0].origin.kind).toBe("pool");
    expect(queuedP[0].status).toBe("waiting");

    // ② 到期后被取出占槽：`from` 必须是 queueTake（证明写点不是 pool）
    state.worldTime = queuedP[0].window.start;
    advanceTurnV2(state, REST, tpl, lookup);
    expect(state.slot).toMatchObject({ eventId: "ev-p", from: "queueTake" });

    // ③ 结算 P ⇒ 无延迟后继 S 直接占槽（连续支线成立）
    chooseOptionV2(state, { optionId: "opt-p" }, tpl, lookup);
    expect(state.slot).toEqual({ eventId: "ev-s", from: "successor", fromEventId: "ev-p" });
  });
});

// ---------- G2-1 ----------

describe("G2-1 · 前提失效的实例留在队列、且不卡队头（§3-3 死结论）", () => {
  it("甲退场后 nextTurn ⇒ 该实例仍在 delayQueue，队尾的事件照常被取出", () => {
    const { state, template: tpl, lookup } = world([EV.gated, EV.free], "w-g21");
    // 先入队「失效后仍要到」的那条，再入队无前提的那条（enqueueSeq 保证前者在队头）
    enqueueDue(state, "ev-gated");
    enqueueDue(state, "ev-free");
    killA(state);

    // 直接问扫描：队头 hold ⇒ 继续扫下一个（不丢弃、不卡队头）
    const scanned = scanDelayQueue(state, lookup, createRng(5));
    expect(scanned.kind).toBe("taken");
    if (scanned.kind === "taken") expect(scanned.definition.id).toBe("ev-free");

    // 完整入口同样结论
    const { state: s2, template: t2, lookup: l2 } = world([EV.gated, EV.free], "w-g21b");
    enqueueDue(s2, "ev-gated");
    enqueueDue(s2, "ev-free");
    killA(s2);
    advanceTurnV2(s2, REST, t2, l2);
    expect(s2.slot).toMatchObject({ eventId: "ev-free", from: "queueTake" });
    // 失效实例仍在队列等待（条件可能再变真），既没被丢弃也没记错失
    const gated = s2.delayQueue.filter((i) => i.definitionId === "ev-gated");
    expect(gated).toHaveLength(1);
    expect(gated[0].status).toBe("waiting");
    expect(s2.missedEvents).toEqual([]);
  });
});

// ---------- G2-2 ----------

describe("G2-2 · 求值时点固定在「被取出那一刻」（§3-4）", () => {
  it("入队时条件成立、到期时已失效 ⇒ 到期那轮判定为不可触发（hold），条件恢复后才上桌", () => {
    const { state, template: tpl, lookup } = world([EV.dueCond], "w-g22");
    state.flags.ready = true; // 入队时成立
    // 按定义声明的窗口入队（1 天后到期）；入队那一轮条件为真，但求值不发生在入队时
    enqueueScheduled({
      state,
      definitionId: "ev-due-cond",
      origin: { kind: "effect", id: "ev-due-cond" },
      start: { value: 1, unit: "day" },
    });
    const inst = state.delayQueue[0];
    expect(inst.window.start).toBe(1440);

    // 到期前条件失效
    state.flags.ready = false;
    state.worldTime = 1440;
    expect(scanDelayQueue(state, lookup, createRng(7))).toEqual({ kind: "none" }); // 取出时求值 ⇒ hold
    expect(state.delayQueue[0].status).toBe("waiting");

    // 通过完整入口再确认一次（仍不上桌）
    advanceTurnV2(state, REST, tpl, lookup);
    expect(state.slot).toBeNull();

    // 条件恢复 ⇒ 同一实例被取出（说明判定不是发生在入队那一刻）
    state.flags.ready = true;
    const taken = scanDelayQueue(state, lookup, createRng(7));
    expect(taken.kind).toBe("taken");
    if (taken.kind === "taken") expect(taken.definition.id).toBe("ev-due-cond");
  });
});
