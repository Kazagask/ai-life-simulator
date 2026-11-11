import { z } from "zod";
import { TimeAmountSchema } from "./common.js";

/**
 * 事件实例（协议 V2.1 §16 / R2.5 design §3.3）：模板定义与本局实例可区分（R3 穿越 seam）。
 *
 * 两类实例：
 * - `EventInstance`：开局抽取/交接产生的元数据实例（沿用旧协议，status 为 opening 语义）。
 * - `ScheduledEventInstance`：R2.5 延时队列实例（进存档、有固化窗口、可审计）。
 *
 * 实例**不复制配置域字段**（probability/weight/once/priority/conditions/onActionId），
 * 判定一律经 lookup.event(definitionId) 读定义现值（R-EV-15 / ADR-0010）。
 */

export const EventInstanceOriginSchema = z
  .object({
    kind: z.enum(["opening", "schedule-init", "effect", "pool"]),
    id: z.string().min(1),
  })
  .strict();

export const EventInstanceStatusSchema = z.enum([
  "pending",
  "scheduled",
  "active",
  "completed",
  "cancelled",
]);

/** 信息分层（AGENTS.md §3）。 */
export const EventInstanceVisibilitySchema = z.enum([
  "known",
  "inferred",
  "unknown",
  "hidden",
]);

export const EventInstanceSchema = z
  .object({
    /** 本局实例 id，由 RunnerContext.idFactory 注入 */
    instanceId: z.string().min(1),
    /** 指向 events.yaml 中既有事件定义；实例不复制定义内容 */
    definitionId: z.string().min(1),
    origin: EventInstanceOriginSchema,
    /** 开局交接的未来事件：相对世界起始的时间偏移（仅 opening 实例使用） */
    scheduledTime: TimeAmountSchema.optional(),
    status: EventInstanceStatusSchema,
    visibility: EventInstanceVisibilitySchema,
  })
  .strict();

// ---------- R2.5 延时队列实例（§3.3） ----------

export const ScheduledEventStatusSchema = z.enum(["waiting", "fired", "expired", "cancelled"]);

/** 固化后的绝对世界分钟窗口；end 缺省 = 无限期，由 hasEnd 显式表达（R-LM-05）。 */
export const ScheduledEventWindowSchema = z
  .object({
    start: z.number().int(),
    end: z.number().int().optional(),
  })
  .strict();

export const ScheduledEventInstanceSchema = z
  .object({
    /** 由 enqueueSeqCounter 派生（evi-<seq>），无 Date / Math.random */
    instanceId: z.string().min(1),
    definitionId: z.string().min(1),
    origin: EventInstanceOriginSchema,
    /** 归属链的延时步骤（chain 断链判定据此对账） */
    chainId: z.string().min(1).optional(),
    window: ScheduledEventWindowSchema,
    /** 显式标记，避免极大世界时间与 +∞ 数值哨兵共域 */
    hasEnd: z.boolean(),
    /** 入队时的世界分钟 */
    enqueuedAt: z.number().int(),
    /** 全局唯一入队序号；排序第三键，保证全序严格 */
    enqueueSeq: z.number().int().nonnegative(),
    status: ScheduledEventStatusSchema,
  })
  .strict()
  .superRefine((inst, ctx) => {
    if (inst.hasEnd !== (inst.window.end !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hasEnd"],
        message: "hasEnd 必须与 window.end 是否存在一致（无限期用 undefined + hasEnd=false）",
      });
    }
    if (inst.hasEnd && inst.window.end !== undefined && inst.window.end < inst.window.start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["window", "end"],
        message: "window.end 不得早于 window.start",
      });
    }
  });

export type EventInstanceOrigin = z.infer<typeof EventInstanceOriginSchema>;
export type EventInstanceStatus = z.infer<typeof EventInstanceStatusSchema>;
export type EventInstanceVisibility = z.infer<typeof EventInstanceVisibilitySchema>;
export type EventInstance = z.infer<typeof EventInstanceSchema>;
export type ScheduledEventInstance = z.infer<typeof ScheduledEventInstanceSchema>;
export type ScheduledEventStatus = z.infer<typeof ScheduledEventStatusSchema>;
export type ScheduledEventWindow = z.infer<typeof ScheduledEventWindowSchema>;
