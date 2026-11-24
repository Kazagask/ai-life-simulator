import { z } from "zod";
import { FormulaSchema, TaskConditionSchema } from "./common.js";

/**
 * 战斗 Hook 协议（ADR-073）。
 *
 * ## 为什么要有它
 *
 * 战斗里有两类被动：
 * - **改数字**（伤害 +30%、消耗 -90%、闪避 100%）—— 现有的 `combat` 面按乘区累加就够了，
 *   不需要钩子；把它们改写成钩子只是多一层间接。
 * - **改流程**（暴击之后再加一次判定、命中时解除对手术式、致命伤锁血、挨打后吸血）——
 *   聚合表达不了，因为它们不是「一个更大的数」，而是「在特定的时刻做一件额外的事」。
 *
 * 本文件只描述第二类。数字仍然走 `CombatFacetSchema` 的乘区。
 *
 * ## 纪律
 *
 * - **闭集，不是脚本**：效果词表在这里定义，引擎逐条实现。模板写不出的效果就是不存在。
 * - **一个 id 只生效一次**：同一效果挂在天赋与武器上不会双倍。
 * - **顺序显式**：`priority` 降序，同优先级按来源层级（世界 → 状态 → 技能）再按声明顺序。
 * - **随机必须分叉**：钩子内部掷骰走 `battle.hook` 流，不挪动命中/闪避的既有序列。
 */

// ---------- 原生暴击 ----------

/**
 * 暴击词条（ADR-073 D2）：`chance` 累加、`multiplier` 同形累加（两个 1.5x 叠成 2.0x）。
 *
 * 可以写在三处，引擎合并成一份：
 * - 世界规则 `world.combat.crit`（全局默认，例如 6% / 1.5x）；
 * - 状态 `statuses[].combat.crit`（天赋/补正：某类人更容易暴击）；
 * - 技能 `skills[].crit`（必暴的技能写 `chance: 1`）。
 *
 * 只作用于 `damage`：治疗、状态概率、回合末持续伤害都不暴击。
 */
export const CritSpecSchema = z
  .object({
    chance: z.number().min(0).max(1).optional(),
    /** 低于 1 的倍率没有意义（暴击不该比不暴击更轻），加载期直接拒。 */
    multiplier: z.number().min(1).optional(),
  })
  .strict();
export type CritSpec = z.infer<typeof CritSpecSchema>;

// ---------- 阶段 ----------

/**
 * 六个阶段（ADR-073 D1）。原设计的 `beforeCost` 被删掉：
 * 费用判定是 `canUseSkill`（投影 / AI / 按钮灰不灰）与 `performBattleAction` 共用的**纯函数**，
 * 而钩子带状态与随机。让费用受钩子影响，就会出现「面板说付不起、实际付得起」的两套真相。
 */
export const HookPhaseSchema = z.enum([
  /** 控制检查之前：整次行动被取消（眩晕的钩子版）。 */
  "beforeAction",
  /** 命中判定入口（必中判断之内）：替身、幻术、取消这一击。 */
  "beforeHit",
  /** 命中通过、伤害之前：暴击后的追加判定就挂在这里。 */
  "afterHit",
  /** 伤害数值算出、扣血之前：护盾、减伤。 */
  "beforeDamage",
  /** 扣血之后、死亡判定之前：锁血、吸血、反伤。 */
  "afterDamage",
  /** 技能结算末尾：余韵、追加状态。 */
  "afterAction",
]);
export type HookPhase = z.infer<typeof HookPhaseSchema>;

export const HookLimitSchema = z
  .object({
    per: z.enum(["action", "round", "battle"]),
    times: z.number().int().positive(),
  })
  .strict();

const HookTargetSchema = z.enum(["self", "target"]);

const HookChanceSchema = z
  .object({
    /** 基础概率；缺省 0。 */
    base: z.number().min(0).max(1).optional(),
    /** 读**施放者**的数值属性，例如「暴击资质」。 */
    attribute: z.string().min(1).optional(),
    /** 每点属性加多少概率（`chance = base + attribute × perPoint`）。 */
    perPoint: z.number().optional(),
    min: z.number().min(0).max(1).optional(),
    max: z.number().min(0).max(1).optional(),
  })
  .strict()
  .refine((c) => c.base !== undefined || c.attribute !== undefined, {
    message: "chance 需要 base 或 attribute 至少其一",
  });

/**
 * 钩子条件：复用模拟域的 `TaskCondition`（旗标 / 属性 / 状态 / 心情 / 关系…），
 * 另加四个**只在一场战斗里有意义**的键。不要在这里引入角色 id —— 需要区分身份时用 tags。
 */
export const HookConditionSchema = z.union([
  TaskConditionSchema,
  z.object({ crit: z.boolean() }).strict(),
  z.object({ hit: z.boolean() }).strict(),
  z
    .object({
      /** 读**受击方**当前血量比例（Boss 二阶段）。 */
      hpPct: z
        .object({
          gte: z.number().optional(),
          lte: z.number().optional(),
          gt: z.number().optional(),
          lt: z.number().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      /** 概率条件：走 `battle.hook` 流。数字 = 固定概率；对象 = 按属性算。 */
      chance: z.union([z.number().min(0).max(1), HookChanceSchema]),
    })
    .strict(),
]);
export type HookCondition = z.infer<typeof HookConditionSchema>;

/**
 * 效果闭集（v1）。刻意**不含**「改目标 / 改阵营 / 改技能 / 复活」——
 * 那些会开出「钩子改协议」的口子，而它们真正需要的是新的技能词表，不是钩子。
 */
const HookEffectUnion = z.discriminatedUnion("type", [
  /** 本次伤害 ×value（与 addDamage 按 priority 顺序叠）。 */
  z.object({ type: z.literal("scaleDamage"), value: z.number().nonnegative() }).strict(),
  /** 本次伤害 ±value（负数即减伤）。 */
  z.object({ type: z.literal("addDamage"), value: z.number() }).strict(),
  /**
   * 把**暴击倍率**按指数放大：倍率 1.5、指数 2.5 ⇒ 1.5^2.5 ≈ 2.76（ADR-073 D2）。
   * 只在本次暴击时有效；非暴击时是空操作。同一动作里多次声明取最后一个（priority 说了算）。
   */
  z.object({ type: z.literal("critExponent"), value: z.number().positive() }).strict(),
  /** 取消当前阶段：`beforeAction` ⇒ 不行动；`beforeHit` ⇒ 落空。 */
  z.object({ type: z.literal("cancel"), reason: z.string().min(1).optional() }).strict(),
  z
    .object({
      type: z.literal("applyStatus"),
      status: z.string().min(1),
      target: HookTargetSchema.optional(),
      stacks: z.number().int().positive().optional(),
      /** 战斗回合数；省略 = 撑到战斗结束。 */
      rounds: z.number().int().positive().optional(),
    })
    .strict(),
  /**
   * 解除状态。只能清 `battle` / `modifier`：天赋在结构上不可驱散（ADR-018），
   * 想「解除术式」就清它挂上去的战斗态。
   */
  z
    .object({
      type: z.literal("cureStatus"),
      target: HookTargetSchema.optional(),
      status: z.string().min(1).optional(),
      kind: z.enum(["battle", "modifier"]).optional(),
      polarity: z.enum(["positive", "negative", "neutral"]).optional(),
      max: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("heal"),
      formula: FormulaSchema,
      target: HookTargetSchema.optional(),
    })
    .strict(),
  /** 锁血：HP 不低于 value，只抬不压。 */
  z
    .object({
      type: z.literal("setHpFloor"),
      value: z.number().int().nonnegative(),
      target: HookTargetSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("log"), text: z.string().min(1) }).strict(),
]);

/**
 * 钩子效果词表（供加载期词表校验使用）。从联合本身派生，不手抄第二份 ——
 * 新增一个效果如果忘了登记，模板加载期会把它当成未知扩展效果拒掉。
 */
export const HOOK_EFFECT_TYPES: ReadonlySet<string> = new Set(
  HookEffectUnion.options.map((option) => option.shape.type.value),
);

export const HookEffectSchema = HookEffectUnion.superRefine((eff, ctx) => {
  // `cureStatus` 必须至少给一个选择器 —— 「不写 = 清空所有状态」太容易误伤。
  if (eff.type === "cureStatus" && eff.status === undefined && eff.kind === undefined && eff.polarity === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "cureStatus 需要 status / kind / polarity 至少其一（不写等于清空所有状态）",
    });
  }
});
export type HookEffect = z.infer<typeof HookEffectSchema>;

export const BattleHookSchema = z
  .object({
    /** 唯一 id：同一效果挂两处只生效一次（先收集到的赢）。 */
    id: z.string().min(1),
    phase: HookPhaseSchema,
    /** 降序；缺省 0。 */
    priority: z.number().int().optional(),
    /** AND；缺省 = 恒成立。 */
    when: z.array(HookConditionSchema).optional(),
    limit: HookLimitSchema.optional(),
    effects: z.array(HookEffectSchema).min(1),
  })
  .strict();
export type BattleHook = z.infer<typeof BattleHookSchema>;
