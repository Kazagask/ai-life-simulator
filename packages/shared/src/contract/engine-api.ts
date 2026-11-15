import { z } from "zod";
import { ObserverIdSchema } from "./perspective.js";
import type { Perspective, PerspectiveFactView } from "./perspective.js";
import type { V2Snapshot, WorldStateV2 } from "../v2.js";

/**
 * 引擎 API 调用与回执契约。
 *
 * 硬不变量：「无 API 调用即无事实变更」。LLM 稀疏参与，经 core -> llm 回调，
 * 回程一律走引擎 API（dispatch）；引擎不做自由文本语义判断。
 * 窗口计算（buildFacts）归 game-core 的引擎 API 所有，agent-runtime 不得自行决定可见性。
 */

/** 事实写入调用：结果进存档（权威状态）。 */
export const FactCallSchema = z
  .object({
    callId: z.string().min(1),
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string().min(1).optional(),
  })
  .strict();
export type FactCall = z.infer<typeof FactCallSchema>;

/** 内容写入调用：叙事正文只进 trace / 展示层，不进 WorldStateV2（F3）。 */
export const ContentCallSchema = z
  .object({
    callId: z.string().min(1),
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    refs: z.array(z.string()).optional(),
  })
  .strict();
export type ContentCall = z.infer<typeof ContentCallSchema>;

export const ApiCallSchema = z.union([FactCallSchema, ContentCallSchema]);
export type ApiCall = z.infer<typeof ApiCallSchema>;

/** 诊断码封闭集合（13 码）；新增 / 删改必须改协议。 */
export const DIAGNOSTIC_CODES = [
  "unknown_tool",
  "invalid_arguments",
  "unknown_reference",
  "precondition_failed",
  "numeric_out_of_range",
  "state_conflict",
  "visibility_violation",
  "idempotency_conflict",
  "budget_exceeded",
  "timeout",
  "provider_unavailable",
  "retry_exhausted",
  "duplicate_invocation",
] as const;
export const DiagnosticCodeSchema = z.enum(DIAGNOSTIC_CODES);
export type DiagnosticCode = z.infer<typeof DiagnosticCodeSchema>;

export const CallOutcomeSchema = z.enum(["accepted", "rejected", "deferred"]);
export type CallOutcome = z.infer<typeof CallOutcomeSchema>;

export const CallReceiptSchema = z
  .object({
    callId: z.string().min(1),
    outcome: CallOutcomeSchema,
    code: DiagnosticCodeSchema.optional(),
    detail: z.string().optional(),
    changes: z.array(z.string()).optional(),
    factsHint: z.array(z.string()).optional(),
  })
  .strict();
export type CallReceipt = z.infer<typeof CallReceiptSchema>;

export const DispatchContextSchema = z
  .object({
    turnIndex: z.number().int().nonnegative(),
    worldTime: z.number().int(),
    actor: ObserverIdSchema.optional(),
    invocationId: z.string().min(1).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();
export type DispatchContext = z.infer<typeof DispatchContextSchema>;

/** dispatch 的结果：一组回执 + 处理后的权威状态。 */
export interface DispatchResult {
  receipts: CallReceipt[];
  state: WorldStateV2;
}

/** 引擎 API 句柄：窗口计算（buildFacts）归 game-core 所有。 */
export interface EngineApiHandle {
  dispatch(calls: ApiCall[], ctx: DispatchContext): Promise<DispatchResult> | DispatchResult;
  snapshot(): V2Snapshot;
  buildFacts(perspective: Perspective): PerspectiveFactView;
}
