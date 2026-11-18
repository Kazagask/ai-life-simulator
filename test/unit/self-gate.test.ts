import { describe, expect, it } from "vitest";
import { checkAllConditions, createRng } from "@life-sim/game-core";
import { makeWorld } from "../helpers/world.ts";

/**
 * 一等 self 门控条件的运行期语义（2026-11-18 · 模板 branch 角色分派）。
 *
 * `selfIs` / `selfIsNot` 是 self 恒单值的互斥判定：
 * - as 变体用 selfIs（只有该演员命中）；
 * - 兜底变体用一组 selfIsNot（都不命中才走兜底）。
 * 两者都只读 `selfIdOf(state)`，展开期装配好、运行期求值，与 LLM 无关。
 */
describe("一等 self 门控条件", () => {
  const { state: baseState, entry } = makeWorld();

  const check = (selfId: string | undefined, conditions: Record<string, unknown>[]) =>
    checkAllConditions(conditions as never, {
      state: { ...baseState, ...(selfId !== undefined ? { selfId } : {}) },
      lookup: entry.lookup,
      rng: createRng(1),
    });

  it("selfIs：只有当前 self 命中", () => {
    expect(check("npc-friend", [{ selfIs: "npc-friend" }])).toBe(true);
    expect(check("player", [{ selfIs: "npc-friend" }])).toBe(false);
    expect(check(undefined, [{ selfIs: "player" }])).toBe(true); // 缺省 self = player
  });

  it("selfIsNot：排除指定演员，兜底变体用它避开 as 变体", () => {
    expect(check("player", [{ selfIsNot: "npc-friend" }])).toBe(true);
    expect(check("npc-friend", [{ selfIsNot: "npc-friend" }])).toBe(false);
  });

  it("兜底门控 = 多个 selfIsNot 逐条 AND，与任一 as 变体恒互斥", () => {
    const fallbackGate = [{ selfIsNot: "npc-friend" }, { selfIsNot: "npc-enemy" }];
    expect(check("player", fallbackGate)).toBe(true); // 两个都不是 ⇒ 走兜底
    expect(check("npc-friend", fallbackGate)).toBe(false);
    expect(check("npc-enemy", fallbackGate)).toBe(false);
    // 同一 self 下，as 变体与兜底不可能同时成立。
    expect(
      check("npc-friend", fallbackGate) && check("npc-friend", [{ selfIs: "npc-friend" }]),
    ).toBe(false);
  });
});
