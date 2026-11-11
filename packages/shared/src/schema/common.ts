import { z } from "zod";

/**
 * 协议 V2 公共 Schema：时间量、数值公式 preset、条件与效果 DSL。
 * 所有对象 strict —— 未知字段在加载期即报错（拼写保护）。
 */

// ---------- 时间 ----------

export const TimeUnitSchema = z.enum(["minute", "hour", "day", "week", "month", "year"]);

export const TimeAmountSchema = z
  .object({
    /** 整数分钟标量：value × UNIT_MINUTES[unit] 必须为整数（R-LM-05） */
    value: z.number().int().positive(),
    unit: TimeUnitSchema,
  })
  .strict();

/**
 * TimeSpec（R2.5 / ADR-0011）：所有延时字段（window.start/end、delay、cooldown、timeCost、
 * ChainStep.delay、enqueueEvent.delay）共用的单一时间写法，**默认相对入队时刻**（OQ-#37 裁决）。
 * 本轮只开放 `TimeAmount` 对象形态；字符串字面量语法（复合时长 / 历法日期）按 OQ-#44 与
 * #39/#43 一并排到下一期，`resolveTimeSpec` 已预留 CalendarAdapter.toMinutes seam。
 */
export const TimeSpecSchema = TimeAmountSchema;

// ---------- 人生阶段（模板可配置，替代引擎硬编码阈值） ----------

export const LifeStageSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1).optional(),
    /** 年龄上界（含）；缺省表示该档为最后一档、无上界 */
    maxAge: z.number().int().nonnegative().optional(),
  })
  .strict();

// ---------- 数值公式（preset 白名单，见规格 10.4） ----------

export const FixedFormulaSchema = z
  .object({ preset: z.literal("fixed"), value: z.number() })
  .strict();

export const ScaledFormulaSchema = z
  .object({
    preset: z.literal("scaled"),
    base: z.number(),
    scaleBy: z.string().min(1),
    multiplier: z.number(),
  })
  .strict();

/** 按施放者指定补正的层数缩放：base + stacks(status) * perStack（如漩涡按献祭咒灵数） */
export const StackScaledFormulaSchema = z
  .object({
    preset: z.literal("stack-scaled"),
    base: z.number(),
    perStack: z.number(),
    status: z.string().min(1),
  })
  .strict();

export const FormulaSchema = z.discriminatedUnion("preset", [
  FixedFormulaSchema,
  ScaledFormulaSchema,
  StackScaledFormulaSchema,
]);

// ---------- 对比操作（条件用） ----------

const numOps = {
  eq: z.number().optional(),
  ne: z.number().optional(),
  gte: z.number().optional(),
  lte: z.number().optional(),
  gt: z.number().optional(),
  lt: z.number().optional(),
};

const hasNumOp = (data: Record<string, unknown>): boolean =>
  ["eq", "ne", "gte", "lte", "gt", "lt"].some((k) => data[k] !== undefined);

// ---------- 条件 DSL（数组内 AND） ----------

export const FlagConditionSchema = z
  .object({
    flag: z.string().min(1),
    eq: z.union([z.string(), z.number(), z.boolean()]).optional(),
    ne: z.union([z.string(), z.number(), z.boolean()]).optional(),
    gte: z.number().optional(),
    lte: z.number().optional(),
    gt: z.number().optional(),
    lt: z.number().optional(),
  })
  .strict()
  .refine(hasNumOp, { message: "flag 条件需要至少一个比较操作" });

export const AttributeConditionSchema = z
  .object({ attribute: z.string().min(1), ...numOps })
  .strict()
  .refine(hasNumOp, { message: "attribute 条件需要至少一个比较操作" });

export const StatusConditionSchema = z
  .object({
    status: z.string().min(1),
    present: z.boolean().optional(),
    stacksGte: z.number().int().positive().optional(),
  })
  .strict();

export const InventoryConditionSchema = z
  .object({ inventory: z.string().min(1), gte: z.number().int().nonnegative() })
  .strict();

export const MoodConditionSchema = z
  .object({ mood: z.object({ gte: z.number().optional(), lte: z.number().optional() }).strict() })
  .strict();

export const RelationConditionSchema = z
  .object({ relation: z.string().min(1), gte: z.number().optional(), lte: z.number().optional() })
  .strict();

export const RequiresSkillConditionSchema = z
  .object({ requiresSkill: z.string().min(1) })
  .strict();

export const RandomConditionSchema = z
  .object({ random: z.number().min(0).max(1) })
  .strict();

/** 时间比较条件：以世界起始为 0 点，按 TimeAmount 偏移量比较当前世界时间。 */
export const TimeConditionSchema = z
  .object({
    time: z
      .object({
        gte: TimeAmountSchema.optional(),
        lte: TimeAmountSchema.optional(),
        gt: TimeAmountSchema.optional(),
        lt: TimeAmountSchema.optional(),
      })
      .strict()
      .refine((t) => [t.gte, t.lte, t.gt, t.lt].some((v) => v !== undefined), {
        message: "time 条件需要至少一个比较操作",
      }),
  })
  .strict();

export const ConditionSchema = z.union([
  FlagConditionSchema,
  AttributeConditionSchema,
  StatusConditionSchema,
  InventoryConditionSchema,
  MoodConditionSchema,
  RelationConditionSchema,
  RequiresSkillConditionSchema,
  RandomConditionSchema,
  TimeConditionSchema,
]);

// ---------- 效果 DSL（声明式，引擎白名单实现） ----------

export const EffectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setFlag"), id: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean()]) }).strict(),
  z.object({ type: z.literal("adjustFlag"), id: z.string().min(1), value: z.number() }).strict(),
  z.object({ type: z.literal("clearFlag"), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal("adjustAttribute"), attribute: z.string().min(1), value: z.number() }).strict(),
  z.object({ type: z.literal("adjustResource"), resource: z.enum(["hp", "mp"]), value: z.number() }).strict(),
  z.object({ type: z.literal("adjustMood"), value: z.number() }).strict(),
  z.object({ type: z.literal("adjustRelation"), npcId: z.string().min(1), value: z.number() }).strict(),
  z.object({ type: z.literal("grantItem"), itemId: z.string().min(1), count: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("removeItem"), itemId: z.string().min(1), count: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("applyStatus"), status: z.string().min(1), stacks: z.number().int().positive().optional() }).strict(),
  z.object({ type: z.literal("cureStatus"), status: z.string().min(1) }).strict(),
  z.object({ type: z.literal("unlockSkill"), skillId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("adjustProficiency"), skillId: z.string().min(1), value: z.number() }).strict(),
  z.object({ type: z.literal("adjustGrowth"), value: z.number() }).strict(),
  /** 绝对推进目标（剧情节点），相对世界起始的偏移量；不倒退 */
  z.object({ type: z.literal("advanceTo"), value: TimeAmountSchema }).strict(),
  /** 相对推进量 */
  z.object({ type: z.literal("advanceBy"), value: TimeAmountSchema }).strict(),
  z.object({ type: z.literal("startChain"), chainId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("advanceChain"), chainId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("cancelChain"), chainId: z.string().min(1) }).strict(),
  /** 延时入队的唯一声明式通道（R-EV-08）；delay 缺省 = 相对入队时刻 0 分钟 */
  z
    .object({
      type: z.literal("enqueueEvent"),
      eventId: z.string().min(1),
      delay: TimeSpecSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("log"), text: z.string().min(1), visibility: z.enum(["public", "hidden"]) }).strict(),
]);

export type Condition = z.infer<typeof ConditionSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type Formula = z.infer<typeof FormulaSchema>;
export type TimeAmount = z.infer<typeof TimeAmountSchema>;
/** 本轮 TimeSpec 与 TimeAmount 同形（字符串字面量按 OQ-#44 排到下一期） */
export type TimeSpec = z.infer<typeof TimeSpecSchema>;
