import { z } from "zod";
import { PolaritySchema, StyleSpecSchema, TagDefinitionSchema } from "./style.js";
import { TaskConditionSchema } from "./common.js";

/**
 * `ui.yaml` —— 模板的展示层声明（形状 B：落位）。
 *
 * 边界（specs/SPEC.md §1.5）：
 * - 引擎不读它：判定、结算、投影内容都不受它影响；
 * - 它进白名单但**不进语义指纹**：改一个页签不该让旧存档拒载；
 * - 缺省等于现状：不写文件、或只写几项 ⇒ 其余能力保持当前内建布局。
 *
 * 能力 id 集合分两层：
 * - `BUILTIN_UI_CAPABILITIES` 是宿主内建能力，闭合在本文件（协议）；
 * - 扩展能力 id 由 `ExtensionRuntime.uiCapabilities` 声明，加载期合并校验。
 *   schema 这里只约束 id 非空字符串，未知 id 由服务端结合注册表判定，
 *   这样扩展新增视图不需要改主包 schema。
 */
export const BUILTIN_UI_CAPABILITIES = [
  "life",
  "world",
  "personal",
  "log",
  "records",
  "character",
  "npcList",
  "wheel",
  "battle",
  "event",
  "equipment",
  "inventory",
  "skills",
  "relations",
  "playerRelations",
  "evaluation",
  "ending",
] as const;

export type BuiltinUiCapability = (typeof BUILTIN_UI_CAPABILITIES)[number];

/** `tab` 顶层页签 / `overlay` 按需浮层 / `off` 不渲染常驻入口 / `slot:<hostId>` 嵌进宿主。 */
export const UiPlacementSchema = z.union([
  z.enum(["tab", "overlay", "off"]),
  z
    .string()
    .regex(/^slot:[A-Za-z][A-Za-z0-9_.-]*$/, '落位必须是 tab / overlay / off 或 slot:<hostId>'),
]);

export type UiPlacement = z.infer<typeof UiPlacementSchema>;

// ---------- ADR-076：战斗表现层（四层：施法 / 轨迹 / 受击 / 结算） ----------

/**
 * 引擎**内置**的表现 id（ADR-078）。
 *
 * 内置的只有「**不表达任何世界观**的几何**」：直线箭头、群体扇刃、上升气流、
 * 火花、登场 / 离场 / 消散。凡是带作品辨识度的（某个术式的法阵、某次暴击的雷弧、
 * 某个角色的刀光）都不在这里 —— 它们由模板用下面的 DSL 自己写。
 *
 * 模板可以用**同名 id 覆盖**内置项（`effects.burst: ...`），不需要改引擎。
 */
export const BUILTIN_TRACE_PRESETS = ["arrow", "fan", "updraft", "none"] as const;
export const BUILTIN_IMPACT_PRESETS = ["burst", "arrive", "depart", "dissolve", "none"] as const;
/** 施法层不内置任何样式：`none` 之外一律由模板提供。 */
export const BUILTIN_CAST_PRESETS = ["none"] as const;

/** 轨迹 / 受击的 preset 是**开放 id**：先查 `presentation.effects`，再查内置。 */
export const TracePresetSchema = z.string().min(1);
export type TracePreset = z.infer<typeof TracePresetSchema>;
export const ImpactPresetSchema = z.string().min(1);
export type ImpactPreset = z.infer<typeof ImpactPresetSchema>;

// ---------- 表现 DSL（ADR-078）：模板写的「积木」----------

/**
 * 锚点：所有图元都相对某个**卡片**画，不写绝对坐标。
 *
 * - `self` / `hand` / `ground`：施法者卡片（中心 / 手边 / 脚下）
 * - `target` / `targetGround`：目标卡片（中心 / 脚下）
 * - `mid`：起手点与目标点之间（只对轨迹有意义）
 * - `board`：整个战场（遮幅用）
 */
export const FX_ANCHORS = ["self", "hand", "ground", "target", "targetGround", "mid", "board"] as const;
export const FxAnchorSchema = z.enum(FX_ANCHORS);
export type FxAnchorName = z.infer<typeof FxAnchorSchema>;

/**
 * 颜色渐变：1–3 个色标。
 *
 * - 1 色 = 单色（等同不写 `gradient`）
 * - 2 色 = `[尾, 头]`
 * - 3 色 = `[尾, 亮核, 头]` —— 中间那道才是「像光」的关键：纯色圆看着像贴纸。
 *
 * **方向由图元自己决定**（环沿直径、柱沿高度、球与光晕沿半径、扇形沿半径），
 * 模板不写角度：写角度等于把排版搬进 yaml，换个分辨率就歪。
 */
const fxFradient = z.array(z.string().min(1)).min(1).max(3).optional();

/** 每个图元都有的参数。颜色缺省 = 这一层的语义色（施法色 / 轨迹色 / 伤害色）。 */
const layerBase = {
  at: FxAnchorSchema.optional(),
  /** 相对锚点的偏移（px）：对撞的两颗球、偏离中心的光柱都靠它 */
  offset: z.tuple([z.number(), z.number()]).optional(),
  delayMs: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().positive().optional(),
  color: z.string().min(1).optional(),
  opacity: z.number().min(0).max(1).optional(),
  /**
   * 整层**几何**旋转圈数（1 = 转一整圈，负值反向）。
   *
   * 和 `ring.spin` 不是一回事：`spin` 只让虚线流动（`stroke-dashoffset`），
   * `turns` 转的是三角 / 扇形 / 刻度这些真正的形状 —— 召唤法阵的「转起来」用它。
   */
  turns: z.number().min(-10).max(10).optional(),
};

const ring = z
  .object({
    shape: z.literal("ring"),
    r: z.number().positive(),
    /** 压扁成椭圆（≈0.32 就是「地上的圈」）；不写 = 正圆 */
    ry: z.number().positive().optional(),
    width: z.number().positive().optional(),
    /** 虚线（实长 / 空长）；写了就按这个节奏转 */
    dash: z.tuple([z.number().positive(), z.number().positive()]).optional(),
    /** 虚线流动方向：1 顺 / -1 逆 */
    spin: z.union([z.literal(1), z.literal(-1)]).optional(),
    /** 描边渐变（沿直径）；不写 = 单色 */
    gradient: fxFradient,
    ...layerBase,
  })
  .strict();

const pool = z
  .object({
    shape: z.literal("pool"),
    rx: z.number().positive(),
    ry: z.number().positive().optional(),
    blur: z.number().nonnegative().optional(),
    /** 径向渐变（跟着椭圆压扁）；不写 = 单色 */
    gradient: fxFradient,
    ...layerBase,
  })
  .strict();

const pillar = z
  .object({
    shape: z.literal("pillar"),
    w: z.number().positive(),
    h: z.number().positive(),
    blur: z.number().nonnegative().optional(),
    /** true = 从锚点向上长；false = 以锚点为中心 */
    rise: z.boolean().optional(),
    /** 底部到顶部的渐变（底亮顶散）；不写 = 单色 */
    gradient: fxFradient,
    /** 亮芯占宽度的比例（缺省 0.34，写 0 = 只有柔光没有芯） */
    core: z.number().min(0).max(1).optional(),
    ...layerBase,
  })
  .strict();

const rays = z
  .object({
    shape: z.literal("rays"),
    count: z.number().int().positive(),
    inner: z.number().nonnegative(),
    outer: z.number().positive(),
    width: z.number().positive().optional(),
    /** 逐根延迟（i × stagger） */
    stagger: z.number().nonnegative().optional(),
    /** 起始角（弧度，缺省 -π/2 = 正上方起） */
    from: z.number().optional(),
    /** 内端到外端的渐变；不写 = 单色 */
    gradient: fxFradient,
    /** 亮度方向：`out` 外亮内虚（发射，缺省）/ `in` 内亮外虚（命中炸开） */
    fade: z.enum(["in", "out"]).optional(),
    ...layerBase,
  })
  .strict();

const motes = z
  .object({
    shape: z.literal("motes"),
    count: z.number().int().positive(),
    radius: z.number().positive(),
    /** in = 向心收；out = 离心散 */
    dir: z.enum(["in", "out"]),
    size: z.number().positive().optional(),
    ...layerBase,
  })
  .strict();

const sparks = z
  .object({ shape: z.literal("sparks"), count: z.number().int().positive(), ...layerBase })
  .strict();

const bolt = z
  .object({
    shape: z.literal("bolt"),
    count: z.number().int().positive(),
    lenMin: z.number().positive(),
    lenMax: z.number().positive(),
    segments: z.number().int().min(2).optional(),
    width: z.number().positive().optional(),
    /** 渐变 [尾, 头]；只写一个 = 尾部固定、头部跟随语义色 */
    gradient: fxFradient,
    /** 方向跨度（弧度）：缺省 -2.5..2.6 的固定六个方向 */
    spread: z.number().positive().optional(),
    ...layerBase,
  })
  .strict();

const orb = z
  .object({
    shape: z.literal("orb"),
    r: z.number().positive(),
    /** 位移终点（相对锚点，px）：写到就「飞过去」 */
    to: z.tuple([z.number(), z.number()]).optional(),
    /** 位移占整层的比例（0..1，缺省 0.42） */
    travel: z.number().min(0).max(1).optional(),
    /** 径向渐变（白核 → 本色 → 暗边）；不写 = 单色 */
    gradient: fxFradient,
    ...layerBase,
  })
  .strict();

const arc = z
  .object({
    shape: z.literal("arc"),
    /** 控制点相对中点的偏移（px） */
    bow: z.tuple([z.number(), z.number()]).optional(),
    profile: z.enum(["comet", "blade", "line", "fan"]).optional(),
    /** 虚线（只对 profile: line 有意义）；不写 = 实线 */
    dash: z.tuple([z.number().positive(), z.number().positive()]).optional(),
    /** 尾部到头部渐变 [尾, 头]；只写一个 = 头部跟随语义色（技能色 / 伤害色） */
    gradient: fxFradient,
    width: z.number().positive().optional(),
    core: z.boolean().optional(),
    /** 芯线的颜色（缺省白）。「红黑刃」这类要把芯压暗，白芯会变成果冻 */
    coreColor: z.string().min(1).optional(),
    head: z.enum(["chevron", "diamond", "none"]).optional(),
    ...layerBase,
  })
  .strict();

const cuts = z
  .object({
    shape: z.literal("cuts"),
    count: z.number().int().positive(),
    /** 每道占卡片宽度的比例（缺省 0.28） */
    length: z.number().positive().optional(),
    width: z.number().positive().optional(),
    /** 逐道延迟 */
    stagger: z.number().nonnegative().optional(),
    ...layerBase,
  })
  .strict();

const hexagon = z
  .object({ shape: z.literal("hexagon"), r: z.number().positive(), gradient: fxFradient, ...layerBase })
  .strict();

const flash = z
  .object({
    shape: z.literal("flash"),
    radius: z.number().positive(),
    /** 中心不透明度（缺省 0.5） */
    alpha: z.number().min(0).max(1).optional(),
    ...layerBase,
  })
  .strict();

const bars = z
  .object({ shape: z.literal("bars"), h: z.number().positive(), ...layerBase })
  .strict();

const diamond = z
  .object({ shape: z.literal("diamond"), size: z.number().positive(), gradient: fxFradient, ...layerBase })
  .strict();

/**
 * 正多边形（3 = 三角，6 = 六芒的一半）。
 *
 * 法阵里那些**内接三角**就是它：`sides: 3, r: 34, turns: 0.35` 一转起来，
 * 整个圆盘立刻从「一个圈」变成「一台机器」（设计稿里的召唤阵就是这么来的）。
 */
const polygon = z
  .object({
    shape: z.literal("polygon"),
    sides: z.number().int().min(3).max(12),
    r: z.number().positive(),
    /** 起始角（弧度，缺省 -π/2 = 一个顶点朝上） */
    from: z.number().optional(),
    width: z.number().positive().optional(),
    dash: z.tuple([z.number().positive(), z.number().positive()]).optional(),
    gradient: fxFradient,
    ...layerBase,
  })
  .strict();

/**
 * 扇形光束（旋转过场）。
 *
 * 召唤落地的那一刻，设计稿是**一道扇形光扫过去**：孔径 `arc`、内外半径都要写，
 * `turns` 让它边转边亮。`mirror: true` 在对侧再来一片，双翼扫光就有了。
 */
const fan = z
  .object({
    shape: z.literal("fan"),
    /** 内半径：> 0 是中空扇形（光环扫过），0 = 实心扇 */
    inner: z.number().nonnegative().optional(),
    outer: z.number().positive(),
    /** 张角（弧度，缺省 π/3 = 60°） */
    arc: z.number().positive().max(Math.PI * 2).optional(),
    /** 起始角（缺省 -π/2 = 正上方） */
    from: z.number().optional(),
    /** 对侧再来一片（相隔 180°） */
    mirror: z.boolean().optional(),
    /** 径向渐变（内亮外散）；不写 = 单色 */
    gradient: fxFradient,
    blur: z.number().nonnegative().optional(),
    ...layerBase,
  })
  .strict();

/**
 * 铁栅栏：上下横梁 + 一排竖条，逐根落下。
 *
 * 收灵 / 拘束类受击用它 —— 这不是「打一下」，是「把东西关起来」。
 */
const cage = z
  .object({
    shape: z.literal("cage"),
    w: z.number().positive(),
    h: z.number().positive(),
    /** true = `w` / `h` 是**卡片宽 / 高的比例**（0–1），不是像素 */
    fit: z.boolean().optional(),
    count: z.number().int().min(2).max(16),
    width: z.number().positive().optional(),
    /** 逐根落下的间隔（ms） */
    stagger: z.number().nonnegative().optional(),
    gradient: fxFradient,
    ...layerBase,
  })
  .strict();

/**
 * 光晕：一团没有边缘的柔光。
 *
 * 和 `flash` 的分工：`flash` 是**整块屏幕**的闪（受「关闭闪光」约束），
 * `glow` 是**局部**的辉光（不闪屏，只是亮），用来托住球 / 法阵 / 道具。
 */
const glow = z
  .object({
    shape: z.literal("glow"),
    r: z.number().positive(),
    /** 额外模糊（px）；纯靠渐变已经足够柔时可以不写 */
    blur: z.number().nonnegative().optional(),
    gradient: fxFradient,
    ...layerBase,
  })
  .strict();

export const FxPrimitiveSchema = z.discriminatedUnion("shape", [
  ring, pool, pillar, rays, motes, sparks, bolt, orb, arc, cuts, hexagon,
  flash, bars, diamond, polygon, fan, glow, cage,
]);
export type FxPrimitive = z.infer<typeof FxPrimitiveSchema>;

/**
 * 一段表现（施法 / 轨迹 / 受击）的完整定义。
 *
 * `layers` 按声明顺序画；每层自带 `delayMs`，所以「先对撞、再出核」这种两拍
 * 不需要额外的相位概念 —— 时间就是延迟。
 */
export const FxEffectSchema = z
  .object({
    /** 自检用：声明它属于哪一层（引用处不匹配时加载期报错） */
    kind: z.enum(["cast", "trace", "impact"]).optional(),
    durationMs: z.number().int().positive().optional(),
    color: z.string().min(1).optional(),
    layers: z.array(FxPrimitiveSchema).min(1),
  })
  .strict();
export type FxEffect = z.infer<typeof FxEffectSchema>;

/**
 * 一层特效的参数。`preset` 缺省 = 不覆盖（继承上一层）。
 *
 * 注意 `cast` 的 preset **不是闭集**：施法不进引擎，id 由模板或扩展提供，
 * 引擎只负责透传（ADR-076 §3.0「归属」）。
 */
export const FxLayerSchema = z
  .object({
    preset: z.string().min(1).optional(),
    color: z.string().min(1).optional(),
    width: z.number().positive().optional(),
    durationMs: z.number().int().positive().optional(),
  })
  .strict();
export type FxLayer = z.infer<typeof FxLayerSchema>;

/** 结算层：只改「怎么显示」，改不了数值与符号（ADR-076 §5）。 */
export const FxResultSchema = z
  .object({
    sizePx: z.number().positive().optional(),
    strokePx: z.number().nonnegative().optional(),
    color: z.string().min(1).optional(),
    /** 后缀阶梯的文本（模板词）：`critTier2` 是「被钩子放大的暴击」 */
    suffix: z
      .object({ crit: z.string().optional(), critTier2: z.string().optional() })
      .strict()
      .optional(),
    /** 双语标签：主文本 + 拉丁副标题（ADR-076 §7）。文本由模板给，内核不写死 */
    label: z
      .object({ text: z.string().min(1).optional(), latin: z.string().min(1).optional() })
      .strict()
      .optional(),
    /** 普通暴击的标签（如 CRITICAL）；放大暴击会用 `label` + 这一个，两条并出 */
    critLabel: z
      .object({ text: z.string().min(1).optional(), latin: z.string().min(1).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type FxResult = z.infer<typeof FxResultSchema>;

/** 一次覆盖：四层各自可选，只写要改的那一层。 */
export const FxOverrideSchema = z
  .object({
    cast: FxLayerSchema.optional(),
    trace: FxLayerSchema.extend({ preset: TracePresetSchema.optional() }).strict().optional(),
    impact: FxLayerSchema.extend({ preset: ImpactPresetSchema.optional() }).strict().optional(),
    result: FxResultSchema.optional(),
  })
  .strict();
export type FxOverride = z.infer<typeof FxOverrideSchema>;

/**
 * 人物皮肤（2026-11-24 · 迭代 character-media）。
 *
 * 一个皮肤就是「同一个人的一套静态素材」：头像 / 半身 / 全身，外加（V1.1 才消费的）演出立绘。
 * 除 `name` 外全部可选 —— 缺哪个槽位就按 `avatar → bust → full` 回退（`design.md §4.1`）。
 *
 * **不进语义指纹**（`ui.yaml` 整体已被排除）：改一张图不该让旧存档拒载。
 */
export const SkinSchema = z
  .object({
    /** 展示名（如「高专时期」），出现在皮肤选择与调试面板。 */
    name: z.string().min(1),
    /** 头像（方图）。 */
    avatar: z.string().min(1).optional(),
    /** 半身立绘。 */
    bust: z.string().min(1).optional(),
    /** 全身立绘。 */
    full: z.string().min(1).optional(),
    /** 通用演出立绘（V1.1 消费；V1.0 只登记）。 */
    cutIn: z.string().min(1).optional(),
    /** 技能专属演出立绘（V1.1 消费）：skillId → assetId。专属**优先于**通用 `cutIn`。 */
    skillCutIns: z.record(z.string().min(1), z.string().min(1)).optional(),
  })
  .strict();
export type Skin = z.infer<typeof SkinSchema>;

/**
 * 自动换皮肤的一条规则：`when` 成立就用 `skin`。
 *
 * 条件**只用全局子集**（时间 / flag / 全局事件事实）—— 白名单在 `template-loader` 里执行，
 * 因为 `Condition` 的类型在这里是全集的，按人物求值的上下文 V1 并不存在（`design.md §5.3`）。
 */
export const SkinRuleSchema = z
  .object({
    skin: z.string().min(1),
    when: z.array(TaskConditionSchema),
  })
  .strict();
export type SkinRule = z.infer<typeof SkinRuleSchema>;

/**
 * 一个人物的媒体配置：皮肤集合 + 默认皮肤 + 自动规则。
 *
 * 优先级：实例 `skinId` → 首个命中的 `skinRules` → `defaultSkin` → 占位符。
 * 没有配置的人物保持现有展示行为（文字头像）。
 */
export const CharacterMediaSchema = z
  .object({
    defaultSkin: z.string().min(1),
    skins: z.record(z.string().min(1), SkinSchema),
    /** 按声明顺序匹配，**首个**命中生效；不引入优先级字段。 */
    skinRules: z.array(SkinRuleSchema).optional(),
  })
  .strict()
  .superRefine((media, ctx) => {
    if (media.skins[media.defaultSkin] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultSkin"],
        message: `defaultSkin「${media.defaultSkin}」不在 skins 里`,
      });
    }
    (media.skinRules ?? []).forEach((rule, i) => {
      if (media.skins[rule.skin] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["skinRules", i, "skin"],
          message: `skinRules[${i}] 指向未定义的皮肤「${rule.skin}」`,
        });
      }
    });
  });
export type CharacterMedia = z.infer<typeof CharacterMediaSchema>;

/**
 * `ui.presentation`：P0 默认之上的覆盖表（ADR-076 §1）。
 *
 * 键是语义 id（角色 / 技能 / 钩子 / 事件），由加载期校验存在性；
 * 引用不存在的 id 直接拒载（ADR-002 D2 的既有口径，不静默回退）。
 */
export const FxPresentationSchema = z
  .object({
    /**
     * 模板自定义的表现（ADR-078）：id → 积木列表。
     * 技能 / 钩子 / 默认层用 `preset: <id>` 引用；与内置同名即覆盖内置。
     */
    effects: z.record(z.string().min(1), FxEffectSchema).optional(),
    defaults: FxOverrideSchema.optional(),
    units: z.record(z.string().min(1), FxOverrideSchema).optional(),
    skills: z.record(z.string().min(1), FxOverrideSchema).optional(),
    hooks: z.record(z.string().min(1), FxOverrideSchema).optional(),
    events: z.record(z.string().min(1), FxOverrideSchema).optional(),
  })
  .strict()
  .superRefine((fx, ctx) => {
    /**
     * 引用校验：`preset` 要么是内置 id，要么在本文件的 `effects` 里定义过。
     * 未知 id **加载期拒载**（ADR-002 D2 的既有口径），不静默变成一个空特效。
     */
    const defined = new Set(Object.keys(fx.effects ?? {}));
    const ok = (id: string, builtin: readonly string[]): boolean => builtin.includes(id) || defined.has(id);
    const check = (where: string, id: string | undefined, kind: "cast" | "trace" | "impact"): void => {
      if (id === undefined) return;
      const builtin =
        kind === "cast" ? BUILTIN_CAST_PRESETS : kind === "trace" ? BUILTIN_TRACE_PRESETS : BUILTIN_IMPACT_PRESETS;
      if (ok(id, builtin)) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [where, kind, "preset"],
        message: `未定义的表现 ${id}：请写进 presentation.effects，或改用内置（${builtin.join(" / ")}）`,
      });
    };
    const tables: Array<[string, FxOverride | undefined]> = [
      ["defaults", fx.defaults],
      ...Object.entries(fx.units ?? {}).map(([k, v]): [string, FxOverride] => [`units.${k}`, v]),
      ...Object.entries(fx.skills ?? {}).map(([k, v]): [string, FxOverride] => [`skills.${k}`, v]),
      ...Object.entries(fx.hooks ?? {}).map(([k, v]): [string, FxOverride] => [`hooks.${k}`, v]),
      ...Object.entries(fx.events ?? {}).map(([k, v]): [string, FxOverride] => [`events.${k}`, v]),
    ];
    for (const [where, layer] of tables) {
      if (layer === undefined) continue;
      check(where, layer.cast?.preset, "cast");
      check(where, layer.trace?.preset, "trace");
      check(where, layer.impact?.preset, "impact");
    }
  });
export type FxPresentation = z.infer<typeof FxPresentationSchema>;

export const UiConfigSchema = z
  .object({
    place: z.record(z.string().min(1), UiPlacementSchema).optional(),
    /**
     * 模板自定义样式（ADR-002 D2）：id → spec。id 同时可被实体的 `style` 引用。
     * 也能覆盖同名预设（如 `rainbow: { preset: rainbow, bold: true }`）。
     */
    styles: z.record(z.string().min(1), StyleSpecSchema).optional(),
    /**
     * 品质 → 样式 id（ADR-002 D3 的展示侧）：实体未自声明 `style` 时按 quality 查这里。
     * 值可以是 `styles` 的键，也可以是引擎预设 id。
     */
    qualityStyles: z.record(z.string().min(1), z.string().min(1)).optional(),
    /**
     * 正负零 → 样式 id（与 `quality` 独立）：缺省用引擎内置
     * positive→green / negative→red / neutral→gray。
     */
    polarityStyles: z.record(PolaritySchema, z.string().min(1)).optional(),
    /**
     * 资源条的渲染形态（ADR-003 D10）：**只做展示**，不进语义指纹。
     * 键必须是 world.yaml `resources` 里已声明的资源；缺省 `display: bar`、
     * hp/mp 的 `dangerAt` 缺省 0.25，自定义资源缺省 0（永不告警）。
     */
    resources: z
      .record(
        z.string().min(1),
        z
          .object({
            display: z.enum(["bar", "pips"]).optional(),
            /** 告警阈值比例（0..1）：value/max ≤ dangerAt 时标红；0 = 永不告警。 */
            dangerAt: z.number().min(0).max(1).optional(),
          })
          .strict(),
      )
      .optional(),
    /**
     * 人生页人物卡展示哪些属性（2026-11-19 用户裁决）。
     *
     * 只影响顶部那张常驻卡；个人页仍然展示全部（`player.attributeViews`）。
     * 顺序即展示顺序：数值 / 枚举 / 复合排成三列，`ladder` 单独占一整行（带进度条）。
     * 键必须是 `world.yaml attributes.order` 里声明过的属性；缺省 = 全部可见属性。
     */
    playerCard: z
      .object({
        attributes: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    /**
     * 标签（ADR-002 D2b）：id → `{ name, style }`。
     * 状态 / 装备用 `tags: [id...]` 引用；未知 id 在加载期拒载（不静默丢弃）。
     */
    tags: z.record(z.string().min(1), TagDefinitionSchema).optional(),
    /**
     * 战斗表现层覆盖（ADR-076）。只影响「怎么演」，不进语义指纹 ——
     * 改一个颜色不该让旧存档 `template_content_drift`。
     */
    presentation: FxPresentationSchema.optional(),
    /**
     * 人物媒体（2026-11-24）：`characterId → { defaultSkin, skins, skinRules? }`。
     *
     * 只影响展示；不配的人物保持现状（文字头像）。资源配置缺失不阻塞游戏。
     */
    characterMedia: z.record(z.string().min(1), CharacterMediaSchema).optional(),
  })
  .strict();

export type UiConfig = z.infer<typeof UiConfigSchema>;

/** 导出为常量，resource 与 UI 共用：hp/mp 未写 `dangerAt` 时的默认告警阈值。 */
export const DEFAULT_RESOURCE_DANGER_RATIO = 0.25;

/** 刻度 / 条形资源条展示的默认形态（自定义资源缺省也是 bar）。 */
export const DEFAULT_RESOURCE_DISPLAY = "bar" as const;

/**
 * 当前内建布局，作为 `ui.yaml` 缺省项的落位。
 * 这不是"推荐配置"，只是把现有前端分布翻译成 place 语言，保证零回归。
 */
export const DEFAULT_UI_PLACEMENTS: Readonly<Record<string, UiPlacement>> = {
  life: "tab",
  world: "tab",
  personal: "tab",
  log: "tab",
  records: "tab",
  character: "slot:personal",
  npcList: "tab",
  wheel: "overlay",
  battle: "overlay",
  event: "overlay",
  equipment: "slot:personal",
  inventory: "slot:personal",
  skills: "slot:personal",
  relations: "slot:npcList",
  /** 玩家自己的关系图（个人页子页签）。与 `relations`（NPC 卡上的关系行）是两个面。 */
  playerRelations: "slot:personal",
  evaluation: "slot:personal",
  ending: "slot:life",
};

/**
 * 解析某项能力的最终落位：声明优先，没声明就回落现状。
 * 前端还要再做一次"宿主认不认这个槽"的降级（认不出 ⇒ 退化为 tab）。
 */
export function uiPlacementOf(ui: UiConfig | undefined, capability: string): UiPlacement {
  return ui?.place?.[capability] ?? DEFAULT_UI_PLACEMENTS[capability] ?? "tab";
}
