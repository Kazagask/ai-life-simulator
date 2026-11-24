import { describe, expect, it } from "vitest";
import {
  createBattle,
  createLookup,
  createRng,
  createWorldV2,
  evaluateBattle,
  finishBattle,
  performBattleAction,
} from "@life-sim/game-core";
import { WorldTemplateV2Schema, type StatusEffect, type WorldTemplateV2 } from "@life-sim/shared";
import { fixtureEntry } from "../helpers/world.ts";

/**
 * ADR-075 §2：战评等级与钩子。
 *
 * 守三件事：
 * 1. grade 按声明顺序首个命中；
 * 2. 结算顺序 = 默认 hooks → 事件引用 sets（组内声明顺序）；
 * 3. `advanceTalent.amount.metric` 只在战评里有上下文 —— 读 `statusStacks`、夹 `max`。
 */

const BF: StatusEffect = {
  id: "t-bf",
  name: "黑闪测试",
  kind: "talent",
  polarity: "positive",
  visibility: "known",
  progress: { max: 10 },
  tiers: [{ at: 1, tier: "purple", effects: {} }],
};

const BF_BATTLE: StatusEffect = {
  id: "black-flash",
  name: "黑闪",
  kind: "battle",
  stacking: "stack",
  polarity: "positive",
  visibility: "known",
  combat: { damageDealt: 0.5 },
};

function makeTemplate(): WorldTemplateV2 {
  const template: WorldTemplateV2 = structuredClone(fixtureEntry().template);
  template.statuses.push(structuredClone(BF), structuredClone(BF_BATTLE));
  template.combat = {
    ...(template.combat ?? {}),
    ...(template.combat ?? {}),
    evaluation: {
      grades: [
        { id: "flawless", label: "完胜", when: [{ outcome: "victory" }, { metric: "hpRatio", gte: 0.8 }] },
        { id: "win", when: [{ outcome: "victory" }] },
      ],
      hooks: [
        {
          id: "bf-growth",
          when: [{ statusStacks: "black-flash", gte: 1 }],
          effects: [
            {
              type: "advanceTalent",
              talent: "t-bf",
              amount: { metric: "statusStacks", status: "black-flash", max: 3 },
              create: true,
            },
            { type: "log", text: "default", visibility: "public" },
          ],
        },
      ],
      sets: {
        ritual: [
          {
            id: "ritual-flag",
            when: [{ metric: "rounds", gte: 1 }],
            effects: [
              { type: "setFlag", id: "ritualSeen", value: true },
              { type: "log", text: "set", visibility: "public" },
            ],
          },
        ],
      },
    },
  };
  return template;
}

function runBattle(template: WorldTemplateV2) {
  const lookup = createLookup(template);
  const state = createWorldV2(
    { templateId: "p0", playerName: "测试", seed: 71 },
    template,
    "w-adr075-t6",
  );
  state.openingCompleted = true;
  const battle = createBattle(
    "ev:fight",
    { enemies: [{ ref: "enemy-x" }], stake: "hard", evaluation: ["ritual"] },
    state,
    lookup,
  );
  state.battle = battle;
  battle.enemies[0]!.hp = 1; // 一刀结束
  battle.player.statuses.push({
    statusId: "black-flash",
    stacks: 2,
    appliedTurn: 0,
    appliedAt: 0,
  });

  performBattleAction(
    state,
    { type: "skill", skillId: "sk-strike", targetInstanceId: battle.enemies[0]!.instanceId },
    lookup,
    createRng(5),
  );
  expect(battle.over).toBe("victory");
  const result = evaluateBattle(state, battle, lookup, createRng(6));
  finishBattle(state, lookup, result);
  return { state, result, battle };
}

describe("ADR-075 §2 · 战评", () => {
  it("grade 首个命中 + 默认 hook 推进天赋（metric 夹 max）", () => {
    const { state, result } = runBattle(makeTemplate());
    expect(result.grade).toBe("flawless");
    expect(result.player.statusStacks["black-flash"]).toBe(2);

    const talent = state.player.statuses.find((s) => s.statusId === "t-bf");
    expect(talent?.progress).toBe(2);
    expect(talent?.tiersApplied).toBe(1);
    expect(state.lastBattleResult?.grade).toBe("flawless");
  });

  it("默认 hooks 先于事件引用的 sets；组内按声明顺序", () => {
    const { battle } = runBattle(makeTemplate());
    expect(battle.log.slice(-2)).toEqual(["default", "set"]);
  });

  it("set 里的旗标在收场后仍然可读（死亡路由同轮能看见）", () => {
    const { state } = runBattle(makeTemplate());
    expect(state.flags.ritualSeen).toBe(true);
  });
});

describe("ADR-075 §2 · 加载期校验", () => {
  it("grade 不得引用 grade（自引用）", () => {
    const template = makeTemplate();
    template.combat!.evaluation!.grades![0]!.when = [{ grade: "win" } as never];
    expect(WorldTemplateV2Schema.safeParse(template).success).toBe(false);
  });

  it("事件引用的 set 必须存在", () => {
    const template = makeTemplate();
    const fight = template.events.find((e) => e.id === "ev:fight")!;
    if (fight.kind !== "combat") throw new Error("fixture broken");
    fight.settle.combat.evaluation = ["nope"];
    expect(WorldTemplateV2Schema.safeParse(template).success).toBe(false);
  });

  it("战评 hook 只允许闭集效果（不能 startChain）", () => {
    const template = makeTemplate();
    template.combat!.evaluation!.hooks![0]!.effects.push({ type: "startChain", chainId: "x" });
    expect(WorldTemplateV2Schema.safeParse(template).success).toBe(false);
  });

  it("世界效果里的 advanceTalent 仍然不许 metric", () => {
    const template = makeTemplate();
    template.actions![0]!.effects = [
      { type: "advanceTalent", talent: "t-bf", amount: { metric: "statusStacks", status: "black-flash" } },
    ];
    expect(WorldTemplateV2Schema.safeParse(template).success).toBe(false);
  });
});

describe("ADR-075 §2 · grade 求值", () => {
  it("没有命中任何 grade ⇒ undefined，不硬塞一个", () => {
    const template = makeTemplate();
    template.combat!.evaluation!.grades = [{ id: "lose", when: [{ outcome: "defeat" }] }];
    const { result } = runBattle(template);
    expect(result.grade).toBeUndefined();
  });
});
