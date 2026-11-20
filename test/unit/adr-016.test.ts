import { describe, expect, it } from "vitest";
import {
  canUseSkill,
  createBattle,
  createWorldV2,
  performBattleAction,
  type WorldStateV2,
} from "@life-sim/game-core";
import type { BattleState } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function loadEntry() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

/** 以惠开局：十影六只式神共享一个英雄位，是「换手」这件事的样板。 */
function megumi(seed = 31) {
  const entry = loadEntry();
  const state = createWorldV2(
    { templateId: "jjk-2006", seed, self: { kind: "reuse", characterId: "npc-megumi" } },
    entry.template,
    `w-adr016-${seed}`,
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

/** 血量拉满的木桩：这几条用例要连跑好几回合，敌人先死会让战斗提前结束。 */
function arena(state: WorldStateV2, entry: ReturnType<typeof loadEntry>): BattleState {
  const battle = battleWith(state, entry, { enemies: [{ ref: "enemy-grade2-curse" }] });
  battle.enemies[0].hp = 5000;
  battle.enemies[0].maxHp = 5000;
  battle.player.mp = 99;
  return battle;
}

const allies = (battle: BattleState) => battle.allies.filter((a) => a.alive);

/**
 * 摆一个**中立式神**（未调伏的魔虚罗）占位：只关心「它在不在场上、会不会被顶掉」，
 * 不想牵动它每回合 94 点的那一刀。`skills: []` ⇒ 它只会「蓄势待发」。
 */
function stubNeutralMahoraga(battle: BattleState, ownerId: string): void {
  battle.neutrals.push({
    instanceId: "stub-neutral",
    characterId: "shiki-mahoraga",
    name: "八握剑异戒神将魔虚罗",
    hp: 345,
    maxHp: 345,
    mp: 0,
    attributes: {},
    resources: {},
    statuses: [],
    skillCooldowns: {},
    skills: [],
    skillWeights: {},
    alive: true,
    tier: "hero",
    summonedBy: ownerId,
    summonRef: "shiki-mahoraga",
  });
}

describe("ADR-016 D1 · 中立单位打两边", () => {
  it("谁最该打就打谁：对面残血时它打对面，不是只追玩家", () => {
    const { state, entry } = megumi();
    const battle = arena(state, entry);
    // 让敌方的血量比例远低于玩家 ⇒ 中立该挑它。召唤那个回合就会出手（D2 同样适用）。
    battle.enemies[0].hp = 40;

    performBattleAction(state, { type: "skill", skillId: "sk-ten-mahoraga" }, entry.lookup, () => 0.01);

    expect(battle.enemies[0].hp).toBeLessThan(40);
  });
});

describe("ADR-016 D2 · 召唤物在登场的那一回合就行动", () => {
  it("玉犬召出来当场就咬（同一个 `performBattleAction` 里）", () => {
    const { state, entry } = megumi();
    const battle = arena(state, entry);
    const before = battle.enemies[0].hp;

    performBattleAction(state, { type: "skill", skillId: "sk-ten-shadow" }, entry.lookup, () => 0.01);

    expect(allies(battle).map((a) => a.characterId)).toContain("shiki-gyokuken");
    expect(battle.enemies[0].hp).toBeLessThan(before);
  });

  it("`enteredRound` 照旧写在单位上（那是它什么时候上场的记录，不是禁令）", () => {
    const { state, entry } = megumi();
    const battle = arena(state, entry);

    performBattleAction(state, { type: "skill", skillId: "sk-ten-shadow" }, entry.lookup, () => 0.01);

    // 一次行动结束会推进回合号，所以它「上场的那个回合」是 `round - 1`
    expect(allies(battle)[0].enteredRound).toBe(battle.round - 1);
  });

  it("中途加入的援军仍然不行动（到场即出手会读成两次行动）", () => {
    const { state, entry } = megumi();
    const battle = battleWith(state, entry, {
      enemies: [{ ref: "enemy-grade2-curse" }],
      reinforcements: [{ id: "r1", ref: "enemy-grade1-curse", atRound: 2, chance: 1, maxAlive: 1 }],
    });
    const playerHp = battle.player.hp;

    performBattleAction(state, { type: "pass" }, entry.lookup, () => 0.01);

    const arrival = battle.enemies.find((e) => e.characterId === "enemy-grade1-curse");
    expect(arrival).toBeDefined();
    // 援军身上没有 `summonRef`：它是剧本丢进来的，不是谁花一个回合召来的
    expect(arrival?.summonRef).toBeUndefined();
    // 它这一回合没出手（玩家掉的血只可能来自原本那只二级咒灵）
    expect(battle.log.some((l) => l.includes("一级咒灵") && l.includes("命中"))).toBe(false);
    expect(playerHp - battle.player.hp).toBeLessThanOrEqual(20);
  });
});

describe("ADR-016 D3 · 满员是替换，不是封印", () => {
  it("英雄位满 ⇒ 后召的顶掉先召的，玉犬进回收架（不阵亡、不记永久损失）", () => {
    const { state, entry } = megumi();
    const battle = arena(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-ten-shadow" }, entry.lookup, () => 0.5);
    const dog = allies(battle)[0];

    // 满员不再是「放不出来」：面板上不该有封印（ADR-015 的 `seal` 里已经没有这一条）
    expect(canUseSkill(state, battle, state.player.id, "sk-ten-nue", entry.lookup)).toEqual({ ok: true });
    performBattleAction(state, { type: "skill", skillId: "sk-ten-nue" }, entry.lookup, () => 0.5);

    expect(allies(battle).map((a) => a.characterId)).toEqual(["shiki-nue"]);
    expect(battle.bench?.some((u) => u.instanceId === dog.instanceId)).toBe(true);
    expect(state.lostSummons ?? []).not.toContain("shiki-gyokuken");
  });

  it("**中立单位不占名额**：魔虚罗站在场上，玉犬照样召得出来", () => {
    const { state, entry } = megumi();
    const battle = arena(state, entry);
    stubNeutralMahoraga(battle, state.player.id);

    performBattleAction(state, { type: "skill", skillId: "sk-ten-shadow" }, entry.lookup, () => 0.5);

    expect(battle.neutrals).toHaveLength(1);
    expect(allies(battle).map((a) => a.characterId)).toEqual(["shiki-gyokuken"]);
  });

  it("**中立单位不会被顶掉**：名额只从友军里出人", () => {
    const { state, entry } = megumi();
    const battle = arena(state, entry);
    stubNeutralMahoraga(battle, state.player.id);
    performBattleAction(state, { type: "skill", skillId: "sk-ten-shadow" }, entry.lookup, () => 0.5);
    const dog = allies(battle)[0];

    // 友军英雄位已满 ⇒ 顶掉的是玉犬，不是站在旁边的魔虚罗
    performBattleAction(state, { type: "skill", skillId: "sk-ten-gama" }, entry.lookup, () => 0.5);

    expect(battle.neutrals.map((n) => n.instanceId)).toEqual(["stub-neutral"]);
    expect(allies(battle).map((a) => a.characterId)).toEqual(["shiki-gama"]);
    expect(battle.bench?.some((u) => u.instanceId === dog.instanceId)).toBe(true);
  });

  it("**召中立魔虚罗不占也不顶友军名额**（用户 02:26 实测：玉犬被替了）", () => {
    const { state, entry } = megumi();
    const battle = arena(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-ten-shadow" }, entry.lookup, () => 0.5);
    const dog = allies(battle)[0];
    expect(allies(battle).map((a) => a.characterId)).toEqual(["shiki-gyokuken"]);

    // 魔虚罗落在中立项，所以它数的是中立项的名额（空 ⇒ 有空位），不该把玉犬挪进回收架
    performBattleAction(state, { type: "skill", skillId: "sk-ten-mahoraga" }, entry.lookup, () => 0.5);

    expect(allies(battle).map((a) => a.characterId)).toEqual(["shiki-gyokuken"]);
    expect(allies(battle)[0].instanceId).toBe(dog.instanceId);
    expect(battle.bench ?? []).toHaveLength(0);
    expect(battle.neutrals.map((n) => n.summonRef)).toContain("shiki-mahoraga");
    expect(battle.log.some((l) => l.includes("被替换下场"))).toBe(false);
  });
});
