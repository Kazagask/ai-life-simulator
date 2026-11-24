import { describe, expect, it } from "vitest";
import { advanceTurnV2, chooseOptionV2, createLookup, createWorldV2 } from "@life-sim/game-core";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * 第二章 · 玉折（W2）可玩性回归。
 *
 * 两件事必须成立，缺一条这一章就是「写进 yaml 但玩家走不到」：
 * 1. 八幕能一路链下去（`ev-yz-00` 定时 → `ev-yz-01..08` 链式），中间不断；
 * 2. 跑满 600 天能落到第二章自己的四个出口之一，而不是又掉回 2006 的结局。
 *
 * 说明：这里**跳过**怀玉（2006 的上半章另有测试覆盖），直接把时钟摆到第 276 天、
 * 把 `yearEnd` 打上，再把第一章还没兑现的定时条目摘掉 —— 只验第二章这一段。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function entry() {
  const e = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
  if (e?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return e;
}

describe("2006 第二章 · 玉折（W2）", () => {
  it("八幕一路链到底，600 天收束在第二章的出口", () => {
    const e = entry();
    const lookup = createLookup(e.template);
    const pipeline = { endingConfig: e.endingConfig, evaluationConfig: e.evaluationConfig, ui: e.ui };
    const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed: 5 }, e.template, "w-w2");
    state.openingCompleted = true;
    state.flags.creationDone = true;
    state.flags.spDone = true;
    state.flags.yearEnd = true;
    state.worldTime = 276 * 1440;
    state.delayQueue = state.delayQueue.filter((i) => i.definitionId === "ev-yz-00");

    const seen: string[] = [];
    for (let day = 276; day <= 610; day += 1) {
      for (let guard = 0; guard < 24; guard += 1) {
        const slot = state.slot as { eventId?: string } | null;
        if (slot?.eventId === undefined) break;
        seen.push(slot.eventId);
        const def = lookup.event(slot.eventId) as
          | { settle?: { normal?: { options?: { id: string }[] } } }
          | undefined;
        const opt = def?.settle?.normal?.options?.[0];
        if (opt === undefined) break;
        chooseOptionV2(state, { optionId: opt.id }, e.template, lookup, pipeline);
      }
      state.worldTime = Math.max(state.worldTime, day * 1440);
      advanceTurnV2(state, { action: { type: "rest", description: "" } }, e.template, lookup, undefined, pipeline);
      if (state.termination !== null) break;
    }

    // 八幕全部走到（第一幕到第八幕），一条不缺
    const acts = seen.filter((id) => id.startsWith("ev-yz-"));
    expect(acts).toEqual([
      "ev-yz-00",
      "ev-yz-01",
      "ev-yz-02",
      "ev-yz-03",
      "ev-yz-04",
      "ev-yz-05",
      "ev-yz-06",
      "ev-yz-07",
      "ev-yz-08",
    ]);
    // 600 天收束，且落在第二章的出口上
    expect(Math.round(state.worldTime / 1440)).toBe(600);
    expect(state.termination?.endingId?.startsWith("end-yz-")).toBe(true);
  });
});
