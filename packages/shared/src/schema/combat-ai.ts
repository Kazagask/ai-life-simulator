import { z } from "zod";

/**
 * 战斗 AI 分域 Schema（协议 V2.1 §20 / R-CA-01..06）。
 *
 * 可见性边界（用户决策 ⑤）：条件求值的唯一输入是 PublicConditionContext——
 * 只含玩家端投影可见的公有字段；禁止 hidden/unknown/secrets、combatHints（敌方私有）、
 * knownGoals（NPC 私有目标）等非公有字段，`when` 为 strict 对象，未知字段在
 * 加载期拒绝并给出字段路径（R-CA-06），无部分初始化状态。
 */

// ---------- 条件（NumericWhen） ----------

const NumericWhenSchema = z
  .object({
    gte: z.number().optional(),
    lte: z.number().optional(),
    gt: z.number().optional(),
    lt: z.number().optional(),
  })
  .strict()
  .refine((w) => [w.gte, w.lte, w.gt, w.lt].some((v) => v !== undefined), {
    message: "条件至少需要一个比较操作",
  });

/**
 * 条件化策略的 `when`：键只能是 PublicConditionContext 的公有字段白名单。
 * strict —— 模板引用 hidden / unknown / secrets / combatHints / knownGoals 等
 * 非公有字段时加载期即报错（含字段路径）。
 */
export const ConditionalStrategySchema = z
  .object({
    when: z
      .object({
        /** 行动方自身 HP 比例（战斗镜像，公有语义） */
        actorHpRatio: NumericWhenSchema.optional(),
        /** 行动方自身 MP 比例 */
        actorMpRatio: NumericWhenSchema.optional(),
        /** 玩家端投影可见的玩家 HP/MP 比例 */
        publicPlayerHpRatio: NumericWhenSchema.optional(),
        publicPlayerMpRatio: NumericWhenSchema.optional(),
        /** 战斗回合数 */
        round: NumericWhenSchema.optional(),
        /** 行动方同阵营存活数（含自身） */
        publicAliveAllies: NumericWhenSchema.optional(),
        /** 对面阵营存活数 */
        publicAliveFoes: NumericWhenSchema.optional(),
      })
      .strict()
      .refine((w) => Object.keys(w).length > 0, { message: "when 至少引用一个公有字段" }),
    /** 条件命中时加权偏好的行动 id（必须为已注册技能；非法 id 运行时忽略并回退） */
    prefer: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type ConditionalStrategy = z.infer<typeof ConditionalStrategySchema>;

// ---------- 行动过滤参数 ----------

const BattleTargetKindSchema = z.enum(["enemy", "self", "ally", "all_enemies", "all_allies"]);

/** 风格的候选集过滤参数（声明式；引擎按参数过滤，不按风格名分支）。 */
export const ActionFilterSchema = z
  .object({
    /** 只保留目标类型在此列表内的行动 */
    includeTargets: z.array(BattleTargetKindSchema).optional(),
    /** 剔除目标类型在此列表内的行动 */
    excludeTargets: z.array(BattleTargetKindSchema).optional(),
    /** 只保留这些行动 id */
    includeActionIds: z.array(z.string().min(1)).optional(),
    /** 剔除这些行动 id */
    excludeActionIds: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine((f) => Object.keys(f).length > 0, { message: "过滤参数不能为空对象" });

export type ActionFilter = z.infer<typeof ActionFilterSchema>;

// ---------- 风格画像 ----------

export const CombatStyleProfileSchema = z
  .object({
    /** 风格标识，仅为模板数据；引擎不得按风格名分支（R-CA-02） */
    styleId: z.string().min(1),
    candidateFilters: z.array(ActionFilterSchema).default([]),
    /** 行动评分权重：actionId → 权重（键必须是模板已注册技能，加载期校验） */
    scoreWeights: z.record(z.string(), z.number()),
    /** 条件化策略（数组内逐条评估，命中即加权） */
    conditions: z.array(ConditionalStrategySchema).default([]),
  })
  .strict();

export type CombatStyleProfile = z.infer<typeof CombatStyleProfileSchema>;

// ---------- PublicConditionContext（运行时形状） ----------

/**
 * 条件求值的唯一输入。由 combat-ai.ts 的 buildPublicConditionContext 从战斗镜像
 * 与玩家端投影可见字段构建；不含完整 WorldStateV2、不含任何 hidden/private 数据。
 */
export const PublicConditionContextSchema = z
  .object({
    actorHpRatio: z.number().min(0).max(1),
    actorMpRatio: z.number().min(0).max(1),
    publicPlayerHpRatio: z.number().min(0).max(1),
    publicPlayerMpRatio: z.number().min(0).max(1),
    round: z.number().int().positive(),
    publicAliveAllies: z.number().int().nonnegative(),
    publicAliveFoes: z.number().int().nonnegative(),
  })
  .strict();

export type PublicConditionContext = z.infer<typeof PublicConditionContextSchema>;

// ---------- combat-ai.yaml 分域 ----------

export const CombatAiConfigSchema = z
  .object({
    styles: z.array(CombatStyleProfileSchema).min(1),
    /** 敌人/友军角色 id → 风格 id；未映射的角色保持既有简单权重路径（向后兼容） */
    assignments: z.record(z.string(), z.string()),
  })
  .strict();

export type CombatAiConfig = z.infer<typeof CombatAiConfigSchema>;
