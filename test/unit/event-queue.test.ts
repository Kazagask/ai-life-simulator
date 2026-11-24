import { describe, expect, it } from "vitest";
import {
  createLookup,
  createTimeAdapter,
  createWorldV2,
  enqueueCandidate,
  enqueueScheduled,
  recordFire,
} from "@life-sim/game-core";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * 队列与池的三条口径（2026-11-24）。
 *
 * 1. **同名不重复入队**：队里已经有一条同 id 的等待实例，就不再塞第二条。
 * 2. **去重按 id，不按数量**：不同 id 各入各的。
 * 3. **`once` 是内容选择，不是引擎要求**：pool 事件可以带 `once`（本模板的日常就是
 *    「一辈子一次」的桥段），也可以不带（可反复触发的池事件）。引擎只在**写了** `once`
 *    时才用 `hasFired` 挡重复；没写就一直可抽。
 *
 * 第 3 条我一开始写反了：先以为「pool 必须是非一次性的」删了模板的 `once`，
 * 被打回后又矫枉过正、在用例里断言「pool 事件必须带 once」——两个方向都不对，
 * 引擎从来没有这条规矩。
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

  it("once 是可选的：写了才挡重复，没写就一直可抽", () => {
    const { entry, state, lookup } = setup();
    state.flags.creationDone = true;
    state.flags.era = 1;
    state.delayQueue = [];
    const def = entry.template.events.find((e) => e.id === "ev-d-class");
    if (def === undefined) throw new Error("ev-d-class 不在模板里");
    // 先让它「已经触发过」
    recordFire(state, def.id);
    const calendar = createTimeAdapter(entry.template);
    const base = { state, lookup, rng: () => 0, calendar };

    // 带 once：触发过就不再入队
    expect(enqueueCandidate({ ...base, definition: def, origin: { kind: "pool", id: def.id } })).toBeUndefined();

    // 去掉 once：同一个事件照样能被抽到（引擎不要求 pool 必须一次性）
    const repeatable = { ...def, trigger: { ...def.trigger, once: undefined } };
    state.delayQueue = [];
    expect(enqueueCandidate({ ...base, definition: repeatable, origin: { kind: "pool", id: def.id } })).toBeDefined();
  });
});
