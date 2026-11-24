import { z } from "zod";
import { AnyMatchSchema, EffectSchema, TaskConditionSchema } from "./common.js";

/**
 * 死亡与战评协议（ADR-075）。
 *
 * 本文件只放**模板可声明**的部分（stake / 战斗力权重）与**战果快照**（BattleResult）。
 * 战评的运行逻辑在 `packages/game-core/src/v2/battle-evaluation.ts`。
 */

// ---------- Stake（会不会死） ----------

/**
 * 战败之后的三态。**`dead` 是唯一进入死亡路由的入口**（ADR-075 §1）；
 * 模板自定义 stake 也只能落这三态——多一档就等于多一条"判死"的旁路。
 */
export const StakeDefeatStateSchema = z.enum(["yielded", "down", "dead"]);
export type StakeDefeatState = z.infer<typeof StakeDefeatStateSchema>;

/**
 * 战败时的 HP 落点。
 *
 * - `floor`：`max(value, hp)` —— 不掉到 value 以下，也不往上抬（切磋留手）；
 * - `set`：直接写 value（死斗写 0）。
 */
export const HpOnDefeatSchema = z
  .object({
    mode: z.enum(["floor", "set"]),
    value: z.number().int().nonnegative(),
  })
  .strict();
export type HpOnDefeat = z.infer<typeof HpOnDefeatSchema>;

export const StakeSchema = z
  .object({
    /** 展示名（战果 / 日志用）；缺省回退 stake id。 */
    label: z.string().min(1).optional(),
    defeatState: StakeDefeatStateSchema,
    /** 缺省由 `defeatState` 推：`dead → set 0`，其余 `floor 1`。 */
    hpOnDefeat: HpOnDefeatSchema.optional(),
  })
  .strict();
export type StakeDef = z.infer<typeof StakeSchema>;

// ---------- 战斗力 ----------

/**
 * 战斗力权重（ADR-075 §4.3）：键必须是**基础、非 signed、非 hidden 数值属性**，
 * 加载期拒绝派生键（派生属性会重复计入同一条底层属性）。
 */
export const BattlePowerConfigSchema = z
  .object({
    weights: z.record(z.string().min(1), z.number()).refine((w) => Object.keys(w).length > 0, {
      message: "power.weights 不能为空表（空表等于没有口径，不是零战力）",
    }),
  })
  .strict();
export type BattlePowerConfig = z.infer<typeof BattlePowerConfigSchema>;

// ---------- 战评：等级与钩子（ADR-075 §2） ----------

export const BattleMetricSchema = z.enum([
  "hpRatio",
  "rounds",
  "damageDealt",
  "damageTaken",
  "crits",
  "kills",
  "powerRatio",
]);
export type BattleMetric = z.infer<typeof BattleMetricSchema>;

const hasCompareOp = (value: Record<string, unknown>): boolean =>
  ["eq", "ne", "gt", "gte", "lt", "lte"].some((key) => value[key] !== undefined);

const MetricConditionSchema = z
  .object({
    metric: BattleMetricSchema,
    eq: z.number().optional(),
    ne: z.number().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
  })
  .strict()
  .refine(hasCompareOp, { message: "metric 条件需要至少一个比较操作" });

const StatusStacksConditionSchema = z
  .object({
    statusStacks: z.string().min(1),
    eq: z.number().optional(),
    ne: z.number().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
  })
  .strict()
  .refine(hasCompareOp, { message: "statusStacks 条件需要至少一个比较操作" });

/** 战评条件：只读战果（`BattleResult`），不读世界状态（世界条件用 `TaskCondition`）。 */
export const BattleEvalConditionSchema = z.union([
  z.object({ outcome: z.enum(["victory", "defeat", "flee"]) }).strict(),
  z.object({ grade: z.string().min(1) }).strict(),
  MetricConditionSchema,
  StatusStacksConditionSchema,
  z.object({ anyMatch: AnyMatchSchema }).strict(),
]);
export type BattleEvalCondition = z.infer<typeof BattleEvalConditionSchema>;

export const BattleGradeSchema = z
  .object({
    id: z.string().min(1),
    /** 展示名（P2）；缺省回退 id。 */
    label: z.string().min(1).optional(),
    /** AND；首个命中的 grade 生效。 */
    when: z.array(BattleEvalConditionSchema).min(1),
  })
  .strict();
export type BattleGrade = z.infer<typeof BattleGradeSchema>;

/** 战评钩子 P1 只允许这四类效果：它们不依赖时间推进 / 槽 / 链。 */
export const BATTLE_EVAL_HOOK_EFFECT_TYPES: ReadonlySet<string> = new Set([
  "advanceTalent",
  "setFlag",
  "adjustFlag",
  "clearFlag",
  "log",
]);

export const BattleEvalHookSchema = z
  .object({
    /** 全模板唯一（诊断用）。 */
    id: z.string().min(1),
    when: z.array(BattleEvalConditionSchema).default([]),
    effects: z.array(EffectSchema).min(1),
  })
  .strict()
  .superRefine((hook, ctx) => {
    hook.effects.forEach((effect, i) => {
      if (BATTLE_EVAL_HOOK_EFFECT_TYPES.has(effect.type)) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effects", i, "type"],
        message: `战评钩子不支持 ${effect.type}（只允许 advanceTalent / setFlag / adjustFlag / clearFlag / log）`,
      });
    });
  });
export type BattleEvalHook = z.infer<typeof BattleEvalHookSchema>;

export const CombatEvaluationSchema = z
  .object({
    power: BattlePowerConfigSchema.optional(),
    /** 战评等级（ADR-075 §2）：按声明顺序首个命中；P2 上屏。 */
    grades: z.array(BattleGradeSchema).optional(),
    /** 默认战评钩子：世界层声明，通常战斗都跑，事件不需要引用。 */
    hooks: z.array(BattleEvalHookSchema).optional(),
    /** 具名钩子组：只有战斗事件 `evaluation` 引用时才跑。 */
    sets: z.record(z.string().min(1), z.array(BattleEvalHookSchema)).optional(),
  })
  .strict();
export type CombatEvaluation = z.infer<typeof CombatEvaluationSchema>;

// ---------- 死亡路由（ADR-075 §5） ----------

/** 比值两侧的名字（聚合不落盘，按需相加）。 */
export const BattleSideNameSchema = z.enum([
  "player",
  "ally",
  "enemy",
  "neutral",
  "playerSide",
  "opposition",
]);
export type BattleSideName = z.infer<typeof BattleSideNameSchema>;

const RangeSchema = z
  .object({
    gte: z.number().optional(),
    lte: z.number().optional(),
  })
  .strict();

const KillerPredicateSchema = z.union([
  z.string().min(1),
  z
    .object({
      ref: z.string().min(1).optional(),
      tier: z.enum(["minion", "hero"]).optional(),
      summonedByPlayer: z.boolean().optional(),
    })
    .strict(),
]);

/**
 * 战果谓词（ADR-075 §5.2）。
 *
 * **这里没有 HP**：死亡已经由 `defeatState: dead` 信号化，再拿血量当死亡判据就违反 R-EN-07。
 * "死时还剩多少血"属于战评 `grade`，不属于死亡路由。
 */
export const BattlePredicateSchema = z
  .object({
    stake: z.string().min(1).optional(),
    defeatState: StakeDefeatStateSchema.optional(),
    killer: KillerPredicateSchema.optional(),
    damageTo: z
      .object({ ref: z.string().min(1), gte: z.number().optional(), lte: z.number().optional() })
      .strict()
      .optional(),
    playerPower: RangeSchema.optional(),
    ratio: z
      .object({
        left: BattleSideNameSchema,
        right: BattleSideNameSchema,
        gte: z.number().optional(),
        lte: z.number().optional(),
      })
      .strict()
      .optional(),
    grade: z.string().min(1).optional(),
    rounds: RangeSchema.optional(),
  })
  .strict();
export type BattlePredicate = z.infer<typeof BattlePredicateSchema>;

export const DeathConditionSchema = z.union([
  TaskConditionSchema,
  z.object({ battle: BattlePredicateSchema }).strict(),
  z.object({ cause: z.enum(["battle", "event", "world"]) }).strict(),
  z
    .object({
      deathDepth: z
        .object({ eq: z.number().int().nonnegative().optional(), gte: z.number().int().nonnegative().optional(), lte: z.number().int().nonnegative().optional() })
        .strict(),
    })
    .strict(),
]);
export type DeathCondition = z.infer<typeof DeathConditionSchema>;

export const DeathActionSchema = z.discriminatedUnion("kind", [
  /** 死亡结局唯一权威：直接引用 `endings.yaml` 的 id，不再跑 triggerConditions。 */
  z.object({ kind: z.literal("ending"), endingId: z.string().min(1) }).strict(),
  /** 死亡事件：占槽（`from: "death"`），结算后自动 hp1，除非事件里 `playerDeath`。 */
  z.object({ kind: z.literal("event"), eventId: z.string().min(1) }).strict(),
]);
export type DeathAction = z.infer<typeof DeathActionSchema>;

export const DeathRouteSchema = z
  .object({
    id: z.string().min(1),
    /** AND；`[]` = 兜底。路由顺序即声明顺序，首个命中。 */
    when: z.array(DeathConditionSchema).default([]),
    then: DeathActionSchema,
  })
  .strict();
export type DeathRoute = z.infer<typeof DeathRouteSchema>;

// ---------- 战果快照 ----------

export const ResourceSnapshotSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    current: z.number(),
    max: z.number(),
    ratio: z.number(),
    /** `hp / mp` = true；自定义资源 false。 */
    preset: z.boolean(),
  })
  .strict();
export type ResourceSnapshot = z.infer<typeof ResourceSnapshotSchema>;

export const BattleDeathSchema = z
  .object({
    /** 战斗实例 id（玩家 = selfId）。 */
    id: z.string().min(1),
    /** 角色 id（玩家没有）。 */
    ref: z.string().min(1).optional(),
    side: z.enum(["player", "ally", "enemy", "neutral"]),
    name: z.string().min(1),
  })
  .strict();
export type BattleDeath = z.infer<typeof BattleDeathSchema>;

export const BattleEnemyResultSchema = z
  .object({
    ref: z.string().min(1),
    name: z.string().min(1),
    tier: z.enum(["minion", "hero"]),
    /** 开场战斗力。 */
    power: z.number(),
    damageByPlayer: z.number(),
    damageToPlayer: z.number(),
    defeated: z.boolean(),
    killer: z.boolean(),
    summonedByPlayer: z.boolean(),
  })
  .strict();
export type BattleEnemyResult = z.infer<typeof BattleEnemyResultSchema>;

export const BattleKillerSchema = z
  .object({
    ref: z.string().min(1),
    name: z.string().min(1),
    tier: z.enum(["minion", "hero"]),
    power: z.number(),
    summonedByPlayer: z.boolean(),
  })
  .strict();
export type BattleKiller = z.infer<typeof BattleKillerSchema>;

/**
 * 战果快照（ADR-075 §3）。
 *
 * **不是权威状态**：世界状态仍是唯一真相；它只是"这一场发生了什么"的只读记录，
 * 供死亡路由、战评条件与叙事读。`statusStacks` 只收 `visibility: known` 的状态。
 */
export const BattleResultSchema = z
  .object({
    eventId: z.string().min(1),
    outcome: z.enum(["victory", "defeat", "flee"]),
    stake: z.string().min(1),
    defeatState: StakeDefeatStateSchema,
    grade: z.string().min(1).optional(),
    rounds: z.number().int().nonnegative(),
    player: z
      .object({
        /** 收场值：已过 `hpOnDefeat` 与夹取（与写回世界的数一致）。 */
        hp: z.number(),
        maxHp: z.number(),
        resources: z.array(ResourceSnapshotSchema),
        /** 世界状态有效属性（不含战斗临时态）。 */
        attributes: z.record(z.string(), z.number()),
        /** 开场战斗力。 */
        power: z.number(),
        /** 收场战斗力（世界态，不含战斗临时态）。 */
        powerEnd: z.number(),
        damageDealt: z.number(),
        damageTaken: z.number(),
        crits: z.number().int().nonnegative(),
        hits: z.number().int().nonnegative(),
        kills: z.number().int().nonnegative(),
        statusStacks: z.record(z.string(), z.number().int()),
      })
      .strict(),
    /** 四侧开场战斗力；聚合（playerSide / opposition）不落盘，按需相加。 */
    sides: z
      .object({
        player: z.number(),
        ally: z.number(),
        enemy: z.number(),
        neutral: z.number(),
      })
      .strict(),
    enemies: z.array(BattleEnemyResultSchema),
    killer: BattleKillerSchema.optional(),
    deaths: z.array(BattleDeathSchema),
  })
  .strict();
export type BattleResult = z.infer<typeof BattleResultSchema>;
