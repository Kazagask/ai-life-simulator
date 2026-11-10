import { z } from "zod";
import { ConditionSchema, EffectSchema, TimeAmountSchema } from "./common.js";
import { EventInstanceSchema } from "./event-instance.js";

/**
 * 开局分域 Schema（协议 V2.1 §16）。全部 strict；类型经 z.infer 派生。
 * 条件 / 效果只引用既有声明式 DSL（§12），不接受任何自由表达式。
 */

const CountRangeSchema = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([lo, hi]) => lo <= hi, { message: "countRange 下界不得大于上界" });

/** steps[].kind 白名单：必经 / 可选 / 分支。 */
export const OpeningStepSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["required", "optional", "branch"]),
    ref: z.string().min(1).optional(),
  })
  .strict();

/**
 * 事件池内单个事件。抽取字段（§16）：
 * tags / weight / conditions / required / countRange / exclusiveGroup /
 * sequence / seed / effects / nextEvents，全部声明式。
 */
export const OpeningPoolEventSchema = z
  .object({
    id: z.string().min(1),
    tags: z.array(z.string().min(1)).optional(),
    weight: z.number().nonnegative().optional(),
    conditions: z.array(ConditionSchema).optional(),
    required: z.boolean().optional(),
    countRange: CountRangeSchema.optional(),
    exclusiveGroup: z.string().min(1).optional(),
    sequence: z.number().int().nonnegative().optional(),
    seed: z.number().int().optional(),
    effects: z.array(EffectSchema).optional(),
    nextEvents: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const OpeningEventPoolSchema = z
  .object({
    id: z.string().min(1),
    /** 本次抽取启用的标签；事件 tags 与之匹配（或事件无 tags 视为通用）才入选 */
    tags: z.array(z.string().min(1)).optional(),
    countRange: CountRangeSchema.optional(),
    exclusiveGroup: z.string().min(1).optional(),
    sequence: z.number().int().nonnegative().optional(),
    seed: z.number().int().optional(),
    events: z.array(OpeningPoolEventSchema).min(1),
  })
  .strict();

/** 通用初始化块：用既有声明式效果 DSL 与世界 flag 表达，不硬编码世界观内容。 */
export const OpeningSetupSchema = z
  .object({
    effects: z.array(EffectSchema).optional(),
    flags: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();

/** 初始关系必须带 source（R-OP-05）；未声明关系的 NPC 由引擎置 unknown 且不建关系条目。 */
export const OpeningRelationSchema = z
  .object({
    npcId: z.string().min(1),
    value: z.number().min(-100).max(100),
    source: z.string().min(1),
  })
  .strict();

export const OpeningNpcSetupSchema = z
  .object({
    relations: z.array(OpeningRelationSchema).optional(),
    /** 信息权限分级：npcId -> 可见性档位 */
    visibility: z.record(z.string(), z.enum(["known", "inferred", "unknown", "hidden"])).optional(),
  })
  .strict();

/** 未来/条件事件去向：引用 events.yaml 中既有 source: schedule 定义。 */
export const OpeningScheduledEventSchema = z
  .object({
    eventId: z.string().min(1),
    at: TimeAmountSchema.optional(),
    conditions: z.array(ConditionSchema).optional(),
  })
  .strict();

export const OpeningHandoffSchema = z
  .object({
    /** 未完成即时事件 eventId（→ 现有 pendingEvents / chains） */
    pendingEvents: z.array(z.string().min(1)),
    /** 未来/条件事件（→ 现有 schedule） */
    schedule: z.array(OpeningScheduledEventSchema),
  })
  .strict();

export const OpeningTemplateSchema = z
  .object({
    openingId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    entryConditions: z.array(ConditionSchema),
    steps: z.array(OpeningStepSchema),
    characterSetup: OpeningSetupSchema,
    worldSetup: OpeningSetupSchema,
    npcSetup: OpeningNpcSetupSchema,
    eventPools: z.array(OpeningEventPoolSchema),
    objectives: OpeningSetupSchema,
    choices: OpeningSetupSchema,
    completionConditions: z.array(ConditionSchema).min(1),
    handoff: OpeningHandoffSchema,
  })
  .strict()
  .superRefine((tpl, ctx) => {
    // 同一模板内 steps / eventPools 的 id 不得重复；openingId 全库唯一由加载器校验。
    const stepIds = new Set<string>();
    tpl.steps.forEach((s, i) => {
      if (stepIds.has(s.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", i, "id"], message: `重复步骤 id：${s.id}` });
      }
      stepIds.add(s.id);
    });
    const poolIds = new Set<string>();
    tpl.eventPools.forEach((p, i) => {
      if (poolIds.has(p.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["eventPools", i, "id"], message: `重复事件池 id：${p.id}` });
      }
      poolIds.add(p.id);
    });
  });

/**
 * 开局运行记录（design §5）。handoff 据此把事件分流到现有队列。
 * 运行时由引擎构造（非 YAML 加载），但仍给出 strict schema 以约束交接数据。
 */
export const OpeningRunSchema = z
  .object({
    openingId: z.string().min(1),
    executedSteps: z.array(z.string().min(1)),
    choiceRecords: z.array(
      z.object({ stepId: z.string().min(1), choiceId: z.string().min(1) }).strict(),
    ),
    seed: z.number().int(),
    startedAt: z.number(),
    completedAt: z.number(),
    /** completionConditions 是否满足；handoff 仅在此为 true 时交接 */
    completed: z.boolean(),
    /** 抽取 / 声明的开局事件实例（含 origin 元数据） */
    instances: z.array(EventInstanceSchema),
    /** 未完成即时事件：eventId + 可选归属链 */
    pendingEvents: z.array(
      z.object({ eventId: z.string().min(1), chainId: z.string().min(1).optional() }).strict(),
    ),
    /** 未来/条件事件：引用既有 schedule 定义 */
    scheduledEvents: z.array(OpeningScheduledEventSchema),
  })
  .strict();

export type OpeningTemplate = z.infer<typeof OpeningTemplateSchema>;
export type OpeningRun = z.infer<typeof OpeningRunSchema>;
export type OpeningStep = z.infer<typeof OpeningStepSchema>;
export type OpeningEventPool = z.infer<typeof OpeningEventPoolSchema>;
export type OpeningPoolEvent = z.infer<typeof OpeningPoolEventSchema>;
export type OpeningSetup = z.infer<typeof OpeningSetupSchema>;
export type OpeningNpcSetup = z.infer<typeof OpeningNpcSetupSchema>;
export type OpeningRelation = z.infer<typeof OpeningRelationSchema>;
export type OpeningScheduledEvent = z.infer<typeof OpeningScheduledEventSchema>;
export type OpeningHandoff = z.infer<typeof OpeningHandoffSchema>;
