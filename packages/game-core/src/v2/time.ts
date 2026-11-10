import type { TimeAmount, WorldTemplateV2 } from "@life-sim/shared";

/**
 * 时间适配器（ADR-0002）。
 *
 * 把「内部时间标量」的换算、历法显示、人生阶段与轮次步长集中到一处，
 * 由世界观模板配置；引擎不再把公历换算与人生阶段阈值硬编码散落在各处
 * （此前 `worldTime / 525600` 推年龄、人生阶段固定 13/20/60、前端 `timeText` 公历格式）。
 *
 * 内部时间标量仍以「分钟」为公分母（见 CORE_ENGINE V0.1「建议以分钟或统一整数 tick 表示」），
 * 但对外的历法语义（显示、年龄、步长、阶段）全部经由本适配器决定，
 * 从而消除「1 年 = 525600 分钟」等硬编码，并解除 V2 对 legacy time.ts 的反向依赖。
 */

export type TimeUnit = TimeAmount["unit"];

/** 通用时间单位 → 分钟（内部公分母）。month/year 为默认公历近似，可由日历扩展覆盖。 */
export const UNIT_MINUTES: Record<TimeUnit, number> = {
  minute: 1,
  hour: 60,
  day: 1440,
  week: 10080,
  month: 43200,
  year: 525600,
};

/** TimeAmount → 内部时间标量（分钟）。 */
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
  /** 内部时间标量 → 经过的整年数（用于年龄推进） */
  elapsedYears(minutes: number): number;
  /** 年龄 → 人生阶段 id */
  resolveLifeStage(age: number): string;
  /** 人生阶段 id → 显示标签 */
  lifeStageLabel(stageId: string): string;
}

export interface TimeAdapter extends CalendarAdapter {
  /** 轮次步长：行动 duration 优先，其次人生阶段步长，最后默认步长。 */
  resolveStep(lifeStage: string, actionDuration?: TimeAmount): TimeAmount;
}

export function createTimeAdapter(template: WorldTemplateV2): TimeAdapter {
  const startYear = template.meta.startYear;
  const stages = template.time.lifeStages;

  const resolveLifeStage = (age: number): string => {
    if (stages && stages.length > 0) {
      for (const s of stages) {
        if (s.maxAge === undefined || age <= s.maxAge) return s.id;
      }
      return stages[stages.length - 1].id;
    }
    // 缺省阈值（与旧实现一致，仅作回退）
    if (age < 13) return "childhood";
    if (age < 20) return "youth";
    if (age < 60) return "adulthood";
    return "elderhood";
  };

  const lifeStageLabel = (stageId: string): string => {
    const found = stages?.find((s) => s.id === stageId);
    return found?.label ?? stageId;
  };

  const format = (minutes: number): string => {
    const years = Math.floor(minutes / UNIT_MINUTES.year);
    const rest = minutes % UNIT_MINUTES.year;
    const months = Math.floor(rest / UNIT_MINUTES.month);
    const days = Math.floor((rest % UNIT_MINUTES.month) / UNIT_MINUTES.day);
    const hours = Math.floor((rest % UNIT_MINUTES.day) / UNIT_MINUTES.hour);
    return `${startYear + years}年${months + 1}月${days + 1}日 ${String(hours).padStart(2, "0")}:00`;
  };

  const elapsedYears = (minutes: number): number => Math.floor(minutes / UNIT_MINUTES.year);

  const resolveStep = (lifeStage: string, actionDuration?: TimeAmount): TimeAmount => {
    if (actionDuration) return actionDuration;
    const steps = template.time.lifeStageSteps;
    return steps?.[lifeStage] ?? template.time.defaultStep;
  };

  return { format, elapsedYears, resolveLifeStage, lifeStageLabel, resolveStep };
}
