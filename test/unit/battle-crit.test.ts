import { describe, expect, it } from "vitest";
import {
  createBattle,
  createBattleRng,
  createLookup,
  createRng,
  createWorldV2,
  critOf,
  makeTestTemplate,
  performBattleAction,
} from "@life-sim/game-core";
import type { StatusInstance, WorldTemplateV2 } from "@life-sim/shared";

/**
 * 原生暴击（ADR-073 D2）。
 *
 * 三处来源同形累加：世界默认（`world.combat.crit`）、状态（`statuses[].combat.crit`）、
 * 技能（`skills[].crit`）；`chance = clamp(Σ)`、`multiplier = 1 + Σ(m − 1)`。
 * 位置在命中与闪避都通过之后、伤害结算之前，且只作用于 `damage`。
 */
function templateWithCrit(crit: { chance: number; multiplier?: number }): WorldTemplateV2 {
  const template = makeTestTemplate();
  template.combat = { crit: { multiplier: 1.5, ...crit } };
  template.skills.push({
    id: "sk-guaranteed",
    kind: "combat",
    name: "必中测试",
    cost: { mp: 0 },
    target: "enemy",
    hit: "guaranteed",
    damage: [{ preset: "fixed", value: 10 }],
    cooldownTurns: 0,
    usableInBattle: true,
  });
  template.statuses.push(
    {
      id: "crit-a",
      name: "暴击甲",
      kind: "talent",
      polarity: "positive",
      visibility: "known",
      combat: { crit: { chance: 0.5, multiplier: 1.5 } },
    },
    {
      id: "crit-b",
      name: "暴击乙",
      kind: "talent",
      polarity: "positive",
      visibility: "known",
      combat: { crit: { chance: 0.7, multiplier: 1.5 } },
    },
  );
  return template;
}

function setup(crit: { chance: number; multiplier?: number }) {
  const template = templateWithCrit(crit);
  const lookup = createLookup(template);
  const state = createWorldV2({ templateId: "test", playerName: "甲", seed: 3 }, template, "w-crit");
  for (const id of ["sk-strike", "sk-guaranteed"]) {
    if (!state.player.skills.includes(id)) state.player.skills.push(id);
  }
  state.battle = createBattle("ev:crit", { enemies: [{ ref: "enemy-x" }] }, state, lookup);
  return { state, lookup };
}

function damageEvent(state: ReturnType<typeof setup>["state"]) {
  const event = state.battle!.events?.find((e) => e.kind === "damage");
  if (event?.kind !== "damage") throw new Error("没有伤害事件");
  return event;
}

describe("原生暴击", () => {
  it("必暴时伤害乘 1.5，并写结构化事件与战报后缀", () => {
    const { state, lookup } = setup({ chance: 1 });
    performBattleAction(state, { type: "skill", skillId: "sk-strike" }, lookup, createBattleRng(createRng(1)));
    const event = damageEvent(state);
    expect(event.amount).toBe(150);
    expect(event.critical).toBe(true);
    expect(state.battle!.log.some((line) => line.includes("（暴击）"))).toBe(true);
  });

  it("不暴击时逐字保持旧口径（伤害不变、没有暴击字样）", () => {
    const { state, lookup } = setup({ chance: 0 });
    performBattleAction(state, { type: "skill", skillId: "sk-strike" }, lookup, createBattleRng(createRng(1)));
    const event = damageEvent(state);
    expect(event.amount).toBe(100);
    expect(event.critical).toBe(false);
    expect(state.battle!.log.some((line) => line.includes("暴击"))).toBe(false);
  });

  it("必中也能暴击（必中解决打不打得中，不解决打得多重）", () => {
    const { state, lookup } = setup({ chance: 1 });
    performBattleAction(state, { type: "skill", skillId: "sk-guaranteed" }, lookup, createBattleRng(createRng(2)));
    const event = damageEvent(state);
    expect(event.amount).toBe(15);
    expect(event.critical).toBe(true);
  });

  it("多来源同形累加：概率相加后夹到 1，倍率相加而不是相乘", () => {
    const template = templateWithCrit({ chance: 0 });
    // 本用例只量两条状态之间怎么叠，先把世界默认值摘掉（否则它会贡献 +0.5）。
    delete template.combat;
    const lookup = createLookup(template);
    const instances: StatusInstance[] = ["crit-a", "crit-b"].map((statusId) => ({
      statusId,
      stacks: 1,
      appliedTurn: 0,
      appliedAt: 0,
    }));
    const profile = critOf(instances, template.skills.find((s) => s.id === "sk-guaranteed"), lookup);
    expect(profile.chance).toBe(1);
    // 1 + (1.5 − 1) + (1.5 − 1) = 2.0，不是 2.25。
    expect(profile.multiplier).toBe(2);
  });
});
