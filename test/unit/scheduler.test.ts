import { describe, expect, it } from "vitest";
import type { EventV2 } from "@life-sim/shared";
import {
  enqueueCandidate,
  enqueueScheduled,
  hasFired,
  recordFire,
} from "@life-sim/game-core";
import { makeWorld } from "../helpers/world.ts";

describe("scheduler: 相对入队时刻换算 + once", () => {
  it("window / end 以入队时刻为基准换算成绝对世界分钟", () => {
    const { state } = makeWorld();
    state.worldTime = 100;
    const inst = enqueueScheduled({
      state,
      definitionId: "ev:x",
      origin: { kind: "pool", id: "x" },
      start: { value: 2, unit: "hour" },
      end: { value: 1, unit: "day" },
    });
    expect(inst.window.start).toBe(220);
    expect(inst.window.end).toBe(1540);
    expect(inst.hasEnd).toBe(true);
  });

  it("delay 覆盖相对起点；once 已触发不再入队", () => {
    const { state, entry } = makeWorld();
    state.worldTime = 50;
    const definition = {
      id: "ev:once",
      title: "一次性",
      narrative: "n",
      trigger: { source: "chain", once: true },
      kind: "normal",
      settle: { normal: { options: [{ id: "o", text: "ok" }] } },
    } as unknown as EventV2;
    const rng = () => 0.5;
    const origin = { kind: "pool" as const, id: "x" };

    const first = enqueueCandidate({
      state,
      definition,
      origin,
      lookup: entry.lookup,
      rng,
      delay: { value: 30, unit: "minute" },
    });
    expect(first?.window.start).toBe(80);

    recordFire(state, definition.id);
    expect(hasFired(state, definition.id)).toBe(true);
    const second = enqueueCandidate({
      state,
      definition,
      origin,
      lookup: entry.lookup,
      rng,
    });
    expect(second).toBeUndefined();
  });
});
