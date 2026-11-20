import { z } from "zod";
import { ResolvedStyleSchema, ResolvedTagSchema, type ResolvedStyle, type ResolvedTag } from "./style.js";

/**
 * 表现层数据（ADR-002 D3 / D4）：**只读投影**，不参与判定、不进 `WorldStateV2`。
 *
 * 放在 `schema/` 而不是 `contract/`，是因为内核快照（`V2Snapshot`）与前端契约
 * （`view-model.ts`）都要用同一份形状；两处各写一份必然漂移。
 */

/**
 * 一条展示用效果。**由定义派生**（`presentation/effects.ts`），不是结算结果。
 *
 * `kind` 决定渲染：
 * - `control` ⇒ 固定效果（下划线，如「无法行动」）；
 * - `attr` / `combat` / `cost` / `formula` ⇒ 数值或公式条目（可带 +/- 与色彩）；
 * - `apply` / `remove` ⇒ 施加 / 移除状态（可点开状态详情）；
 * - `note` ⇒ 说明性文字。
 */
/** 被引用实体的详情快照（递归结构，见 `EffectSummary`）。 */
export interface EffectRefDetail {
  title: string;
  description?: string;
  effects?: EffectSummary[];
  durationLabel?: string;
  style?: ResolvedStyle;
  /** 被引用实体的标签（品级 / 增益减益）。 */
  tags?: ResolvedTag[];
  /** 状态的正负（只有 `kind: "status"` 的引用有）：技能描述里的名字颜色读它。 */
  polarity?: "positive" | "negative" | "neutral";
}

export interface EffectSummary {
  /** 完整句子（无障碍 / 复制用）。有引用时 = `lead + refName + trail`。 */
  text: string;
  /**
   * 引用条目的三段式（2026-11-20）：UI **只给 `refName` 上样式**，
   * 不再自己按 `refDetail.title` 在 `text` 里做字符串切分 —— 文案一改就退化。
   * 无引用时三者缺省，`text` 就是整句。
   */
  lead?: string;
  refName?: string;
  trail?: string;
  kind: "attr" | "combat" | "control" | "apply" | "remove" | "cost" | "formula" | "note";
  tone?: "buff" | "debuff" | "neutral";
  note?: string;
  ref?: { kind: "status" | "item" | "skill"; id: string };
  refDetail?: EffectRefDetail;
}

// 自引用（refDetail.effects 里还是 EffectSummary）⇒ 必须显式标注类型 + z.lazy。
export const EffectSummarySchema: z.ZodType<EffectSummary> = z
  .object({
    text: z.string(),
    lead: z.string().optional(),
    refName: z.string().optional(),
    trail: z.string().optional(),
    kind: z.enum(["attr", "combat", "control", "apply", "remove", "cost", "formula", "note"]),
    tone: z.enum(["buff", "debuff", "neutral"]).optional(),
    note: z.string().optional(),
    ref: z.object({ kind: z.enum(["status", "item", "skill"]), id: z.string() }).strict().optional(),
    refDetail: z
      .object({
        title: z.string(),
        description: z.string().optional(),
        effects: z.array(z.lazy(() => EffectSummarySchema)).optional(),
        durationLabel: z.string().optional(),
        style: ResolvedStyleSchema.optional(),
        tags: z.array(ResolvedTagSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict() as z.ZodType<EffectSummary>;

/**
 * 一回合里的一条收获（ADR-002 D4）。
 *
 * `action` 与 `amount` 一起读：
 * - 属性：`up` / `down` + 净值；
 * - 物品：`gain` / `lose` + 数量；
 * - 状态：`gain` / `lose` + 最终层数 `stacks`；
 * - 装备：`equip` / `unequip`；
 * - 技能：`gain`。
 */
export const TurnGainSchema = z
  .object({
    category: z.enum(["attribute", "status", "skill", "item", "equipment"]),
    /**
     * `set` = 初始值（开局定的绝对属性，不是增减），展示为 `力量 126` 且用中性色。
     * 其余：属性 up/down、物品 gain/lose、状态 gain/lose、装备 equip/unequip、技能 gain。
     */
    action: z.enum(["gain", "lose", "up", "down", "set", "equip", "unequip"]),
    /** 属性 key / statusId / skillId / itemId / 装备 instanceId。 */
    id: z.string(),
    /** 展示名（已按模板标签解析）。 */
    name: z.string(),
    amount: z.number().optional(),
    /**
     * 文本属性的展示值（ADR-003）：enum 的选项 label / composite 的称号 / reset 阶梯的档位。
     * 与 `amount` 互斥使用（数值属性用 amount，文本属性用 value）。
     */
    value: z.string().optional(),
    stacks: z.number().optional(),
    quality: z.string().optional(),
    style: ResolvedStyleSchema.optional(),
    /** 展示标签（ADR-002 D2b）：品级 / 增益减益，带自己的样式。 */
    tags: z.array(ResolvedTagSchema).optional(),
    /**
     * 详情快照（追加）：让收获条目**自带**打开详情所需的一切。
     * 没有它，开局面板 / 刷新后的列表都得回头去快照里查实体，查不到就成了「点了没反应」。
     */
    description: z.string().optional(),
    effects: z.array(EffectSummarySchema).optional(),
    durationLabel: z.string().optional(),
  })
  .strict();
export type TurnGain = z.infer<typeof TurnGainSchema>;

/** 五个写操作响应里统一追加的字段名（服务端与前端共用同一常量，避免拼错）。 */
export const TURN_GAINS_FIELD = "gains" as const;
