import { z } from "zod";
import { TimeAmountSchema } from "./common.js";

/**
 * 事件实例（协议 V2.1 §16 / design §5）：模板定义与本局实例可区分（R3 穿越 seam）。
 * 本轮只写 origin 元数据；不引入 EventRecord、不新增事件类型枚举、不改动
 * events.yaml 的 trigger.source 枚举（附录 A A4/A5）。
 */

/** 开局事件来源：kind 固定为 opening，id 为 openingId（实例级元数据）。 */
export const EventInstanceOriginSchema = z
  .object({
    kind: z.literal("opening"),
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
    /** 未来事件：相对世界起始的时间偏移 */
    scheduledTime: TimeAmountSchema.optional(),
    status: EventInstanceStatusSchema,
    visibility: EventInstanceVisibilitySchema,
  })
  .strict();

export type EventInstanceOrigin = z.infer<typeof EventInstanceOriginSchema>;
export type EventInstanceStatus = z.infer<typeof EventInstanceStatusSchema>;
export type EventInstanceVisibility = z.infer<typeof EventInstanceVisibilitySchema>;
export type EventInstance = z.infer<typeof EventInstanceSchema>;
