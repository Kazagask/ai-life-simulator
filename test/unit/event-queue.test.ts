import { describe, expect, it } from "vitest";
import { createLookup, createWorldV2, enqueueScheduled } from "@life-sim/game-core";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * 队列的两条硬规矩（2026-11-24 用户裁决）：
 * 1. **同名不重复入队** —— 队里已经有一条同 id 的等待实例，就不再塞第二条；
 * 2. **pool 事件不是一次性的** —— 模板里的日常/池事件不带 `once`，靠 `cooldown` 控制节奏。
 *
 * 第 1 条以前会让「同一事件两条候选」把 `once` 用掉两次；第 2 条是「前面几十天没事件」的一半原因。
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

  it("pool 事件没有 once（可以被反复抽到）", () => {
    const { entry } = setup();
    const pool = entry.template.events.filter((e) => e.trigger.source === "pool");
    expect(pool.length).toBeGreaterThan(0);
    for (const e of pool) {
      expect(e.trigger.once ?? false).toBe(false);
    }
  });
});
