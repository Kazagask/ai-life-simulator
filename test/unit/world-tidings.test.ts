import { describe, expect, it } from "vitest";
import { advanceTurnV2, createWorldV2, type WorldStateV2 } from "@life-sim/game-core";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * 世界事实的「世事」栏（2026-11-19）。
 *
 * 事实不经过玩家：五条悟在 2007 年学会赫，跟玩家那回合在修炼还是在上课无关。
 * 所以它天然没有「本轮收获」——但「玩家没参与」不等于「玩家不该知道」。
 * `tidings` 是作者写给玩家的那一句，进编年史的 `world` 类；
 * `note` 仍是作者注（含设计说明），一个字都不上屏。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };
const DAY = 1440;

function loadEntry() {
  const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

function newWorld(seed = 31) {
  const entry = loadEntry();
  const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed }, entry.template, `w-tidings-${seed}`);
  state.openingCompleted = true;
  return { state, entry };
}

function advanceTo(state: WorldStateV2, entry: ReturnType<typeof loadEntry>, day: number): void {
  state.worldTime = day * DAY;
  advanceTurnV2(state, { action: { type: "rest", description: "" } }, entry.template, entry.lookup);
}

const tidings = (state: WorldStateV2) => state.history.filter((h) => h.type === "world");

describe("世界事实上屏", () => {
  it("怀玉开场：甚尔进东京，编年史多一条「世」（不是作者注）", () => {
    const { state, entry } = newWorld();
    advanceTo(state, entry, 216);

    const rows = tidings(state);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.summary.includes("没有咒力"))).toBe(true);
    // 作者注是写给开发者的（含「为什么写在时间表而不是事件」这种句子），不得上屏
    expect(rows.every((r) => !r.summary.includes("为什么写在时间表"))).toBe(true);
    // 事实自身仍然照常生效
    expect(state.npcs.find((n) => n.id === "npc-toji")?.lifecycle.state).toBe("alive");
  });

  it("一条事实只上一次：再推一轮不重复", () => {
    const { state, entry } = newWorld();
    advanceTo(state, entry, 216);
    const first = tidings(state).length;
    advanceTo(state, entry, 217);
    expect(tidings(state).length).toBe(first);
  });
});
