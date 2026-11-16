import { z } from "zod";
import { ObserverIdSchema, PerspectiveSchema } from "./perspective.js";
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

/** 权威字段变更摘要（v2 §2.3）：结构化 { path, before?, after? }。 */
export const FactChangeSchema = z
  .object({
    path: z.string().min(1),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
  })
  .strict();
export type FactChange = z.infer<typeof FactChangeSchema>;

export const CallReceiptSchema = z
  .object({
    callId: z.string().min(1),
    outcome: CallOutcomeSchema,
    code: DiagnosticCodeSchema.optional(),
    detail: z.string().optional(),
    /** 权威字段变更摘要（结构化，trace / 档 1 取证用）。 */
    changes: z.array(FactChangeSchema).optional(),
    /** v2 §2.3：当前正确事实片段（结构化），供分支①带事实重生成。 */
    factsHint: z.record(z.string(), z.unknown()).optional(),
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
    /** v2 §2.3：本次 invocation 的观察窗口（可选，缺省 = targetPerspective）。 */
    perspective: PerspectiveSchema.optional(),
    /**
     * F4 权威验收窗口（必填）：dispatch 第 2 层只以它校验 content.* 的 refs[]，
     * 绝不采信 args 自带的窗口；args 若带 targetPerspective 且 !== 本值 ⇒ visibility_violation。
     */
    targetPerspective: PerspectiveSchema,
    /**
     * ADR-0038：本次 invocation 的分支能力声明（从 `LlmInvocation.context` 透传）。
     *
     * ⚠ 历史上的三态拒绝语义由已下线的 `fact.enqueueEvent` 实现；该工具下线后
     * 引擎侧没有消费者，本字段目前只作为「本轮可写分支」的能力信号随上下文透传。
     *
     * 只由 core 求值写进 `LlmInvocation`，**不接收**模型输出 / HTTP 请求体的拼接结果。
     */
    branchEventIds: z.array(z.string().min(1)).optional(),
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
  /** v2 §2.3：同步纯函数。异步只留在 LlmGateway.invoke / agent-runtime。 */
  dispatch(calls: ApiCall[], ctx: DispatchContext): DispatchResult;
  snapshot(): V2Snapshot;
  /**
   * 权威状态（**只读**）——仅供 `world.*` 只读工具回答"历史 / 线索"这类问题。
   *
   * 为什么不能只靠 `snapshot()`：快照是**投影**，不含 history 与 taskDag。
   * 但注意：读工具**不得**把这里的东西原样返回 —— 视角裁剪仍以投影为准，
   * 这个字段只用于补投影里没有、但属于玩家可见范围的派生查询。
   */
  readonly state?: WorldStateV2;
  buildFacts(perspective: Perspective): PerspectiveFactView;
  /**
   * 清掉「在飞 invocation」标记（投影的 `llmPending` 读它）。
   *
   * 可选：只有能承载异步回调的实现才需要提供。语义是**按 id 清**——
   * 玩家可能在 LLM 回来之前已经推进过回合，`pendingInvocation` 已被新一轮覆盖；
   * 这时清空会抹掉新一轮的标记，所以实现必须比对 `invocationId` 再决定是否清。
   *
   * 为什么需要它：invocation 是 fire-and-forget，失败（重试耗尽 / 超时 / provider 报错）
   * 不会走 `agent.submit`，若只在提交时清，`llmPending` 会永久为真、前端永远显示「AI 书写中」。
   */
  clearPending?(invocationId: string): void;
}
