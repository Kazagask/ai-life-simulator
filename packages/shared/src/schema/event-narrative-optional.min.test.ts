import { describe, expect, it } from "vitest";
import {
  EventV2Schema,
  EventOptionSchema,
  WheelSegmentSchema,
  EventTriggerSchema,
} from "./event.js";

/** 最小合法 normal 事件（trigger: chain 不附带额外必填约束）。 */
const baseEvent = {
  id: "e1",
  title: "测试事件",
  trigger: { source: "chain" },
  kind: "normal",
  settle: { normal: { options: [{ id: "o1", text: "继续" }] } },
};

describe("EventBase.narrative optional (F3)", () => {
  it("parses with narrative omitted", () => {
    expect(EventV2Schema.safeParse(baseEvent).success).toBe(true);
  });
  it("parses with narrative provided", () => {
    expect(EventV2Schema.safeParse({ ...baseEvent, narrative: "一段叙事" }).success).toBe(true);
  });
});

describe("kept-required fields / trigger refinements", () => {
  it("rejects EventOption.text = ''", () => {
    expect(EventOptionSchema.safeParse({ id: "o1", text: "" }).success).toBe(false);
  });
  it("rejects WheelSegment.label = ''", () => {
    expect(WheelSegmentSchema.safeParse({ weight: 1, label: "" }).success).toBe(false);
  });
  it("rejects source:pool without probability/weight", () => {
    expect(EventTriggerSchema.safeParse({ source: "pool" }).success).toBe(false);
  });
  it("rejects source:schedule without window", () => {
    expect(EventTriggerSchema.safeParse({ source: "schedule" }).success).toBe(false);
  });
});
