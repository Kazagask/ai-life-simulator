import { describe, expect, it } from "vitest";
import type { OpeningTemplate, WorldTemplateV2 } from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { advanceTurnV2, chooseOptionV2, createWorldV2, slotEventView } from "./turn.js";
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
    characters: [],
    skills: [],
    items: [],
    statuses: [],
    events: [
      {
        id: "ev-handoff-sched",
        title: "交接定时事件",
        narrative: "开局交接的定时事件。",
        trigger: { source: "schedule", window: { start: { value: 1, unit: "day" } } },
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
    state.slot = { eventId: "ev-handoff-normal", from: "queueTake" };
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
    // R2.5：交接不再写 flags 占位标记，而是真正入队一个 waiting 实例（origin=opening）。
    const legacyPrefix = "opening" + "Scheduled:";
    expect(Object.keys(state.flags).some((k) => k.startsWith(legacyPrefix))).toBe(false);
    expect(
      state.delayQueue.some(
        (i) => i.definitionId === "ev-handoff-sched" && i.status === "waiting" && i.origin.kind === "opening",
      ),
    ).toBe(true);
    const res = advanceTurnV2(state, REST, template, lookup);
    expect(res.state.turnIndex).toBe(1);
    /**
     * ADR-0034 §2 步 1 vs 步 3：首轮只**呈现**（取出占槽、等玩家选择），
     * 「消费」这件事的可观察形式因此分成两步 —— 旧断言「首轮即进 triggeredEvents」
     * 属于 `pendingEvents` 时代「一轮 drain 多条并立刻结算」的语义，已被 S1 收敛。
     */
    expect(res.state.slot).toMatchObject({ eventId: "ev-handoff-sched", from: "queueTake" });
    expect(res.snapshot.slotEvent).toMatchObject({ eventId: "ev-handoff-sched", kind: "normal" });
    expect(res.triggeredEvents.some((e) => e.id === "ev-handoff-sched")).toBe(false);
    // 取出即摘除（status=fired），不会下一轮重复上桌。
    // 注意同一 definitionId 有两条实例：建世界期的 `schedule-init` 被 handoff 标 cancelled
    //（避免同一事件触发两次），opening 那条才是被取出的（ADR-0034 §3 取出即 fired）。
    expect(
      res.state.delayQueue.filter((i) => i.definitionId === "ev-handoff-sched").map((i) => i.status),
    ).toEqual(["cancelled", "fired"]);
    // 选择之后才是结算 ⇒ 此时才进 triggeredEvents
    const settled = chooseOptionV2(state, { optionId: "opt-ok" }, template, lookup);
    expect(settled.triggeredEvents.some((e) => e.id === "ev-handoff-sched")).toBe(true);
    expect(state.slot).toBeNull();
  });

  it("handoff 交接的即时事件占槽（from: opening），可被 slotEventView 呈现", () => {
    const template = makeTemplate();
    const lookup = createLookup(template);
    const opening: OpeningTemplate = {
      ...createDefaultOpeningTemplate(),
      handoff: { pendingEvents: ["ev-handoff-normal"], schedule: [] },
    };
    const state = createActiveWorldV2(INPUT, template, "w-active-pending", opening);
    expect(state.openingCompleted).toBe(true);
    // ADR-0034 §5：`pendingEventView` 已随过渡字段删除，唯一读取入口是 `slotEventView`
    expect(slotEventView(state, lookup)).toMatchObject({ eventId: "ev-handoff-normal", kind: "normal" });
    expect(state.slot).toMatchObject({ eventId: "ev-handoff-normal", from: "opening" });
  });
});
