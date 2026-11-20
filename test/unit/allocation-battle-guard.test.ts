import { describe, expect, it } from "vitest";
import type { WorldStateV2 } from "@life-sim/shared";
import { allocationBlockedReason } from "../../apps/server/src/allocation-guard.ts";

/**
 * 战斗中禁止加点（2026-11-21 用户裁定）。
 *
 * 规则本身很短，但它守的是一条容易被"优化"掉的语义：战斗单位在开打那一刻就把
 * 属性快照进 `Combatant`，之后加点对这一场没有任何作用。判据只看
 * `battle.over === null` —— 已判胜负、尚未清场的状态允许加点。
 */

function worldWithBattle(battle: unknown): WorldStateV2 {
  return { battle } as unknown as WorldStateV2;
}

describe("加点的战斗门禁", () => {
  it("没有战斗时可以加点", () => {
    expect(allocationBlockedReason(worldWithBattle(null))).toBeNull();
    // 旧档可能没有该字段
    expect(allocationBlockedReason({} as WorldStateV2)).toBeNull();
  });

  it("战斗进行中（over 为 null）拒绝", () => {
    expect(allocationBlockedReason(worldWithBattle({ over: null }))).toBe("battle");
  });

  it("胜负已判定、还没清场时允许（战斗已经结束）", () => {
    expect(allocationBlockedReason(worldWithBattle({ over: { result: "win" } }))).toBeNull();
  });
});
