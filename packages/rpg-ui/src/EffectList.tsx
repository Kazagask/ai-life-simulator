import type { EffectSummaryVM } from "@life-sim/shared";
import { StyledName } from "./StyledName.js";

export interface EffectListProps {
  effects?: EffectSummaryVM[];
  /**
   * 点开关联实体：参数是**整条条目**，宿主可直接用 `refDetail` 打开详情，
   * 不必再去快照里查（「施加 X」指向的是定义，玩家身上未必有这条实例）。
   */
  onOpenRef?: (effect: EffectSummaryVM) => void;
  /** 紧凑模式：收获卡 / 事件区里用，去掉分隔线。 */
  dense?: boolean;
}

/**
 * 效果列表（ADR-002 D3 / R-FX-01）。
 *
 * 三种渲染：
 * - `control`（固定效果，如「无法行动」）⇒ **下划线** + 一句人话说明（`note`）；
 * - 有 `ref` ⇒ 名字用被引用实体自己的样式，可点开它的详情（浮层可叠加）；
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
        const ref = effect.ref;

        let body;
        if (effect.kind === "control") {
          // 固定效果：下划线 + 说明（「无法行动」本身不解释回合数，说明补足语义）。
          body = (
            <u className="ls-fixed-effect" title={effect.note ?? effect.text} aria-label={effect.text}>
              {effect.text}
            </u>
          );
        } else if (ref !== undefined && onOpenRef !== undefined) {
          body = (
            <button type="button" className="ls-effect__link" onClick={() => onOpenRef(effect)}>
              <StyledName name={effect.text} style={effect.refDetail?.style} />
            </button>
          );
        } else {
          body = <StyledName name={effect.text} style={effect.refDetail?.style} as="span" />;
        }

        return (
          <li key={`${effect.kind}-${i}-${effect.text}`} className={`ls-effect ls-effect--${tone}`}>
            {body}
            {effect.note !== undefined && effect.kind !== "control" && (
              <span className="ls-effect__note">（{effect.note}）</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
