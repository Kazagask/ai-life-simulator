import { z } from "zod";
import { ConditionSchema, EffectSchema, TimeAmountSchema } from "./common.js";
import { OpposedCheckSchema } from "./skill.js";

/**
 * 事件协议 V2：三段式「触发 trigger -> 类型 kind -> 结算 settle」。
 * kind 判别联合：normal（选项，支持出现条件）/ random（转盘）/ combat（战斗）。
 * 事件链（chain）与事件池（source: pool）同文件定义。
 */

// ---------- 触发 ----------

export const EventTriggerSchema = z
  .object({
    source: z.enum(["pool", "chain", "schedule", "action-hook"]),
    conditions: z.array(ConditionSchema).optional(),
    probability: z.number().min(0).max(1).optional(),
    weight: z.number().positive().optional(),
    cooldownTurns: z.number().int().nonnegative().optional(),
    once: z.boolean().optional(),
    priority: z.number().int().optional(),
    /** source: schedule 专用 */
    atTurn: z.number().int().nonnegative().optional(),
    /** 相对世界起始的绝对时间偏移（剧情节点触发） */
    atWorldTime: TimeAmountSchema.optional(),
    /** source: action-hook 专用 */
    onActionId: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.probability !== undefined && t.weight !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["probability"], message: "probability 与 weight 二选一" });
    }
    if (t.source === "pool" && t.probability === undefined && t.weight === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["source"], message: "池事件需要 probability 或 weight" });
    }
    if (t.source === "schedule" && t.atTurn === undefined && t.atWorldTime === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["source"], message: "schedule 事件需要 atTurn 或 atWorldTime" });
    }
    if (t.source === "action-hook" && t.onActionId === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["source"], message: "action-hook 事件需要 onActionId" });
    }
  });

// ---------- 结算：normal ----------

export const EventOptionSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    /** 选项出现条件：全部满足才进入玩家可见投影 */
    visibleWhen: z.array(ConditionSchema).optional(),
    effects: z.array(EffectSchema).optional(),
    nextEventId: z.string().min(1).optional(),
  })
  .strict();

export const NormalSettleSchema = z
  .object({
    normal: z.object({ options: z.array(EventOptionSchema).min(1) }).strict(),
  })
  .strict();

// ---------- 结算：random（转盘） ----------

export const WheelSegmentSchema = z
  .object({
    /** 基础权重；最终权重 = max(0, weight + Σ(玩家有效属性值 × weightBy 系数)) */
    weight: z.number().positive(),
    /** 属性加权：属性 id → 每点加成系数（可为负，如"凶"随幸运降低） */
    weightBy: z.record(z.string(), z.number()).optional(),
    label: z.string().min(1),
    effects: z.array(EffectSchema).optional(),
    nextEventId: z.string().min(1).optional(),
  })
  .strict();

export const RandomSettleSchema = z
  .object({
    random: z
      .object({
        wheel: z.object({ segments: z.array(WheelSegmentSchema).min(1) }).strict(),
      })
      .strict(),
  })
  .strict();

// ---------- 结算：combat ----------

export const EnemyRefSchema = z
  .object({
    ref: z.string().min(1),
    levelScale: z.number().positive().optional(),
  })
  .strict();

export const SettleOutcomeSchema = z
  .object({
    effects: z.array(EffectSchema).optional(),
    nextEventId: z.string().min(1).optional(),
  })
  .strict();

export const CombatSettleSchema = z
  .object({
    combat: z
      .object({
        enemies: z.array(EnemyRefSchema).min(1),
        /** 友军单位（与主角同阵营，AI 自动行动；形状同敌人） */
        allies: z.array(EnemyRefSchema).optional(),
        canFlee: z.boolean().optional(),
        fleeCheck: OpposedCheckSchema.optional(),
        onVictory: SettleOutcomeSchema.optional(),
        onDefeat: SettleOutcomeSchema.optional(),
        onFlee: SettleOutcomeSchema.optional(),
      })
      .strict(),
  })
  .strict();

// ---------- 事件（kind 判别联合） ----------

const EventBase = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    narrative: z.string().min(1),
    trigger: EventTriggerSchema,
  })
  .strict();

export const EventV2Schema = z.discriminatedUnion("kind", [
  EventBase.extend({ kind: z.literal("normal"), settle: NormalSettleSchema }).strict(),
  EventBase.extend({ kind: z.literal("random"), settle: RandomSettleSchema }).strict(),
  EventBase.extend({ kind: z.literal("combat"), settle: CombatSettleSchema }).strict(),
]);

// ---------- 事件链 ----------

export const ChainStepSchema = z
  .object({
    eventId: z.string().min(1),
    advanceWhen: z.enum(["nextTurn", "onSettle"]),
  })
  .strict();

export const ChainSchema = z
  .object({
    id: z.string().min(1),
    startEventId: z.string().min(1),
    steps: z.array(ChainStepSchema).min(1),
    pauseWhenHidden: z.boolean().optional(),
  })
  .strict();

export type EventV2 = z.infer<typeof EventV2Schema>;
export type Chain = z.infer<typeof ChainSchema>;
export type EventTrigger = z.infer<typeof EventTriggerSchema>;
export type EventOption = z.infer<typeof EventOptionSchema>;
export type CombatSettle = z.infer<typeof CombatSettleSchema>["combat"];
export type SettleOutcome = z.infer<typeof SettleOutcomeSchema>;
