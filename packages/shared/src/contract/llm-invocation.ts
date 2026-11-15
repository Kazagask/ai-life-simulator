import { z } from "zod";
import { CallReceiptSchema, DiagnosticCodeSchema } from "./engine-api.js";
import { PerspectiveSchema } from "./perspective.js";

/**
 * LLM 调用契约（F3 / 稀疏参与）：core -> llm 回调，回程一律走引擎 API。
 * LLM 不直接写权威状态；LlmOutcome 只携带「已提交回执 / 回退 / 延后」三态。
 */

/** 预算默认值（封闭 schema，任何字段都可省，解析时补全）。 */
export const LlmBudgetSchema = z
  .object({
    maxToolRounds: z.number().int().nonnegative().default(6),
    retryLimit: z.number().int().nonnegative().default(2),
    perCallTimeoutMs: z.number().int().nonnegative().default(20000),
    invocationTimeoutMs: z.number().int().nonnegative().default(90000),
    turnLlmBudgetMs: z.number().int().nonnegative().default(120000),
    maxInputTokens: z.number().int().nonnegative().default(8000),
    maxOutputTokens: z.number().int().nonnegative().default(2000),
    maxTotalTokens: z.number().int().nonnegative().default(24000),
    recentTurns: z.number().int().nonnegative().default(6),
  })
  .strict();
export type LlmBudget = z.infer<typeof LlmBudgetSchema>;
export const DEFAULT_LLM_BUDGET: LlmBudget = LlmBudgetSchema.parse({});

export const ToolDescriptorSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

export const LlmInvocationSchema = z
  .object({
    invocationId: z.string().min(1),
    reason: z.string().min(1),
    context: z.record(z.string(), z.unknown()),
    tools: z.array(ToolDescriptorSchema),
    budget: LlmBudgetSchema.default({}),
    replyTo: z.literal("dispatch"),
    perspective: PerspectiveSchema,
    targetPerspective: PerspectiveSchema,
  })
  .strict();
export type LlmInvocation = z.infer<typeof LlmInvocationSchema>;

export const LlmOutcomeSchema = z.union([
  z
    .object({
      outcome: z.literal("committed"),
      invocationId: z.string().min(1),
      receipts: z.array(CallReceiptSchema),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("fallback"),
      invocationId: z.string().min(1),
      code: DiagnosticCodeSchema.optional(),
      reason: z.string().optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("deferred"),
      invocationId: z.string().min(1),
      reason: z.string().optional(),
    })
    .strict(),
]);
export type LlmOutcome = z.infer<typeof LlmOutcomeSchema>;

/** LLM 网关：invoke 返回结构化结果，绝不直接写 WorldStateV2。 */
export interface LlmGateway {
  invoke(inv: LlmInvocation): Promise<LlmOutcome>;
}
