import { z } from "zod";
import { CallReceiptSchema, DiagnosticCodeSchema } from "./engine-api.js";
import { PerspectiveSchema } from "./perspective.js";
import { ContentVisibilitySchema, ContentBlockSchema } from "./content-ref.js";

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

/**
 * 内容块元数据（v2 §5.4 :468 / §6.3.5-3）：每块强制带
 * { blockId, targetPerspective, refs[], visibility, maskText? }。
 * 该「仅元数据」形保留作结构说明 / 兼容引用；LlmTrace.contentBlocks 改带
 * 完整 ContentBlockSchema（正文 + 元数据一体，见下方），使叙事正文可持久化读回。
 */
export const ContentBlockMetaSchema = z
  .object({
    blockId: z.string().min(1),
    targetPerspective: PerspectiveSchema,
    refs: z.array(z.string()),
    visibility: ContentVisibilitySchema,
    maskText: z.string().optional(),
  })
  .strict();
export type ContentBlockMeta = z.infer<typeof ContentBlockMetaSchema>;

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
    /**
     * F3：本条 trace 产出的内容块（正文 + 元数据一体，完整 ContentBlockSchema）。
     * 叙事正文由此成为唯一持久落点；读回端点按请求者窗口过滤 / 掩码后下发。
     * 绝不把正文写进 WorldStateV2。
     */
    contentBlocks: z.array(ContentBlockSchema).optional(),
    /**
     * 本次 invocation 模型实际发出的工具调用（按发出顺序）。
     *
     * 为什么必须落盘：验收时要回答"模型到底传了什么"，而 `callsHash` 只是哈希、
     * 回执只有结果码。没有这一项，`story.submitBranch` 到底提交了什么只能靠
     * 反编译 `generatedEvents` 猜，而那是**编译后**的形态、不是模型的原始输入。
     *
     * `args` 是 provider 解析后的对象（不是 JSON 字符串），测试的 mock 可直接回放。
     * **必填**：没调工具时写 `[]`，强制每次 invocation 都把这一通道写全。
     */
    calls: z
      .array(
        z
          .object({
            tool: z.string().min(1),
            args: z.unknown(),
          })
          .strict(),
      ),
  })
  .strict();
export type LlmTrace = z.infer<typeof LlmTraceSchema>;
