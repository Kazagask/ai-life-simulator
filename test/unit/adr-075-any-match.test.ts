import { describe, expect, it } from "vitest";
import { anyMatchMet, checkCondition, createLookup, createRng } from "@life-sim/game-core";
import {
  AnyMatchSchema,
  type AnyMatch,
  type BattleResult,
  type StatusInstance,
} from "@life-sim/shared";
import { makeWorld } from "../helpers/world.ts";

/**
 * ADR-075 §6：`anyMatch`。
 *
 * 守三件事：集合 / 字段是加载期白名单；任意一项满足即真；`battle.*` 有战果读战果、
 * 没战果读 `lastBattleResult`、两者都没有就是空集合（不猜）。
 */

const battleResult: BattleResult = {
  eventId: "ev",
  outcome: "defeat",
  stake: "deaths",
  defeatState: "dead",
  rounds: 5,
  player: {
    hp: 0,
    maxHp: 100,
    resources: [],
    attributes: {},
    power: 20,
    powerEnd: 0,
    damageDealt: 30,
    damageTaken: 40,
    crits: 1,
    hits: 2,
    kills: 0,
    statusStacks: {},
  },
  sides: { player: 20, ally: 0, enemy: 10, neutral: 0 },
  enemies: [
    {
      ref: "npc-kenjaku",
      name: "絹索",
      tier: "hero",
      power: 10,
      damageByPlayer: 30,
      damageToPlayer: 40,
      defeated: false,
      killer: true,
      summonedByPlayer: false,
    },
  ],
  killer: { ref: "npc-kenjaku", name: "絹索", tier: "hero", power: 10, summonedByPlayer: false },
  deaths: [{ id: "player", side: "player", name: "测试" }],
};

function setup() {
  const { state, entry } = makeWorld(61);
  return { state, lookup: entry.lookup };
}

describe("ADR-075 §6 · anyMatch 求值", () => {
  it("战评传入的战果优先：ref + damageByPlayer 同时成立", () => {
    const { state } = setup();
    const match: AnyMatch = {
      over: "battle.enemies",
      where: [
        { field: "ref", eq: "npc-kenjaku" },
        { field: "damageByPlayer", gte: 1 },
      ],
    };
    expect(anyMatchMet(match, { state, battle: battleResult })).toBe(true);
  });

  it("没有显式战果时读 lastBattleResult", () => {
    const { state } = setup();
    state.lastBattleResult = battleResult;
    expect(
      anyMatchMet(
        { over: "battle.enemies", where: [{ field: "killer", eq: true }] },
        { state },
      ),
    ).toBe(true);
  });

  it("两者都没有 ⇒ 空集合 ⇒ false（不猜）", () => {
    const { state } = setup();
    expect(
      anyMatchMet({ over: "battle.enemies", where: [{ field: "ref", eq: "npc-kenjaku" }] }, { state }),
    ).toBe(false);
  });

  it("状态集合：stacks / progress 都是数值谓词", () => {
    const { state } = setup();
    const inst: StatusInstance = {
      statusId: "inj",
      stacks: 2,
      appliedTurn: 0,
      appliedAt: 0,
      progress: 3,
    };
    state.player.statuses.push(inst);
    expect(
      anyMatchMet(
        {
          over: "player.statuses",
          where: [
            { field: "statusId", eq: "inj" },
            { field: "stacks", gte: 2 },
            { field: "progress", lt: 4 },
          ],
        },
        { state },
      ),
    ).toBe(true);
  });

  it("背包 / NPC 集合", () => {
    const { state } = setup();
    state.player.inventory["potion"] = 3;
    expect(
      anyMatchMet({ over: "player.inventory", where: [{ field: "itemId", eq: "potion" }, { field: "count", gte: 3 }] }, { state }),
    ).toBe(true);
    expect(
      anyMatchMet(
        { over: "npcs", where: [{ field: "id", eq: "npc-friend" }, { field: "lifecycle", eq: "alive" }] },
        { state },
      ),
    ).toBe(true);
  });

  it("checkCondition 接线：同一份 anyMatch 走引擎入口", () => {
    const { state, lookup } = setup();
    state.lastBattleResult = battleResult;
    expect(
      checkCondition(
        { anyMatch: { over: "battle.enemies", where: [{ field: "ref", eq: "npc-kenjaku" }] } },
        { state, lookup, rng: createRng(1) },
      ),
    ).toBe(true);
  });
});

describe("ADR-075 §6 · 加载期白名单", () => {
  it.each([
    ["未知集合", { over: "battle.dead", where: [{ field: "ref", eq: "x" }] }],
    ["未知字段", { over: "battle.enemies", where: [{ field: "hp", gte: 1 }] }],
    ["布尔字段用数值谓词", { over: "battle.enemies", where: [{ field: "alive", gte: 1 }] }],
    ["空 where", { over: "battle.enemies", where: [] }],
  ])("拒绝 %s", (_label, value) => {
    expect(AnyMatchSchema.safeParse(value).success).toBe(false);
  });
});
