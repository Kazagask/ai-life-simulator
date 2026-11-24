import { describe, expect, it } from "vitest";
import {
  checkBattleEnd,
  createBattle,
  createRng,
  finishBattle,
  performBattleAction,
} from "@life-sim/game-core";
import { makeWorld } from "../helpers/world.ts";

/**
 * ADR-075 §1：Stake（会不会死）与战果快照。
 *
 * 这一组守三件事：
 * 1. 判负阈值随 `defeatState`（dead → 0，其余 → 1），`checkBattleEnd` 不再夹血；
 * 2. 收场 HP 由 `hpOnDefeat` 决定（set / floor）；
 * 3. 战果快照在镜像丢弃前落下（伤害计数、killer、deaths）。
 */

function setup(stake: string) {
  const { state, entry } = makeWorld(31);
  const battle = createBattle(
    "ev:fight",
    { enemies: [{ ref: "enemy-x", levelScale: 1 }], stake },
    state,
    entry.lookup,
  );
  state.battle = battle;
  return { state, entry, battle };
}

describe("ADR-075 §1.1 · 判负阈值", () => {
  it("hard：hp ≤ 1 判负，收场写 1（恶战不判死）", () => {
    const { state, entry, battle } = setup("hard");
    expect(battle.defeatState).toBe("down");
    expect(battle.defeatThreshold).toBe(1);
    battle.player.hp = -5;
    checkBattleEnd(battle, state, entry.lookup);
    expect(battle.over).toBe("defeat");
    // 判负只写 over，不夹血；落点由收场统一写。
    expect(battle.player.hp).toBe(-5);

    finishBattle(state, entry.lookup);
    expect(state.player.hp).toBe(1);
    expect(state.lastBattleResult?.defeatState).toBe("down");
    expect(state.lastBattleResult?.player.hp).toBe(1);
  });

  it("deaths：hp ≤ 0 才判负，收场写 0", () => {
    const { state, entry, battle } = setup("deaths");
    expect(battle.defeatState).toBe("dead");
    expect(battle.defeatThreshold).toBe(0);

    battle.player.hp = 1;
    checkBattleEnd(battle, state, entry.lookup);
    expect(battle.over).toBeNull(); // 死斗里 1 血还活着

    battle.player.hp = 0;
    checkBattleEnd(battle, state, entry.lookup);
    expect(battle.over).toBe("defeat");

    finishBattle(state, entry.lookup);
    expect(state.player.hp).toBe(0);
    expect(state.lastBattleResult?.defeatState).toBe("dead");
    expect(state.lastBattleResult?.deaths.some((d) => d.side === "player")).toBe(true);
  });

  it("spar：floor 只保底、不往上抬", () => {
    const { state, entry, battle } = setup("spar");
    battle.over = "defeat";
    battle.player.hp = 4;
    finishBattle(state, entry.lookup);
    expect(state.player.hp).toBe(4);

    const second = setup("spar");
    second.battle.over = "defeat";
    second.battle.player.hp = -9;
    finishBattle(second.state, second.entry.lookup);
    expect(second.state.player.hp).toBe(1);
  });

  it("hp_below：按比例判负，不受判负阈值影响", () => {
    const { state, entry, battle } = setup("hard");
    battle.settle.defeat = [{ kind: "hp_below", ratio: 0.3 }];
    battle.player.maxHp = 100;
    battle.player.hp = 30;
    checkBattleEnd(battle, state, entry.lookup);
    expect(battle.over).toBe("defeat");
  });
});

describe("ADR-075 §3 · 战果快照", () => {
  it("伤害计数与击杀：玩家一刀打死敌人 ⇒ deals/hits/kills 都记在玩家身上", () => {
    const { state, entry, battle } = setup("hard");
    const target = battle.enemies[0]!;
    target.hp = 50; // sk-strike 固定 100，够一刀
    performBattleAction(
      state,
      { type: "skill", skillId: "sk-strike", targetInstanceId: target.instanceId },
      entry.lookup,
      createRng(7),
    );
    expect(battle.over).toBe("victory");

    finishBattle(state, entry.lookup);
    const result = state.lastBattleResult!;
    expect(result.player.damageDealt).toBe(100);
    expect(result.player.hits).toBe(1);
    expect(result.player.kills).toBe(1);
    expect(result.enemies[0]?.damageByPlayer).toBe(100);
    expect(result.enemies[0]?.defeated).toBe(true);
    expect(result.deaths.some((d) => d.ref === "enemy-x")).toBe(true);
    expect(result.killer).toBeUndefined(); // 玩家没死，没有凶手
  });

  it("killer：致命一击来源被记进战果，且不越权标到别人头上", () => {
    const { state, entry, battle } = setup("deaths");
    const enemy = battle.enemies[0]!;
    battle.over = "defeat";
    battle.player.hp = 0;
    battle.player.lastHitBy = enemy.instanceId;

    finishBattle(state, entry.lookup);
    const result = state.lastBattleResult!;
    expect(result.killer?.ref).toBe("enemy-x");
    expect(result.killer?.name).toBe("测试敌人");
    expect(result.enemies[0]?.killer).toBe(true);
  });

  it("新一场战斗清空上一场战果（死亡事件不会读到更早的那场）", () => {
    const { state, entry, battle } = setup("hard");
    battle.over = "victory";
    finishBattle(state, entry.lookup);
    expect(state.lastBattleResult).toBeDefined();

    createBattle("ev:fight", { enemies: [{ ref: "enemy-x" }], stake: "hard" }, state, entry.lookup);
    expect(state.lastBattleResult).toBeUndefined();
  });
});
