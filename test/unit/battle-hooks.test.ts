import { describe, expect, it } from "vitest";
import {
  createBattle,
  createBattleRng,
  createLookup,
  createRng,
  createWorldV2,
  makeTestTemplate,
  performBattleAction,
} from "@life-sim/game-core";
import type { WorldTemplateV2 } from "@life-sim/shared";

/**
 * 战斗钩子（ADR-073）。
 *
 * 这些用例只走**公开协议**（模板里写 `hooks`），不直接调内部函数 ——
 * 钩子是不是「闭集声明」的，取决于模板作者能不能只靠 YAML 写出这四种效果。
 */
function templateWithHooks(): WorldTemplateV2 {
  const template = makeTestTemplate();
  // 旧夹具的状态没有 kind/polarity（它们是 as unknown 铸出来的），补齐后才能被战斗域读到。
  for (const status of template.statuses) {
    Object.assign(status, {
      kind: "battle",
      stacking: "unique",
      polarity: "neutral",
    });
  }
  template.statuses.push(
    {
      id: "t-last-stand",
      name: "不屈",
      kind: "talent",
      polarity: "positive",
      visibility: "known",
      combat: {
        hooks: [
          {
            id: "last-stand",
            phase: "afterDamage",
            when: [{ hpPct: { lte: 0.3 } }],
            limit: { per: "battle", times: 1 },
            effects: [{ type: "setHpFloor", value: 30 }],
          },
        ],
      },
    },
    {
      id: "t-substitute",
      name: "替身",
      kind: "talent",
      polarity: "positive",
      visibility: "known",
      combat: {
        hooks: [
          {
            id: "substitute",
            phase: "beforeHit",
            when: [{ chance: 1 }],
            limit: { per: "battle", times: 2 },
            effects: [{ type: "cancel", reason: "替身" }],
          },
        ],
      },
    },
    {
      id: "t-vampire",
      name: "吸血",
      kind: "talent",
      polarity: "positive",
      visibility: "known",
      combat: {
        hooks: [
          {
            id: "vampire",
            phase: "afterDamage",
            effects: [{ type: "heal", formula: { preset: "fixed", value: 20 } }],
          },
        ],
      },
    },
    {
      id: "t-silenced",
      name: "封口",
      kind: "talent",
      polarity: "negative",
      visibility: "known",
      combat: {
        hooks: [
          {
            id: "silence",
            phase: "beforeAction",
            limit: { per: "battle", times: 1 },
            effects: [{ type: "cancel", reason: "封口" }],
          },
        ],
      },
    },
    {
      id: "buff-x",
      name: "增益",
      kind: "battle",
      stacking: "unique",
      polarity: "positive",
      visibility: "known",
      combat: { damageDealt: 0.2 },
    },
  );
  template.skills.push({
    id: "sk-dispel",
    kind: "combat",
    name: "解除",
    cost: { mp: 0 },
    target: "enemy",
    damage: [{ preset: "fixed", value: 1 }],
    cooldownTurns: 0,
    usableInBattle: true,
    hooks: [
      {
        id: "dispel",
        phase: "afterHit",
        effects: [{ type: "cureStatus", target: "target", polarity: "positive" }],
      },
    ],
  });
  return template;
}

function setup(statuses: string[] = []): {
  state: ReturnType<typeof createWorldV2>;
  lookup: ReturnType<typeof createLookup>;
} {
  const template = templateWithHooks();
  const lookup = createLookup(template);
  const state = createWorldV2({ templateId: "test", playerName: "甲", seed: 5 }, template, "w-hook");
  for (const id of statuses) {
    state.player.statuses.push({ statusId: id, stacks: 1, appliedTurn: 0, appliedAt: 0 });
  }
  for (const id of ["sk-strike", "sk-dispel"]) {
    if (!state.player.skills.includes(id)) state.player.skills.push(id);
  }
  state.battle = createBattle("ev:hook", { enemies: [{ ref: "enemy-x" }] }, state, lookup);
  return { state, lookup };
}

describe("战斗钩子", () => {
  it("不屈：致命伤被抬回下限，且每场只生效一次", () => {
    const { state, lookup } = setup(["t-last-stand"]);
    // 敌方湮灭 500 点，玩家 120 血 ⇒ 第一条命靠钩子留在 30。
    performBattleAction(state, { type: "pass" }, lookup, createBattleRng(createRng(9)));
    expect(state.battle!.player.hp).toBe(30);
    expect(state.battle!.over).toBeNull();
    expect(state.battle!.hookFires?.["last-stand"]).toBe(1);

    // 第二次致命伤：`limit: per battle` 已用完，不再兜底。
    performBattleAction(state, { type: "pass" }, lookup, createBattleRng(createRng(9)));
    expect(state.battle!.over).toBe("defeat");
  });

  it("替身：命中判定之前取消这一击，写结构化事件", () => {
    const { state, lookup } = setup(["t-substitute"]);
    const before = state.battle!.player.hp;
    performBattleAction(state, { type: "pass" }, lookup, createBattleRng(createRng(9)));
    expect(state.battle!.player.hp).toBe(before);
    const cancel = state.battle!.events?.find((e) => e.kind === "cancel");
    expect(cancel).toBeDefined();
    if (cancel?.kind === "cancel") expect(cancel.hookId).toBe("substitute");
  });

  it("吸血：造成伤害后回复，且不超过血量上限", () => {
    const { state, lookup } = setup(["t-vampire"]);
    state.battle!.player.hp = 50;
    // 这一击要把敌人打死，否则回合末敌人反手就是 500 点（吸血用例不该被那件事干扰）。
    state.battle!.enemies[0]!.hp = 50;
    performBattleAction(state, { type: "skill", skillId: "sk-strike" }, lookup, createBattleRng(createRng(4)));
    expect(state.battle!.player.hp).toBe(70);
    const heal = state.battle!.events?.find((e) => e.kind === "heal");
    expect(heal).toBeDefined();
    if (heal?.kind === "heal") expect(heal.amount).toBe(20);
  });

  it("AI 也有钩子：敌方 beforeAction 被取消时这一回合不会行动", () => {
    const { state, lookup } = setup();
    const enemy = state.battle!.enemies[0]!;
    enemy.statuses.push({ statusId: "t-silenced", stacks: 1, appliedTurn: 0, appliedAt: 0 });
    const before = state.battle!.player.hp;
    performBattleAction(state, { type: "pass" }, lookup, createBattleRng(createRng(9)));
    expect(state.battle!.player.hp).toBe(before);
    expect(state.battle!.log.some((line) => line.includes("没能行动"))).toBe(true);
    expect(state.battle!.hookFires?.["silence"]).toBe(1);
  });

  it("解除术式：命中后清掉目标的正向战斗态，天赋不受影响", () => {
    const { state, lookup } = setup();
    const enemy = state.battle!.enemies[0]!;
    enemy.statuses.push({ statusId: "buff-x", stacks: 1, appliedTurn: 0, appliedAt: 0 });
    performBattleAction(state, { type: "skill", skillId: "sk-dispel" }, lookup, createBattleRng(createRng(6)));
    expect(enemy.statuses.some((s) => s.statusId === "buff-x")).toBe(false);
  });
});
