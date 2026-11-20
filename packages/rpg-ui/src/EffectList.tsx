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
  /** 单行模式：条目横向排开（召唤物技能表里「一个技能一行」用）。 */
  inline?: boolean;
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
/**
 * 效果文本：**样式只落在被引用实体的名字上**（用户 2026-11-20）。
 *
 * 三段由内核拼好（`lead / refName / trail`），前端不再按标题在整句里找位置 ——
 * 那是字符串切分，文案一改就退化。没有 `refName` 就整句按纯文本渲染。
 */
function EffectText({ effect, as }: { effect: EffectSummaryVM; as?: "span" }) {
  if (effect.refName === undefined) return <>{effect.text}</>;
  /**
   * 状态引用按**正负**上色（2026-11-20）：技能描述里的「施加 束缚」读的是状态的一等字段，
   * 不是它的身份色（品级 / 自定义 style）。非状态引用（技能 / 物品）仍走 `style`。
   */
  const tone = effect.refDetail?.polarity;
  return (
    <>
      {effect.lead ?? ""}
      <StyledName
        name={effect.refName}
        {...(tone !== undefined
          ? { className: `ls-tone--${tone}` }
          : effect.refDetail?.style !== undefined
            ? { style: effect.refDetail.style }
            : {})}
        {...(as === "span" ? { as } : {})}
      />
      {effect.trail ?? ""}
    </>
  );
}

export function EffectList({ effects, onOpenRef, dense = false, inline = false }: EffectListProps) {
  if (effects === undefined || effects.length === 0) return null;
  return (
    <ul className={`ls-effects${dense ? " ls-effects--dense" : ""}${inline ? " ls-effects--inline" : ""}`}>
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
              <EffectText effect={effect} />
            </button>
          );
        } else {
          body = <EffectText effect={effect} as="span" />;
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
