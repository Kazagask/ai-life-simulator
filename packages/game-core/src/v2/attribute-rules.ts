import { numericAttr, type AttributeDef, type AttributeValue, type WorldTemplateV2 } from "@life-sim/shared";

/**
 * 属性类型规则（ADR-003）：**一处**实现 kind 查找、阶梯档位派生与条件求值。
 *
 * 为什么单独成模块：属性条件有两个求值入口（引擎 `checkCondition` 与触发器
 * `condition-evaluator`），阶梯档位又在投影里要用一次。三处各写一份 switch 必然漂移，
 * 而「同一个条件在不同入口结果不同」是这类系统最难查的 bug。
 */

export type AttributeKindOf = "number" | "enum" | "ladder" | "composite";

export function attributeDefOf(template: WorldTemplateV2, id: string): AttributeDef | undefined {
  return template.attributes.defs?.[id];
}

export function attributeKindOf(template: WorldTemplateV2, id: string): AttributeKindOf {
  return template.attributes.defs?.[id]?.kind ?? "number";
}

export interface LadderTierState {
  index: number;
  id: string;
  label: string;
  style?: string;
  /** 本档起点 / reset 模式下的本档所需（value 语义见 mode）。 */
  at: number;
  /** 本档内已积累的值（cumulative = value - at；reset = value）。 */
  progressValue: number;
  /** 到下一档的距离；最后一档无下一档时为 undefined。 */
  nextAt?: number;
  /** 本档进度分母；最后一档且无 caps 时为 undefined（不画进度条）。 */
  progressMax?: number;
}

/**
 * 派生阶梯当前档。
 *
 * - cumulative：取最后一个 `at <= value` 的档；
 * - reset：档位来自 `storedTierId`（数值在本档内重置，单靠 value 无法区分档位）。
 *
 * `cap` 只用于最后一档的进度分母（`attributes.caps[id]`）。
 */
export function ladderTierState(
  def: Extract<AttributeDef, { kind: "ladder" }>,
  value: number,
  storedTierId: string | undefined,
  cap: number | undefined,
): LadderTierState {
  const tiers = def.tiers;
  let index: number;
  let progressValue: number;
  if (def.mode === "reset") {
    const found = storedTierId === undefined ? -1 : tiers.findIndex((t) => t.id === storedTierId);
    index = found >= 0 ? found : 0;
    progressValue = Math.max(0, value);
  } else {
    index = 0;
    for (let i = 0; i < tiers.length; i++) {
      if (value >= tiers[i].at) index = i;
      else break;
    }
    progressValue = Math.max(0, value - tiers[index].at);
  }
  const tier = tiers[index];
  const next = tiers[index + 1];
  // cumulative：分母 = 下一档 at - 本档 at；reset：分母 = 本档 at（本档所需）。
  const nextAt = next === undefined ? undefined : def.mode === "reset" ? tier.at : next.at;
  let progressMax: number | undefined;
  if (next !== undefined) {
    progressMax = def.mode === "reset" ? Math.max(1, tier.at) : Math.max(1, next.at - tier.at);
  } else if (cap !== undefined && cap > tier.at) {
    progressMax = cap - tier.at;
  }
  return {
    index,
    id: tier.id,
    label: tier.label,
    ...(tier.style !== undefined ? { style: tier.style } : {}),
    at: tier.at,
    progressValue,
    ...(nextAt !== undefined ? { nextAt } : {}),
    ...(progressMax !== undefined ? { progressMax } : {}),
  };
}

/**
 * reset 阶梯的升档处理：加值 → 循环扣减本档所需 → 返回新值与新档 id。
 * cumulative / number 只返回值（档位由值派生）。
 */
export function applyLadderGain(
  def: Extract<AttributeDef, { kind: "ladder" }>,
  current: number,
  delta: number,
  storedTierId: string | undefined,
): { value: number; tierId?: string } {
  if (def.mode !== "reset") return { value: current + delta };
  const tiers = def.tiers;
  const found = storedTierId === undefined ? -1 : tiers.findIndex((t) => t.id === storedTierId);
  let index = found >= 0 ? found : 0;
  let value = Math.max(0, current + delta);
  // 只升不降：扣减到下一档即停，最多走完所有档。
  while (index < tiers.length - 1 && value >= tiers[index].at) {
    value -= tiers[index].at;
    index += 1;
  }
  return { value, tierId: tiers[index].id };
}

/** setAttribute 对 reset 阶梯的绝对赋值：从首档起逐档扣减（不读旧档位，保证可复现）。 */
export function ladderResetFromAbsolute(
  def: Extract<AttributeDef, { kind: "ladder" }>,
  value: number,
): { value: number; tierId: string } {
  const tiers = def.tiers;
  let index = 0;
  let rest = Math.max(0, value);
  while (index < tiers.length - 1 && rest >= tiers[index].at) {
    rest -= tiers[index].at;
    index += 1;
  }
  return { value: rest, tierId: tiers[index].id };
}

/** 条件里可出现的属性比较（`AttributeCondition` 的结构子集）。 */
export interface AttributeConditionLike {
  attribute: string;
  eq?: number | string;
  ne?: number | string;
  gte?: number;
  lte?: number;
  gt?: number;
  lt?: number;
  tier?: string;
}

/**
 * 属性条件求值（两个入口共用）。
 *
 * - enum：`eq/ne` 比选项 id；
 * - number / ladder：`eq/ne/gte/lte/gt/lt` 比有效值（含状态）；
 * - ladder：`tier` 比当前档 id（reset 用存档档位，cumulative 由值派生）；
 * - composite：不可作为条件（加载期已拒载），运行时一律 false。
 */
export function evaluateAttributeCondition(
  cond: AttributeConditionLike,
  rawAttrs: Record<string, AttributeValue>,
  effectiveAttrs: Record<string, number>,
  template: WorldTemplateV2,
  storedTiers?: Record<string, string>,
): boolean {
  const def = attributeDefOf(template, cond.attribute);
  if (def?.kind === "composite") return false;

  if (def?.kind === "enum") {
    const raw = rawAttrs[cond.attribute];
    if (cond.eq !== undefined) return raw === cond.eq;
    if (cond.ne !== undefined) return raw !== cond.ne;
    return true;
  }

  const value = effectiveAttrs[cond.attribute] ?? numericAttr(rawAttrs[cond.attribute]);
  if (cond.tier !== undefined) {
    if (def?.kind !== "ladder") return false;
    const cap = template.attributes.caps?.[cond.attribute];
    const state = ladderTierState(def, value, storedTiers?.[cond.attribute], cap);
    if (state.id !== cond.tier) return false;
  }
  if (cond.eq !== undefined && typeof cond.eq === "number" && value !== cond.eq) return false;
  if (cond.ne !== undefined && typeof cond.ne === "number" && value === cond.ne) return false;
  if (cond.gte !== undefined && value < cond.gte) return false;
  if (cond.lte !== undefined && value > cond.lte) return false;
  if (cond.gt !== undefined && value <= cond.gt) return false;
  if (cond.lt !== undefined && value >= cond.lt) return false;
  return true;
}
