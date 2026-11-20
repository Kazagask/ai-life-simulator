import type { TurnGainVM } from "@life-sim/shared";
import { StyledName, styleBoxClassName, styleBoxInline } from "./StyledName.js";

const GROUP_ORDER = ["attribute", "status", "skill", "item", "equipment"] as const;
const GROUP_LABEL: Record<(typeof GROUP_ORDER)[number], string> = {
  attribute: "属性",
  status: "状态",
  skill: "技能",
  item: "物品",
  equipment: "装备",
};

export interface TurnGainsCardProps {
  gains: TurnGainVM[];
  /** 本轮的转盘结果（若有）：作为卡片首行，避免「只有收获没有事件上下文」。 */
  wheel?: { title?: string; label: string } | null;
  /** 点开条目详情（属性不可点；技能 / 物品 / 装备 / 状态走各自详情）。 */
  onSelect?: (gain: TurnGainVM) => void;
}

/** 属性的正负号：`+2` / `-15`（0 不会出现，差分不出条目）。 */
function signed(amount: number | undefined): string {
  if (amount === undefined) return "";
  return `${amount > 0 ? "+" : ""}${amount}`;
}

/** 类别的动词前缀：状态是 +/-，技能是「习得」，物品是「获得/失去」，装备是「装备/卸下」。 */
function prefixOf(gain: TurnGainVM): string {
  switch (gain.category) {
    case "status":
      return gain.action === "gain" ? "+" : "-";
    case "skill":
      return "习得";
    case "item":
      return gain.action === "gain" ? "获得" : "失去";
    case "equipment":
      return gain.action === "equip" ? "装备" : "卸下";
    default:
      return "";
  }
}

/** 属性条目的显示：初始值（set）不带正负号，增减带 +/-。 */
function attributeText(gain: TurnGainVM): string {
  if (gain.action === "set") return String(gain.amount ?? "");
  return signed(gain.amount);
}

/**
 * 本轮收获（ADR-002 D4 / R-GAIN-01..03）。
 *
 * 位置就是原来「命运落定」那张卡：一回合结束后，玩家先看到「我拿到了什么」，
 * 而不是只有一句事件标签。**空数组不渲染**（宿主负责回退「世界平静地流转着」）。
 *
 * 色义：增益绿、减益红、中性灰（用户 2026-11-18 裁决）。
 */
export function TurnGainsCard({ gains, wheel, onSelect }: TurnGainsCardProps) {
  if (gains.length === 0 && (wheel === undefined || wheel === null)) return null;

  return (
    <section className="card result ls-gains">
      <h3 className="result-title">本轮收获</h3>
      {wheel !== undefined && wheel !== null && (
        <p className="ls-gains__wheel">
          ⚄ {wheel.title ?? "随机事件"}：{wheel.label}
        </p>
      )}
      {GROUP_ORDER.map((category) => {
        const rows = gains.filter((g) => g.category === category);
        if (rows.length === 0) return null;
        return (
          <div key={category} className="ls-gains__group">
            <span className="ls-gains__group-label">{GROUP_LABEL[category]}</span>
            <ul className="ls-gains__list">
              {rows.map((gain) => {
                const clickable = gain.category !== "attribute" && onSelect !== undefined;
                const tone =
                  gain.category === "attribute"
                    ? gain.action === "set"
                      ? "neutral"
                      : gain.action === "up"
                        ? "buff"
                        : "debuff"
                    : gain.action === "lose" || gain.action === "unequip" || gain.action === "down"
                      ? "debuff"
                      : "buff";
                const content = (
                  <>
                    <span className="ls-gains__sign">{prefixOf(gain)}</span>
                    {/* 属性也要吃样式：文本属性（等级 / 身份）的颜色是模板给的，
                        只给行加边框会让「特级」显示成灰字（用户 2026-11-19 反馈）。 */}
                    <StyledName name={gain.name} style={gain.style} />
                    {gain.category === "attribute" && (
                      gain.value !== undefined ? (
                        <StyledName className="ls-gains__amount" name={String(gain.value)} style={gain.style} />
                      ) : (
                        <span className="ls-gains__amount">{attributeText(gain)}</span>
                      )
                    )}
                    {gain.category !== "attribute" && gain.amount !== undefined && (
                      <span className="ls-gains__amount">×{Math.abs(gain.amount)}</span>
                    )}
                    {gain.category === "status" && gain.stacks !== undefined && gain.stacks > 1 && (
                      <span className="ls-gains__amount">×{gain.stacks}</span>
                    )}
                  </>
                );
                return (
                  <li
                    key={`${gain.category}-${gain.action}-${gain.id}`}
                    className={`ls-gains__row ls-effect--${tone}${styleBoxClassName(gain.style) === undefined ? "" : ` ${styleBoxClassName(gain.style)}`}`}
                    style={styleBoxInline(gain.style)}
                  >
                    {clickable ? (
                      <button type="button" className="ls-gains__button" onClick={() => onSelect(gain)}>
                        {content}
                      </button>
                    ) : (
                      <span className="ls-gains__static">{content}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
