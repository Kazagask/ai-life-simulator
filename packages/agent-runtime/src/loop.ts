import {
  LlmBudgetSchema,
  LlmTraceSchema,
  type ApiCall,
  type CallReceipt,
  type DiagnosticCode,
  type DispatchContext,
  type EngineApiHandle,
  type LlmBudget,
  type LlmInvocation,
  type LlmOutcome,
  type LlmTrace,
} from "@life-sim/shared";
import {
  buildContentTrace,
  createContentSink,
  isRetryable,
  type ContentSink,
} from "@life-sim/game-core";
import { sha256, stableStringify } from "./context.js";
import {
  toApiCall,
  validateToolCall,
  type AgentMessage,
  type AgentProvider,
  type AgentStreamDelta,
  type ToolCallRequest,
} from "./tool-registry.js";
import { AgentProviderError } from "./providers/errors.js";

/**
 * T-04：agentic 循环。一次 invocation 内多轮「模型 → 工具调用 → dispatch → 回执」，
 * 直到七种终止条件之一命中。所有权威写入只经 `engineApi.dispatch`。
 *
 * 硬不变量：
 * - 第 1 层校验（工具名 / 参数）失败 = FATAL，不消耗重试；
 * - 引擎回执里 RETRYABLE（visibility_violation / precondition_failed / …）走分支①：
 *   把回执 + `factsHint` 作为 `tool` 消息回灌，重生成，最多 `budget.retryLimit` 次；
 * - 任何终止路径都产出 `LlmTrace`，`runAgentLoop` 绝不向外抛异常；
 * - `traceRef` 只由 `traceRefFor` 生成（全包唯一生成点）。
 */

/** traceRef 的唯一生成点（全包只此一处出现 `trace:` 模板串）。 */
export function traceRefFor(invocationId: string): string {
  return `trace:${invocationId}`;
}

export interface AgentLoopDeps {
  provider: AgentProvider;
  /** 引擎 API；`sink` 用于把正文收进 trace（RpgEngineAPI 会提供）。 */
  engineApi: EngineApiHandle & { sink?: ContentSink };
  budget?: LlmBudget;
  templateRef?: string;
  toolProfile?: string;
  contextHash?: string;
  /** 可选：trace 落点（网关负责调用；直接使用 loop 时可自接）。 */
  onTrace?: (trace: LlmTrace) => void;
  /**
   * 可选：正文增量**只转发**给调用方（提供 ⇒ provider 走流式，缺省 ⇒ 完整响应）。
   * 绝不写 sink / trace / state：F3 的正文仍然只在收尾时一次性进 trace。
   */
  onDelta?: (chunk: AgentStreamDelta) => void;
  /** 可选：外部取消（如 HTTP 客户端断开）；与每轮 `timeoutMs` 合并，不改变既有时限语义。 */
  signal?: AbortSignal;
  /** 仅用于测量延迟（不参与任何决策），测试可注入。 */
  now?: () => number;
}

export type LoopEndReason =
  | "submitted"
  | "no_tool_calls"
  | "max_tool_rounds"
  | "retry_exhausted"
  | "timeout"
  | "budget_exceeded"
  | "provider_unavailable"
  | "rejected_fatal";

interface EndState {
  reason: LoopEndReason;
  code?: DiagnosticCode;
  detail?: string;
}

/** 初始消息：system = stablePrefix（字节稳定），user = 结构化可见上下文。 */
function buildInitialMessages(inv: LlmInvocation): AgentMessage[] {
  const payload = {
    invocationId: inv.invocationId,
    reason: inv.reason,
    perspective: inv.perspective,
    targetPerspective: inv.targetPerspective,
    facts: inv.context.facts,
    recentTurns: inv.context.recentTurns,
    ...(inv.context.contextHints !== undefined ? { contextHints: inv.context.contextHints } : {}),
    ...(inv.context.secrets !== undefined ? { secrets: inv.context.secrets } : {}),
  };
  return [
    { role: "system", content: inv.context.stablePrefix },
    { role: "user", content: JSON.stringify(payload) },
  ];
}

/** provider 异常 → 13 码之一（超时 / 不可用 / 参数）。 */
function classifyProviderError(err: unknown): DiagnosticCode {
  if (err instanceof AgentProviderError) return err.code;
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  return "provider_unavailable";
}

function hashCalls(calls: readonly ApiCall[]): string {
  const normalized = calls.map((call) => ({
    callId: call.callId,
    tool: call.tool,
    args: call.args,
  }));
  return sha256(stableStringify(normalized));
}

function dedupeCodes(codes: readonly DiagnosticCode[]): DiagnosticCode[] {
  return [...new Set(codes)];
}

export async function runAgentLoop(
  inv: LlmInvocation,
  deps: AgentLoopDeps,
): Promise<{ outcome: LlmOutcome; trace: LlmTrace }> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const budget = LlmBudgetSchema.parse(deps.budget ?? inv.budget);
  const sink: ContentSink = deps.engineApi.sink ?? createContentSink();
  const templateRef = deps.templateRef ?? "template:inline";
  const toolProfile = deps.toolProfile ?? "default";
  const contextHash = deps.contextHash ?? sha256(stableStringify(inv.context));

  let turnIndex = 0;
  let worldTime = 0;
  try {
    const snapshot = deps.engineApi.snapshot();
    turnIndex = snapshot.turnIndex;
    worldTime = snapshot.worldTime;
  } catch {
    // snapshot 不可用不阻断循环；上下文仍可由调用方通过 world 时钟注入。
  }

  const dispatchCtx: DispatchContext = {
    turnIndex,
    worldTime,
    invocationId: inv.invocationId,
    ...(inv.perspective === "world" ? {} : { actor: inv.perspective }),
    perspective: inv.perspective,
    targetPerspective: inv.targetPerspective,
  };

  const messages = buildInitialMessages(inv);
  const allowed = new Set(inv.tools.map((tool) => tool.name));
  const allCalls: ApiCall[] = [];
  const receipts: CallReceipt[] = [];
  const diagnostics: DiagnosticCode[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let retries = 0;
  let end: EndState | null = null;

  const record = (code: DiagnosticCode): void => {
    if (!diagnostics.includes(code)) diagnostics.push(code);
  };

  for (let round = 0; round < budget.maxToolRounds; round += 1) {
    if (now() - startedAt >= budget.invocationTimeoutMs) {
      record("timeout");
      end = { reason: "timeout", code: "timeout", detail: "整个 invocation 超时" };
      break;
    }
    const remaining = Math.max(1, budget.invocationTimeoutMs - (now() - startedAt));
    const timeoutMs = Math.min(budget.perCallTimeoutMs, remaining);

    let completion;
    try {
      completion = await deps.provider.chat({
        messages,
        tools: inv.tools,
        timeoutMs,
        ...(deps.onDelta !== undefined ? { onDelta: deps.onDelta } : {}),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
    } catch (err) {
      const code = classifyProviderError(err);
      record(code);
      end = {
        reason: code === "timeout" ? "timeout" : "provider_unavailable",
        code,
        detail: err instanceof Error ? err.message : String(err),
      };
      break;
    }

    inputTokens += completion.inputTokens;
    outputTokens += completion.outputTokens;
    if (inputTokens + outputTokens > budget.maxTotalTokens || inputTokens > budget.maxInputTokens) {
      record("budget_exceeded");
      end = { reason: "budget_exceeded", code: "budget_exceeded", detail: "token 预算耗尽" };
      break;
    }

    if (completion.toolCalls.length === 0) {
      end = { reason: "no_tool_calls", detail: "provider 只返回文本，未发起工具调用" };
      break;
    }

    // ---------- 第 1 层：工具名 / 参数（FATAL，不消耗重试） ----------
    const valid: ToolCallRequest[] = [];
    let fatal: { call: ToolCallRequest; code: "unknown_tool" | "invalid_arguments"; detail: string } | null =
      null;
    for (const [index, call] of completion.toolCalls.entries()) {
      const verdict = validateToolCall(call, allowed);
      if (!verdict.ok) {
        fatal = { call, code: verdict.code, detail: verdict.detail };
        receipts.push({
          callId: `${inv.invocationId}:${round}:${index}`,
          outcome: "rejected",
          code: verdict.code,
          detail: verdict.detail,
        });
        break;
      }
      valid.push(call);
    }
    if (fatal !== null) {
      record(fatal.code);
      end = { reason: "rejected_fatal", code: fatal.code, detail: fatal.detail };
      break;
    }

    // ---------- 回程：一律 engineApi.dispatch ----------
    const calls: ApiCall[] = valid.map((call, index) =>
      toApiCall(call.name, call.arguments, {
        callId: `${inv.invocationId}:${round}:${index}`,
        targetPerspective: inv.targetPerspective,
      }),
    );
    allCalls.push(...calls);

    const result = deps.engineApi.dispatch(calls, dispatchCtx);
    receipts.push(...result.receipts);

    const submitted = result.receipts.some(
      (receipt, index) => valid[index]?.name === "content.submit" && receipt.outcome === "accepted",
    );
    if (submitted) {
      end = { reason: "submitted" };
      break;
    }

    messages.push({
      role: "assistant",
      toolCalls: valid.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    });
    for (const [index, receipt] of result.receipts.entries()) {
      const call = valid[index];
      if (call === undefined) continue;
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify({
          outcome: receipt.outcome,
          ...(receipt.code !== undefined ? { code: receipt.code } : {}),
          ...(receipt.detail !== undefined ? { detail: receipt.detail } : {}),
          ...(receipt.factsHint !== undefined ? { factsHint: receipt.factsHint } : {}),
        }),
      });
    }

    // ---------- 分支①：RETRYABLE 回执 → 带 factsHint 重生成 ----------
    const retryable = result.receipts.filter(
      (receipt) => receipt.outcome === "rejected" && receipt.code !== undefined && isRetryable(receipt.code),
    );
    if (retryable.length > 0) {
      for (const receipt of retryable) record(receipt.code!);
      if (retries >= budget.retryLimit) {
        record("retry_exhausted");
        end = { reason: "retry_exhausted", code: "retry_exhausted", detail: "重试额度耗尽" };
        break;
      }
      retries += 1;
      continue;
    }

    // 引擎层面的不可重试拒绝（如 idempotency_conflict）也终止，避免死循环。
    const fatalRejections = result.receipts.filter(
      (receipt) =>
        receipt.outcome === "rejected" && receipt.code !== undefined && !isRetryable(receipt.code),
    );
    if (fatalRejections.length > 0) {
      for (const receipt of fatalRejections) record(receipt.code!);
      end = {
        reason: "rejected_fatal",
        code: fatalRejections[0]!.code,
        detail: fatalRejections[0]!.detail,
      };
      break;
    }
  }

  if (end === null) {
    end = { reason: "max_tool_rounds", detail: `达到 ${budget.maxToolRounds} 轮上限` };
  }

  const outcome: "committed" | "fallback" = end.reason === "submitted" ? "committed" : "fallback";
  const latencyMs = Math.max(0, now() - startedAt);
  const base = buildContentTrace(sink, {
    invocationId: inv.invocationId,
    turnIndex,
    worldTime,
    reason: inv.reason,
    toolProfile,
    templateRef,
  });

  const candidate = {
    ...base,
    contextHash,
    callsHash: hashCalls(allCalls),
    receipts,
    diagnostics: dedupeCodes(diagnostics),
    inputTokens,
    outputTokens,
    latencyMs,
    outcome,
    ...(outcome === "fallback" && end.code !== undefined ? { fallbackCode: end.code } : {}),
  };

  const parsed = LlmTraceSchema.safeParse(candidate);
  const trace: LlmTrace = parsed.success ? parsed.data : coerceTrace(candidate, inv);

  if (deps.onTrace !== undefined) {
    try {
      deps.onTrace(trace);
    } catch {
      // trace 回调失败绝不外抛；诊断已由 LlmTraceSchema 之外的调用方（网关）记录。
    }
  }

  if (outcome === "committed") {
    return {
      outcome: {
        outcome: "committed",
        invocationId: inv.invocationId,
        receipts,
        traceRef: traceRefFor(inv.invocationId),
      },
      trace,
    };
  }
  return {
    outcome: {
      outcome: "fallback",
      invocationId: inv.invocationId,
      ...(end.code !== undefined ? { code: end.code } : {}),
      ...(end.detail !== undefined ? { reason: end.detail } : { reason: end.reason }),
      traceRef: traceRefFor(inv.invocationId),
    },
    trace,
  };
}

/** 兜底：万一组装出的 trace 过不了 schema，用最小合法字段重建（仍不抛异常）。 */
function coerceTrace(candidate: Record<string, unknown>, inv: LlmInvocation): LlmTrace {
  return {
    invocationId: inv.invocationId,
    turnIndex: typeof candidate.turnIndex === "number" ? candidate.turnIndex : 0,
    worldTime: typeof candidate.worldTime === "number" ? candidate.worldTime : 0,
    reason: inv.reason,
    contextHash:
      typeof candidate.contextHash === "string" && candidate.contextHash.length > 0
        ? candidate.contextHash
        : "sha256:unknown",
    toolProfile:
      typeof candidate.toolProfile === "string" && candidate.toolProfile.length > 0
        ? candidate.toolProfile
        : "default",
    callsHash:
      typeof candidate.callsHash === "string" && candidate.callsHash.length > 0
        ? candidate.callsHash
        : "sha256:unknown",
    receipts: [],
    diagnostics: [],
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: typeof candidate.latencyMs === "number" ? candidate.latencyMs : 0,
    outcome: candidate.outcome === "committed" ? "committed" : "fallback",
    templateRef:
      typeof candidate.templateRef === "string" && candidate.templateRef.length > 0
        ? candidate.templateRef
        : "template:inline",
  };
}
