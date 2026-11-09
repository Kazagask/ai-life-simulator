import type { LifeStage, TimeAmount, WorldTemplate, Character } from "@life-sim/shared";

const UNIT_TO_MINUTES: Record<TimeAmount["unit"], number> = {
  minute: 1,
  hour: 60,
  day: 1440,
  week: 10080,
  month: 43200,
  year: 525600,
};

export function toMinutes(amount: TimeAmount): number {
  return amount.value * UNIT_TO_MINUTES[amount.unit];
}

export function fromMinutes(minutes: number): TimeAmount {
  if (minutes % UNIT_TO_MINUTES.year === 0) return { value: minutes / UNIT_TO_MINUTES.year, unit: "year" };
  if (minutes % UNIT_TO_MINUTES.month === 0) return { value: minutes / UNIT_TO_MINUTES.month, unit: "month" };
  if (minutes % UNIT_TO_MINUTES.week === 0) return { value: minutes / UNIT_TO_MINUTES.week, unit: "week" };
  if (minutes % UNIT_TO_MINUTES.day === 0) return { value: minutes / UNIT_TO_MINUTES.day, unit: "day" };
  if (minutes % UNIT_TO_MINUTES.hour === 0) return { value: minutes / UNIT_TO_MINUTES.hour, unit: "hour" };
  return { value: minutes, unit: "minute" };
}

export function resolveLifeStage(age: number): LifeStage {
  if (age < 13) return "childhood";
  if (age < 20) return "youth";
  if (age < 60) return "adulthood";
  return "elderhood";
}

export function determineStep(
  character: Character,
  template: WorldTemplate,
  actionDuration?: TimeAmount,
): TimeAmount {
  if (actionDuration) return actionDuration;
  const stageStep = template.lifeStageSteps[character.lifeStage];
  return stageStep ?? template.defaultStep;
}
