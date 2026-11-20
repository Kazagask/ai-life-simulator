import { describe, expect, it } from "vitest";
import { chooseOptionV2 } from "@life-sim/game-core";
import { makeWorld } from "../helpers/world.ts";

/**
 * 终止边界（2026-11-19 回归）。
 *
 * 选项结算是唯一靠 `effects` 里的 `setFlag` 写结局旗标的入口。旧实现只在
 * `advanceTurnV2` / 战斗 / 转盘确认三处调用 `applyEndingBoundary`，于是
 * 「已经死了 / 已经到结局了，却还要再点一轮才结束」——玩家看到的是结局条件成立后
 * 又多了一个回合。
 *
 * 判据仍然是**落盘旗标**（这里 `endingReached`），不读 HP 数值（R-EN-07 / P9）。
 */
describe("chooseOptionV2：选项结算当场走终止边界", () => {
  it("选项落下结局旗标 ⇒ 同一响应的快照里就有 ending，不需要再推一回合", () => {
    const { state, entry } = makeWorld();
    // makeWorld 建的是「还没交接」的世界（NOT_ACTIVE）；本用例只关心「结算这一刻」是否判终止。
    state.openingCompleted = true;
    // 直接把终局事件摆上槽。
    state.slot = { eventId: "ev:final", from: "hook" };
    const result = chooseOptionV2(
      state,
      { optionId: "opt-good" },
      entry.template,
      entry.lookup,
      { endingConfig: entry.endingConfig },
    );
    expect(state.termination).not.toBeNull();
    expect(state.termination?.endingId).toBe("end-good");
    expect(result.snapshot.ending?.endingId).toBe("end-good");
  });

  it("没写结局旗标的选项不误判终止（边界仍然是条件驱动）", () => {
    const { state, entry } = makeWorld();
    state.openingCompleted = true;
    state.slot = { eventId: "ev:start-gojo", from: "hook" };
    const result = chooseOptionV2(
      state,
      { optionId: "opt-go" },
      entry.template,
      entry.lookup,
      { endingConfig: entry.endingConfig },
    );
    expect(state.termination).toBeNull();
    expect(result.snapshot.ending ?? null).toBeNull();
  });
});
