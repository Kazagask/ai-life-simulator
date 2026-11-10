import { describe, expect, it } from "vitest";
import type { OpeningTemplate, WorldTemplateV2 } from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { advanceTurnV2, createWorldV2, pendingEventView } from "./turn.js";
import { createActiveWorldV2 } from "./test-utils.js";
import { EndingGuardError, markTerminated } from "./ending.js";
import { createDefaultOpeningTemplate } from "./opening.js";

/** 带一条 schedule 交接事件与一条即时交接事件的最小模板。 */
function makeTemplate(): WorldTemplateV2 {
  return {
    meta: { id: "t", name: "门禁测试", description: "d", startYear: 2000, engineProtocol: "v2" },
    time: { defaultStep: { value: 1, unit: "day" } },
    genders: [{ id: "f", label: "女" }],
    mood: {
      min: 0,
      max: 100,
      defaultValue: 60,
      bands: [{ id: "normal", label: "平静", min: 0, max: 100, attributeModifiers: {} }],
    },
    statusBar: [{ id: "sb1", label: "基本", source: "identity" }],
    attributes: { order: ["str"], defaults: { str: 5 } },
    resources: {
      hp: { base: 100, perLevel: 0 },
      mp: { base: 50, perLevel: 0 },
    },
    regen: { perTurn: { hp: 0, mp: 0 } },
    checks: {},
    characters: [],
    skills: [],
    items: [],
    statuses: [],
    events: [
      {
        id: "ev-handoff-sched",
        title: "交接定时事件",
        narrative: "开局交接的定时事件。",
        trigger: { source: "schedule", atWorldTime: { value: 1, unit: "day" } },
        kind: "normal",
        settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
      },
      {
        id: "ev-handoff-normal",
        title: "交接即时事件",
        narrative: "开局交接的即时事件。",
        trigger: { source: "chain" },
        kind: "normal",
        settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
      },
    ],
  };
}

const INPUT = { templateId: "t", playerName: "测试者", seed: 1 };
const REST = { action: { type: "rest" } };

function guardCodeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof EndingGuardError) return err.code;
    throw err;
  }
  throw new Error("未被门禁拒绝");
}

describe("T2-02 · 门禁：开局未完成 ⇒ NOT_ACTIVE", () => {
  it("openingCompleted=false 被拒，门禁在 pendingEvents 检查之前，且逐字段不变", () => {
    const template = makeTemplate();
    const lookup = createLookup(template);
    const state = createWorldV2(INPUT, template, "w-not-active");
    // 预置待决事件：若门禁不在最前，会先抛 pending_event_required 而非 NOT_ACTIVE。
    state.pendingEvents = [{ eventId: "ev-handoff-normal" }];
    state.flags.turnsPlayed = 0;
    const before = structuredClone(state);
    expect(guardCodeOf(() => advanceTurnV2(state, REST, template, lookup))).toBe("NOT_ACTIVE");
    expect(state).toEqual(before);
  });
});

describe("T2-02 · 门禁：已终止 / 已归档 ⇒ TERMINATED", () => {
  it("已终止被拒，且逐字段不变", () => {
    const template = makeTemplate();
    const lookup = createLookup(template);
    const active = createActiveWorldV2(INPUT, template, "w-terminated");
    const state = markTerminated(active, {
      reason: "测试终止",
      worldTime: 0,
      turnIndex: 0,
      source: "condition",
    });
    const before = structuredClone(state);
    expect(guardCodeOf(() => advanceTurnV2(state, REST, template, lookup))).toBe("TERMINATED");
    expect(state).toEqual(before);
  });

  it("已归档被拒，且逐字段不变", () => {
    const template = makeTemplate();
    const lookup = createLookup(template);
    const state = createActiveWorldV2(INPUT, template, "w-archived");
    state.archived = true;
    const before = structuredClone(state);
    expect(guardCodeOf(() => advanceTurnV2(state, REST, template, lookup))).toBe("TERMINATED");
    expect(state).toEqual(before);
  });
});

describe("T2-02 · 门禁：openingCompleted=true 首轮推进", () => {
  it("首轮推进成功，并消费 handoff 交接的 schedule 事件", () => {
    const template = makeTemplate();
    const lookup = createLookup(template);
    const opening: OpeningTemplate = {
      ...createDefaultOpeningTemplate(),
      handoff: { pendingEvents: [], schedule: [{ eventId: "ev-handoff-sched" }] },
    };
    const state = createActiveWorldV2(INPUT, template, "w-active", opening);
    expect(state.openingCompleted).toBe(true);
    expect(state.flags["openingScheduled:ev-handoff-sched"]).toBe(true);
    const res = advanceTurnV2(state, REST, template, lookup);
    expect(res.state.turnIndex).toBe(1);
    expect(res.triggeredEvents.some((e) => e.id === "ev-handoff-sched")).toBe(true);
  });

  it("handoff 交接的即时事件进入 pendingEvents，可被 pendingEventView 消费", () => {
    const template = makeTemplate();
    const lookup = createLookup(template);
    const opening: OpeningTemplate = {
      ...createDefaultOpeningTemplate(),
      handoff: { pendingEvents: ["ev-handoff-normal"], schedule: [] },
    };
    const state = createActiveWorldV2(INPUT, template, "w-active-pending", opening);
    expect(state.openingCompleted).toBe(true);
    expect(pendingEventView(state, lookup)?.eventId).toBe("ev-handoff-normal");
  });
});
