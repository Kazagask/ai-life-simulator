import { describe, expect, it } from "vitest";
import type { WorldTemplateV2 } from "@life-sim/shared";
import { WorldTemplateV2Schema } from "@life-sim/shared";
import { amountToMinutes, birthTimeFromAge, createTimeAdapter, minutesToAmount, UNIT_MINUTES } from "./time.js";
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

  it("schedule 事件的 window.start 用 TimeSpec 相对世界起始（now=0 入队）触发", () => {
    const template = makeTemplate({
      actions: [{ id: "rest", label: "休息", duration: { value: 1, unit: "day" } }],
      events: [
        {
          id: "ev-sched",
          title: "定时事件",
          narrative: "到了第二天。",
          trigger: { source: "schedule", window: { start: { value: 1, unit: "day" } } },
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

describe("ADR-0021 决策 4.3 · 负分钟（世界起点之前）与 yearOf/ageAt", () => {
  function gregorianTemplate(startYear = 2000): WorldTemplateV2 {
    return makeTemplate({
      meta: { id: "t", name: "负分钟测试", description: "d", startYear, engineProtocol: "v2" },
      time: { defaultStep: { value: 1, unit: "day" }, calendar: { preset: "gregorian" } },
    });
  }

  it("gregorian：负分钟向回走真实年长（不钳位）", () => {
    const adapter = createTimeAdapter(gregorianTemplate());
    expect(adapter.format(-1)).toBe("1999年12月31日 23:00"); // 显示粒度到小时（既有口径）
    expect(adapter.format(-1440)).toBe("1999年12月31日 00:00");
    expect(adapter.format(-365 * 1440)).toBe("1999年1月1日 00:00");
    // 2000 是闰年（366 天）：-366 天落在 1998-12-31，不是 1999-01-01
    expect(adapter.format(-366 * 1440)).toBe("1998年12月31日 00:00");
    expect(adapter.yearOf(-1)).toBe(1999);
    expect(adapter.yearOf(0)).toBe(2000);
    expect(adapter.yearOf(366 * 1440)).toBe(2001);
  });

  it("gregorian：toMinutes 支持负 year/month 负累加（回溯真实月长/年长）", () => {
    const adapter = createTimeAdapter(gregorianTemplate());
    // 1985..1999 = 15 年 × 365 天 + 闰年 1988/1992/1996 三天
    expect(adapter.toMinutes({ value: -15, unit: "year" }, 0)).toBe(-(15 * 365 + 3) * 1440);
    // 从 2000-01-01 回走 1 个月 ⇒ 1999-12-01（31 天）
    expect(adapter.toMinutes({ value: -1, unit: "month" }, 0)).toBe(-31 * 1440);
    // 回走 15 年后落到 1985-01-01，年差口径年龄恰为 15（不是 14/16）
    const birth = adapter.toMinutes({ value: -15, unit: "year" }, 0);
    expect(adapter.format(birth)).toBe("1985年1月1日 00:00");
    expect(adapter.ageAt(birth, 0)).toBe(15);
  });

  it("gregorian：viewToMinutes 负方向可逆（日期字面量 < startYear）", () => {
    const adapter = createTimeAdapter(gregorianTemplate());
    expect(adapter.parseTimeSpec("1999-12-31", 0)).toBe(-1440);
    expect(adapter.parseTimeSpec("1985-01-01", 0)).toBe(-(15 * 365 + 3) * 1440);
    // 两个方向互逆：分钟 → 视图（format）→ 分钟（parseTimeSpec）按日闭合
    const isoOf = (minutes: number): string => {
      const text = adapter.format(minutes).split(" ")[0];
      const [, y, mo, d] = /^(\d+)年(\d+)月(\d+)日$/.exec(text)!;
      return `${y}-${mo}-${d}`;
    };
    for (const dayMinutes of [-1, -1440, -365 * 1440, -366 * 1440, -(15 * 365 + 3) * 1440]) {
      expect(adapter.parseTimeSpec(isoOf(dayMinutes), 0)).toBe(Math.floor(dayMinutes / 1440) * 1440);
    }
    // 分钟级闭合（含时刻）：1999-12-31 23:59 = -1
    expect(adapter.parseTimeSpec("1999-12-31", 0) + 23 * 60 + 59).toBe(-1);
  });

  it("minutes ≥ 0 的输出字节不变（回归：钳位版与本实现同值）", () => {
    const adapter = createTimeAdapter(gregorianTemplate());
    expect(adapter.format(0)).toBe("2000年1月1日 00:00");
    expect(adapter.format((31 + 28) * 1440)).toBe("2000年2月29日 00:00");
    expect(adapter.format(366 * 1440 + 58 * 1440)).toBe("2001年2月28日 00:00");
    expect(adapter.yearOf(366 * 1440 - 1)).toBe(2000);
    expect(adapter.toMinutes({ value: 1, unit: "year" }, 0)).toBe(366 * 1440);
    // approx 分支同样零回归
    const approx = createTimeAdapter(makeTemplate());
    expect(approx.format(0)).toBe("2000年1月1日 00:00");
    expect(approx.format(525600)).toBe("2001年1月1日 00:00");
    expect(approx.yearOf(525600)).toBe(2001);
  });

  it("ageAt 是年差口径（跨年界即 +1），不是生日口径；ADR 反例 1991-04-03 → 2007-01-15 = 16 岁", () => {
    const adapter = createTimeAdapter(gregorianTemplate(1991));
    const birth = adapter.parseTimeSpec("1991-04-03", 0);
    const now = adapter.parseTimeSpec("2007-01-15", 0);
    expect(adapter.ageAt(birth, now)).toBe(16);
    // 生日口径（把「两个时刻之差」喂给 elapsedYears）会差 1 岁 —— 坑已钉住
    expect(adapter.elapsedYears(now - birth)).toBe(15);
    expect(adapter.ageAt(birth, now)).toBe(adapter.yearOf(now) - adapter.yearOf(birth) + 0);
  });

  it("跨年界前后各差 1 分钟：年龄差恰为 1；同一侧差 1 分钟则为 0", () => {
    const adapter = createTimeAdapter(gregorianTemplate());
    const boundary = 366 * 1440; // 2001-01-01 00:00
    expect(adapter.ageAt(0, boundary - 1)).toBe(0);
    expect(adapter.ageAt(0, boundary)).toBe(1);
    expect(adapter.ageAt(0, boundary) - adapter.ageAt(0, boundary - 1)).toBe(1);
    expect(adapter.ageAt(0, boundary - 2)).toBe(adapter.ageAt(0, boundary - 1));
    // approx 下两条口径等价（525600 整除）
    const approx = createTimeAdapter(makeTemplate());
    expect(approx.ageAt(0, UNIT_MINUTES.year)).toBe(1);
    expect(approx.ageAt(0, UNIT_MINUTES.year - 1)).toBe(0);
  });

  it("custom 历法：负分钟与年龄同样成立（年长 ≠ 公历）", () => {
    const template = makeTemplate({
      meta: { id: "t", name: "自定义纪年", description: "d", startYear: 2006, engineProtocol: "v2" },
      time: {
        defaultStep: { value: 1, unit: "day" },
        calendar: { preset: "custom", months: [{ name: "睦月", days: 31 }, { name: "如月", days: 30 }] },
      },
    });
    const adapter = createTimeAdapter(template);
    const yearMinutes = 61 * 1440;
    expect(adapter.yearOf(-1)).toBe(2005);
    expect(adapter.format(-yearMinutes)).toBe("2005年睦月1日 00:00");
    expect(adapter.toMinutes({ value: -20, unit: "year" }, 0)).toBe(-20 * yearMinutes);
    expect(adapter.ageAt(-20 * yearMinutes, 0)).toBe(20);
  });

  it("birthTimeFromAge：反推后 ageAt(birth, 0) === age（两种 preset 都成立）", () => {
    const gregorian = createTimeAdapter(gregorianTemplate());
    for (const age of [0, 1, 15, 40]) {
      const birth = birthTimeFromAge(age, gregorian);
      expect(gregorian.ageAt(birth, 0)).toBe(age);
    }
    const approx = createTimeAdapter(makeTemplate());
    expect(birthTimeFromAge(15, approx)).toBe(-15 * UNIT_MINUTES.year); // approx 下等价于 -age × 525600
    expect(approx.ageAt(birthTimeFromAge(15, approx), 0)).toBe(15);
  });
});

describe("R2.6 · 历法模型与字面量（ADR-0013）", () => {
  function calendarTemplate(
    calendar: NonNullable<WorldTemplateV2["time"]["calendar"]>,
    startYear = 2000,
  ): WorldTemplateV2 {
    return makeTemplate({
      meta: { id: "t", name: "历法测试", description: "d", startYear, engineProtocol: "v2" },
      time: { defaultStep: { value: 1, unit: "day" }, calendar },
    });
  }

  // ---- approx（缺省）：零迁移 + 复合时长字面量 ----
  it("approx：toMinutes 与 amountToMinutes 一致；复合时长可解析；日期字面量抛错", () => {
    const adapter = createTimeAdapter(makeTemplate());
    expect(adapter.toMinutes({ value: 2, unit: "month" }, 12345)).toBe(amountToMinutes({ value: 2, unit: "month" }));
    expect(adapter.parseTimeSpec("2h30m", 100)).toBe(250);
    expect(adapter.parseTimeSpec("3d", 0)).toBe(4320);
    expect(adapter.parseTimeSpec("1y", 0)).toBe(525600);
    expect(() => adapter.parseTimeSpec("2006-12-24", 0)).toThrow(/approx/);
  });

  // ---- gregorian：真实月长 + 闰年 ----
  it("gregorian：format 走真实公历（闰年 2/29），elapsedYears 按日历边界", () => {
    const adapter = createTimeAdapter(calendarTemplate({ preset: "gregorian" }));
    expect(adapter.format(0)).toBe("2000年1月1日 00:00");
    expect(adapter.format((31 + 28) * 1440)).toBe("2000年2月29日 00:00"); // 闰年
    expect(adapter.format(366 * 1440 + 58 * 1440)).toBe("2001年2月28日 00:00"); // 平年
    expect(adapter.elapsedYears(366 * 1440)).toBe(1); // 2001-01-01
    expect(adapter.elapsedYears(366 * 1440 - 1)).toBe(0); // 2000-12-31
  });

  it("gregorian：toMinutes 的 year/month 按真实月长推进（日历增量语义）", () => {
    const adapter = createTimeAdapter(calendarTemplate({ preset: "gregorian" }));
    expect(adapter.toMinutes({ value: 1, unit: "year" }, 0)).toBe(366 * 1440); // 2000 闰
    expect(adapter.toMinutes({ value: 1, unit: "year" }, 366 * 1440)).toBe(365 * 1440); // 2001 平
    // 1-31 + 1mo → 2-29（闰年截断到月末日）
    expect(adapter.toMinutes({ value: 1, unit: "month" }, 30 * 1440)).toBe(59 * 1440 - 30 * 1440);
    // 与日历无关单位不受影响
    expect(adapter.toMinutes({ value: 3, unit: "day" }, 12345)).toBe(3 * 1440);
  });

  it("gregorian：parseTimeSpec 解析日期字面量为绝对分钟 + 复合时长串联", () => {
    const adapter = createTimeAdapter(calendarTemplate({ preset: "gregorian" }));
    expect(adapter.parseTimeSpec("2000-03-01", 999999)).toBe(60 * 1440); // 31+29 天
    expect(adapter.parseTimeSpec("1y", 0)).toBe(366 * 1440);
    expect(adapter.parseTimeSpec("2h30m", 100)).toBe(250);
    expect(() => adapter.parseTimeSpec("2001-02-29", 0)).toThrow(/越界/); // 平年无 2/29
  });

  // ---- custom：自定义月名 + 年号/纪元 ----
  const CUSTOM_MONTHS = [
    { name: "睦月", days: 31 },
    { name: "如月", days: 30 },
  ];

  it("custom + era：年号年份由 epochStartMinute 起算，月名/月长取自 months[]", () => {
    const t0 = calendarTemplate(
      { preset: "custom", months: CUSTOM_MONTHS, era: { name: "咒术纪元", epochStartMinute: 0 } },
      2006,
    );
    const adapter = createTimeAdapter(t0);
    expect(adapter.format(0)).toBe("咒术纪元 1年睦月1日 00:00");
    expect(adapter.format(31 * 1440)).toBe("咒术纪元 1年如月1日 00:00");
    expect(adapter.format(61 * 1440)).toBe("咒术纪元 2年睦月1日 00:00"); // 一年 = 61 天
    expect(adapter.toMinutes({ value: 1, unit: "month" }, 31 * 1440)).toBe(30 * 1440);
    expect(adapter.toMinutes({ value: 1, unit: "year" }, 0)).toBe(61 * 1440);
  });

  it("custom + era（epochStartMinute 为负 = 纪元早于世界开始）", () => {
    // 锚点整一年前：世界起始即纪元二年
    const tPrev = calendarTemplate(
      { preset: "custom", months: CUSTOM_MONTHS, era: { name: "洪荒纪", epochStartMinute: -61 * 1440 } },
      2006,
    );
    expect(createTimeAdapter(tPrev).format(0)).toBe("洪荒纪 2年睦月1日 00:00");
    // 锚点在年中：该年剩余为元年，次年为二年
    const tMid = calendarTemplate(
      { preset: "custom", months: CUSTOM_MONTHS, era: { name: "洪荒纪", epochStartMinute: -31 * 1440 } },
      2006,
    );
    expect(createTimeAdapter(tMid).format(0)).toBe("洪荒纪 2年睦月1日 00:00");
    // 锚点为正（世界开始后开纪元）：纪元首年前显示 0 年，纪元年自锚点年起算
    const tPost = calendarTemplate(
      { preset: "custom", months: CUSTOM_MONTHS, era: { name: "开元", epochStartMinute: 61 * 1440 } },
      2006,
    );
    expect(createTimeAdapter(tPost).format(0)).toBe("开元 0年睦月1日 00:00");
    expect(createTimeAdapter(tPost).format(61 * 1440)).toBe("开元 1年睦月1日 00:00");
  });

  it("custom 无 era：显示绝对年份", () => {
    const adapter = createTimeAdapter(calendarTemplate({ preset: "custom", months: CUSTOM_MONTHS }, 2006));
    expect(adapter.format(0)).toBe("2006年睦月1日 00:00");
  });

  // ---- schema + 端到端：字符串 TimeSpec 经适配器固化 ----
  it("schema 接受字符串 window.start；schedule 日期字面量在公历下按日历触发（端到端）", () => {
    const template = makeTemplate({
      meta: { id: "t", name: "字面量测试", description: "d", startYear: 2000, engineProtocol: "v2" },
      time: {
        defaultStep: { value: 1, unit: "day" },
        calendar: { preset: "gregorian" },
      },
      actions: [{ id: "rest", label: "休息", duration: { value: 1, unit: "day" } }],
      events: [
        {
          id: "ev-date",
          title: "日期字面量",
          narrative: "到了。",
          trigger: { source: "schedule", window: { start: "2000-01-02" } },
          kind: "normal",
          settle: { normal: { options: [{ id: "opt-a", text: "继续" }] } },
        },
      ],
    });
    // schema 层：字符串 TimeSpec 合法（加载期零改动，运行期经适配器解析）
    const parsed = WorldTemplateV2Schema.parse(template);
    expect(
      parsed.events.find((e) => e.id === "ev-date")?.trigger.source === "schedule" &&
        "window" in parsed.events.find((e) => e.id === "ev-date")!.trigger,
    ).toBe(true);

    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "t", playerName: "测试者", seed: 1 }, template, "w1");
    // 休一天 = 1440 分钟 = 2000-01-02 00:00 ⇒ 到期触发
    advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(state.worldTime).toBe(1440);
    expect(state.pendingEvents[0]?.eventId).toBe("ev-date");
  });
});
