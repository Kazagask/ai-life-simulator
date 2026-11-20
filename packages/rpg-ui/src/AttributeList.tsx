import type { ReactNode } from "react";
import type { PlayerAttributeVM } from "@life-sim/shared";
import { StyledName } from "./StyledName.js";

/**
 * 属性展示（ADR-003）：**玩家个人页与 NPC 详情共用**，避免两套口径。
 *
 * 分工：
 * - `number`：原样数字（与改前视觉一致）；
 * - `enum` / `composite`：展示 `display`（选项 label / 称号），样式由投影解析；
 * - `ladder`：单独一条「成长」进度条（档位 + 本档 value/max）；
 * - `composite`：额外一行来源轴（如「恶名 ＋＋ · 善名 ＋＋」）。
 *
 * 组件**不查模板、不重算**——`display` / `style` / `progress` 都是投影给的。
 */

export function AttributeValue({ attr }: { attr: PlayerAttributeVM }) {
  if (attr.kind === "enum" || attr.kind === "composite") {
    return <StyledName name={attr.display} style={attr.style} />;
  }
  return <>{attr.display}</>;
}

/** 属性网格：数字 / 文本 / 复合（阶梯单独走 `LadderList`）。`trailing` 用于心情等固定格。 */
export function AttributeGrid({
  attributes,
  trailing,
}: {
  attributes: readonly PlayerAttributeVM[];
  trailing?: ReactNode;
}) {
  const rows = attributes.filter((a) => a.kind !== "ladder");
  if (rows.length === 0 && trailing === undefined) return null;
  return (
    <div className="stat-grid">
      {rows.map((attr) => (
        <div key={attr.key} className={`stat stat--${attr.kind}`}>
          <span>{attr.label}</span>
          <strong>
            <AttributeValue attr={attr} />
          </strong>
          {attr.kind === "composite" && attr.sources !== undefined && attr.sources.length > 0 && (
            <span className="stat-sources">
              {attr.sources.map((s, i) => (
                <span key={s.key}>
                  {i > 0 ? " · " : ""}
                  {s.label} <StyledName name={s.display} style={s.style} />
                </span>
              ))}
            </span>
          )}
        </div>
      ))}
      {trailing}
    </div>
  );
}

function LadderBar({ attr }: { attr: PlayerAttributeVM }) {
  const pct =
    attr.progress === undefined
      ? 0
      : Math.min(100, Math.max(0, (attr.progress.value / Math.max(1, attr.progress.max)) * 100));
  return (
    <div className="ls-ladder" data-key={attr.key}>
      <div className="ls-ladder__top">
        <span className="ls-ladder__name">{attr.label}</span>
        <span className="ls-ladder__tier">
          <StyledName name={attr.tier?.label ?? attr.display} style={attr.tier?.style ?? attr.style} />
        </span>
        {attr.progress !== undefined && (
          <span className="ls-ladder__value">
            {attr.progress.value}/{attr.progress.max}
          </span>
        )}
      </div>
      {attr.progress !== undefined && (
        <div className="bar ls-ladder__track">
          <div className="bar-fill ladder" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * 成长进度区：**一个或多个**阶梯属性各一条。没有阶梯属性时整块不渲染
 * （不留一个空标题——属性页的信息密度本来就紧）。
 */
export function LadderList({
  attributes,
  title = "成长",
}: {
  attributes: readonly PlayerAttributeVM[];
  title?: string;
}) {
  const ladders = attributes.filter((a) => a.kind === "ladder");
  if (ladders.length === 0) return null;
  return (
    <div className="ls-ladders">
      <span className="ls-ladders__title">{title}</span>
      {ladders.map((attr) => (
        <LadderBar key={attr.key} attr={attr} />
      ))}
    </div>
  );
}
