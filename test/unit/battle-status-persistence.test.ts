import { describe, expect, it } from "vitest";
import { createBattle, createWorldV2, finishBattle, type WorldStateV2 } from "@life-sim/game-core";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * 战斗收尾（ADR-018 D4）。
 *
 * 规则一句话：**镜像整体丢弃，世界那份从来没被动过**。
 *
 * 旧判据是实例上的 `battleOnly` 标记，而那个标记由 `duration` 形态代理出来
 * （`{ rounds }` / `{ untilBattleEnd }` 才打），`exhausted` 这种两不像的就卡在缝里。
 * 三档之后不需要启发式：战斗态一律不回写，带出去的只有定义上的 `toModifier`
 * ——按「待了几回合」折算世界时间。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function loadEntry() {
  const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

const DAY = 24 * 60;

/**
 * 建一个「刚打完」的世界：玩家身上挂着三类来路的状态。
 * - 六眼 / 无下限：**挂载的天赋**（世界实例，战斗期间没被动过）
 * - 领域展开：**战斗态**，无 `toModifier` ⇒ 随镜像一起丢
 * - 咒火：**战斗态**，`toModifier → 灼伤`，按 `roundsHeld` 折算
 */
function endedBattle(held?: number): { state: WorldStateV2; entry: ReturnType<typeof loadEntry> } {
  const entry = loadEntry();
  const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed: 11 }, entry.template, "w-finish-status");
  const now = state.worldTime;
  for (const id of ["infinity", "six-eyes"]) {
    state.player.statuses.push({ statusId: id, stacks: 1, appliedTurn: 0, appliedAt: now });
  }
  state.battle = createBattle("ev:test", { enemies: [{ ref: "npc-gojo" }] }, state, entry.lookup);
  state.battle.player.statuses.push({
    statusId: "domain-active",
    stacks: 1,
    appliedTurn: state.turnIndex,
    appliedAt: now,
    roundsLeft: 3,
  });
  state.battle.player.statuses.push({
    statusId: "battle-cursed-burn",
    stacks: 2,
    appliedTurn: state.turnIndex,
    appliedAt: now,
    ...(held === undefined ? {} : { roundsHeld: held }),
  });
  state.battle.over = "victory";
  finishBattle(state, entry.lookup);
  return { state, entry };
}

describe("战斗收尾：镜像丢弃 + toModifier 折算", () => {
  it("挂载的天赋（六眼 / 无下限）战斗后还在——世界那份没被动过", () => {
    const ids = endedBattle().state.player.statuses.map((s) => s.statusId);
    expect(ids).toContain("infinity");
    expect(ids).toContain("six-eyes");
  });

  it("没有 toModifier 的战斗态一律不回写", () => {
    const ids = endedBattle().state.player.statuses.map((s) => s.statusId);
    expect(ids).not.toContain("domain-active");
  });

  it("折算出的世界状态带着到期点：每回合 1 天 × 3 回合", () => {
    const { state } = endedBattle(3);
    const burn = state.player.statuses.find((s) => s.statusId === "cursed-burn");
    expect(burn).toBeDefined();
    expect(burn?.expiresAt).toBe(state.worldTime + 3 * DAY);
    // 层数沿用：战场上叠了两层，离场还是两层
    expect(burn?.stacks).toBe(2);
  });

  it("roundsHeld 缺失按 1 回合算——挨了一下也留印子", () => {
    const { state } = endedBattle();
    const burn = state.player.statuses.find((s) => s.statusId === "cursed-burn");
    expect(burn?.expiresAt).toBe(state.worldTime + DAY);
  });

  it("折算过的世界状态会带进下一场（它是世界的东西）", () => {
    const { state, entry } = endedBattle(2);
    state.battle = createBattle("ev:test2", { enemies: [{ ref: "npc-gojo" }] }, state, entry.lookup);
    const ids = state.battle.player.statuses.map((s) => s.statusId);
    expect(ids).toContain("cursed-burn");
    expect(ids).not.toContain("battle-cursed-burn");
  });
});
