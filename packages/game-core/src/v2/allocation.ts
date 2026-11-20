/**
 * 加点的**唯一校验器**（ADR-004 D4 / ADR-019）：开局与世界内共用。
 *
 * 为什么必须共用：开局的 `allocate` 节点与世界的 `POST /allocation` 是同一件事的
 * 两个入口。两处各写一份判定，玩家在两个地方会收到不一致的反馈
 * （「开局说超预算了，世界里却收下了」——这类分叉比 bug 更难查）。
 *
 * 四条边界（顺序即报错优先级）：
 * 1. 目标必须在声明里；
 * 2. 值必须是非负整数；
 * 3. 逐项 `min` / `max`（限制的是**这次分到的点数**，不是属性终值）；
 * 4. 总和不得超过预算 —— 但**允许放弃余额**（只分一部分是合法选择，
 *    「要不要二次确认」是 UI 的事，内核不替玩家决定）。
 */

export interface AllocationTargetLike {
  readonly attribute: string;
  readonly min?: number;
  readonly max?: number;
}

export interface AllocationSpecLike {
  readonly budget: number;
  readonly targets: readonly AllocationTargetLike[];
}

export type AllocationFailureCode =
  | "unknown_target"
  | "invalid_value"
  | "below_min"
  | "above_max"
  | "over_budget";

export type AllocationResult =
  | { readonly ok: true; readonly points: Record<string, number>; readonly spent: number }
  | { readonly ok: false; readonly code: AllocationFailureCode; readonly detail: string };

export function normalizeAllocation(
  input: Readonly<Record<string, number>>,
  spec: AllocationSpecLike,
): AllocationResult {
  const targets = new Map(spec.targets.map((t) => [t.attribute, t]));
  /**
   * 先展开成「白名单全量」（没提交的目标按 0），再统一校验 ——
   * 否则 `min > 0` 的目标漏填会被当成合法，直接绕过下限。
   */
  const points: Record<string, number> = {};
  for (const attribute of targets.keys()) points[attribute] = 0;
  for (const [attribute, value] of Object.entries(input)) {
    if (!targets.has(attribute)) return { ok: false, code: "unknown_target", detail: attribute };
    if (!Number.isInteger(value) || value < 0) {
      return { ok: false, code: "invalid_value", detail: `${attribute}=${value}` };
    }
    points[attribute] = value;
  }

  let spent = 0;
  for (const [attribute, value] of Object.entries(points)) {
    const target = targets.get(attribute);
    if (target?.min !== undefined && value < target.min) {
      return { ok: false, code: "below_min", detail: `${attribute}=${value}` };
    }
    if (target?.max !== undefined && value > target.max) {
      return { ok: false, code: "above_max", detail: `${attribute}=${value}` };
    }
    spent += value;
  }
  if (spent > spec.budget) {
    return { ok: false, code: "over_budget", detail: `${spent}/${spec.budget}` };
  }
  return { ok: true, points, spent };
}
