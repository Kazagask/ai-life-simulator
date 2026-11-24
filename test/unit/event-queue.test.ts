import { describe, expect, it } from "vitest";
import { createLookup, createWorldV2, enqueueScheduled } from "@life-sim/game-core";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * 队列的两条硬规矩（2026-11-24 用户裁决）：
 * 1. **同名不重复入队** —— 队里已经有一条同 id 的等待实例，就不再塞第二条；
 *    这条对 `pool` 的**非一次性**事件尤其重要（`once` 事件本来就会被 `hasFired` 挡住）。
 * 2. **pool 事件仍然是一次性的** —— 模板里的日常/池事件保留 `once: true`。
 *    我一度把「pool 非一次性事件」读成「把 pool 事件改成非一次性」，删了 12 条 `once`，
 *    还顺手把冷却从 4 天拉到 30 天去补漏 —— 两处都是自说自话。这条用例就是防它再发生。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function setup() {
  const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed: 4 }, entry.template, "w-queue");
  return { entry, state, lookup: createLookup(entry.template) };
}

describe("事件队列", () => {
  it("同 id 已在队里 ⇒ 拒绝入队，队列长度不变", () => {
    const { state } = setup();
    const before = state.delayQueue.length;
    const input = {
      state,
      definitionId: "ev-d-class",
      origin: { kind: "pool" as const, id: "ev-d-class" },
      start: { value: 0, unit: "minute" as const },
    };
    const first = enqueueScheduled(input);
    const second = enqueueScheduled(input);
    // 第二次拿到的是队里那一条，不是新造的
    expect(state.delayQueue.length).toBe(before + 1);
    expect(second.instanceId).toBe(first.instanceId);
  });

  it("不同 id 各自入队（去重按 id，不是按数量一刀切）", () => {
    const { state } = setup();
    const before = state.delayQueue.length;
    enqueueScheduled({
      state,
      definitionId: "ev-d-class",
      origin: { kind: "pool", id: "ev-d-class" },
      start: { value: 0, unit: "minute" },
    });
    enqueueScheduled({
      state,
      definitionId: "ev-d-canteen",
      origin: { kind: "pool", id: "ev-d-canteen" },
      start: { value: 0, unit: "minute" },
    });
    expect(state.delayQueue.length).toBe(before + 2);
  });

  it("模板里的 pool 事件仍是**一次性**的（保留 once）", () => {
    const { entry } = setup();
    const pool = entry.template.events.filter((e) => e.trigger.source === "pool");
    expect(pool.length).toBeGreaterThan(0);
    for (const e of pool) {
      expect(e.trigger.once).toBe(true);
    }
  });
});
