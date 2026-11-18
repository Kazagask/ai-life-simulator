import { z } from "zod";
import { TaskConditionSchema, TemplateEffectSchema, TimeAmountSchema } from "./common.js";
import { EventInstanceSchema } from "./event-instance.js";
import { RelationKindSchema } from "./relation.js";

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
    conditions: z.array(TaskConditionSchema).optional(),
    required: z.boolean().optional(),
    countRange: CountRangeSchema.optional(),
    exclusiveGroup: z.string().min(1).optional(),
    sequence: z.number().int().nonnegative().optional(),
    seed: z.number().int().optional(),
    effects: z.array(TemplateEffectSchema).optional(),
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
    effects: z.array(TemplateEffectSchema).optional(),
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
    conditions: z.array(TaskConditionSchema).optional(),
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
    entryConditions: z.array(TaskConditionSchema),
    steps: z.array(OpeningStepSchema),
    characterSetup: OpeningSetupSchema,
    worldSetup: OpeningSetupSchema,
    npcSetup: OpeningNpcSetupSchema,
    eventPools: z.array(OpeningEventPoolSchema),
    objectives: OpeningSetupSchema,
    choices: OpeningSetupSchema,
    completionConditions: z.array(TaskConditionSchema).min(1),
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

// ---------- 前实例化开局（ADR-001 / R-OP-01..07） ----------
//
// 新语法与上面的旧 opening.yaml 分域**并存**：旧分域继续服务 1.0.0 模板（旧档拒载由
// schemaVersion=5 统一处理），新分域由 2.0.0 的 `opening.yaml` 声明，加载期择一解释。
// 参数落点由引擎注册（模板只给 kind/约束/展示提示），这里只约束"声明的形状"。

/** 参数闭集（R-OP-05）：新参数类型需改 core + ADR，不在模板里自造落点。 */
export const OpeningParamKindSchema = z.enum([
  "self",
  "name",
  "gender",
  "age",
  "attribute",
  "status",
  "skill",
  "item",
  "relation",
  "flag",
  "time",
  "points",
  "extensions",
]);
export type OpeningParamKind = z.infer<typeof OpeningParamKindSchema>;

/** 展示组件提示（渲染层消费；v1 内联，ui.yaml 定案后迁出）。 */
export const OpeningParamUiSchema = z
  .object({
    label: z.string().min(1),
    component: z.enum(["text", "enum", "wheel", "points"]).optional(),
    order: z.number().int().nonnegative().optional(),
    hidden: z.boolean().optional(),
  })
  .strict();

/** 单个开局参数声明：id 是模板侧别名，kind 决定引擎落点（不写 target）。 */
export const OpeningParamDeclSchema = z
  .object({
    id: z.string().min(1),
    kind: OpeningParamKindSchema,
    /** 枚举可选值（kind=gender/self 等）；引擎不解释语义，只透传展示与校验。 */
    values: z.array(z.string().min(1)).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    /** 点数分配规格（kind=points）：预算 + 各属性上下界。 */
    budget: z.number().int().positive().optional(),
    targets: z
      .array(
        z
          .object({
            attribute: z.string().min(1),
            min: z.number().optional(),
            max: z.number().optional(),
          })
          .strict(),
      )
      .optional(),
    ui: OpeningParamUiSchema.optional(),
  })
  .strict();

/** 一步"抽到/选到就 set 哪些参数"。set 的键必须是本模板声明过的 param id。 */
export const OpeningBranchSetSchema = z.record(z.string().min(1), z.unknown());

/** 转盘权重：v1 只静态 weight（D-4 裁决：不支持 weightBy）。 */
export const OpeningBranchOptionSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    weight: z.number().nonnegative().optional(),
    /** 加载期拒载任何 weightBy —— 开局期未实例化，世界属性加权复用不了。 */
    weightBy: z.unknown().optional(),
    set: OpeningBranchSetSchema,
    goto: z.string().min(1).optional(),
  })
  .strict()
  .refine((o) => o.weightBy === undefined, { message: "开局 roll 不支持 weightBy（ADR-001 D-4）" });

/** branch DAG 节点：roll 自动掷、choose 玩家点、allocate 加点；可任意交错（R-OP-02）。 */
export const OpeningBranchNodeSchema = z
  .object({
    node: z.string().min(1),
    title: z.string().min(1),
    text: z.string().min(1).optional(),
    mode: z.enum(["roll", "choose", "allocate"]),
    /** allocate 节点指向的 points 参数 id；roll/choose 可省略。 */
    param: z.string().min(1).optional(),
    options: z.array(OpeningBranchOptionSchema).optional(),
    goto: z.string().min(1).optional(),
  })
  .strict();

/** 前实例化开局声明（新 opening.yaml 的顶层形状，可选分域）。 */
export const OpeningBranchDagSchema = z
  .object({
    openingId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    params: z.array(OpeningParamDeclSchema),
    entry: z.string().min(1),
    nodes: z.array(OpeningBranchNodeSchema).min(1),
  })
  .strict()
  .superRefine((dag, ctx) => {
    const ids = new Set(dag.params.map((p) => p.id));
    const kindById = new Map(dag.params.map((p) => [p.id, p.kind]));
    if (ids.size !== dag.params.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["params"], message: "重复 param id" });
    }
    const nodes = new Set<string>();
    dag.nodes.forEach((n, i) => {
      if (nodes.has(n.node)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", i, "node"], message: `重复节点 id：${n.node}` });
      }
      nodes.add(n.node);
      for (const [optionIndex, option] of (n.options ?? []).entries()) {
        for (const [key, value] of Object.entries(option.set)) {
          const path = ["nodes", i, "options", optionIndex, "set", key] as const;
          if (!ids.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path],
              message: `set 引用未声明参数：${key}`,
            });
            continue;
          }
          // set 值按 param kind 透传（引擎推断落点），但 relation 的 kind 是闭集枚举：
          // 此处放行非法值会写进 state.relations，存档将永久载不回来（开局提交后即坏档）。
          if (kindById.get(key) === "relation") {
            const rel = value as { with?: unknown; value?: unknown; kind?: unknown } | null;
            if (typeof rel !== "object" || rel === null) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message: "relation 参数值必须是对象" });
              continue;
            }
            if (typeof rel.with !== "string") {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message: "relation 缺少 with（目标角色 id）" });
            }
            if (typeof rel.value !== "number") {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message: "relation 缺少数值 value" });
            }
            if (rel.kind !== undefined && !RelationKindSchema.safeParse(rel.kind).success) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path],
                message: `relation kind 不在闭集内：${String(rel.kind)}`,
              });
            }
          }
        }
      }
    });
    if (!nodes.has(dag.entry)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entry"], message: `entry 指向不存在的节点：${dag.entry}` });
    }
  });

/** 会话一步的结果（只记结果，不记 Draft / 中间世界）。 */
export const OpeningStepResultSchema = z
  .object({
    nodeId: z.string().min(1),
    optionId: z.string().min(1).optional(),
    rollIndex: z.number().int().nonnegative().optional(),
    /** allocate 节点的最终分配结果：paramId -> attribute -> value */
    allocation: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  })
  .strict();

/** 会话契约（服务端资源，不进 WorldStateV2）。 */
export const OpeningSessionSchema = z
  .object({
    id: z.string().min(1),
    templateId: z.string().min(1),
    templateVersion: z.string().min(1),
    openingId: z.string().min(1),
    seed: z.number().int(),
    nodeId: z.string().min(1),
    results: z.array(OpeningStepResultSchema),
    done: z.boolean(),
  })
  .strict();

export type OpeningTemplate = z.infer<typeof OpeningTemplateSchema>;
export type OpeningBranchDag = z.infer<typeof OpeningBranchDagSchema>;
export type OpeningBranchNode = z.infer<typeof OpeningBranchNodeSchema>;
export type OpeningBranchOption = z.infer<typeof OpeningBranchOptionSchema>;
export type OpeningSession = z.infer<typeof OpeningSessionSchema>;
export type OpeningStepResult = z.infer<typeof OpeningStepResultSchema>;
export type OpeningRun = z.infer<typeof OpeningRunSchema>;
export type OpeningStep = z.infer<typeof OpeningStepSchema>;
export type OpeningEventPool = z.infer<typeof OpeningEventPoolSchema>;
export type OpeningPoolEvent = z.infer<typeof OpeningPoolEventSchema>;
export type OpeningSetup = z.infer<typeof OpeningSetupSchema>;
export type OpeningNpcSetup = z.infer<typeof OpeningNpcSetupSchema>;
export type OpeningRelation = z.infer<typeof OpeningRelationSchema>;
export type OpeningScheduledEvent = z.infer<typeof OpeningScheduledEventSchema>;
export type OpeningHandoff = z.infer<typeof OpeningHandoffSchema>;
