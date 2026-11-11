import { describe, expect, it } from "vitest";
import type { WorldTemplateV2 } from "@life-sim/shared";
import { amountToMinutes, createTimeAdapter, minutesToAmount } from "./time.js";
import { advanceTurnV2 } from "./turn.js";
import { createActiveWorldV2 } from "./test-utils.js";
import { createLookup } from "./lookup.js";

function makeTemplate(overrides?: Partial<WorldTemplateV2>): WorldTemplateV2 {
  const base: WorldTemplateV2 = {
    meta: { id: "t", name: "时间测试", description: "d", startYear: 2000, engineProtocol: "v2" },
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
    events: [],
  };
  return { ...base, ...overrides };
}

describe("时间适配器 · 换算与历法", () => {
  it("amountToMinutes / minutesToAmount 互为可逆换算", () => {
    expect(amountToMinutes({ value: 1, unit: "hour" })).toBe(60);
    expect(amountToMinutes({ value: 1, unit: "day" })).toBe(1440);
    expect(minutesToAmount(1440)).toEqual({ value: 1, unit: "day" });
    expect(minutesToAmount(10080)).toEqual({ value: 1, unit: "week" });
  });

  it("format 按公历从 startYear 起算", () => {
    const adapter = createTimeAdapter(makeTemplate());
    expect(adapter.format(0)).toBe("2000年1月1日 00:00");
    expect(adapter.format(525600)).toBe("2001年1月1日 00:00");
    expect(adapter.elapsedYears(525600)).toBe(1);
    expect(adapter.elapsedYears(525599)).toBe(0);
  });

  it("resolveLifeStage 走模板 lifeStages 阈值", () => {
    const template = makeTemplate({
      time: {
        defaultStep: { value: 1, unit: "day" },
        lifeStages: [
          { id: "minor", label: "未成年", maxAge: 17 },
          { id: "adult", label: "成年", maxAge: 59 },
          { id: "senior", label: "老年" },
        ],
      },
    });
    const adapter = createTimeAdapter(template);
    expect(adapter.resolveLifeStage(10)).toBe("minor");
    expect(adapter.resolveLifeStage(18)).toBe("adult");
    expect(adapter.resolveLifeStage(60)).toBe("senior");
    expect(adapter.lifeStageLabel("minor")).toBe("未成年");
  });

  it("resolveLifeStage 无 lifeStages 时回退旧固定阈值", () => {
    const adapter = createTimeAdapter(makeTemplate());
    expect(adapter.resolveLifeStage(5)).toBe("childhood");
    expect(adapter.resolveLifeStage(15)).toBe("youth");
    expect(adapter.resolveLifeStage(30)).toBe("adulthood");
    expect(adapter.resolveLifeStage(70)).toBe("elderhood");
  });

  it("resolveStep：行动 duration 覆盖 > 人生阶段步长 > 默认步长", () => {
    const template = makeTemplate({
      time: {
        defaultStep: { value: 1, unit: "hour" },
        lifeStageSteps: { minor: { value: 1, unit: "week" }, adult: { value: 1, unit: "month" } },
      },
    });
    const adapter = createTimeAdapter(template);
    expect(adapter.resolveStep("minor")).toEqual({ value: 1, unit: "week" });
    expect(adapter.resolveStep("minor", { value: 2, unit: "hour" })).toEqual({ value: 2, unit: "hour" });
    expect(adapter.resolveStep("adult")).toEqual({ value: 1, unit: "month" });
    // 无匹配阶段 → 默认步长
    expect(adapter.resolveStep("senior")).toEqual({ value: 1, unit: "hour" });
  });
});

describe("时间系统集成 · 推进模式与条件", () => {
  it("advanceTo 绝对推进到目标时间（不倒退），elapsed 反映实际推进量", () => {
    const template = makeTemplate({
      actions: [{ id: "skip", label: "跳转", advanceTo: { value: 2, unit: "day" } }],
    });
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "t", playerName: "测试者", seed: 1 }, template, "w1");
    const res = advanceTurnV2(state, { action: { type: "skip", description: "" } }, template, lookup);
    expect(state.worldTime).toBe(2880);
    expect(state.turnIndex).toBe(1);
    expect(res.elapsed).toEqual({ value: 2, unit: "day" });

    // 目标已过则不再倒退
    advanceTurnV2(state, { action: { type: "skip", description: "" } }, template, lookup);
    expect(state.worldTime).toBe(2880);
  });

  it("time 条件在达到世界时间后触发", () => {
    const template = makeTemplate({
      actions: [{ id: "rest", label: "休息", duration: { value: 1, unit: "day" } }],
      events: [
        {
          id: "ev-gate",
          title: "时间门",
          narrative: "时间到了。",
          trigger: { source: "pool", probability: 1, conditions: [{ time: { gte: { value: 2, unit: "day" } } }] },
          kind: "normal",
          settle: { normal: { options: [{ id: "opt-a", text: "继续" }] } },
        },
      ],
    });
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "t", playerName: "测试者", seed: 1 }, template, "w1");

    advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(state.pendingEvents).toHaveLength(0);

    advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(state.pendingEvents[0]?.eventId).toBe("ev-gate");
  });

  it("schedule 事件的 atWorldTime 用 TimeAmount 相对世界起始触发", () => {
    const template = makeTemplate({
      actions: [{ id: "rest", label: "休息", duration: { value: 1, unit: "day" } }],
      events: [
        {
          id: "ev-sched",
          title: "定时事件",
          narrative: "到了第二天。",
          trigger: { source: "schedule", atWorldTime: { value: 1, unit: "day" } },
          kind: "normal",
          settle: { normal: { options: [{ id: "opt-a", text: "继续" }] } },
        },
      ],
    });
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "t", playerName: "测试者", seed: 1 }, template, "w1");

    advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(state.pendingEvents[0]?.eventId).toBe("ev-sched");
  });

  it("投影输出 formattedTime 与 lifeStage（消除前端公历硬编码）", () => {
    const template = makeTemplate({
      time: {
        defaultStep: { value: 1, unit: "day" },
        lifeStages: [{ id: "youth", label: "青年", maxAge: 30 }],
      },
    });
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "t", playerName: "测试者", seed: 1 }, template, "w1");
    const res = advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(res.snapshot.formattedTime).toBe("2000年1月2日 00:00");
    expect(res.snapshot.lifeStage).toBe("youth");
    expect(res.snapshot.lifeStageLabel).toBe("青年");
  });
});
