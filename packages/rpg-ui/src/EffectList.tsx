import type { EffectSummaryVM } from "@life-sim/shared";

export interface EffectListProps {
  effects?: EffectSummaryVM[];
  /** 点开关联实体（`ref`）：施加补正 / 移除补正这类条目要能跳到详情。 */
  onOpenRef?: (ref: NonNullable<EffectSummaryVM["ref"]>) => void;
  /** 紧凑模式：收获卡 / 事件区里用，去掉分隔线。 */
  dense?: boolean;
}

/**
 * 效果列表（ADR-002 D3 / R-FX-01）。
 *
 * 三种渲染：
 * - `control`（固定效果，如「无法行动」）⇒ **下划线**，与数值条目区分；
 * - 有 `ref` ⇒ 可点，跳详情；
 * - 其余 ⇒ 纯文本，带增益 / 减益色。
 *
 * 色义：增益绿、减益红、中性灰（用户 2026-11-18 裁决「增绿减红 0 灰」）。
 */
export function EffectList({ effects, onOpenRef, dense = false }: EffectListProps) {
  if (effects === undefined || effects.length === 0) return null;
  return (
    <ul className={`ls-effects${dense ? " ls-effects--dense" : ""}`}>
      {effects.map((effect, i) => {
        const tone = effect.tone ?? "neutral";
        const body =
          effect.kind === "control" ? (
            <u className="ls-fixed-effect" title={effect.text} aria-label={effect.text}>
              {effect.text}
            </u>
          ) : effect.ref !== undefined && onOpenRef !== undefined ? (
            <button
              type="button"
              className="ls-effect__link"
              onClick={() => onOpenRef(effect.ref as NonNullable<EffectSummaryVM["ref"]>)}
            >
              {effect.text}
            </button>
          ) : (
            <span>{effect.text}</span>
          );
        return (
          <li key={`${effect.kind}-${i}-${effect.text}`} className={`ls-effect ls-effect--${tone}`}>
            {body}
          </li>
        );
      })}
    </ul>
  );
}
