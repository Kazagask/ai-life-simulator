import { describe, expect, it } from "vitest";
import { registerExtensionRuntime } from "@life-sim/game-core";
import { familyExtension } from "@life-sim/ext-family";
import { WorldTemplateV2Schema, type WorldTemplateV2 } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";
import { createWorldV2 } from "../../packages/game-core/src/v2/turn.ts";
import { createLookup } from "../../packages/game-core/src/v2/lookup.ts";
import { applyEffectsV2 } from "../../packages/game-core/src/v2/engine.ts";
import { adjustResourceValue, resolveRegenAmount, resourceMax } from "../../packages/game-core/src/v2/resources.ts";
import { createBattle, finishBattle, performBattleAction } from "../../packages/game-core/src/v2/battle.ts";
import { projectSnapshotV2 } from "../../packages/game-core/src/v2/projection.ts";

/**
 * ADR-003 D8/D9/D10：自定义资源（决意 / beans）的声明、上限、效果、战斗消耗与刻度投影。
 * 用真实模板 valmont 1.0.0 的决斗夹具，不手搓 battle settle。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };
registerExtensionRuntime(familyExtension);

function loadValmont() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "valmont", version: "1.0.0" });
  if (entry?.status !== "ready") throw new Error("valmont/1.0.0 未就绪");
  return entry;
}

function newWorld(template: WorldTemplateV2) {
  return createWorldV2({ templateId: template.meta.id, playerName: "罗兰" }, template, "w-res-test");
}

describe("ADR-003 · 自定义资源（决意）", () => {
  it("建世界按 initial 初始化（5/5），上限受 cap 约束", () => {
    const { template } = loadValmont();
    const state = newWorld(template);
    expect(state.player.resources.beans).toBe(5);
    expect(state.player.hp).toBe(100);
    expect(resourceMax(state.player, template, "beans")).toBe(5);
  });

  it("adjustResource 写自定义资源并按 [0, max] 夹取；hp/mp 仍走原字段", () => {
    const { template } = loadValmont();
    const state = newWorld(template);
    const lookup = createLookup(template);
    applyEffectsV2({ state, lookup, rng: () => 0.5, logs: [] }, [
      { type: "adjustResource", resource: "beans", value: -2 },
      { type: "adjustResource", resource: "hp", value: -10 },
    ]);
    expect(state.player.resources.beans).toBe(3);
    expect(state.player.hp).toBe(90);
    applyEffectsV2({ state, lookup, rng: () => 0.5, logs: [] }, [
      { type: "adjustResource", resource: "beans", value: 99 },
      { type: "adjustResource", resource: "beans", value: -99 },
    ]);
    // +99 夹到 5，再 -99 夹到 0。
    expect(state.player.resources.beans).toBe(0);
  });

  it("资源条按 statusBar 顺序投影：valmont = hp + beans（不再常驻 MP）", () => {
    const { template, ui } = loadValmont();
    const state = newWorld(template);
    const snap = projectSnapshotV2(state, template, createLookup(template), null, undefined, ui);
    expect(snap.player.resources.map((r) => r.key)).toEqual(["hp", "beans"]);
    const beans = snap.player.resources.find((r) => r.key === "beans");
    expect(beans?.display).toBe("pips");
    expect(beans?.dangerAt).toBe(0);
    const hp = snap.player.resources.find((r) => r.key === "hp");
    expect(hp?.dangerAt).toBe(0.25);
    expect(hp?.display).toBe("bar");
  });

  it("技能消耗自定义资源：5 → 2；不足时 not_enough_resource:beans（不扣资源、不进冷却判定）", () => {
    const { template } = loadValmont();
    const state = newWorld(template);
    const lookup = createLookup(template);
    const event = template.events.find((e) => e.id === "evt:duel");
    if (event?.kind !== "combat") throw new Error("evt:duel 不是战斗事件");
    state.battle = createBattle("evt:duel", event.settle.combat, state, lookup);

    performBattleAction(state, { type: "skill", skillId: "sk-duel-finisher" }, lookup, () => 0.1);
    expect(state.battle?.player.resources.beans).toBe(2);
    expect(state.player.resources.beans).toBe(5); // 战斗内只写镜像

    expect(() =>
      performBattleAction(state, { type: "skill", skillId: "sk-duel-finisher" }, lookup, () => 0.1),
    ).toThrow(/not_enough_resource:beans/);
    expect(state.battle?.player.resources.beans).toBe(2);
  });

  it("战斗视图下发 costs 与资源刻度；战斗结束回写权威资源", () => {
    const { template, ui } = loadValmont();
    const state = newWorld(template);
    const lookup = createLookup(template);
    const event = template.events.find((e) => e.id === "evt:duel");
    if (event?.kind !== "combat") throw new Error("evt:duel 不是战斗事件");
    state.battle = createBattle("evt:duel", event.settle.combat, state, lookup);
    performBattleAction(state, { type: "skill", skillId: "sk-duel-finisher" }, lookup, () => 0.1);

    const snap = projectSnapshotV2(state, template, lookup, null, undefined, ui);
    const beans = snap.battle?.player.resources.find((r) => r.key === "beans");
    expect(beans?.value).toBe(2);
    const finisher = snap.battle?.player.skills.find((s) => s.id === "sk-duel-finisher");
    expect(finisher?.costs).toEqual([{ resource: "beans", label: "决意", amount: 3 }]);
    // MP 为 0 的技能不出现在 `costs` 里（没有重复的 `costMp` 字段）。
    expect(finisher?.costs?.some((c) => c.resource === "mp")).toBe(false);

    state.battle!.over = "victory";
    finishBattle(state, lookup);
    expect(state.player.resources.beans).toBe(2);
    expect(state.battle).not.toBeNull(); // 清会话由 turn 层负责，这里只验证回写
  });

  it("加载期拒绝未声明的资源：statusBar / 技能 cost / 效果", () => {
    const { template } = loadValmont();

    const badBar = structuredClone(template);
    badBar.statusBar = [...badBar.statusBar, { id: "x", label: "？", source: "resource", key: "mana" }];
    expect(WorldTemplateV2Schema.safeParse(badBar).success).toBe(false);

    const badCost = structuredClone(template);
    const skill = badCost.skills.find((s) => s.id === "sk-duel-finisher");
    if (skill?.kind !== "combat") throw new Error("技能缺失");
    (skill.cost as Record<string, number>).mana = 1;
    expect(WorldTemplateV2Schema.safeParse(badCost).success).toBe(false);

    const badEffect = structuredClone(template);
    badEffect.actions = [
      {
        id: "act-x",
        label: "？",
        effects: [{ type: "adjustResource", resource: "mana", value: 1 }],
      },
    ];
    expect(WorldTemplateV2Schema.safeParse(badEffect).success).toBe(false);
  });
});

describe("ADR-003 D12 · 战斗内每回合回复", () => {
  /** 复制 valmont 模板并注入战斗回复，走一遍真实 schema（不是手改运行时对象）。 */
  function withCombatRegen(patch: {
    player?: Record<string, number>;
    enemy?: Record<string, number>;
  }): WorldTemplateV2 {
    const { template } = loadValmont();
    const clone = structuredClone(template) as WorldTemplateV2;
    if (patch.player !== undefined) {
      clone.regen = { ...clone.regen, combat: patch.player };
    }
    if (patch.enemy !== undefined) {
      const duelist = clone.characters.find((c) => c.id === "npc-duelist");
      if (duelist === undefined) throw new Error("npc-duelist 缺失");
      duelist.combatRegen = patch.enemy;
    }
    return WorldTemplateV2Schema.parse(clone);
  }

  it("玩家：每回合按上限回复，只写战斗镜像，结束才回写", () => {
    const template = withCombatRegen({ player: { beans: 2 } });
    const state = newWorld(template);
    state.player.resources.beans = 4;
    const lookup = createLookup(template);
    const event = template.events.find((e) => e.id === "evt:duel");
    if (event?.kind !== "combat") throw new Error("evt:duel 不是战斗事件");
    state.battle = createBattle("evt:duel", event.settle.combat, state, lookup);
    state.battle.player.resources.beans = 4;

    performBattleAction(state, { type: "pass" }, lookup, () => 0.9);
    // 4 + 2 夹到 cap 5；日志给出实际回复量。
    expect(state.battle?.player.resources.beans).toBe(5);
    expect(state.battle?.log.some((line) => line.includes("回复 1 点决意"))).toBe(true);
    // 权威状态仍然只有战斗结束才回写。
    expect(state.player.resources.beans).toBe(4);

    state.battle!.over = "victory";
    finishBattle(state, lookup);
    expect(state.player.resources.beans).toBe(5);
  });

  it("敌人：角色 combatRegen 同样生效（hp 按自身上限夹取）", () => {
    const template = withCombatRegen({ enemy: { hp: 3 } });
    const state = newWorld(template);
    const lookup = createLookup(template);
    const event = template.events.find((e) => e.id === "evt:duel");
    if (event?.kind !== "combat") throw new Error("evt:duel 不是战斗事件");
    state.battle = createBattle("evt:duel", event.settle.combat, state, lookup);
    const enemy = state.battle!.enemies[0]!;
    enemy.hp = 10;
    const maxHp = enemy.maxHp;

    performBattleAction(state, { type: "pass" }, lookup, () => 0.9);
    // 玩家 pass 不造成伤害 ⇒ 敌人净回复 +3（且不超过 maxHp）。
    expect(state.battle?.enemies[0]?.hp).toBe(Math.min(maxHp, 13));
    expect(state.battle?.log.some((line) => line.includes("外姓骑士回复 3 点"))).toBe(true);
  });

  it("按属性加权：base + Σ coef × 基础属性，结果四舍五入", () => {
    // valmont 的数值属性是 body / mind / will（体魄 / 心智 / 意志），玩家 body = 5。
    expect(resolveRegenAmount(1, { body: 5 })).toBe(1);
    expect(resolveRegenAmount({ base: 1, perAttribute: { body: 0.2 } }, { body: 5 })).toBe(2);
    expect(resolveRegenAmount({ base: 0, perAttribute: { body: 0.3 } }, { body: 5 })).toBe(2);
    // 未声明的属性按 0 计（加载期已拒，这里只验证求值不炸）
    expect(resolveRegenAmount({ base: 2, perAttribute: { nope: 9 } }, { body: 5 })).toBe(2);
    expect(resolveRegenAmount(undefined, { body: 5 })).toBe(0);
  });

  it("战斗内加权回复：体魄 5 × 0.4 ⇒ 每回合 2 点决意", () => {
    const template = withCombatRegen({ player: { beans: { base: 0, perAttribute: { body: 0.4 } } } });
    const state = newWorld(template);
    expect(state.player.attributes.body).toBe(5);
    const lookup = createLookup(template);
    const event = template.events.find((e) => e.id === "evt:duel");
    if (event?.kind !== "combat") throw new Error("evt:duel 不是战斗事件");
    state.battle = createBattle("evt:duel", event.settle.combat, state, lookup);
    state.battle.player.resources.beans = 0;

    performBattleAction(state, { type: "pass" }, lookup, () => 0.9);
    expect(state.battle?.player.resources.beans).toBe(2);
    expect(state.battle?.log.some((line) => line.includes("回复 2 点决意"))).toBe(true);
  });

  it("加载期：加权系数只能引用已声明属性", () => {
    const { template } = loadValmont();
    const bad = structuredClone(template) as WorldTemplateV2;
    bad.regen = { ...bad.regen, combat: { beans: { base: 1, perAttribute: { mana: 1 } } } };
    expect(WorldTemplateV2Schema.safeParse(bad).success).toBe(false);
    const badType = structuredClone(template) as WorldTemplateV2;
    badType.regen = { ...badType.regen, combat: { beans: { base: 1, perAttribute: { body: "x" as unknown as number } } } };
    expect(WorldTemplateV2Schema.safeParse(badType).success).toBe(false);
  });

  it("加载期：regen.combat / combatRegen 只能引用已声明资源", () => {
    const { template } = loadValmont();
    const badPlayer = structuredClone(template) as WorldTemplateV2;
    badPlayer.regen = { ...badPlayer.regen, combat: { mana: 1 } };
    expect(WorldTemplateV2Schema.safeParse(badPlayer).success).toBe(false);

    const badEnemy = structuredClone(template) as WorldTemplateV2;
    const duelist = badEnemy.characters.find((c) => c.id === "npc-duelist");
    if (duelist === undefined) throw new Error("npc-duelist 缺失");
    duelist.combatRegen = { mana: 1 };
    expect(WorldTemplateV2Schema.safeParse(badEnemy).success).toBe(false);
  });
});
