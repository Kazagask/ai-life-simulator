import { describe, expect, it } from "vitest";
import type { WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";

import { createActiveWorldV2, makeTestTemplate } from "./v2/test-utils.js";
import { collectRefs, createLookup } from "./v2/lookup.js";
import { RpgEngineAPI, assignSlot, isRetryable } from "./api/engine-api.js";
import { recordFire } from "./v2/scheduler.js";

/**
 * `fact.enqueueEvent` 必须尊重模板的 `once`（回归锁）。
 *
 * 实测事故：mock 分支轮每轮都发 `fact.enqueueEvent{evt:trial}`，而幂等只查「队列里有没有
 * waiting 实例」、不查「是否已触发过」，于是 `once` 事件被 LLM 反复复活，
 * `trial→chance→closing→trial` 连转 24 步。once 是模板对「一辈子只演一次」的声明，
 * LLM 不可信，不能改写这条语义。
 */

function makeTemplate(): WorldTemplateV2 {
  const base = makeTestTemplate() as unknown as Record<string, unknown>;
  return {
    ...base,
    events: [
      {
        id: "evt-once",
        title: "一次性",
        narrative: "只会发生一次。",
        trigger: { source: "chain", once: true },
        kind: "normal",
        settle: { normal: { options: [{ id: "o1", text: "好" }] } },
      },
      {
        id: "evt-repeat",
        title: "可重演",
        narrative: "还能再来。",
        trigger: { source: "chain" },
        kind: "normal",
        settle: { normal: { options: [{ id: "o1", text: "好" }] } },
      },
    ],
  } as unknown as WorldTemplateV2;
}

const ALLOW = ["evt-once", "evt-repeat"];

function setup() {
  const template = makeTemplate();
  const lookup = createLookup(template);
  const state = createActiveWorldV2(
    { templateId: "enqueue-once", playerName: "测试", seed: 11 },
    template,
    "al-once",
  );
  assignSlot(state, null);
  const api = new RpgEngineAPI({
    state,
    lookup,
    perspective: "world",
    targetPerspective: "player",
    lookupRefs: collectRefs(template),
  });
  return { template, lookup, state, api };
}

function enqueue(api: RpgEngineAPI, state: WorldStateV2, eventId: string) {
  return api.dispatch(
    [{ callId: `c-${eventId}-${state.delayQueue.length}`, tool: "fact.enqueueEvent", args: { eventId } }],
    {
      turnIndex: state.turnIndex,
      worldTime: state.worldTime,
      perspective: "world",
      targetPerspective: "player",
      branchEventIds: ALLOW,
    },
  ).receipts[0]!;
}

describe("fact.enqueueEvent 尊重 once", () => {
  it("once + 已触发 ⇒ 拒绝、队列不变、码不可重试", () => {
    const { state, api } = setup();
    recordFire(state, "evt-once");
    const before = state.delayQueue.length;

    const r = enqueue(api, state, "evt-once");
    expect(r.outcome).toBe("rejected");
    expect(r.code).toBe("idempotency_conflict");
    expect(isRetryable("idempotency_conflict")).toBe(false);
    expect(state.delayQueue.length).toBe(before);
  });

  it("once + 尚未触发 ⇒ 正常入队", () => {
    const { state, api } = setup();
    const before = state.delayQueue.length;
    const r = enqueue(api, state, "evt-once");
    expect(r.outcome).toBe("accepted");
    expect(state.delayQueue.length).toBe(before + 1);
  });

  it("非 once + 已触发 ⇒ 仍可入队（可重演事件不许被误拦）", () => {
    const { state, api } = setup();
    recordFire(state, "evt-repeat");
    const r = enqueue(api, state, "evt-repeat");
    expect(r.outcome).toBe("accepted");
  });

  it("已有 waiting 实例 + once 未触发 ⇒ 走幂等分支，不新增实例", () => {
    const { state, api } = setup();
    expect(enqueue(api, state, "evt-once").outcome).toBe("accepted");
    const len = state.delayQueue.length;
    const r = enqueue(api, state, "evt-once");
    expect(r.outcome).toBe("accepted");
    expect(state.delayQueue.length).toBe(len);
  });

  it("回归锁：连发两次、中间真触发一次 ⇒ 第二次必被拒", () => {
    const { state, api } = setup();
    expect(enqueue(api, state, "evt-once").outcome).toBe("accepted");
    recordFire(state, "evt-once");
    const len = state.delayQueue.length;

    const r = enqueue(api, state, "evt-once");
    expect(r.outcome).toBe("rejected");
    expect(r.code).toBe("idempotency_conflict");
    expect(state.delayQueue.length).toBe(len);
  });
});
