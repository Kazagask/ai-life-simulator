import { describe, expect, it } from "vitest";
import { createBattle, createWorldV2, performBattleAction, projectSnapshotV2, type WorldStateV2 } from "@life-sim/game-core";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function loadEntry() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

/**
 * 黑闪的「会心窗口」（2026-11-21 用户反馈「战斗状态没展示到状态区」）。
 *
 * 根因不是投影：`{ rounds: 1 }` 的自增益在**当回合末**就被倒计时清掉，
 * 投影发生在回合结算之后，于是面板上看不见、下一击也吃不到 +50%。
 * 模板把它改成 `{ rounds: 2 }`（撑过本回合末，覆盖到下一次行动）。
 *
 * 这条用例守三件事：状态在、投影下发、下一击真的吃到伤害增幅。
 */
function battle(seed = 7): { state: WorldStateV2; entry: ReturnType<typeof loadEntry> } {
  const entry = loadEntry();
  const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed }, entry.template, `w-bf-${seed}`);
  for (const id of ["sk-black-flash", "sk-basic-strike"]) {
    if (!state.player.skills.includes(id)) state.player.skills.push(id);
  }
  state.player.mp = 200;
  state.battle = createBattle("ev:bf", { enemies: [{ ref: "enemy-grade2-curse" }] }, state, entry.lookup);
  return { state, entry };
}

describe("黑闪：会心窗口跨回合", () => {
  it("施放后状态还在，且投影下发给战斗面板", () => {
    const { state, entry } = battle();
    performBattleAction(state, { type: "skill", skillId: "sk-black-flash" }, entry.lookup, () => 0.5);

    const mirror = state.battle!.player.statuses.find((s) => s.statusId === "black-flash");
    expect(mirror, "战斗镜像里应该有黑闪").toBeDefined();
    expect(mirror!.roundsLeft ?? 0).toBeGreaterThanOrEqual(1);

    const snap = projectSnapshotV2(state, entry.template, entry.lookup);
    expect(snap.battle?.player.statuses.some((s) => s.id === "black-flash")).toBe(true);
    // 个人页的状态列表与战斗面板同源（投影合并镜像 + 世界层）。
    expect(snap.player.statuses.some((s) => s.id === "black-flash")).toBe(true);
  });

  it("下一击吃到 +50% 伤害（同一骰子下比不开窗口更疼）", () => {
    const strikeDamage = (withWindowFirst: boolean): number => {
      const { state, entry } = battle(11);
      if (withWindowFirst) {
        performBattleAction(state, { type: "skill", skillId: "sk-black-flash" }, entry.lookup, () => 0.5);
      }
      const before = state.battle!.enemies[0]!.hp;
      performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, entry.lookup, () => 0.5);
      return before - state.battle!.enemies[0]!.hp;
    };

    const boosted = strikeDamage(true);
    const plain = strikeDamage(false);
    expect(plain).toBeGreaterThan(0);
    expect(boosted).toBeGreaterThan(plain);
  });
});
