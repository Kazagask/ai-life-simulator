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
 * 稀有度色（10 档，从高到低）：rainbow（动态彩）/ rainbow-static（静态彩）/
 * gold / orange / pink / purple / cyan（青）/ blue / white / gray；
 * 另有正负两档：green（增益）/ red（异常）。
 *
 * 注意：`gray` 一色两用（九品·粗劣与「中性」共用），是刻意的——模板只在需要
 * 「中性」语义时才会显式引用 `neutral` 标签。
 */
export const STYLE_PRESET_IDS = [
  "rainbow",
  "rainbow-static",
  "gold",
  "orange",
  "pink",
  "purple",
  "cyan",
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

/**
 * **引擎预置标签**（ADR-002 D2c，用户 2026-11-18）。
 *
 * 为什么放到内核：品级 / 增益 / 异常这三类是**每一份模板都要用**的词汇，
 * 让每个模板抄一遍 10 行 yaml，只会让「同一个品级在两张卡上不同色」变成常态。
 * 这里给一套默认词表（名称 + 颜色），模板**一行不写**就能用；
 * 想改词（换叫法、换配色）就在自己的 `ui.tags` 里覆盖同名 id，其余继续继承预置。
 *
 * 命名与视觉的对应（品级由高到低）：
 *   mythic-unique 唯一·神话（动态彩）/ mythic 一品·神话（静态彩）/ legend 二品·传说（金）
 *   epic 三品·史诗（橙）/ treasure 四品·珍宝（粉）/ excellent 五品·卓越（紫）
 *   rare 六品·稀有（青）/ fine 七品·精良（蓝）/ common 八品·寻常（白）/ poor 九品·粗劣（灰）
 *   abnormal 异常（红）/ buff 增益（绿）/ neutral 中性（灰）
 */
export const TAG_PRESET_IDS = [
  "mythic-unique",
  "mythic",
  "legend",
  "epic",
  "treasure",
  "excellent",
  "rare",
  "fine",
  "common",
  "poor",
  "abnormal",
  "buff",
  "neutral",
] as const;
export type TagPresetId = (typeof TAG_PRESET_IDS)[number];

/** 预置标签的默认词表；模板 `ui.tags` 里同名 id 覆盖单条。 */
export const DEFAULT_TAGS: Readonly<Record<string, TagDefinition>> = {
  "mythic-unique": { name: "唯一·神话", style: { preset: "rainbow", animation: "rainbow-flow" } },
  mythic: { name: "一品·神话", style: { preset: "rainbow-static" } },
  legend: { name: "二品·传说", style: { preset: "gold" } },
  epic: { name: "三品·史诗", style: { preset: "orange" } },
  treasure: { name: "四品·珍宝", style: { preset: "pink" } },
  excellent: { name: "五品·卓越", style: { preset: "purple" } },
  rare: { name: "六品·稀有", style: { preset: "cyan" } },
  fine: { name: "七品·精良", style: { preset: "blue" } },
  common: { name: "八品·寻常", style: { preset: "white" } },
  poor: { name: "九品·粗劣", style: { preset: "gray" } },
  abnormal: { name: "异常", style: { preset: "red" } },
  buff: { name: "增益", style: { preset: "green" } },
  neutral: { name: "中性", style: { preset: "gray" } },
};

/** 投影后交给前端的标签（样式已解析）。 */
export const ResolvedTagSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    style: ResolvedStyleSchema.optional(),
  })
  .strict();
export type ResolvedTag = z.infer<typeof ResolvedTagSchema>;
