import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { WorldTemplateV2Schema, type WorldTemplateV2 } from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { createActiveWorldV2 } from "./test-utils.js";
import { createBattle, resolveCombatRefs } from "./battle.js";
import { advanceTurnV2, SKIP_ALL_ENEMIES_INACTIVE } from "./turn.js";
import type { WorldStateV2 } from "@life-sim/shared";

/**
 * 参战 ref 判活（ADR-0021 决策 1）的契约测试。
 *
 * 判据单一入口 = `resolveCombatRefs`：**有同 id 实例且 lifecycle != alive ⇒ 移出**；
 * **无实例 ⇒ 视为可用**（模板敌人永不实例化，误判会把全部战斗清空）。
 * 处置：敌人耗尽 ⇒ 整条触发跳过（与既有 combat 并发 skip 同处、同口径）；友军耗尽 ⇒ 照常打。
 */

const RAW_TEMPLATE: Record<string, unknown> = {
  meta: { id: "t-refs", name: "判活测试", description: "d", startYear: 2000, engineProtocol: "v2" },
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
    // 有实例的 NPC（非敌人 ⇒ createWorldV2 会建实例）：友军/「被实例化的敌人」两种用法都测
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
      id: "npc-b",
      isEnemy: false,
      identity: { name: "乙", age: 18, gender: "f" },
      visibility: "public",
      mood: { value: 60 },
      attributes: { power: 4 },
      skills: ["sk-strike"],
      public: {},
      private: {},
      relationship: 10,
    },
    // 纯模板敌人（isEnemy ⇒ 无实例），复刻 jjk-2006 的 enemy-* 事实
    {
      id: "enemy-x",
      isEnemy: true,
      identity: { name: "咒灵X", age: 0, gender: "f" },
      visibility: "public",
      mood: { value: 50 },
      attributes: { power: 6 },
      skills: ["sk-strike"],
      public: {},
      private: {},
      relationship: -100,
    },
    {
      id: "enemy-y",
      isEnemy: true,
      identity: { name: "咒灵Y", age: 0, gender: "f" },
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
  actions: [{ id: "patrol", label: "巡逻", duration: { value: 1, unit: "hour" } }],
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
  items: [],
  statuses: [],
  events: [
    {
      id: "ev-ambush",
      title: "遇袭",
      narrative: "敌人出现！",
      // once + 冷却：用于验证「跳过不消耗 once/冷却」
      trigger: { source: "action-hook", onActionId: "patrol", probability: 1, once: true, cooldown: { value: 1, unit: "day" } },
      kind: "combat",
      settle: {
        combat: {
          enemies: [{ ref: "npc-a" }],
          onVictory: { effects: [{ type: "setFlag", id: "won", value: true }] },
        },
      },
    },
  ],
};

function makeTemplate(): WorldTemplateV2 {
  return WorldTemplateV2Schema.parse(structuredClone(RAW_TEMPLATE));
}

function setup(worldId: string, seed = 3) {
  const template = makeTemplate();
  const lookup = createLookup(template);
  const state = createActiveWorldV2({ templateId: template.meta.id, playerName: "测试者", seed }, template, worldId);
  return { template, lookup, state };
}

const setLifecycle = (state: WorldStateV2, npcId: string, lifecycle: "alive" | "inactive" | "unspawned") => {
  state.npcs.find((n) => n.id === npcId)!.lifecycle = { state: lifecycle, sinceTurn: 0, sinceWorldTime: 0 };
};

describe("参战 ref 判活（ADR-0021 决策 1.1）", () => {
  it("敌人在 state.npcs 里且非 alive ⇒ 移出参战列表，其余敌人照常", () => {
    const { state, lookup } = setup("w-refs-1");
    setLifecycle(state, "npc-a", "inactive");
    const resolved = resolveCombatRefs({ enemies: [{ ref: "npc-a" }, { ref: "enemy-x" }] }, state, lookup);
    expect(resolved.enemies.map((r) => r.ref)).toEqual(["enemy-x"]);
    expect(resolved.enemiesExhausted).toBe(false);
    expect(resolved.inactiveNpcIds).toEqual(["npc-a"]);

    // 建场侧同口径：死者不参战
    const battle = createBattle("ev-t", { enemies: [{ ref: "npc-a" }, { ref: "enemy-x" }] }, state, lookup);
    expect(battle.enemies.map((e) => e.characterId)).toEqual(["enemy-x"]);
  });

  it("敌人无同 id 实例（纯模板敌人定义）⇒ 视为可用，不因「无实例」被挡", () => {
    const { state, lookup } = setup("w-refs-2");
    // 世界初始化只实例化非敌人角色：enemy-* 全部无实例
    expect(state.npcs.some((n) => n.id === "enemy-y")).toBe(false);
    const resolved = resolveCombatRefs({ enemies: [{ ref: "enemy-x" }, { ref: "enemy-y", levelScale: 2 }] }, state, lookup);
    expect(resolved.enemies.map((r) => r.ref)).toEqual(["enemy-x", "enemy-y"]);
    expect(resolved.enemiesExhausted).toBe(false);
    expect(resolved.inactiveNpcIds).toEqual([]);
  });

  it("unspawned 与 inactive 同属「确知非在世」⇒ 都移出；alive 才参战", () => {
    const { state, lookup } = setup("w-refs-3");
    setLifecycle(state, "npc-a", "unspawned");
    expect(resolveCombatRefs({ enemies: [{ ref: "npc-a" }] }, state, lookup).enemies).toEqual([]);
    setLifecycle(state, "npc-a", "alive");
    expect(resolveCombatRefs({ enemies: [{ ref: "npc-a" }] }, state, lookup).enemies).toEqual([{ ref: "npc-a" }]);
  });

  it("判活与 lookup 解耦：同一 ref 在 NPC alive 时参战、改为 inactive 后不参战", () => {
    const { state, lookup } = setup("w-refs-4");
    const settle = { enemies: [{ ref: "npc-a" }, { ref: "enemy-x" }] };
    expect(resolveCombatRefs(settle, state, lookup).enemies.map((r) => r.ref)).toEqual(["npc-a", "enemy-x"]);
    setLifecycle(state, "npc-a", "inactive");
    expect(resolveCombatRefs(settle, state, lookup).enemies.map((r) => r.ref)).toEqual(["enemy-x"]);
    // 模板定义本身不会被修改（判活是纯读 state，不写 lookup）
    expect(lookup.character("npc-a")).toBeDefined();
  });

  it("未知 ref 仍抛 character_not_found（引用完整性先于判活，不被过滤静默吞掉）", () => {
    const { state, lookup } = setup("w-refs-5");
    expect(() => resolveCombatRefs({ enemies: [{ ref: "npc-ghost" }] }, state, lookup)).toThrow(/character_not_found/);
  });

  it("友军全非在世但敌人可用 ⇒ 照常建场，allies 为空数组", () => {
    const { state, lookup } = setup("w-refs-6");
    setLifecycle(state, "npc-a", "inactive");
    setLifecycle(state, "npc-b", "inactive");
    const resolved = resolveCombatRefs(
      { enemies: [{ ref: "enemy-x" }], allies: [{ ref: "npc-a" }, { ref: "npc-b" }] },
      state,
      lookup,
    );
    expect(resolved.allies).toEqual([]);
    expect(resolved.enemiesExhausted).toBe(false);

    const battle = createBattle(
      "ev-sj",
      { enemies: [{ ref: "enemy-x" }], allies: [{ ref: "npc-a" }, { ref: "npc-b" }], canFlee: true },
      state,
      lookup,
    );
    expect(battle.allies).toEqual([]);
    expect(battle.enemies.map((e) => e.characterId)).toEqual(["enemy-x"]);
  });
});

describe("敌人耗尽 ⇒ 整条触发跳过（ADR-0021 决策 1.2）", () => {
  it("不建场、零事实写入、不耗 once/冷却、不白送 onVictory", () => {
    const { template, lookup, state } = setup("w-refs-7");
    setLifecycle(state, "npc-a", "inactive");
    // 前置：判活谓词与触发器一致（触发门用的就是同一个 enemiesExhausted）
    expect(resolveCombatRefs({ enemies: [{ ref: "npc-a" }] }, state, lookup).enemiesExhausted).toBe(true);
    // 诊断原因字符串（TriggerResult.skipped 的取值）不得被静默改名
    expect(SKIP_ALL_ENEMIES_INACTIVE).toBe("all_enemies_inactive");

    const res = advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);

    // 战斗维度：不建场
    expect(state.battle).toBeNull();
    expect(res.snapshot.battle).toBeNull();
    // 事实层：无 firedEvents / lastFiredIndex / eventFires / history / triggered 痕迹
    expect(state.firedEvents["ev-ambush"]).toBeUndefined();
    expect(state.lastFiredIndex["ev-ambush"]).toBeUndefined();
    expect(state.eventFires.some((f) => f.eventId === "ev-ambush")).toBe(false);
    expect(state.history.some((h) => h.id.includes("ev-ambush"))).toBe(false);
    expect(res.triggeredEvents.some((e) => e.id === "ev-ambush")).toBe(false);
    // 槽位：未入待决队列，onVictory 未结算（空 enemies ⇒ 即胜漏洞被封）
    expect(state.pendingEvents).toEqual([]);
    expect(state.flags.won).toBeUndefined();
    expect(state.missedEvents).toEqual([]);
    // 时间/轮次：只有行动本身的步长，战斗未额外推进 timeCost
    expect(state.turnIndex).toBe(1);
    expect(state.worldTime).toBe(60);
  });

  it("同 seed 下跳过不改变 RNG 序列之外的结果：第二轮仍不建场（once 未被消耗）", () => {
    const { template, lookup, state } = setup("w-refs-8");
    setLifecycle(state, "npc-a", "inactive");
    advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);
    advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);
    expect(state.battle).toBeNull();
    expect(state.lastFiredIndex["ev-ambush"]).toBeUndefined();
  });

  it("复活后同一事件正常建场（跳过不落盘 ⇒ 无遗留状态挡住后续）", () => {
    const { template, lookup, state } = setup("w-refs-9");
    setLifecycle(state, "npc-a", "inactive");
    advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);
    expect(state.battle).toBeNull();

    setLifecycle(state, "npc-a", "alive");
    advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);
    expect(state.battle).not.toBeNull();
    expect(state.battle!.enemies.map((e) => e.characterId)).toEqual(["npc-a"]);
    expect(state.firedEvents["ev-ambush"]).toBe(state.turnIndex);
  });
});

// ---------- 真实模板回归：jjk-2006 的 12 场战斗都引用无实例的 enemy-* ----------

const jjkDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../specs/data/templates/jjk-2006");

function loadJjkTemplate(): WorldTemplateV2 {
  const merged: Record<string, unknown> = {};
  for (const file of ["world.yaml", "characters.yaml", "skills.yaml", "items.yaml", "statuses.yaml", "events.yaml"]) {
    const doc = parse(readFileSync(path.join(jjkDir, file), "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(doc)) {
      if (key === "meta") merged.meta = value;
      else if (merged[key] === undefined) merged[key] = value;
      else if (Array.isArray(merged[key]) && Array.isArray(value)) merged[key] = (merged[key] as unknown[]).concat(value);
    }
  }
  return WorldTemplateV2Schema.parse(merged);
}

describe("真实模板回归（jjk-2006）· 无实例敌人不被判活误杀", () => {
  it("全部 combat 事件的 enemies 过滤后非空（否则 12 场战斗会被整批清空）", () => {
    const template = loadJjkTemplate();
    const lookup = createLookup(template);
    const state = createActiveWorldV2(
      { templateId: "jjk-2006", playerName: "测试者", seed: 7 },
      template,
      "w-jjk-refs",
    );
    const combats = template.events.filter((e) => e.kind === "combat");
    expect(combats.length).toBeGreaterThan(5);
    for (const e of combats) {
      if (e.kind !== "combat") continue;
      const resolved = resolveCombatRefs(e.settle.combat, state, lookup);
      expect(resolved.enemies.length).toBeGreaterThan(0);
      expect(resolved.enemiesExhausted).toBe(false);
    }
  });

  it("ev-sj-02：npc-gojo 非在世 ⇒ 涩谷终战照常建场，allies 不含 gojo、敌人不变", () => {
    const template = loadJjkTemplate();
    const lookup = createLookup(template);
    const state = createActiveWorldV2(
      { templateId: "jjk-2006", playerName: "测试者", seed: 7 },
      template,
      "w-jjk-sj",
    );
    const event = template.events.find((e) => e.id === "ev-sj-02");
    expect(event?.kind).toBe("combat");
    if (event?.kind !== "combat") throw new Error("fixture: ev-sj-02 不再是 combat");

    state.npcs.find((n) => n.id === "npc-gojo")!.lifecycle = {
      state: "inactive",
      reasonCode: "封印",
      sinceTurn: 1,
      sinceWorldTime: 60,
    };

    const resolved = resolveCombatRefs(event.settle.combat, state, lookup);
    expect(resolved.enemies.map((r) => r.ref)).toEqual(["enemy-sukuna"]);
    expect(resolved.allies.map((r) => r.ref)).toEqual(["npc-yuji"]);
    expect(resolved.inactiveNpcIds).toEqual(["npc-gojo"]);

    const battle = createBattle("ev-sj-02", event.settle.combat, state, lookup);
    expect(battle.enemies.map((e) => e.characterId)).toEqual(["enemy-sukuna"]);
    expect(battle.allies.map((a) => a.characterId)).toEqual(["npc-yuji"]);
  });
});
