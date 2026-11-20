import type { CSSProperties, ReactNode } from "react";
import type { ResolvedStyle } from "@life-sim/shared";

/**
 * 样式呈现（ADR-002 D2）：**唯一**把 `ResolvedStyle` 变成 DOM 的地方。
 *
 * 三种东西分别落位：
 * - 预设 → 类名 `ls-style--<preset>`（颜色 / 渐变由 `styles.css` 提供）；
 * - 自定义颜色 / 背景 / 加粗 → 内联样式（值已在引擎侧解析成 `#rrggbb` 或 `var(--…)`）；
 * - 动画 → 类名 `ls-anim--<id>`（`prefers-reduced-motion` 下统一停用）。
 *
 * 自定义前端实现自己的 `StyledName` 时，只要消费同一份 `style` 就能保持一致；
 * 不要自己再解析模板里的颜色 token（那是引擎的事）。
 */
export function styleClassName(style?: ResolvedStyle): string | undefined {
  if (style === undefined) return undefined;
  const parts = ["ls-styled"];
  if (style.preset !== undefined) parts.push(`ls-style--${style.preset}`);
  if (style.animation !== undefined && style.animation !== "none") parts.push(`ls-anim--${style.animation}`);
  return parts.join(" ");
}

export function styleInline(style?: ResolvedStyle): CSSProperties | undefined {
  if (style === undefined) return undefined;
  const out: CSSProperties = {};
  if (style.color !== undefined) out.color = style.color;
  if (style.background !== undefined) out.background = style.background;
  if (style.bold === true) out.fontWeight = 700;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 容器样式（chip / 卡片边框）：文字染色只改字，玩家反馈「只有字体变色了 边框没变」。
 * 预设 ⇒ 类名 `.ls-box--<preset>`（CSS 给边框色，彩虹是流动边框）；自定义颜色 ⇒ 内联 borderColor。
 */
export function styleBoxClassName(style?: ResolvedStyle): string | undefined {
  if (style === undefined) return undefined;
  const parts: string[] = ["ls-box"];
  if (style.preset !== undefined) parts.push(`ls-box--${style.preset}`);
  if (style.animation !== undefined && style.animation !== "none") parts.push(`ls-box-anim--${style.animation}`);
  return parts.join(" ");
}

export function styleBoxInline(style?: ResolvedStyle): CSSProperties | undefined {
  if (style === undefined) return undefined;
  const out: CSSProperties = {};
  if (style.color !== undefined) out.borderColor = style.color;
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface StyledNameProps {
  children?: ReactNode;
  name?: string;
  style?: ResolvedStyle;
  className?: string;
  as?: "span" | "strong" | "b";
}

/** 带样式的实体名（状态 / 技能 / 物品 / 装备统一入口）。 */
export function StyledName({ children, name, style, className, as = "span" }: StyledNameProps) {
  const Tag = as;
  const cls = [className, styleClassName(style)].filter(Boolean).join(" ");
  return (
    <Tag className={cls === "" ? undefined : cls} style={styleInline(style)}>
      {children ?? name}
    </Tag>
  );
}
