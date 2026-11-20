import { describe, expect, it } from "vitest";
import {
  advanceTurnV2,
  applyEffectsV2,
  applyStatusToPlayer,
  createRng,
  createRunnerContext,
  createWorldV2,
  pruneExpiredStatuses,
  type WorldStateV2,
} from "@life-sim/game-core";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * 状态时长按**世界时间**（ADR-009 D2）。
 *
 * 这一组用例守的是那个已经出过事的边界：`turnIndex` 数的是「指针推进了几次」，
 * 而事件可以 `advanceTo 4752 day` 而一格状态都不缩水。旧实现里 `turns: 3` 的重伤
 * 能跟着玩家跨完 12 年蒙太奇——因为「3」数的是玩家点了多少次，不是过了多久。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };
const DAY = 1440;

function loadEntry() {
  const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

function newWorld(seed = 11) {
  const entry = loadEntry();
  const state = createWorldV2(
    { templateId: "jjk-2006", playerName: "测试", seed },
    entry.template,
    `w-duration-${seed}`,
  );
  state.openingCompleted = true;
  return { state, entry };
}

const has = (state: WorldStateV2, id: string) => state.player.statuses.some((s) => s.statusId === id);

describe("模拟域时长 = 世界时间", () => {
  it("事件把时间推到两个月后：「三天痊愈」的伤自己就好了", () => {
    const { state, entry } = newWorld();
    applyStatusToPlayer(state, "injured-sim", 1, entry.lookup, { value: 3, unit: "day" });
    expect(has(state, "injured-sim")).toBe(true);

    // 走引擎的时间效果（和事件里的 `advanceTo` 同一条路径），而不是手改 worldTime
    applyEffectsV2(
      { state, lookup: entry.lookup, rng: createRng(1), logs: [] },
      [{ type: "advanceTo", value: { value: 60, unit: "day" } }],
    );

    expect(has(state, "injured-sim")).toBe(false);
  });

  it("时间不动就不会缩水：反复读取 / 反复结算都不消耗时长", () => {
    const { state, entry } = newWorld();
    applyStatusToPlayer(state, "injured-sim", 1, entry.lookup, { value: 3, unit: "day" });
    const expiresAt = state.player.statuses.find((s) => s.statusId === "injured-sim")?.expiresAt;
    for (let i = 0; i < 50; i += 1) pruneExpiredStatuses(state);
    expect(has(state, "injured-sim")).toBe(true);
    expect(state.player.statuses.find((s) => s.statusId === "injured-sim")?.expiresAt).toBe(expiresAt);
  });

  it("过期点跟着世界时钟走，不跟着行动次数走", () => {
    const { state, entry } = newWorld();
    // 用「大吉」而不是「重伤」：重伤会被疗养类事件 cureStatus 掉，那样测的就不是时长了。
    applyStatusToPlayer(state, "blessed", 1, entry.lookup, { value: 3, unit: "day" });
    const expiresAt = state.player.statuses.find((s) => s.statusId === "blessed")!.expiresAt!;
    const step = () =>
      advanceTurnV2(state, { action: { type: "rest", description: "" } }, entry.template, entry.lookup, createRunnerContext(state.seed));

    // 每一步都对照时钟，而不是对照「走了几步」：事件链里的 `advanceBy` 会额外加时间，
    // 那段时间也该算进伤病里。
    for (let i = 0; i < 4; i += 1) {
      step();
      expect(has(state, "blessed"), `第 ${i + 1} 步（t=${state.worldTime}，到期 t=${expiresAt}）`).toBe(
        state.worldTime < expiresAt,
      );
    }
    expect(state.worldTime).toBeGreaterThanOrEqual(expiresAt); // 确实走到了到期点之后
  });

  it("一小时的活动花不掉「一天」的伤病：时长不按行动次数数", () => {
    const { state, entry } = newWorld();
    applyStatusToPlayer(state, "injured-sim", 1, entry.lookup, { value: 1, unit: "day" });
    // 直接把世界时钟往前拨一小时，模拟一次短行动
    state.worldTime += 60;
    pruneExpiredStatuses(state);
    expect(has(state, "injured-sim")).toBe(true);
  });

  it("不给时长 = 永久：挂载身份没有到期点", () => {
    const { state, entry } = newWorld();
    applyStatusToPlayer(state, "six-eyes", 1, entry.lookup);
    state.worldTime += 100 * 365 * DAY;
    pruneExpiredStatuses(state);
    expect(has(state, "six-eyes")).toBe(true);
  });
});
