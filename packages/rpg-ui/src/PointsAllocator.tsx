import { useState } from "react";
import type { ResolvedStyle } from "@life-sim/shared";
import { StyledName } from "./StyledName.js";

/**
 * 加点面板（ADR-004 D6）。
 *
 * **游戏内加点复用此组件**：升级、训练、奇遇等场景需要「给若干属性分配 N 点」时，
 * 直接传 `budget` / `targets` / `value` / `onChange`，不要另写一套
 * —— 加点的边界（每项上下限、非负整数、不能超支）在开局和游戏内必须是同一套口径，
 * 否则同一件事在两处给玩家的反馈会不一致。
 *
 * 组件是**纯受控**的：不持有点数、不发请求、不认识 `attribute` 之外的语义。
 * 「随机」也只在前端掷（不消耗世界 RNG，不影响回放）。
 *
 * 余额可以放弃：没分完也能点确定，但会先弹二次确认（`stillRemaining`），
 * 避免「以为还能回来点」——开局是一次性的。
 */

export interface PointsTargetVM {
  attribute: string;
  label: string;
  min?: number;
  max?: number;
  /** 属性名着色（模板 target.style）；未声明则按普通文本渲染。 */
  style?: ResolvedStyle;
}

export interface PointsAllocatorProps {
  budget: number;
  targets: readonly PointsTargetVM[];
  /** attribute -> 已分配点数（缺省视为 0）。 */
  value: Record<string, number>;
  onChange(next: Record<string, number>): void;
  /** 可选：由调用方接管「确定」按钮（开局 = 推进一步；游戏内 = 提交加点）。 */
  onConfirm?(): void;
  confirmLabel?: string;
  disabled?: boolean;
}

const sumOf = (value: Record<string, number>): number =>
  Object.values(value).reduce((sum, v) => sum + v, 0);

const maxOf = (target: PointsTargetVM): number =>
  target.max === undefined ? Number.POSITIVE_INFINITY : target.max;

/** 纯前端随机：把剩余点数撒到还有空间的属性上（不触碰世界 RNG）。 */
function randomFill(
  targets: readonly PointsTargetVM[],
  value: Record<string, number>,
  budget: number,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const target of targets) next[target.attribute] = value[target.attribute] ?? target.min ?? 0;
  let left = budget - sumOf(next);
  if (left <= 0) return next;

  // 每个属性按剩余空间展开成「格子」，洗牌后逐个 +1 —— 分布均匀且天然守住 max。
  const slots: string[] = [];
  for (const target of targets) {
    const room = Math.min(left, Math.max(0, maxOf(target) - next[target.attribute]));
    for (let i = 0; i < room; i += 1) slots.push(target.attribute);
  }
  for (let i = slots.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [slots[i], slots[j]] = [slots[j]!, slots[i]!];
  }
  for (const attribute of slots) {
    if (left <= 0) break;
    next[attribute] = (next[attribute] ?? 0) + 1;
    left -= 1;
  }
  return next;
}

export function PointsAllocator({
  budget,
  targets,
  value,
  onChange,
  onConfirm,
  confirmLabel = "确定分配",
  disabled = false,
}: PointsAllocatorProps) {
  const [confirming, setConfirming] = useState(false);
  const allocated = sumOf(value);
  const remaining = budget - allocated;

  const setOne = (attribute: string, next: number, min = 0, max = Number.POSITIVE_INFINITY): void => {
    const clamped = Math.max(min, Math.min(max, next));
    if (clamped === (value[attribute] ?? 0)) return;
    onChange({ ...value, [attribute]: clamped });
  };

  const reset = (): void => {
    const cleared: Record<string, number> = {};
    for (const target of targets) cleared[target.attribute] = target.min ?? 0;
    onChange(cleared);
  };

  const fillToMax = (target: PointsTargetVM): void => {
    const current = value[target.attribute] ?? 0;
    const room = Math.max(0, maxOf(target) - current);
    const take = Math.min(room, remaining);
    if (take <= 0) return;
    onChange({ ...value, [target.attribute]: current + take });
  };

  const submit = (): void => {
    if (remaining > 0) {
      setConfirming(true);
      return;
    }
    onConfirm?.();
  };

  return (
    <div className="ls-alloc">
      <div className="ls-alloc__head">
        <span className={`ls-alloc__remaining${remaining === 0 ? " is-done" : ""}`}>
          剩余 <strong>{remaining}</strong> 点
        </span>
        <span className="ls-alloc__budget">本次共 {budget} 点</span>
        <button
          type="button"
          className="ls-alloc__quick"
          onClick={() => onChange(randomFill(targets, value, budget))}
          disabled={disabled || remaining === 0 || targets.length === 0}
        >
          随机
        </button>
        <button
          type="button"
          className="ls-alloc__quick"
          onClick={reset}
          disabled={disabled || allocated === 0}
        >
          重置
        </button>
      </div>

      <ul className="ls-alloc__list">
        {targets.map((target) => {
          const min = target.min ?? 0;
          const max = maxOf(target);
          const current = value[target.attribute] ?? 0;
          const canAdd = !disabled && remaining > 0 && current < max;
          const canSub = !disabled && current > min;
          return (
            <li key={target.attribute} className="ls-alloc__row">
              <span className="ls-alloc__label">
                <StyledName name={target.label} style={target.style} />
              </span>
              <span className="ls-alloc__hint">
                {Number.isFinite(max) ? `上限 ${max}` : "无上限"}
              </span>
              <div className="ls-alloc__stepper">
                <button
                  type="button"
                  className="ls-alloc__btn"
                  aria-label={`${target.label} 减一点`}
                  disabled={!canSub}
                  onClick={() => setOne(target.attribute, current - 1, min, max)}
                >
                  −
                </button>
                <output className={`ls-alloc__value${current > min ? " is-positive" : ""}`}>
                  {current > 0 ? `+${current}` : "0"}
                </output>
                <button
                  type="button"
                  className="ls-alloc__btn"
                  aria-label={`${target.label} 加一点`}
                  disabled={!canAdd}
                  onClick={() => setOne(target.attribute, current + 1, min, max)}
                >
                  +
                </button>
                <button
                  type="button"
                  className="ls-alloc__max"
                  aria-label={`${target.label} 加到上限`}
                  disabled={disabled || remaining === 0 || current >= max}
                  onClick={() => fillToMax(target)}
                >
                  MAX
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {onConfirm !== undefined && (
        <button
          type="button"
          className="primary ls-alloc__confirm"
          disabled={disabled}
          onClick={submit}
        >
          {remaining === 0 ? confirmLabel : `${confirmLabel}（剩 ${remaining} 点未分配）`}
        </button>
      )}

      {confirming && (
        <div className="ls-alloc__confirm-mask" role="dialog" aria-modal="true" aria-label="加点确认">
          <div className="ls-alloc__confirm-box">
            <p className="ls-alloc__confirm-title">还有 {remaining} 点没有分配</p>
            <p className="ls-alloc__confirm-text">
              落定之后不能再改，剩下的点数会直接作废。确定就这样吗？
            </p>
            <div className="ls-alloc__confirm-actions">
              <button type="button" className="ghost" onClick={() => setConfirming(false)}>
                继续分配
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setConfirming(false);
                  onConfirm?.();
                }}
              >
                就这样确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
