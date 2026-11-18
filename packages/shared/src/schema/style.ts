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

/** 引擎内置预设。新增预设 = 协议变更，需同步 `packages/rpg-ui/src/styles.css` 的类。 */
export const STYLE_PRESET_IDS = [
  "rainbow",
  "gold",
  "silver",
  "bronze",
  "crimson",
  "azure",
  "jade",
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

/** 把颜色 token 解析成可直接写进内联样式的 CSS 值（十六进制原样返回）。 */
export function resolveColorToken(token: ColorToken): string {
  if (token.startsWith("#")) return token;
  return COLOR_TOKEN_TO_VAR[token] ?? token;
}

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
