import { z } from "zod";
import { ConditionSchema } from "./common.js";

/**
 * 终止记录（ADR-0004）：运行 / 已终止二态的唯一终止事实来源。
 * 固化后只读；由 game-core/v2/ending.ts 幂等写入，模板不得声明本记录。
 */

export const TerminationSourceSchema = z.enum([
  "condition",
  "player",
  "battleDefeat",
  "event",
]);

export type TerminationSource = z.infer<typeof TerminationSourceSchema>;

export const TerminationRecordSchema = z
  .object({
    /** 可诊断的终止原因 */
    reason: z.string().min(1),
    /** 终止时的世界时间（分钟标量，取自 WorldStateV2.worldTime） */
    worldTime: z.number(),
    /** 终止时的逻辑轮次（取自 WorldStateV2.turnIndex） */
    turnIndex: z.number().int().nonnegative(),
    /** 命中的结局模板 id（可选） */
    endingId: z.string().min(1).optional(),
    source: TerminationSourceSchema,
  })
  .strict();

export type TerminationRecord = z.infer<typeof TerminationRecordSchema>;

// ---------- 叙事来源（结局叙事与人生总结共用） ----------

/** template=模板文本，llm=已校验的结构化结果，fallback=校验失败/不可用后的模板回退。 */
export const NarrativeSourceSchema = z.enum(["template", "llm", "fallback"]);
export type NarrativeSource = z.infer<typeof NarrativeSourceSchema>;

// ---------- 终止条件（协议 §17） ----------

/** 七类白名单；battleDefeat 由战败信号触发，不由资源数值触发（R-EN-07 / P9）。 */
export const EndingConditionTypeSchema = z.enum([
  "timeReached",
  "characterState",
  "objective",
  "worldState",
  "eventOccurred",
  "playerRequested",
  "battleDefeat",
]);
export type EndingConditionType = z.infer<typeof EndingConditionTypeSchema>;

export const CombinatorSchema = z.enum(["AND", "OR"]);
export type Combinator = z.infer<typeof CombinatorSchema>;

export const TerminationModeSchema = z.enum(["immediate", "afterSettle"]);
export type TerminationMode = z.infer<typeof TerminationModeSchema>;

/**
 * 加载期拒绝任何以 HP 数值 / HP 归零为判据的声明（R-EN-07 / P9 / 协议 §17）。
 * 条件只复用 §12 声明式 DSL；HP 不得作为终止或死亡判据。
 */
function referencesHpAsCriterion(conditions: unknown): boolean {
  const text = JSON.stringify(conditions).toLowerCase();
  return /"hp"|hp\s*(<=|==|lte|eq|lt)\s*0|hp归零|归零/.test(text);
}

export const EndingConditionParamsSchema = z
  .object({
    /** 声明式条件（§12），由 combinator 组合；不接收自由表达式 */
    conditions: z.array(ConditionSchema).default([]),
    /** eventOccurred 专用：需在 firedEvents 中已登记的事件 id */
    eventIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const EndingConditionSchema = z
  .object({
    type: EndingConditionTypeSchema,
    params: EndingConditionParamsSchema.default({ conditions: [] }),
    /** 同一条件内多个声明式条件的组合方式 */
    combinator: CombinatorSchema.default("AND"),
    /** immediate=边界命中即停止；afterSettle=当前事件结算完成后停止（默认） */
    terminationMode: TerminationModeSchema.default("afterSettle"),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (referencesHpAsCriterion(c.params.conditions)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["params", "conditions"],
        message: "拒绝以 HP 数值 / HP 归零为终止判据的条件（R-EN-07 / P9）",
      });
    }
  });

export type EndingCondition = z.infer<typeof EndingConditionSchema>;

// ---------- 结局模板 / 记录 ----------

export const NarrativeConfigSchema = z
  .object({
    source: z.enum(["template", "llm"]).default("template"),
    /** 模板回退文本（source=template 或 LLM 失败时使用） */
    title: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    /** 叙事掩码（ADR-0006）：存在即隐藏结局——命中后 title/summary 按此掩码下发、evidenceIds 置空；文案缺省回退引擎默认掩码 */
    masked: z
      .object({
        title: z.string().min(1).optional(),
        summary: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * 结局模板只负责选择与描述；strict 拒绝任何评分字段（R-EN-05）。
 * 非空 unlockConditions 必须满足才进候选集（任意结局，ADR-0006）；隐藏结局 = narrativeConfig.masked 存在。
 */
export const EndingTemplateSchema = z
  .object({
    endingId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().default(""),
    triggerConditions: z.array(ConditionSchema).default([]),
    priority: z.number().int().default(0),
    endingType: z.string().min(1).default("neutral"),
    narrativeConfig: NarrativeConfigSchema.default({ source: "template" }),
    exclusiveGroup: z.string().min(1).optional(),
    fallback: z.boolean().default(false),
    unlockConditions: z.array(ConditionSchema).default([]),
  })
  .strict();

export type EndingTemplate = z.infer<typeof EndingTemplateSchema>;

/** 本局固化的结局记录（独立类型，不写入 WorldStateV2）。 */
export const EndingRecordSchema = z
  .object({
    endingId: z.string().min(1),
    /** 可在本局 history / 选择记录中解析的事件 id（P6） */
    evidenceIds: z.array(z.string().min(1)),
    title: z.string().min(1),
    summary: z.string(),
    narrativeSource: NarrativeSourceSchema,
  })
  .strict();

export type EndingRecord = z.infer<typeof EndingRecordSchema>;

// ---------- 死亡路径（协议 §17 / §9.3） ----------

export const DeathRouteSchema = z
  .object({
    deathMode: z.enum(["event", "direct"]),
    /** event 路径：复用既有事件定义，不新增 source 枚举 */
    deathEventId: z.string().min(1).optional(),
    conditions: z.array(ConditionSchema).default([]),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.deathMode === "event" && r.deathEventId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deathEventId"],
        message: "deathMode=event 需要 deathEventId 指向既有事件定义",
      });
    }
    if (referencesHpAsCriterion(r.conditions)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conditions"],
        message: "拒绝以 HP 数值 / HP 归零为死亡判据的条件（R-EN-07 / P9）",
      });
    }
  });

export type DeathRoute = z.infer<typeof DeathRouteSchema>;

// ---------- endings.yaml 顶层聚合 ----------

export const EndingConfigSchema = z
  .object({
    terminationConditions: z.array(EndingConditionSchema).default([]),
    endings: z.array(EndingTemplateSchema).default([]),
    deathRoute: DeathRouteSchema.optional(),
    /** 无专属命中时的兜底结局 id（须指向 endings 中已定义的结局） */
    fallback: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const ids = new Set<string>();
    cfg.endings.forEach((e, i) => {
      if (ids.has(e.endingId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endings", i, "endingId"],
          message: `重复 endingId：${e.endingId}`,
        });
      }
      ids.add(e.endingId);
    });
    if (cfg.fallback !== undefined && !ids.has(cfg.fallback)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fallback"],
        message: `fallback 指向未定义结局：${cfg.fallback}`,
      });
    }
  });

export type EndingConfig = z.infer<typeof EndingConfigSchema>;
export type EndingConditionParams = z.infer<typeof EndingConditionParamsSchema>;
export type NarrativeConfig = z.infer<typeof NarrativeConfigSchema>;
