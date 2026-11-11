import { describe, expect, it } from "vitest";
import type { EventV2, WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { createActiveWorldV2 } from "./test-utils.js";
import {
  advanceTurnV2,
  battleActionV2,
  chooseOptionV2,
  useItemV2,
} from "./turn.js";
import { alignChainStep, enqueueScheduled, recordFire } from "./scheduler.js";
import { applyEffectsV2, type EffectContextV2 } from "./engine.js";

/**
 * R2.5 验收用例（T1-07 / test-design §3.7 / §3.9）：
 * 槽位不变量、结算轮与 timeCost、战斗结束/用物品、确定性、玩家端投影边界。
 * 四条口径：正常路径 / 边界条件 / 无效输入 / 类型检查（pnpm typecheck）。
 */

function normal(id: string, trigger: EventV2["trigger"]): EventV2 {
  return {
    id,
    title: `事件 ${id}`,
    narrative: "R2.5 验收事件。",
    trigger,
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  } as EventV2;
}

function makeTemplate(events: EventV2[]): WorldTemplateV2 {
  return {
    meta: { id: "t-r25", name: "R2.5 验收", description: "d", startYear: 2000, engineProtocol: "v2" },
    time: { defaultStep: { value: 1, unit: "hour" } },
    genders: [{ id: "f", label: "女" }],
    mood: {
      min: 0,
      max: 100,
      defaultValue: 60,
      bands: [{ id: "normal", label: "平静", min: 0, max: 100, attributeModifiers: {} }],
    },
    statusBar: [{ id: "sb1", label: "基本", source: "identity" }],
    attributes: { order: ["str"], defaults: { str: 5 } },
    resources: { hp: { base: 100 }, mp: { base: 50 } },
    regen: { perTurn: { hp: 0, mp: 0 } },
    characters: [],
    skills: [],
    items: [
      {
        id: "item-potion",
        type: "consumable",
        name: "药剂",
        stackable: true,
        usableInBattle: true,
        usableOutsideBattle: true,
        use: [{ type: "adjustMood", value: 1 }],
      },
    ],
    statuses: [],
    events,
    actions: [{ id: "rest", label: "休息", duration: { value: 1, unit: "hour" } }],
  } as unknown as WorldTemplateV2;
}

function world(template: WorldTemplateV2, seed = 11): WorldStateV2 {
  return createActiveWorldV2({ templateId: "t-r25", playerName: "验收者", seed }, template, `w-r25-${seed}`);
}

const REST = { action: { type: "rest", description: "" } };

describe("T1-07 · 槽位守卫与结算轮（#34 / R-EV-01/02/14）", () => {
  it("正常：结算推进 turnIndex +1；timeCost 缺省 0 ⇒ worldTime 不变、elapsed 为 0", () => {
    const template = makeTemplate([normal("ev-free", { source: "chain" })]);
    const lookup = createLookup(template);
    const state = world(template);
    state.pendingEvents = [{ eventId: "ev-free" }];

    const res = chooseOptionV2(state, { optionId: "opt-ok" }, template, lookup);
    expect(state.turnIndex).toBe(1);
    expect(state.worldTime).toBe(0);
    expect(res.elapsed).toEqual({ value: 0, unit: "minute" });
    // 结算释放槽位：另一条自由行动可以正常提交
    expect(() => advanceTurnV2(state, REST, template, lookup)).not.toThrow();
    expect(state.turnIndex).toBe(2);
  });

  it("正常：timeCost 非 0 ⇒ worldTime 按分钟推进、elapsed 反映耗时、年龄按适配器重算", () => {
    const template = makeTemplate([
      normal("ev-cost", { source: "chain", timeCost: { value: 2, unit: "hour" } }),
    ]);
    const lookup = createLookup(template);
    const state = world(template);
    state.pendingEvents = [{ eventId: "ev-cost" }];

    const res = chooseOptionV2(state, { optionId: "opt-ok" }, template, lookup);
    expect(state.worldTime).toBe(120);
    expect(res.elapsed).toEqual({ value: 2, unit: "hour" });
    expect(state.turnIndex).toBe(1);
    expect(state.player.age).toBe(state.playerAgeAtStart);
  });

  it("边界：待决事件占槽时自由行动被拒绝（pending_event_required 收窄语义）", () => {
    const template = makeTemplate([normal("ev-free", { source: "chain" })]);
    const lookup = createLookup(template);
    const state = world(template);
    state.pendingEvents = [{ eventId: "ev-free" }];
    const before = structuredClone(state);
    expect(() => advanceTurnV2(state, REST, template, lookup)).toThrow("pending_event_required");
    expect(state).toEqual(before); // 拒绝时逐字段不变
  });

  it("无效输入：未知选项 / 无待决事件分别给可诊断错误", () => {
    const template = makeTemplate([normal("ev-free", { source: "chain" })]);
    const lookup = createLookup(template);
    const state = world(template);
    expect(() => chooseOptionV2(state, { optionId: "opt-missing" }, template, lookup)).toThrow("no_pending_event");
    state.pendingEvents = [{ eventId: "ev-free" }];
    expect(() => chooseOptionV2(state, { optionId: "opt-missing" }, template, lookup)).toThrow("option_not_available");
  });

  it("用物品是轮外操作：不推进 turnIndex、不推进 worldTime", () => {
    const template = makeTemplate([]);
    const lookup = createLookup(template);
    const state = world(template);
    state.player.inventory["item-potion"] = 1;
    const beforeTurn = state.turnIndex;
    const beforeTime = state.worldTime;

    const res = useItemV2(state, { itemId: "item-potion" }, template, lookup);
    expect(state.turnIndex).toBe(beforeTurn);
    expect(state.worldTime).toBe(beforeTime);
    expect(res.elapsed).toEqual({ value: 0, unit: "minute" });
    expect(state.player.inventory["item-potion"]).toBeUndefined();
  });
});

describe("T1-07 · 战斗结束算一次结算轮（R-EV-14）", () => {
  it("战斗回合内不推进，战斗结束推进一次 turnIndex 且战果留在槽位", () => {
    const template = makeTemplate([
      {
        id: "ev-combat",
        title: "遭遇战",
        narrative: "敌人出现。",
        trigger: { source: "action-hook", onActionId: "patrol", probability: 1 },
        kind: "combat",
        settle: { combat: { enemies: [{ ref: "enemy-x", levelScale: 1 }], onVictory: { effects: [] } } },
      } as EventV2,
    ]);
    // 最小战斗依赖：敌方角色 + 一击必杀技能
    template.characters = [
      {
        id: "enemy-x",
        isEnemy: true,
        visibility: "public",
        identity: { name: "测试敌", age: 0, gender: "f" },
        mood: { value: 50 },
        attributes: {},
        skills: [],
        public: { personality: "测试用" },
        private: {},
        relationship: -100,
      },
    ] as unknown as WorldTemplateV2["characters"];
    template.skills = [
      {
        id: "sk-strike",
        kind: "combat",
        name: "强击",
        cost: { mp: 0 },
        target: "enemy",
        damage: [{ preset: "fixed", value: 999 }],
        cooldownTurns: 0,
        usableInBattle: true,
      },
    ] as unknown as WorldTemplateV2["skills"];
    template.playerTemplate = {
      identity: { age: 16, gender: "f" },
      skills: ["sk-strike"],
    } as unknown as WorldTemplateV2["playerTemplate"];
    template.actions = [
      { id: "patrol", label: "巡逻", duration: { value: 1, unit: "hour" } },
    ] as unknown as WorldTemplateV2["actions"];
    const lookup = createLookup(template);
    const state = world(template);

    advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);
    expect(state.battle).not.toBeNull();
    const turnAtBattleStart = state.turnIndex;
    expect(state.battle!.enemies[0].hp).toBeGreaterThan(0);

    const res = battleActionV2(state, { type: "skill", skillId: "sk-strike" }, template, lookup);
    expect(state.battle).toBeNull();
    expect(state.turnIndex).toBe(turnAtBattleStart + 1);
    expect(res.triggeredEvents.some((e) => e.title.includes("战斗"))).toBe(true);
  });
});

describe("T1-04/06 · 效果 DSL 接线与链步单一推进规则", () => {
  it("enqueueEvent 效果：按 delay 相对入队时刻固化窗口，ctx.enqueued 可供路由层 drain", () => {
    const template = makeTemplate([
      normal("ev-target", { source: "chain" }),
      normal("ev-sched", { source: "schedule", window: { start: { value: 1, unit: "day" } } }),
    ]);
    const lookup = createLookup(template);
    const state = world(template);
    const ctx: EffectContextV2 = { state, lookup, rng: () => 0.5, logs: [] };

    applyEffectsV2(ctx, [{ type: "enqueueEvent", eventId: "ev-target", delay: { value: 2, unit: "hour" } }]);
    expect(ctx.enqueued).toEqual(["ev-target"]);
    const inst = state.scheduledEvents.find(
      (i) => i.definitionId === "ev-target" && i.origin.kind === "effect",
    );
    expect(inst?.window.start).toBe(120);
    expect(inst?.hasEnd).toBe(false);
    expect(inst?.status).toBe("waiting");
    // createWorldV2 已为 schedule 定义入队一条 schedule-init 实例（窗口 1 天），互不干扰
    expect(state.scheduledEvents.some((i) => i.origin.kind === "schedule-init" && i.window.start === 1440)).toBe(true);
  });

  it("无效输入：enqueueEvent 引用未知事件直接抛可诊断错误，不静默吞掉", () => {
    const template = makeTemplate([]);
    const lookup = createLookup(template);
    const state = world(template);
    const ctx: EffectContextV2 = { state, lookup, rng: () => 0.5, logs: [] };
    expect(() => applyEffectsV2(ctx, [{ type: "enqueueEvent", eventId: "ev-missing" }])).toThrow(
      /enqueueEvent 引用未知事件/,
    );
    expect(state.scheduledEvents).toHaveLength(0);
  });

  it("advanceChain 效果收口到 alignChainStep：无 nextTurn 步时不盲目 +1", () => {
    const template = makeTemplate([
      normal("ev-a", { source: "chain" }),
      normal("ev-b", { source: "chain" }),
    ]);
    template.chains = [
      {
        id: "chain-a",
        startEventId: "ev-a",
        steps: [
          { eventId: "ev-a", advanceWhen: "onSettle" },
          { eventId: "ev-b", advanceWhen: "onSettle" },
        ],
      },
    ] as unknown as WorldTemplateV2["chains"];
    const lookup = createLookup(template);
    const state = world(template);
    state.chains.push({ id: "chain-a", stepIndex: 0, status: "active", startedTurn: 0 });

    applyEffectsV2({ state, lookup, rng: () => 0.5, logs: [] }, [{ type: "advanceChain", chainId: "chain-a" }]);
    expect(state.chains[0].stepIndex).toBe(0); // 旧实现会盲目 +1 ⇒ 1
    // 结算对齐与效果是同一条规则，重复对齐幂等
    alignChainStep(state, "chain-a", lookup, "ev-b");
    alignChainStep(state, "chain-a", lookup, "ev-b");
    expect(state.chains[0].stepIndex).toBe(1);
    expect(state.chains[0].status).toBe("active");
  });
});

describe("T1-09 · 确定性与玩家端投影边界", () => {
  it("同 seed 同输入逐字段一致（含新事实层 / 队列 / 计数器）", () => {
    const template = makeTemplate([
      normal("ev-chain-a", { source: "chain", timeCost: { value: 30, unit: "minute" } }),
      normal("ev-sched", { source: "schedule", window: { start: { value: 1, unit: "hour" } } }),
    ]);
    const run = (): WorldStateV2 => {
      const lookup = createLookup(template);
      const state = world(template, 77);
      // 注入一次手工触发与一次效果入队，扩大状态面
      recordFire(state, "ev-chain-a");
      enqueueScheduled({
        state,
        definitionId: "ev-sched",
        origin: { kind: "effect", id: "test" },
        start: { value: 1, unit: "hour" },
      });
      state.pendingEvents = [{ eventId: "ev-chain-a" }];
      chooseOptionV2(state, { optionId: "opt-ok" }, template, lookup);
      advanceTurnV2(state, REST, template, lookup);
      return state;
    };
    expect(run()).toEqual(run());
  });

  it("hidden 与实例层/事实层字段不进入玩家端投影", () => {
    const template = makeTemplate([normal("ev-free", { source: "chain" })]);
    const lookup = createLookup(template);
    const state = world(template);
    state.pendingEvents = [{ eventId: "ev-free" }];
    recordFire(state, "ev-free");
    enqueueScheduled({
      state,
      definitionId: "ev-free",
      origin: { kind: "effect", id: "test" },
      start: { value: 1, unit: "day" },
    });
    const snapshot = chooseOptionV2(state, { optionId: "opt-ok" }, template, lookup).snapshot as unknown as Record<
      string,
      unknown
    >;
    for (const key of [
      "scheduledEvents",
      "enqueueSeqCounter",
      "missedEvents",
      "eventFires",
      "lastFiredIndex",
      "firedEvents",
      "chains",
      "flags",
      "termination",
    ]) {
      expect(Object.keys(snapshot)).not.toContain(key);
    }
    // npcs / activeChains 是既有白名单投影：只允许公开字段，隐藏字段一律不出现。
    const projectedNpcs = snapshot["npcs"] as Array<Record<string, unknown>> | undefined;
    for (const npc of projectedNpcs ?? []) {
      for (const key of ["goals", "traits", "knowledge", "secrets", "isEnemy"]) {
        expect(Object.keys(npc)).not.toContain(key);
      }
    }
    const projectedChains = snapshot["activeChains"] as Array<Record<string, unknown>> | undefined;
    for (const chain of projectedChains ?? []) {
      for (const key of ["stepIndex", "startedTurn"]) expect(Object.keys(chain)).not.toContain(key);
    }
  });
});
