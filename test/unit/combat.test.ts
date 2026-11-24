import { describe, expect, it } from "vitest";
import type { BattleState } from "@life-sim/game-core";
import { checkBattleEnd, resolveCombatRefs } from "@life-sim/game-core";
import { makeWorld } from "../helpers/world.ts";

describe("battle: 结算 clamp 与参战者判活", () => {
  it("判负只写 over，不再夹血（落点由收场的 hpOnDefeat 决定，ADR-075）", () => {
    const { state } = makeWorld();
    const battle = {
      eventId: "ev:fight",
      settle: { enemies: [] },
      round: 1,
      player: { hp: 0, mp: 0, statuses: [], skillCooldowns: {} },
      enemies: [{ instanceId: "e1", alive: true }],
      allies: [],
      log: [],
      over: null,
    } as unknown as BattleState;

    checkBattleEnd(battle, state);
    expect(battle.player.hp).toBe(0);
    expect(battle.over).toBe("defeat");
  });

  it("非 alive 的友军被 resolveCombatRefs 剔除并记录", () => {
    const { state, entry } = makeWorld();
    const friend = state.npcs.find((npc) => npc.id === "npc-friend");
    expect(friend).toBeDefined();
    friend!.lifecycle = { state: "inactive", reasonCode: "left", sinceTurn: 0, sinceWorldTime: 0 };

    const resolved = resolveCombatRefs(
      { enemies: [], allies: [{ ref: "npc-friend" }] },
      state,
      entry.lookup,
    );
    expect(resolved.allies).toEqual([]);
    expect(resolved.inactiveNpcIds).toContain("npc-friend");
    expect(resolved.enemiesExhausted).toBe(true);
  });
});
