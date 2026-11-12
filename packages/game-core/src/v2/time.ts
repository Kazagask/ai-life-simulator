import type { TimeAmount, WorldTemplateV2 } from "@life-sim/shared";

/**
 * 时间适配器（ADR-0002 / ADR-0013）。
 *
 * 把「内部时间标量」的换算、历法显示、人生阶段与轮次步长集中到一处，由世界观模板配置；
 * 引擎不再把公历换算与人生阶段阈值硬编码散落在各处。
 *
 * 内部时间标量仍以「分钟」为公分母（CORE_ENGINE V0.1），但对外的历法语义（显示、年龄、步长、阶段）
 * 全部经由本适配器决定。三种时间模型（#39/#43）：
 * - approx：固定分钟近似（1 月 = 30 天、1 年 = 365 天）= R2.5 现状，零迁移；
 * - gregorian：真实公历（月长 28–31、闰年）；
 * - custom：模板声明 months[]/leapRule/era（年号/纪元）。
 * 全部纯函数、无 Date/Math.random，确定性可注入。
 */

export type TimeUnit = TimeAmount["unit"];

/** 通用时间单位 → 分钟（approx 默认公历近似；gregorian/custom 的 year/month 改走 CalendarAdapter.toMinutes）。 */
export const UNIT_MINUTES: Record<TimeUnit, number> = {
  minute: 1,
  hour: 60,
  day: 1440,
  week: 10080,
  month: 43200,
  year: 525600,
};

/** TimeAmount → 内部时间标量（分钟）。approx 语义；日历感知的 year/month 换算见 CalendarAdapter.toMinutes。 */
export function amountToMinutes(amount: TimeAmount): number {
  return amount.value * UNIT_MINUTES[amount.unit];
}

/** 内部时间标量（分钟）→ 尽量粗粒度的 TimeAmount（用于返回相对推进量）。 */
export function minutesToAmount(minutes: number): TimeAmount {
  const units: Array<[TimeUnit, number]> = [
    ["year", UNIT_MINUTES.year],
    ["month", UNIT_MINUTES.month],
    ["week", UNIT_MINUTES.week],
    ["day", UNIT_MINUTES.day],
    ["hour", UNIT_MINUTES.hour],
    ["minute", 1],
  ];
  for (const [unit, size] of units) {
    if (minutes >= size && minutes % size === 0) return { value: minutes / size, unit };
  }
  return { value: minutes, unit: "minute" };
}

export interface CalendarAdapter {
  /** 内部时间标量（分钟）→ 历法显示文本 */
  format(minutes: number): string;
  /** 内部时间标量 → 经过的整年数（用于年龄推进；生日未达不减岁，限日历感知 preset） */
  elapsedYears(minutes: number): number;
  /**
   * 该世界分钟落在**哪一年**（历法年；approx 用固定年长折算）。
   * 负分钟（世界起点之前）⇒ startYear 之前的年份，不做钳位（ADR-0021 决策 4.3）。
   */
  yearOf(minute: number): number;
  /**
   * 年龄派生（ADR-0021 决策 4.2）：**年差口径** `yearOf(now) − yearOf(birth)`，
   * 即 ADR-0013 修订 R1 的「跨年界即 +1」。
   *
   * **不得**实现为 `elapsedYears(now − birth)`：`elapsedYears` 的语义是「相对 startYear
   * 的整年差」，喂两个时刻之差得到的是**生日口径**（满周年才加岁），二者在 gregorian/custom
   * 下会差 1 岁（生于 1991-04-03、观察点 2007-01-15：本式 16 岁，生日口径 15 岁）。
   * approx 下两者恰好等价（525600 整除），所以这个坑只会在日历感知 preset 上炸。
   */
  ageAt(birthMinute: number, nowMinute: number): number;
  /** 年龄 → 人生阶段 id */
  resolveLifeStage(age: number): string;
  /** 人生阶段 id → 显示标签 */
  lifeStageLabel(stageId: string): string;
  /**
   * 按注入历法把 TimeAmount 换算为**分钟增量**（R2.6 落地，ADR-0013）：
   * 从 fromMinute 起推进 value 个 unit 后净增加的分钟数。day/week/hour/minute 与时历结构无关；
   * year/month 经日历逐月推进（如 2000-02-28 起 1 月因闰年到 03-28，比平年少 1 天）。
   * **负值表示回溯**（ADR-0021 决策 4.3）：year/month 向回走真实日历长度。
   */
  toMinutes(amount: TimeAmount, fromMinute: number): number;
  /** 解析复合时长（3d / 2h30m / 1y2mo）与历法日期字面量（2006-12-24）→ **绝对世界分钟**；非法抛错。 */
  parseTimeSpec(spec: string, fromMinute: number): number;
}

export interface TimeAdapter extends CalendarAdapter {
  /** 轮次步长：行动 duration 优先，其次人生阶段步长，最后默认步长。 */
  resolveStep(lifeStage: string, actionDuration?: TimeAmount): TimeAmount;
}

// ---------------- 日历模型（Date-free） ----------------

interface MonthDef {
  name: string;
  days: number;
}
interface CalendarModel {
  startYear: number;
  months: MonthDef[];
  isLeap: (year: number) => boolean;
  leapMonthIndex: number; // 0-based，闰年该月 +1 天
}

const GREGORIAN_MONTHS: MonthDef[] = [
  { name: "1月", days: 31 }, { name: "2月", days: 28 }, { name: "3月", days: 31 }, { name: "4月", days: 30 },
  { name: "5月", days: 31 }, { name: "6月", days: 30 }, { name: "7月", days: 31 }, { name: "8月", days: 31 },
  { name: "9月", days: 30 }, { name: "10月", days: 31 }, { name: "11月", days: 30 }, { name: "12月", days: 31 },
];

function gregorianLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function buildModel(
  calendar: NonNullable<WorldTemplateV2["time"]["calendar"]>,
  startYear: number,
): CalendarModel {
  if (calendar.preset === "gregorian") {
    return { startYear, months: GREGORIAN_MONTHS, isLeap: gregorianLeap, leapMonthIndex: 1 };
  }
  // custom
  const isLeap = calendar.leapRule === "gregorian" ? gregorianLeap : () => false;
  return {
    startYear,
    months: (calendar.months ?? []).map((m) => ({ name: m.name, days: m.days })),
    isLeap,
    leapMonthIndex: 1,
  };
}

function daysInYear(model: CalendarModel, year: number): number {
  let total = model.months.reduce((s, m) => s + m.days, 0);
  if (model.isLeap(year)) total += 1;
  return total;
}
function daysInMonth(model: CalendarModel, year: number, monthIndex: number): number {
  const base = model.months[monthIndex].days;
  return model.isLeap(year) && monthIndex === model.leapMonthIndex ? base + 1 : base;
}
interface View {
  year: number;
  monthIndex: number; // 0-based
  day: number; // 1-based
  minuteOfDay: number; // 0..1439
}
/**
 * 内部分钟 → 历法视图（Date-free）。
 *
 * ADR-0021 决策 4.3：**支持负分钟**（世界起点之前）。`minutes >= 0` 的输出与钳位版逐字节一致：
 * 非负时 `Math.floor(total/1440) === total % 1440` 的分解与旧实现同值，故零回归。
 * 负值时从 startYear-01-01 逐年向回走真实年长（闰年/自定义月长各自计入），
 * 与 `eraYearBase` 的手写负分支同一思路（那里保留手写是因为它数的是「纪元年基」）。
 */
function minutesToView(minutes: number, model: CalendarModel): View {
  const total = Math.floor(minutes);
  const dayIndex = Math.floor(total / 1440); // 可为负（欧几里得分解）
  const minuteOfDay = total - dayIndex * 1440; // 恒在 0..1439
  let rem = dayIndex; // 剩余天数（可为负）
  let year = model.startYear;
  if (rem >= 0) {
    while (rem >= daysInYear(model, year)) {
      rem -= daysInYear(model, year);
      year++;
    }
  } else {
    while (rem < 0) {
      year--;
      rem += daysInYear(model, year);
    }
  }
  let monthIndex = 0;
  while (rem >= daysInMonth(model, year, monthIndex)) {
    rem -= daysInMonth(model, year, monthIndex);
    monthIndex++;
  }
  return { year, monthIndex, day: rem + 1, minuteOfDay };
}
function viewToMinutes(v: View, model: CalendarModel): number {
  let minutes = 0;
  // ADR-0021 决策 4.3：year < startYear 时负累加（回溯），非负路径逐字节不变
  if (v.year >= model.startYear) {
    for (let y = model.startYear; y < v.year; y++) minutes += daysInYear(model, y) * 1440;
  } else {
    for (let y = v.year; y < model.startYear; y++) minutes -= daysInYear(model, y) * 1440;
  }
  for (let m = 0; m < v.monthIndex; m++) minutes += daysInMonth(model, v.year, m) * 1440;
  minutes += (v.day - 1) * 1440;
  minutes += v.minuteOfDay;
  return minutes;
}
function addMonthsToView(v: View, n: number, model: CalendarModel): View {
  const M = model.months.length;
  const total = (v.year - model.startYear) * M + v.monthIndex + n;
  const year = model.startYear + Math.floor(total / M);
  const monthIndex = ((total % M) + M) % M;
  const day = Math.min(v.day, daysInMonth(model, year, monthIndex));
  return { year, monthIndex, day, minuteOfDay: v.minuteOfDay };
}

// ---------------- 适配器工厂 ----------------

/**
 * 纪元年基（R-CAL-02）：世界起始年（startYear）对应的纪元年份。
 * epochStartMinute 可为负（纪元早于世界开始，如「洪荒 N 亿年」）：从 startYear 逐日历年
 * 往回数整年；锚点落在年中 ⇒ 该年剩余部分为纪元元年，次年起纪元二年。
 */
function eraYearBase(model: CalendarModel, anchor: number): number {
  if (anchor >= 0) {
    const av = minutesToView(anchor, model);
    return model.startYear - av.year + 1;
  }
  let rem = -anchor;
  let y = model.startYear;
  let full = 0;
  while (rem > 0) {
    y -= 1;
    const mins = daysInYear(model, y) * 1440;
    if (rem < mins) return full + 2; // 锚点在 y 年年中：y 年剩余 = 元年
    rem -= mins;
    full += 1;
  }
  return full + 1; // 锚点恰在 startYear - full 年初
}

/**
 * approx 分支：与 R2.5 字节级一致（固定分钟近似），保证旧模板零迁移（R-CAL-06）。
 */
function createApproxAdapter(template: WorldTemplateV2): TimeAdapter {
  const startYear = template.meta.startYear;
  const stages = template.time.lifeStages;

  const resolveLifeStage = (age: number): string => {
    if (stages && stages.length > 0) {
      for (const s of stages) {
        if (s.maxAge === undefined || age <= s.maxAge) return s.id;
      }
      return stages[stages.length - 1].id;
    }
    if (age < 13) return "childhood";
    if (age < 20) return "youth";
    if (age < 60) return "adulthood";
    return "elderhood";
  };
  const lifeStageLabel = (stageId: string): string => stages?.find((s) => s.id === stageId)?.label ?? stageId;
  const format = (minutes: number): string => {
    // 欧几里得分解：非负时与旧实现逐字节一致（floor/取余同值），负分钟也不产出 0 月 0 日
    const total = Math.floor(minutes);
    const years = Math.floor(total / UNIT_MINUTES.year);
    const rest = total - years * UNIT_MINUTES.year; // 恒在 0..年长-1
    const months = Math.floor(rest / UNIT_MINUTES.month);
    const days = Math.floor((rest % UNIT_MINUTES.month) / UNIT_MINUTES.day);
    const hours = Math.floor((rest % UNIT_MINUTES.day) / UNIT_MINUTES.hour);
    return `${startYear + years}年${months + 1}月${days + 1}日 ${String(hours).padStart(2, "0")}:00`;
  };
  const elapsedYears = (minutes: number): number => Math.floor(minutes / UNIT_MINUTES.year);
  // approx 无真实日历：年长恒为 525600 ⇒ 年差口径与「固定年长折算」等价（ADR-0021 决策 4.2）
  const yearOf = (minute: number): number => startYear + Math.floor(minute / UNIT_MINUTES.year);
  const ageAt = (birthMinute: number, nowMinute: number): number => yearOf(nowMinute) - yearOf(birthMinute);
  const resolveStep = (lifeStage: string, actionDuration?: TimeAmount): TimeAmount => {
    if (actionDuration) return actionDuration;
    const steps = template.time.lifeStageSteps;
    return steps?.[lifeStage] ?? template.time.defaultStep;
  };

  return {
    format,
    elapsedYears,
    yearOf,
    ageAt,
    resolveLifeStage,
    lifeStageLabel,
    resolveStep,
    toMinutes: amountToMinutes,
    parseTimeSpec: parseCompositeOnly,
  };
}

/** approx 仅支持复合时长字面量（不含历法日期，因 approx 非真实日历）。 */
function parseCompositeOnly(spec: string, fromMinute: number): number {
  return parseComposite(spec, fromMinute, amountToMinutes);
}

/** 复合时长解析（与日历无关的单位走 raw，year/month 经 toMin 回调累加增量）。 */
function parseComposite(spec: string, fromMinute: number, toMin: (a: TimeAmount, from: number) => number): number {
  const dateMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(spec.trim());
  if (dateMatch) {
    // 历法日期字面量暂不在 approx 支持；由调用方（gregorian/custom）以真实日历解析。
    throw new Error(`approx 历法不支持日期字面量解析：${spec}`);
  }
  const re = /(\d+)(y|mo|w|d|h|m)/g;
  let m: RegExpExecArray | null;
  let cur = fromMinute;
  let matched = false;
  while ((m = re.exec(spec)) !== null) {
    matched = true;
    const value = parseInt(m[1], 10);
    const unit = m[2];
    if (unit === "y") cur += toMin({ value, unit: "year" }, cur);
    else if (unit === "mo") cur += toMin({ value, unit: "month" }, cur);
    else if (unit === "w") cur += value * 10080;
    else if (unit === "d") cur += value * 1440;
    else if (unit === "h") cur += value * 60;
    else if (unit === "m") cur += value;
  }
  if (!matched) throw new Error(`无法解析 TimeSpec 字面量：${spec}`);
  return cur;
}

export function createTimeAdapter(template: WorldTemplateV2): TimeAdapter {
  const calendar = template.time.calendar ?? { preset: "approx" as const };
  if (calendar.preset === "approx") return createApproxAdapter(template);

  const startYear = template.meta.startYear;
  const model = buildModel(calendar, startYear);
  const eraBase = calendar.era ? eraYearBase(model, calendar.era.epochStartMinute ?? 0) : 0;

  const resolveLifeStage = (age: number): string => {
    const stages = template.time.lifeStages;
    if (stages && stages.length > 0) {
      for (const s of stages) {
        if (s.maxAge === undefined || age <= s.maxAge) return s.id;
      }
      return stages[stages.length - 1].id;
    }
    if (age < 13) return "childhood";
    if (age < 20) return "youth";
    if (age < 60) return "adulthood";
    return "elderhood";
  };
  const lifeStageLabel = (stageId: string): string =>
    template.time.lifeStages?.find((s) => s.id === stageId)?.label ?? stageId;

  const format = (minutes: number): string => {
    const v = minutesToView(minutes, model);
    const hour = Math.floor(v.minuteOfDay / 60);
    const monthLabel = model.months[v.monthIndex].name + v.day;
    if (calendar.era) {
      const eraYear = eraBase + (v.year - model.startYear);
      return `${calendar.era.name} ${eraYear}年${monthLabel}日 ${String(hour).padStart(2, "0")}:00`;
    }
    return `${v.year}年${monthLabel}日 ${String(hour).padStart(2, "0")}:00`;
  };

  const elapsedYears = (minutes: number): number => {
    const v = minutesToView(minutes, model);
    return Math.max(0, v.year - model.startYear);
  };

  /** ADR-0021 决策 4.2：年龄用**年差口径**，不是「相对 startYear 的整年差」。 */
  const yearOf = (minute: number): number => minutesToView(minute, model).year;
  const ageAt = (birthMinute: number, nowMinute: number): number => yearOf(nowMinute) - yearOf(birthMinute);

  const toMinutes = (amount: TimeAmount, fromMinute: number): number => {
    const raw: Record<string, number> = { week: 10080, day: 1440, hour: 60, minute: 1 };
    if (amount.unit in raw) return amount.value * raw[amount.unit];
    const v = minutesToView(fromMinute, model);
    // 1 年 = 历法整年（该历 months.length 个月），不是固定 12 个月（custom 可能月数不同）
    const months = amount.unit === "year" ? model.months.length * amount.value : amount.value;
    const added = addMonthsToView(v, months, model);
    return viewToMinutes(added, model) - viewToMinutes(v, model);
  };

  const parseTimeSpec = (spec: string, fromMinute: number): number => {
    const dateMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(spec.trim());
    if (dateMatch) {
      const y = parseInt(dateMatch[1], 10);
      const mo = parseInt(dateMatch[2], 10);
      const d = parseInt(dateMatch[3], 10);
      if (mo < 1 || mo > model.months.length || d < 1 || d > daysInMonth(model, y, mo - 1)) {
        throw new Error(`历法日期字面量越界：${spec}`);
      }
      return viewToMinutes({ year: y, monthIndex: mo - 1, day: d, minuteOfDay: 0 }, model);
    }
    return parseComposite(spec, fromMinute, toMinutes);
  };

  const resolveStep = (lifeStage: string, actionDuration?: TimeAmount): TimeAmount => {
    if (actionDuration) return actionDuration;
    const steps = template.time.lifeStageSteps;
    return steps?.[lifeStage] ?? template.time.defaultStep;
  };

  return { format, elapsedYears, yearOf, ageAt, resolveLifeStage, lifeStageLabel, resolveStep, toMinutes, parseTimeSpec };
}

/**
 * 年龄 → 出生分钟（ADR-0021 决策 4.1 的反推口径）：按**整年从世界起点回溯**。
 *
 * 用 `toMinutes({ value: -age, unit: "year" }, 0)` 而非 `-age * 525600`：
 * 后者在日历感知 preset 下会漂（真实年长 365/366 天不等，custom 甚至可能是 61 天/年），
 * 反推出的年份可能差好几年，`ageAt(birthTime, 0) === age` 就不成立。
 * approx 下 `toMinutes` 就是 525600 的整数倍 ⇒ 与朴素式等价。
 *
 * 建实例（turn.ts）与旧档读侧兜底（projection.ts）共用本函数，避免两处各写一遍口径。
 */
export function birthTimeFromAge(age: number, adapter: CalendarAdapter): number {
  return adapter.toMinutes({ value: -age, unit: "year" }, 0);
}
