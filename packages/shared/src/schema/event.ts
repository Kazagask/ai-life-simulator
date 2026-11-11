import { z } from "zod";
import { ConditionSchema, EffectSchema, TimeAmountSchema, TimeSpecSchema } from "./common.js";
import { OpposedCheckSchema } from "./skill.js";

/**
 * 事件协议 V2：三段式「触发 trigger -> 类型 kind -> 结算 settle」。
 * kind 判别联合：normal（选项，支持出现条件）/ random（转盘）/ combat（战斗）。
 * 事件链（chain）与事件池（source: pool）同文件定义。
 *
 * R2.5（ADR-0011）：触发收敛为「立即 / 延时」两类，判据是是否声明时间窗，
 * 与 source 正交；`action-hook` 保留旧名。TimeSpec 本轮只有 TimeAmount 形态。
 */

// ---------- 触发 ----------

/**
 * 退役字段**仍声明在 schema 里**，但 superRefine 一律拒绝并给出替代表达：
 * 这样错误信息是可诊断的「atTurn 已退役，请改用 window.start」，
 * 而不是 strict object 的通用 "Unrecognized key"，且旧 TS 消费点在迁移期仍可编译。
 */
const RETIRED_HINT = {
  atTurn: "atTurn 已退役（x 轮后无法换算为世界时间），请改用 window.start: TimeSpec（默认相对入队时刻）",
  atWorldTime: "atWorldTime 已退役，请改用 window: { start: TimeSpec }（世界初始化 now=0 入队等价表达）",
  cooldownTurns: "cooldownTurns 已退役（轮次冷却），请改用 cooldown: TimeSpec（世界分钟，如 { value: 3, unit: 'day' }）",
} as const;

export const EventWindowSchema = z
  .object({
    /** 相对入队时刻的窗口起点（TimeSpec），入队时换算为绝对世界分钟 */
    start: TimeSpecSchema,
    /** 相对入队时刻的窗口终点；缺省 = 无限期（实例 hasEnd=false，不用数值哨兵） */
    end: TimeSpecSchema.optional(),
  })
  .strict();

export const EventTriggerSchema = z
  .object({
    /** `action-hook` 保留旧名（Q-R25-01 已裁决）；既可立即也可延时 */
    source: z.enum(["pool", "chain", "schedule", "action-hook"]),
    /** 配置域只读：出队终判读定义现值，实例不得复制（R-EV-15） */
    conditions: z.array(ConditionSchema).optional(),
    probability: z.number().min(0).max(1).optional(),
    weight: z.number().positive().optional(),
    once: z.boolean().optional(),
    priority: z.number().int().optional(),
    /** source: action-hook 专用；仅配置域 */
    onActionId: z.string().min(1).optional(),

    // ---------- R2.5 新增：时间窗 / 延时 / 冷却 / 结算耗时 / 错失 ----------
    /** 声明了 window 或 delay 即视为延时触发（立即/延时与 source 正交） */
    window: EventWindowSchema.optional(),
    /** 候选产生后入队的延迟；缺省 = 相对入队时刻 0 分钟（OQ-#38） */
    delay: TimeSpecSchema.optional(),
    /** 时间维度冷却：worldTime - lastFiredIndex[id].worldTime < cooldown 分钟 */
    cooldown: TimeSpecSchema.optional(),
    /** 事件结算轮的 worldTime 增量；缺省 0（只占槽不耗时，R-EV-14） */
    timeCost: TimeSpecSchema.optional(),
    /** 触发前提永久失效谓词；命中即错失出队（原因 miss_when），与 conditions 同一 DSL */
    missWhen: z.array(ConditionSchema).optional(),
    /** 错失事实的人类可读标签，仅 miss_when 有意义 */
    missLabel: z.string().min(1).optional(),

    // ---------- 退役字段（declared-but-deprecated，仅用于给出诊断错误） ----------
    /** @deprecated 用 window.start */
    atTurn: z.number().int().nonnegative().optional(),
    /** @deprecated 用 window.start */
    atWorldTime: TimeAmountSchema.optional(),
    /** @deprecated 用 cooldown */
    cooldownTurns: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.probability !== undefined && t.weight !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["probability"], message: "probability 与 weight 二选一" });
    }
    if (t.source === "pool" && t.probability === undefined && t.weight === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["source"], message: "池事件需要 probability 或 weight" });
    }
    if (t.source === "schedule" && t.window === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["window"],
        message: "schedule 事件需要 window.start（TimeSpec，默认相对入队时刻；替代已退役的 atTurn/atWorldTime）",
      });
    }
    if (t.source === "action-hook" && t.onActionId === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["source"], message: "action-hook 事件需要 onActionId" });
    }
    if (t.atTurn !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["atTurn"], message: RETIRED_HINT.atTurn });
    }
    if (t.atWorldTime !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["atWorldTime"], message: RETIRED_HINT.atWorldTime });
    }
    if (t.cooldownTurns !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cooldownTurns"], message: RETIRED_HINT.cooldownTurns });
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
    /** Q-R25-06 裁决 A：保留 nextTurn（「下一轮」是槽位语义，不是时间量） */
    advanceWhen: z.enum(["nextTurn", "onSettle"]),
    /** 声明 delay 的链步走延时队列；队列仍有该链 waiting 实例时不得判断链 */
    delay: TimeSpecSchema.optional(),
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
export type EventWindow = z.infer<typeof EventWindowSchema>;
export type EventOption = z.infer<typeof EventOptionSchema>;
export type CombatSettle = z.infer<typeof CombatSettleSchema>["combat"];
export type SettleOutcome = z.infer<typeof SettleOutcomeSchema>;
