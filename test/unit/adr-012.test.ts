import { describe, expect, it } from "vitest";
import {
  buildUnit,
  canUseSkill,
  checkBattleEnd,
  createBattle,
  createLookup,
  createWorldV2,
  effectiveCostOf,
  finishBattle,
  playerSkills,
  performBattleAction,
  projectSnapshotV2,
  type WorldStateV2,
} from "@life-sim/game-core";
import type { BattleState, StatusInstance, WorldTemplateV2 } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function loadEntry() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

/** 以夏油开局：他带着整套咒灵操术，是召唤相关的实验主角。 */
function getoWorld(seed = 11) {
  const entry = loadEntry();
  const state = createWorldV2(
    { templateId: "jjk-2006", seed, self: { kind: "reuse", characterId: "npc-geto" } },
    entry.template,
    `w-adr012-${seed}`,
  );
  return { state, entry };
}

function battleWith(
  state: WorldStateV2,
  entry: ReturnType<typeof loadEntry>,
  settle: BattleState["settle"],
): BattleState {
  const battle = createBattle("ev:test", settle, state, entry.lookup);
  state.battle = battle;
  return battle;
}

/** 场上活着的友军（这几条用例的友军全是召唤物）。 */
const aliveAllies = (battle: BattleState) => battle.allies.filter((a) => a.alive);

const summons = (battle: BattleState) => battle.allies.filter((a) => a.summonedBy !== undefined);

/**
 * ADR-013（2026-11-20，用户口径）：**不再有「咒灵数量」这个池子**。
 *
 * 池子当初解决两件事——限制强度、给旋涡凑祭品——现在分别由「场上的 `limit`」与
 * 「献祭场上单位」表达。于是「有几只咒灵」这个问题不再有第二个答案，
 * 也就没有「打完一场数量对不上」这一类 bug。
 */
describe("ADR-013 B1 · 召唤不花资源（池子已撤）", () => {
  it("夏油开局没有「咒灵」这条槽 —— 计数不是状态", () => {
    const { state } = getoWorld();
    expect(state.player.resources.curses).toBeUndefined();
    expect(state.player.resourceMax?.curses).toBeUndefined();
  });

  it("别人也没有：这条槽整个不存在，不是「值为 0」", () => {
    const entry = loadEntry();
    const state = createWorldV2(
      { templateId: "jjk-2006", seed: 3, self: { kind: "reuse", characterId: "npc-gojo" } },
      entry.template,
      "w-adr012-gojo",
    );
    expect(state.player.resources.curses).toBeUndefined();
  });
});

describe("ADR-012 D1/D2 · 召唤与两级单位", () => {
  it("召灵：一次三只、落进友军、标记召唤者与入场回合，且不扣任何资源", () => {
    const { state, entry } = getoWorld();
    const battle = battleWith(state, entry, { enemies: [{ ref: "enemy-grade2-curse" }] });
    const mpBefore = battle.player.mp;
    performBattleAction(state, { type: "skill", skillId: "sk-summon-curse" }, entry.lookup, () => 0.5);

    const minions = summons(battle);
    expect(minions).toHaveLength(3);
    for (const m of minions) {
      expect(m.tier).toBe("minion");
      expect(m.summonedBy).toBe(state.player.id);
      expect(m.enteredRound).toBe(1);
      // ADR-013 D1：回收再召靠 `summonRef` 认亲，它就是「技能里点名的那个角色」。
      expect(m.summonRef).toBe("enemy-grade2-curse");
    }
    // 只花 MP（效率折扣后的价格）；「召唤物数量」不是一个会掉的数字。
    const cost = effectiveCostOf(state, battle, state.player.id, "sk-summon-curse", entry.lookup).mp;
    expect(battle.player.mp).toBe(mpBefore - cost);
    expect(battle.player.resources.curses).toBeUndefined();
  });

  it("普通单位上限 3：站满时再召是**替换**（前一批下场，场上仍是 3 只）", () => {
    const { state, entry } = getoWorld();
    const battle = battleWith(state, entry, { enemies: [{ ref: "enemy-grade2-curse" }] });
    // 不真打三回合（会牵动敌人行动/状态），直接摆三只占位：上限统计只看召唤者与档位。
    for (let i = 0; i < 3; i += 1) {
      battle.allies.push({
        instanceId: `stub#${i}`,
        characterId: "enemy-grade2-curse",
        name: "咒灵",
        hp: 10,
        maxHp: 10,
        mp: 0,
        attributes: {},
        resources: {},
        statuses: [],
        skillCooldowns: {},
        skills: [],
        skillWeights: {},
        alive: true,
        tier: "minion",
        summonedBy: state.player.id,
      });
    }
    // ADR-016 D3：不再返回 `summon_limit`，满员是可以放的。
    expect(canUseSkill(state, battle, state.player.id, "sk-summon-curse", entry.lookup)).toEqual({ ok: true });

    performBattleAction(state, { type: "skill", skillId: "sk-summon-curse" }, entry.lookup, () => 0.5);

    const minions = summons(battle);
    expect(minions).toHaveLength(3);
    // 三只替身全被挪进回收架（不是阵亡，也不是永久损失）
    expect(minions.some((m) => m.instanceId.startsWith("stub#"))).toBe(false);
    expect(battle.bench?.map((u) => u.instanceId).sort()).toEqual(["stub#0", "stub#1", "stub#2"]);
  });

  it("英雄单位上限 1：虹龙顶掉场上的那一只，不是被拒", () => {
    const { state, entry } = getoWorld();
    const battle = battleWith(state, entry, { enemies: [{ ref: "enemy-grade2-curse" }] });
    battle.allies.push({
      instanceId: "stub-hero",
      characterId: "enemy-grade1-curse",
      name: "虹龙",
      hp: 10,
      maxHp: 10,
      mp: 0,
      attributes: {},
      resources: {},
      statuses: [],
      skillCooldowns: {},
      skills: [],
      skillWeights: {},
      alive: true,
      tier: "hero",
      summonedBy: state.player.id,
    });
    expect(canUseSkill(state, battle, state.player.id, "sk-summon-dragon", entry.lookup)).toEqual({ ok: true });

    performBattleAction(state, { type: "skill", skillId: "sk-summon-dragon" }, entry.lookup, () => 0.5);

    const heroes = battle.allies.filter((a) => a.tier === "hero");
    expect(heroes).toHaveLength(1);
    expect(heroes[0].characterId).toBe("curse-rainbow-dragon");
    expect(battle.bench?.some((u) => u.instanceId === "stub-hero")).toBe(true);
    // 被替换 ≠ 阵亡：不进永久损失名册
    expect(state.lostSummons ?? []).not.toContain("enemy-grade1-curse");
  });

  it("收灵：收回场上的那一只，且**什么都不返还**（本来就没花）", () => {
    const { state, entry } = getoWorld();
    const battle = battleWith(state, entry, { enemies: [{ ref: "enemy-grade2-curse" }] });
    performBattleAction(state, { type: "skill", skillId: "sk-summon-curse" }, entry.lookup, () => 0.5);
    expect(summons(battle)).toHaveLength(3);

    const mpBefore = battle.player.mp;
    // 敌人可能已经把某只打死了 —— 先复活它，让「收得回来」这件事可测
    const first = summons(battle)[0];
    first.alive = true;
    first.hp = Math.max(1, first.hp);
    performBattleAction(state, { type: "skill", skillId: "sk-recall" }, entry.lookup, () => 0.5);

    expect(summons(battle).filter((a) => a.alive)).toHaveLength(2);
    expect(battle.bench).toHaveLength(1);
    expect(battle.player.mp).toBe(mpBefore); // 收灵是 0 费，也没有别的返还
  });
});

describe("ADR-012 D3 · 中途加入（回合 / 概率 / 条件）", () => {
  it("atRound 到点就入场", () => {
    const { state, entry } = getoWorld();
    const battle = battleWith(state, entry, {
      enemies: [{ ref: "enemy-grade2-curse" }],
      reinforcements: [{ id: "r1", ref: "enemy-grade2-curse", atRound: 2, chance: 1, maxAlive: 2 }],
    });
    expect(battle.enemies).toHaveLength(1);
    performBattleAction(state, { type: "pass" }, entry.lookup, () => 0.5);
    expect(battle.round).toBe(2);
    expect(battle.enemies).toHaveLength(2);
    // 新来的不在入场回合行动 —— 它的 enteredRound 就是当前回合
    expect(battle.enemies[1].enteredRound).toBe(2);
  });

  it("概率 0 就永远不来", () => {
    const { state, entry } = getoWorld();
    const battle = battleWith(state, entry, {
      enemies: [{ ref: "enemy-grade2-curse" }],
      reinforcements: [{ id: "r1", ref: "enemy-grade2-curse", atRound: 2, chance: 0 }],
    });
    performBattleAction(state, { type: "pass" }, entry.lookup, () => 0.5);
    expect(battle.enemies).toHaveLength(1);
  });

  it("条件不成立就不来（when 走模板条件 DSL）", () => {
    const { state, entry } = getoWorld();
    state.flags.someFlag = 0;
    const battle = battleWith(state, entry, {
      enemies: [{ ref: "enemy-grade2-curse" }],
      reinforcements: [
        { id: "r1", ref: "enemy-grade2-curse", atRound: 2, chance: 1, when: [{ flag: "someFlag", gte: 1 }] },
      ],
    });
    performBattleAction(state, { type: "pass" }, entry.lookup, () => 0.5);
    expect(battle.enemies).toHaveLength(1);
    expect(battle.reinforcementFires?.["r1"]).toBeUndefined();
  });

  it("不写 everyRounds ⇒ 只来一次（50% 不会变成每回合 50%）", () => {
    const { state, entry } = getoWorld();
    const battle = battleWith(state, entry, {
      enemies: [{ ref: "enemy-grade2-curse" }],
      reinforcements: [{ id: "r1", ref: "enemy-grade2-curse", atRound: 2, chance: 1, maxAlive: 5 }],
    });
    performBattleAction(state, { type: "pass" }, entry.lookup, () => 0.5);
    performBattleAction(state, { type: "pass" }, entry.lookup, () => 0.5);
    performBattleAction(state, { type: "pass" }, entry.lookup, () => 0.5);
    expect(battle.enemies).toHaveLength(2);
    expect(battle.reinforcementFires?.["r1"]).toBe(1);
  });
});

describe("ADR-012 D4/D5 · 胜负条件与中立", () => {
  it("survive_rounds：撑过 N 回合即胜", () => {
    const { state, entry } = getoWorld();
    const battle = battleWith(state, entry, {
      enemies: [{ ref: "enemy-grade2-curse" }],
      victory: [{ kind: "survive_rounds", rounds: 1 }],
    });
    performBattleAction(state, { type: "pass" }, entry.lookup, () => 0.5);
    expect(battle.over).toBe("victory");
  });

  it("unit_down：敌方还剩人，但指定的那个倒了就算赢", () => {
    const { state, entry } = getoWorld();
    const battle = battleWith(state, entry, {
      enemies: [{ ref: "enemy-grade2-curse" }, { ref: "enemy-grade1-curse" }],
      victory: [{ kind: "unit_down", ref: "enemy-grade1-curse" }],
      canFlee: false,
    });
    battle.enemies[1].alive = false;
    battle.enemies[1].hp = 0;
    checkBattleEnd(battle, state);
    expect(battle.over).toBe("victory");
  });

  it("中立：不参与胜负（敌方全灭即胜，哪怕它还站着）", () => {
    const { state, entry } = getoWorld();
    const battle = battleWith(state, entry, {
      enemies: [{ ref: "enemy-grade2-curse" }],
      neutrals: [{ ref: "enemy-grade1-curse" }],
    });
    expect(battle.neutrals).toHaveLength(1);
    battle.enemies[0].alive = false;
    battle.enemies[0].hp = 0;
    checkBattleEnd(battle, state);
    expect(battle.over).toBe("victory");
    expect(battle.neutrals[0].alive).toBe(true);
  });

  it("中立：站在中间，双方的范围技都打到它", () => {
    const { state, entry } = getoWorld();
    const battle = battleWith(state, entry, {
      enemies: [{ ref: "enemy-grade2-curse" }],
      neutrals: [{ ref: "enemy-grade1-curse" }],
    });
    // 领域是五条的招：夏油不会，借来用一下（这里测的是目标解析，不是技能归属）
    state.player.skills.push("sk-domain-empty");
    const neutralBefore = battle.neutrals[0].hp;
    // 领域的全体目标 = 施放者视角的敌对阵营（含中立）
    performBattleAction(state, { type: "skill", skillId: "sk-domain-empty" }, entry.lookup, () => 0.5);
    expect(battle.neutrals[0].hp).toBeLessThan(neutralBefore);
  });
});

describe("ADR-012 D6/D7/D8 · 层数、授予技能、消耗修正", () => {
  it("stacksPerLayer：层数进战斗面，`damageTaken` 每层再减一成", () => {
    const entry = loadEntry();
    const raw = JSON.parse(JSON.stringify(entry.template)) as WorldTemplateV2;
    raw.statuses.push({
      id: "test-ward",
      name: "适应",
      stacking: "stack",
      combat: { damageTaken: -0.2, stacksPerLayer: true },
      visibility: "known",
    });
    const lookup = createLookup(raw);
    const state = createWorldV2({ templateId: "jjk-2006", seed: 7, playerName: "测试" }, raw, "w-adr012-ward");
    state.player.skills.push("sk-ten-spear");
    const battle = createBattle("ev:test", { enemies: [{ ref: "enemy-grade2-curse" }] }, state, lookup);
    state.battle = battle;

    const ward = (stacks: number): StatusInstance => ({ statusId: "test-ward", stacks, appliedTurn: 0, appliedAt: 0 });
    // 1 层：32 × 0.8 = 25.6 ⇒ 26
    battle.enemies[0].statuses = [ward(1)];
    battle.enemies[0].hp = 500;
    performBattleAction(state, { type: "skill", skillId: "sk-ten-spear" }, lookup, () => 0.5);
    const one = 500 - battle.enemies[0].hp;

    battle.enemies[0].statuses = [ward(3)];
    battle.enemies[0].hp = 500;
    battle.enemies[0].alive = true;
    performBattleAction(state, { type: "skill", skillId: "sk-ten-spear" }, lookup, () => 0.5);
    const three = 500 - battle.enemies[0].hp;

    expect(one).toBe(26);
    // 3 层：32 × (1 - 0.6) = 12.8 ⇒ 13（定值口径下会是同一个 26）
    expect(three).toBe(13);
  });

  it("grantsSkill：拿着天逆鉾就拥有那一招（甚尔自带即可放）", () => {
    const { state, entry } = getoWorld();
    // 甚尔在玩家开局时还是 unspawned，直接塞进战斗会被判活过滤掉 ⇒ 单件构建更能说明问题
    const toji = entry.template.characters.find((c) => c.id === "npc-toji");
    expect(toji?.equipment).toContain("eq-ten-spear");
    const unit = buildUnit(toji!, state, entry.lookup, {});
    expect(unit.skills).toContain("sk-ten-spear");
  });

  it("grantsSkill：玩家没拿就没有（`skill_not_owned`）", () => {
    const { state, entry } = getoWorld();
    battleWith(state, entry, { enemies: [{ ref: "enemy-grade2-curse" }] });
    expect(() =>
      performBattleAction(state, { type: "skill", skillId: "sk-ten-spear" }, entry.lookup, () => 0.5),
    ).toThrow("skill_not_owned");
    expect(playerSkills(state, entry.lookup)).not.toContain("sk-ten-spear");
  });

  it("咒力效率：六眼把苍从 18 压到 6（ceil 不是 round）", () => {
    const { state, entry } = getoWorld();
    const battle = battleWith(state, entry, { enemies: [{ ref: "enemy-grade2-curse" }] });
    const before = effectiveCostOf(state, battle, state.player.id, "sk-gojo-blue", entry.lookup);
    // 夏油总量 48 ⇒ 效率 24 ⇒ mp 消耗 -14.4%：18 × 0.856 = 15.4 ⇒ 16。
    expect(before.mp).toBe(16);

    state.player.statuses.push({ statusId: "six-eyes", stacks: 1, appliedTurn: 0, appliedAt: 0 });
    battle.player.statuses.push({ statusId: "six-eyes", stacks: 1, appliedTurn: 0, appliedAt: 0 });
    const after = effectiveCostOf(state, battle, state.player.id, "sk-gojo-blue", entry.lookup);
    // 六眼 +90 效率：24 + 90 = 114 ⇒ -68.4%：18 × 0.316 = 5.69 ⇒ 6（显式 ceil）。
    expect(after.mp).toBe(6);
    const heavy = effectiveCostOf(state, battle, state.player.id, "sk-gojo-red", entry.lookup);
    expect(heavy.mp).toBe(11);
  });
});

/**
 * ADR-013 · 召唤生命周期（用户口径 2026-11-20）
 *
 * 「杂兵献祭就献祭了，也不搞池子做库存了，就当无限；英雄单位就用宝可梦那种模式，
 *  死了/献祭就没了，召唤不了了。协议统一在技能里 summon 点名。消耗啥的也不返回。
 *  战斗内收回再召唤，状态继承；第二次战斗状态自动回满。」
 *
 * 这四条就是下面这组用例：没有账本、英雄会真的消失、回收架保留状态、跨战斗归零。
 */
describe("ADR-013 D2/D3/D4/D5 · 召唤生命周期", () => {
  /** 血量拉满的木桩：这几条用例要连跑几个回合，敌人先死会让战斗提前结束。 */
  function beefyBattle(state: WorldStateV2, entry: ReturnType<typeof loadEntry>): BattleState {
    const battle = battleWith(state, entry, { enemies: [{ ref: "enemy-grade2-curse" }] });
    const foe = battle.enemies[0];
    foe.hp = 5000;
    foe.maxHp = 5000;
    battle.player.mp = 99;
    return battle;
  }

  it("战斗内收回再召：回来的是**同一只**，血与状态都还在", () => {
    const { state, entry } = getoWorld();
    const battle = beefyBattle(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-summon-curse" }, entry.lookup, () => 0.5);
    const hurt = summons(battle)[0];
    hurt.hp = 7;
    const hurtId = hurt.instanceId;

    performBattleAction(state, { type: "skill", skillId: "sk-recall" }, entry.lookup, () => 0.5);
    expect(battle.bench?.some((u) => u.instanceId === hurtId)).toBe(true);

    // 补满第三只：回来的是那一只，不是一只新的
    performBattleAction(state, { type: "skill", skillId: "sk-summon-curse" }, entry.lookup, () => 0.5);
    const back = summons(battle).find((u) => u.instanceId === hurtId);
    expect(back).toBeDefined();
    expect(back?.hp).toBe(7);
    expect(battle.bench).toHaveLength(0);
  });

  it("第二次战斗自动回满：回收架随 battle 丢弃，新一场是新的个体", () => {
    const { state, entry } = getoWorld();
    const battle = beefyBattle(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-summon-curse" }, entry.lookup, () => 0.5);
    const hurt = summons(battle)[0];
    hurt.hp = 1;

    battle.over = "victory";
    finishBattle(state, entry.lookup);

    const next = beefyBattle(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-summon-curse" }, entry.lookup, () => 0.5);
    expect(summons(next).every((u) => u.hp === u.maxHp)).toBe(true);
  });

  it("英雄阵亡 ⇒ 记进 `lostSummons`，本局再也召不出来", () => {
    const { state, entry } = getoWorld();
    const battle = beefyBattle(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-summon-dragon" }, entry.lookup, () => 0.5);
    const hero = summons(battle).find((u) => u.tier === "hero")!;
    expect(hero.summonRef).toBe("curse-rainbow-dragon");

    hero.hp = 0;
    performBattleAction(state, { type: "pass" }, entry.lookup, () => 0.5);

    expect(hero.alive).toBe(false);
    expect(state.lostSummons).toContain("curse-rainbow-dragon");
    // 冷却先清掉：这里要测的是「没了」这条判定，不是「还在转冷却」。
    battle.player.skillCooldowns["sk-summon-dragon"] = 0;
    expect(canUseSkill(state, battle, state.player.id, "sk-summon-dragon", entry.lookup)).toEqual({
      ok: false,
      reason: "summon_lost",
    });
    // ADR-015（2026-11-20 用户裁决）改口径：不再从面板上拿掉 —— 留着并挂封印说明原因
    // （「藏起来」让玩家分不清「没学过」和「学过但没了」）。详细断言在 adr-015.test.ts。
    const snap = projectSnapshotV2(state, entry.template, entry.lookup);
    const listed = snap.battle?.player.skills.find((s) => s.id === "sk-summon-dragon");
    expect(listed?.seal?.code).toBe("summon_lost");
  });

  it("英雄被献祭 ⇒ 同样永久失去（献祭不是召回）", () => {
    const { state, entry } = getoWorld();
    const battle = beefyBattle(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-summon-dragon" }, entry.lookup, () => 0.5);

    const foe = battle.enemies[0];
    const before = foe.hp;
    performBattleAction(state, { type: "skill", skillId: "sk-uzumaki" }, entry.lookup, () => 0.5);

    // 10（基础）+ 55（英雄档作价）
    expect(before - foe.hp).toBe(65);
    expect(summons(battle)).toHaveLength(0);
    expect(state.lostSummons).toContain("curse-rainbow-dragon");
  });

  it("杂兵阵亡不记账：它们是兵力，不是资产", () => {
    const { state, entry } = getoWorld();
    const battle = beefyBattle(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-summon-curse" }, entry.lookup, () => 0.5);
    summons(battle)[0].hp = 0;
    performBattleAction(state, { type: "pass" }, entry.lookup, () => 0.5);

    expect(state.lostSummons ?? []).not.toContain("enemy-grade2-curse");
    expect(canUseSkill(state, battle, state.player.id, "sk-summon-curse", entry.lookup).ok).toBe(true);
  });

  it("旋涡：三只杂兵 = 10 + 15×3 = 55，打完一只不剩", () => {
    const { state, entry } = getoWorld();
    const battle = beefyBattle(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-summon-curse" }, entry.lookup, () => 0.5);
    expect(summons(battle)).toHaveLength(3);

    const foe = battle.enemies[0];
    const before = foe.hp;
    performBattleAction(state, { type: "skill", skillId: "sk-uzumaki" }, entry.lookup, () => 0.5);

    expect(before - foe.hp).toBe(55);
    expect(aliveAllies(battle)).toHaveLength(0);
  });

  it("献祭掉的不进回收架：再也收不回来了", () => {
    const { state, entry } = getoWorld();
    const battle = beefyBattle(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-summon-curse" }, entry.lookup, () => 0.5);
    performBattleAction(state, { type: "skill", skillId: "sk-uzumaki" }, entry.lookup, () => 0.5);

    expect(battle.bench ?? []).toHaveLength(0);
    expect(canUseSkill(state, battle, state.player.id, "sk-recall", entry.lookup)).toEqual({
      ok: false,
      reason: "recall_empty",
    });
  });

  it("没有祭品就放不出旋涡（`sacrifice_empty`），不是白扣 25 点 MP", () => {
    const { state, entry } = getoWorld();
    const battle = beefyBattle(state, entry);
    expect(canUseSkill(state, battle, state.player.id, "sk-uzumaki", entry.lookup)).toEqual({
      ok: false,
      reason: "sacrifice_empty",
    });
  });

  it("友军单体：只治指定的那一只，不再顺带治好全场", () => {
    const { state, entry } = getoWorld();
    const battle = beefyBattle(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-summon-curse" }, entry.lookup, () => 0.5);
    const [first, second] = summons(battle);
    first.hp = 1;
    second.hp = 1;
    // 夏油不会治人：把硝子的技能临时塞给他，只为走通「友军单体」这条链。
    state.player.skills.push("sk-reverse-heal-ally");

    performBattleAction(
      state,
      { type: "skill", skillId: "sk-reverse-heal-ally", targetInstanceId: second.instanceId },
      entry.lookup,
      () => 0.5,
    );

    expect(second.hp).toBeGreaterThan(1);
    expect(first.hp).toBe(1);
  });
});

/**
 * ADR-013 D7 · 十影（召唤流）
 *
 * 与咒灵操术共用**同一套**协议，差别只有三处：没有 `sacrifice`、除脱兔外全是英雄档、
 * 英雄阵亡即永久失去。所以这里不重测生命周期（`battle.bench` / `lostSummons` 上面测过），
 * 只测十影特有的形状：脱兔是兵力、式神共享一个英雄位、换手靠收回、魔虚羅自伤换时间。
 */
describe("ADR-013 D7 · 十影（召唤流）", () => {
  function megumiWorld(seed = 21) {
    const entry = loadEntry();
    const state = createWorldV2(
      { templateId: "jjk-2006", seed, self: { kind: "reuse", characterId: "npc-megumi" } },
      entry.template,
      `w-adr013-ten-${seed}`,
    );
    return { state, entry };
  }

  /** 血量拉满的木桩：换手要连跑几回合，敌人先死会让战斗提前结束。 */
  function beefy(state: WorldStateV2, entry: ReturnType<typeof loadEntry>): BattleState {
    const battle = battleWith(state, entry, { enemies: [{ ref: "enemy-grade2-curse" }] });
    battle.enemies[0].hp = 5000;
    battle.enemies[0].maxHp = 5000;
    return battle;
  }

  it("脱兔：一次三只、杂兵档，且不花任何资源（只花 MP）", () => {
    const { state, entry } = megumiWorld();
    const battle = beefy(state, entry);
    const mpBefore = battle.player.mp;
    performBattleAction(state, { type: "skill", skillId: "sk-ten-rabbits" }, entry.lookup, () => 0.5);

    const rabbits = summons(battle);
    expect(rabbits).toHaveLength(3);
    expect(rabbits.every((u) => u.tier === "minion")).toBe(true);
    expect(rabbits.every((u) => u.characterId === "shiki-rabbits")).toBe(true);
    expect(mpBefore - battle.player.mp).toBe(8);
  });

  it("英雄档共用一个名额：玉犬在场时召鵺 = 直接把玉犬顶下去（ADR-016）", () => {
    const { state, entry } = megumiWorld();
    const battle = beefy(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-ten-shadow" }, entry.lookup, () => 0.5);
    const dog = summons(battle)[0];

    expect(canUseSkill(state, battle, state.player.id, "sk-ten-nue", entry.lookup)).toEqual({ ok: true });
    performBattleAction(state, { type: "skill", skillId: "sk-ten-nue" }, entry.lookup, () => 0.5);

    expect(summons(battle)).toHaveLength(1);
    expect(summons(battle)[0].characterId).toBe("shiki-nue");
    // 玉犬在架子上等着，而不是「没了」
    expect(battle.bench?.some((u) => u.instanceId === dog.instanceId)).toBe(true);
    expect(state.lostSummons ?? []).not.toContain("shiki-gyokuken");
  });

  it("换手：收回的式神进回收架，再召回来还是**同一只**（伤还在）", () => {
    const { state, entry } = megumiWorld();
    const battle = beefy(state, entry);
    battle.player.mp = 99;

    performBattleAction(state, { type: "skill", skillId: "sk-ten-shadow" }, entry.lookup, () => 0.5);
    const dog = summons(battle)[0];
    dog.hp = 20;

    performBattleAction(state, { type: "skill", skillId: "sk-ten-recall" }, entry.lookup, () => 0.5);
    expect(summons(battle)).toHaveLength(0);
    expect(battle.bench).toHaveLength(1);

    // 空出来的位置换另一只：鵺上场，玉犬还在架子上
    performBattleAction(state, { type: "skill", skillId: "sk-ten-nue" }, entry.lookup, () => 0.5);
    expect(summons(battle)[0].characterId).toBe("shiki-nue");

    performBattleAction(state, { type: "skill", skillId: "sk-ten-recall" }, entry.lookup, () => 0.5);
    performBattleAction(state, { type: "skill", skillId: "sk-ten-shadow" }, entry.lookup, () => 0.5);

    const back = summons(battle)[0];
    expect(back.instanceId).toBe(dog.instanceId);
    expect(back.hp).toBe(20);
  });

  it("十影没有献祭：整套技能都不声明 `sacrifice`（那是咒灵操术的私有解法）", () => {
    const { entry } = megumiWorld();
    for (const id of [
      "sk-ten-rabbits",
      "sk-ten-shadow",
      "sk-ten-nue",
      "sk-ten-gama",
      "sk-ten-orochi",
      "sk-ten-enzuru",
      "sk-ten-kangyu",
      "sk-ten-mahoraga",
    ]) {
      const skill = entry.lookup.skill(id);
      expect(skill?.kind).toBe("combat");
      expect((skill as { sacrifice?: unknown }).sacrifice).toBeUndefined();
      expect((skill as { summon?: unknown }).summon).toBeDefined();
    }
  });

  it("魔虚羅：召它拿两天状态换，代价挂在施放者身上", () => {
    const { state, entry } = megumiWorld();
    const battle = beefy(state, entry);
    battle.player.mp = 99;
    performBattleAction(state, { type: "skill", skillId: "sk-ten-mahoraga" }, entry.lookup, () => 0.5);

    // ADR-014：它是**中立**的，不在友军里 —— 见下面那组用例。
    expect(battle.neutrals.some((u) => u.characterId === "shiki-mahoraga")).toBe(true);
    expect(summons(battle)).toHaveLength(0);
    expect(battle.player.statuses.some((s) => s.statusId === "battle-exhausted")).toBe(true);
  });

  it("玉犬阵亡 ⇒ 那一招还在面板上，但挂上封印（别的式神不受影响）", () => {
    const { state, entry } = megumiWorld();
    const battle = beefy(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-ten-shadow" }, entry.lookup, () => 0.5);
    const dog = summons(battle)[0];
    dog.hp = 0;
    performBattleAction(state, { type: "pass" }, entry.lookup, () => 0.5);

    expect(dog.alive).toBe(false);
    expect(state.lostSummons).toContain("shiki-gyokuken");
    expect(canUseSkill(state, battle, state.player.id, "sk-ten-shadow", entry.lookup)).toEqual({
      ok: false,
      reason: "summon_lost",
    });

    // ADR-015：不再从面板上删掉，改成「列出 + 封印」。
    const snap = projectSnapshotV2(state, entry.template, entry.lookup);
    const skills = snap.battle?.player.skills ?? [];
    expect(skills.find((s) => s.id === "sk-ten-shadow")?.seal?.code).toBe("summon_lost");
    expect(skills.find((s) => s.id === "sk-ten-nue")?.seal).toBeUndefined();
  });
});

/**
 * ADR-014 · 未调伏的魔虚罗
 *
 * 三条语义各自用一个用例钉住：站中间（敌我不分靠既有的 `campsOf`）、越打越硬（层数进结算）、
 * 死了不算「失去式神」（未调伏就不在名册里）。另外钉一条召回边界。
 */
describe("ADR-014 · 未调伏的魔虚罗", () => {
  function megumi(seed = 31) {
    const entry = loadEntry();
    const state = createWorldV2(
      { templateId: "jjk-2006", seed, self: { kind: "reuse", characterId: "npc-megumi" } },
      entry.template,
      `w-adr014-${seed}`,
    );
    return { state, entry };
  }

  /** 血量拉满的木桩：适应要看几回合的走势，敌人先死会让战斗提前结束。 */
  function arena(state: WorldStateV2, entry: ReturnType<typeof loadEntry>): BattleState {
    const battle = battleWith(state, entry, { enemies: [{ ref: "enemy-grade2-curse" }] });
    battle.enemies[0].hp = 5000;
    battle.enemies[0].maxHp = 5000;
    battle.player.mp = 99;
    return battle;
  }

  const mahoragaOf = (battle: BattleState) => battle.neutrals.find((u) => u.characterId === "shiki-mahoraga");

  it("站中间：进 neutrals，不进友军", () => {
    const { state, entry } = megumi();
    const battle = arena(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-ten-mahoraga" }, entry.lookup, () => 0.5);

    expect(mahoragaOf(battle)).toBeDefined();
    expect(battle.allies.some((a) => a.characterId === "shiki-mahoraga")).toBe(false);
    expect(mahoragaOf(battle)?.summonedBy).toBe(state.player.id);
  });

  it("敌我不分：玩家能打它，它也打玩家 —— 两边互为敌对", () => {
    const { state, entry } = megumi();
    const battle = arena(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-ten-mahoraga" }, entry.lookup, () => 0.5);
    const maho = mahoragaOf(battle)!;

    // ① 友军 → 中立：`target: enemy` 的 hostile 里含中立项，所以「自己的召唤物」打得中。
    // 命中率在 0.4~0.5 区间（敏捷差 4 点 ×0.05）；魔虚罗敏捷 4 ⇒ 闪避 4%，
    // 所以骰子取 0.2：低于命中率、高于闪避率。
    performBattleAction(
      state,
      { type: "skill", skillId: "sk-basic-strike", targetInstanceId: maho.instanceId },
      entry.lookup,
      () => 0.2,
    );
    // 它每回合末会被法轮回满血，所以「掉过血」不能靠事后读数断言 —— 看日志。
    expect(battle.log.some((l) => l.includes("命中八握剑异戒神将魔虚罗，造成"))).toBe(true);

    // ② 中立 → 玩家：它自己行动时，目标从「敌 + 友」两边取。
    const playerHp = battle.player.hp;
    for (let i = 0; i < 6 && !battle.over; i += 1) {
      performBattleAction(state, { type: "pass" }, entry.lookup, () => 0.5);
    }
    expect(battle.player.hp < playerHp || battle.enemies[0].hp < 5000).toBe(true);
  });

  it("它死了不判胜，也不记进 lostSummons（未调伏 ≠ 失去式神）", () => {
    const { state, entry } = megumi();
    const battle = arena(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-ten-mahoraga" }, entry.lookup, () => 0.5);
    const maho = mahoragaOf(battle)!;
    maho.hp = 0;
    performBattleAction(state, { type: "pass" }, entry.lookup, () => 0.5);

    expect(maho.alive).toBe(false);
    expect(state.lostSummons ?? []).not.toContain("shiki-mahoraga");
    expect(canUseSkill(state, battle, state.player.id, "sk-ten-mahoraga", entry.lookup)).not.toEqual({
      ok: false,
      reason: "summon_lost",
    });
  });

  it("适应：法轮每回合末叠一层，减伤按层数递增", () => {
    const { state, entry } = megumi();
    const battle = arena(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-ten-mahoraga" }, entry.lookup, () => 0.5);
    const maho = mahoragaOf(battle)!;
    expect(maho.statuses.some((s) => s.statusId === "mahoraga-wheel")).toBe(true);

    for (let i = 0; i < 3; i += 1) {
      performBattleAction(state, { type: "pass" }, entry.lookup, () => 0.5);
    }
    const adapt = maho.statuses.find((s) => s.statusId === "mahoraga-adapt");
    expect(adapt).toBeDefined();
    expect(adapt!.stacks).toBeGreaterThanOrEqual(3);
  });

  it("打不死：法轮每回合回 25 点，砍掉大半血也会被拉回上限", () => {
    const { state, entry } = megumi();
    const battle = arena(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-ten-mahoraga" }, entry.lookup, () => 0.5);
    const maho = mahoragaOf(battle)!;
    maho.hp = 200;

    performBattleAction(state, { type: "pass" }, entry.lookup, () => 0.5);

    expect(maho.hp).toBeGreaterThan(200);
  });

  it("召回收不到中立那只（`recall_empty`）—— 暴走没有「收回」这个动作", () => {
    const { state, entry } = megumi();
    const battle = arena(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-ten-mahoraga" }, entry.lookup, () => 0.5);

    expect(canUseSkill(state, battle, state.player.id, "sk-ten-recall", entry.lookup)).toEqual({
      ok: false,
      reason: "recall_empty",
    });
  });
});
