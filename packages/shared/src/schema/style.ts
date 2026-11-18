import { z } from "zod";

/**
 * 表现层样式协议（ADR-002 D2）。
 *
 * 边界：样式**只影响展示**，不参与判定、不进 `WorldStateV2`、不进语义指纹。
 *
 * 为什么是闭集而不是自由 CSS：模板是内容，不是样式表。允许任意字符串等于把注入面、
 * 跨端一致性与可访问性（减少动效 / 对比度）全部外包给模板作者；而实际需要的表达力
 * （金属色 / 语义色 / 流动彩虹 / 加粗）用一个枚举 + 颜色 token 就能覆盖。
 *
 * 解析顺序（引擎 `presentation/style.ts` 唯一实现）：
 *   实体 `style`（先查模板 `ui.styles` 别名，再查预设 id）
 *   > `ui.qualityStyles[quality]`
 *   > 无样式（渲染回退默认）。
 */

/**
 * 引擎内置预设。**命名只描述视觉，不与品级耦合**（用户 2026-11-18）：
 * 内核不出现 mythic/legendary 这类品级词——品级是模板侧的 `quality` 值，
 * 由模板自己映射到这里的预设 id。
 *
 * 稀有度色（DNF 式 8 档，从高到低）：rainbow（动虹）/ rainbow-static（静虹）/
 * gold / orange / pink / purple / blue / white；
 * 另有正负零三档：green（正）/ red（负）/ gray（中性）。
 */
export const STYLE_PRESET_IDS = [
  "rainbow",
  "rainbow-static",
  "gold",
  "orange",
  "pink",
  "purple",
  "blue",
  "white",
  "green",
  "red",
  "gray",
] as const;
export const StylePresetIdSchema = z.enum(STYLE_PRESET_IDS);
export type StylePresetId = z.infer<typeof StylePresetIdSchema>;

/** 预设动画。`none` 显式关闭（覆盖品质映射带来的动画）。 */
export const STYLE_ANIMATION_IDS = ["none", "rainbow-flow", "pulse", "glow"] as const;
export const StyleAnimationSchema = z.enum(STYLE_ANIMATION_IDS);
export type StyleAnimation = z.infer<typeof StyleAnimationSchema>;

/**
 * 颜色 token → CSS 变量。模板写 `gold`，前端拿 `var(--ls-gold)`；
 * 这样主题换色不需要改模板，也不需要前端认识语义。
 */
export const COLOR_TOKEN_TO_VAR: Readonly<Record<string, string>> = {
  text: "var(--ls-text, var(--text))",
  muted: "var(--ls-text-dim, var(--muted))",
  accent: "var(--accent)",
  "accent-2": "var(--accent-2)",
  gold: "var(--ls-gold, var(--gold, #c9a227))",
  danger: "var(--danger, #ff6b6b)",
  success: "var(--success, #4fd1c5)",
};

/** 只收 3/6/8 位十六进制或引擎颜色 token；任何带 `;{}()` 的值在正则就失败。 */
export const ColorTokenSchema = z.union([
  z
    .string()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "颜色只接受 #rgb / #rrggbb / #rrggbbaa"),
  z.enum(["text", "muted", "accent", "accent-2", "gold", "danger", "success"]),
]);
export type ColorToken = z.infer<typeof ColorTokenSchema>;

export const StyleSpecSchema = z
  .object({
    preset: StylePresetIdSchema.optional(),
    color: ColorTokenSchema.optional(),
    background: ColorTokenSchema.optional(),
    bold: z.boolean().optional(),
    animation: StyleAnimationSchema.optional(),
  })
  .strict();
export type StyleSpec = z.infer<typeof StyleSpecSchema>;

/** 正负零（用户 2026-11-18：模板里与品级**独立**的字段）。 */
export const POLARITY_IDS = ["positive", "negative", "neutral"] as const;
export const PolaritySchema = z.enum(POLARITY_IDS);
export type Polarity = z.infer<typeof PolaritySchema>;

/** 正负零 → 默认预设（模板没写 `ui.polarityStyles` 时用它）。 */
export const DEFAULT_POLARITY_STYLES: Readonly<Record<Polarity, StylePresetId>> = {
  positive: "green",
  negative: "red",
  neutral: "gray",
};

/** 把颜色 token 解析成可直接写进内联样式的 CSS 值（十六进制原样返回）。 */
export function resolveColorToken(token: ColorToken): string {
  if (token.startsWith("#")) return token;
  return COLOR_TOKEN_TO_VAR[token] ?? token;
}

/**
 * 标签（ADR-002 D2b，用户 2026-11-18）：**展示规格**，与样式解耦。
 *
 * 为什么要单独一层：`rainbow` 是引擎的视觉变量名，玩家不该看到「RAINBOW」。
 * 玩家该看到的是「神话」这种**模板自己定的词**。所以标签 = `name` + 自带 `style`，
 * 补正 / 装备用 `tags: [id...]` 引用；同一个实体可以既挂品级标签又挂增益标签。
 *
 * 边界：tag 只在 `ui.yaml` 里声明（展示域），不进语义指纹、不参与判定。
 */
export const TagDefinitionSchema = z
  .object({
    name: z.string().min(1),
    /** 标签自己的样式（可与实体样式不同）。缺省 ⇒ 中性默认。 */
    style: StyleSpecSchema.optional(),
  })
  .strict();
export type TagDefinition = z.infer<typeof TagDefinitionSchema>;

/** 投影后交给前端的最终样式：颜色已解析，动画仍是 id（CSS 类名由展示层拼）。 */
export const ResolvedStyleSchema = z
  .object({
    preset: StylePresetIdSchema.optional(),
    color: z.string().optional(),
    background: z.string().optional(),
    bold: z.boolean().optional(),
    animation: StyleAnimationSchema.optional(),
  })
  .strict();
export type ResolvedStyle = z.infer<typeof ResolvedStyleSchema>;

/** 投影后交给前端的标签（样式已解析）。 */
export const ResolvedTagSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    style: ResolvedStyleSchema.optional(),
  })
  .strict();
export type ResolvedTag = z.infer<typeof ResolvedTagSchema>;
