import { describe, expect, it } from "vitest";
import {
  createBattle,
  createWorldV2,
  equipmentCombatOf,
  equipmentEffectSummaries,
  performBattleAction,
} from "@life-sim/game-core";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * 装备词条（2026-11-20）：
 * 1. 一件装备可以有多条词条（属性 / 战斗轴混排）；
 * 2. 战斗轴词条能改命中、闪避、增减伤，**也能给必中** —— 以前这件事只能靠
 *    `grantsSkill` 造一条带 `hit: guaranteed` 的招式，玩家技能栏里凭空多一个技能；
 * 3. 词条有自己的 `label`（「贯穿」「斩魂」），面板上不再只有数字。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function loadEntry() {
  const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

describe("装备词条：多条 / 战斗轴 / 必中", () => {
  it("天逆鉾同时有属性词条与「必中」战斗词条，摘要带词条名", () => {
    const entry = loadEntry();
    const spear = entry.lookup.item("eq-ten-spear");
    expect(spear?.dynamicModifiers).toHaveLength(2);
    const texts = equipmentEffectSummaries(spear!, entry.lookup).map((e) => e.text);
    expect(texts.some((t) => t.includes("【咒力回路】") && t.includes("咒力"))).toBe(true);
    expect(texts.some((t) => t.includes("【贯穿】") && t.includes("必中"))).toBe(true);
  });

  it("equipmentCombatOf 汇总战斗轴（多件叠加，必中取或）", () => {
    const entry = loadEntry();
    const gear = equipmentCombatOf(
      [
        { instanceId: "a", itemId: "eq-ten-spear", ownerId: "player", slot: "weapon" },
        { instanceId: "b", itemId: "eq-bancho", ownerId: "player", slot: "accessory" },
        { instanceId: "c", itemId: "eq-shakujin", ownerId: "player", slot: "weapon" },
      ],
      entry.lookup,
    );
    expect(gear.guaranteedHit).toBe(true);
    expect(gear.evade).toBeCloseTo(0.12, 5);
    expect(gear.damageDealt).toBeCloseTo(0.15, 5);
  });

  it("拿着天逆鉾时攻击不会落空（必中跳过命中骰与闪避）", () => {
    const entry = loadEntry();
    const state = createWorldV2(
      { templateId: "jjk-2006", playerName: "测试", seed: 31 },
      entry.template,
      "w-gear-hit",
    );
    state.openingCompleted = true;
    state.player.equipment = [
      { instanceId: "eq1", itemId: "eq-ten-spear", ownerId: "player", slot: "weapon" },
    ];
    state.battle = createBattle("ev:gear", { enemies: [{ ref: "enemy-grade2-curse" }] }, state, entry.lookup);
    const hpBefore = state.battle.enemies[0]!.hp;

    // rng 恒 0.99：没有必中时这一击必然被闪开/打空
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, entry.lookup, () => 0.99);

    expect(state.battle.enemies[0]!.hp).toBeLessThan(hpBefore);
    // 只看**你这一击**：敌人现在也会普通攻击（2026-11-21 全员配普通攻击），
    // 它打你时用的是同一招，日志同样带「体术打击」，不能混在一起看。
    expect(state.battle.log.some((line) => line.includes("你的「体术打击」") && line.includes("闪开"))).toBe(false);
  });

  it("没有必中时同样的骰子会落空（证明上一条不是白测）", () => {
    const entry = loadEntry();
    const state = createWorldV2(
      { templateId: "jjk-2006", playerName: "测试", seed: 32 },
      entry.template,
      "w-gear-miss",
    );
    state.openingCompleted = true;
    state.battle = createBattle("ev:gear2", { enemies: [{ ref: "enemy-grade2-curse" }] }, state, entry.lookup);
    const hpBefore = state.battle.enemies[0]!.hp;

    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, entry.lookup, () => 0.99);

    expect(state.battle.enemies[0]!.hp).toBe(hpBefore);
  });
});
