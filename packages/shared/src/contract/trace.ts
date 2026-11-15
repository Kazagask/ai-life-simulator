import { z } from "zod";
import { CallReceiptSchema, DiagnosticCodeSchema } from "./engine-api.js";

/**
 * trace 契约（F3）。
 *
 * ⚠ trace（append-only *.trace.jsonl）是 LLM 叙事正文的**唯一持久落点**。
 * 存档只保留 traceRef / contentRef，不放叙事正文（WorldStateV2 不含 contentLayer）。
 * 禁止写入：apiKey / session / 完整隐秘原文 / 完整 prompt。
 */

export const CallLogEntrySchema = z
  .object({
    callId: z.string().min(1),
    tool: z.string().min(1),
    argsHash: z.string().min(1),
    outcome: z.enum(["accepted", "rejected", "deferred"]),
    code: DiagnosticCodeSchema.optional(),
    latencyMs: z.number().nonnegative().optional(),
  })
  .strict();
export type CallLogEntry = z.infer<typeof CallLogEntrySchema>;

export const LlmTraceSchema = z
  .object({
    invocationId: z.string().min(1),
    turnIndex: z.number().int().nonnegative(),
    worldTime: z.number().int(),
    reason: z.string().min(1),
    contextHash: z.string().min(1),
    toolProfile: z.string().min(1),
    callsHash: z.string().min(1),
    receipts: z.array(CallReceiptSchema),
    diagnostics: z.array(DiagnosticCodeSchema),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    latencyMs: z.number().nonnegative(),
    outcome: z.enum(["committed", "fallback", "deferred"]),
    fallbackCode: DiagnosticCodeSchema.optional(),
    templateRef: z.string().min(1),
    /** 本条 trace 产出的内容块 id（正文存于 trace 记录的内容段，不进存档状态）。 */
    contentBlocks: z.array(z.string()).optional(),
  })
  .strict();
export type LlmTrace = z.infer<typeof LlmTraceSchema>;
