import {
  isReadTool,
} from "./read-tools.js";
import {
  LlmBudgetSchema,
  LlmTraceSchema,
  type ApiCall,
  type CallReceipt,
  type ContentBlock,
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
  /** 只读查询入口（world.* 工具）。缺省时读工具会回一条 error，不影响其他路径。 */
  readWorld?: (name: string, args: Record<string, unknown>) => unknown;
  /** 仅用于测量延迟（不参与任何决策），测试可注入。 */
  now?: () => number;
}

export type LoopEndReason =
  /**
   * `completed` = **自然退出**：模型不再发 tool call，且本轮有过成功写入。
   * 这是现在唯一的"正常完成"路径（`submitted` 保留只为兼容旧 trace）。
   */
  | "completed"
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

/** 分支白名单的固定引导语（锁 7 的断言锚点：不给白名单时整句不得出现）。 */
export const BRANCH_PROMPT_LEAD = "本轮你最多可以把下列事件之一摆上桌";

/**
 * 初始消息：system = stablePrefix（字节稳定），user = 结构化可见上下文。
 *
 * ADR-0038 R8：user 段用 spread 展开整个 `LlmContext`（**挖掉 `stablePrefix`**，
 * 它已作为 system 消息单独发送，重复一遍只会白烧 token）。这样以后 `LlmContext`
 * 加字段会自动进 prompt，不会再出现「字段有了但 provider / 真模型看不到」这类静默失能。
 *
 * `branchEventIds` 额外渲染成一句固定引导语：真实模型必须知道「本轮可以摆什么」，
 * 否则白名单只是锁住能力却不给钥匙 —— 只有 mock 能演。
 */
function buildInitialMessages(inv: LlmInvocation): AgentMessage[] {
  const { stablePrefix: _stablePrefix, ...rest } = inv.context;
  const branchEventIds = inv.context.branchEventIds;
  const payload = {
    invocationId: inv.invocationId,
    reason: inv.reason,
    perspective: inv.perspective,
    targetPerspective: inv.targetPerspective,
    ...rest,
    ...(branchEventIds !== undefined && branchEventIds.length > 0
      ? {
          branchInstruction: `${BRANCH_PROMPT_LEAD}：${branchEventIds.join("、")}；不在列表内的一律被拒绝。`,
        }
      : {}),
  };
  return [
    { role: "system", content: inv.context.stablePrefix },
    { role: "user", content: JSON.stringify(payload) },
  ];
}

/** provider 异常 → 14 码之一（超时 / 不可用 / 参数）。 */
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

/**
 * 格式清洗：把**排版噪声**去掉，不动语义、不改写句子。
 *
 * 真实模型（glm-5.3）会稳定犯两类格式错，靠提示词压不住：
 * - 用 ASCII 引号写对话（`"南"`），读起来像代码；中文散文该用「」；
 * - 段落开头带 markdown 标记（`**`、`#`、`- `、`1. `），在正文里就是符号噪声。
 *
 * 全部是确定性替换：同一输入必得同一输出。
 */
function sanitizeNarrative(text: string): string {
  let out = text;
  // ASCII 成对双引号 → 中文引号（只处理成对的，落单的不动，避免误伤）。
  out = out.replace(/"([^"\n]{1,120})"/g, "「$1」");
  // 行首 markdown 标记（列表 / 标题 / 引用 / 加粗）。
  out = out
    .split(/\n/)
    .map((line) => line.replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/, ""))
    .join("\n");
  // 行内加粗 / 斜体 / 代码标记。
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/`([^`\n]+)`/g, "$1");
  return out;
}

/** 正文字符上限（缺省）：超过就按段落边界截断（保留整段，不切半句）。 */
export const NARRATIVE_MAX_CHARS = 420;

/**
 * 正文后处理：**去重 + 限长**。
 *
 * 两种真实模型行为（glm-5.3 实测）会让正文变脏，而它们都不是"内容问题"、是"格式问题"：
 * 1. **整段复读**：模型把同一段话写两遍（一次 invocation 里自问自答式重来），
 *    直接上屏就是"你坐回椅子上……你坐回椅子上……"；
 * 2. **超长**：契约写了 80–220 字，模型常常写到 500+。
 *
 * 处理方式是确定性的（同输入同输出）：
 * - 按空行切段，**按首现顺序保留唯一的段**（重复段直接丢，不做相似度判断）；
 * - 再按段落累加，超过 `NARRATIVE_MAX_CHARS` 就停（不截断半句）。
 */
function normalizeNarrative(
  text: string,
  maxChars: number = NARRATIVE_MAX_CHARS,
): { text: string; droppedParagraphs: number } {
  const cleaned = sanitizeNarrative(text);
  const paragraphs = cleaned
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of paragraphs) {
    if (seen.has(p)) continue;
    seen.add(p);
    unique.push(p);
  }
  const kept: string[] = [];
  let total = 0;
  for (const p of unique) {
    if (kept.length > 0 && total + p.length > maxChars) break;
    kept.push(p);
    total += p.length;
  }
  return {
    text: kept.join("\n\n"),
    droppedParagraphs: paragraphs.length - kept.length,
  };
}

/**
 * 从模型 content 中提取 `<narrative-content>` 块。
 *
 * 边界行为（写死在这里，免得上层各自解释）：
 * - **多块**：按出现顺序保留，非空块用 `\n\n` 拼接；
 * - **嵌套**：非贪婪匹配，内层开标签会被当成外层正文的一部分（模板不承诺嵌套语义）；
 * - **未闭合**：不匹配，整段算标签外内容（⇒ 无块，走 `narrative_tag_missing`）；
 * - **标签外内容**：一律丢弃，只统计非空白字符数用于诊断；
 * - **块内后处理**：去重 + 限长，见 `normalizeNarrative`。
 */
function extractNarrativeContent(
  raw: string,
  maxChars: number = NARRATIVE_MAX_CHARS,
): {
  text?: string;
  blockCount: number;
  outsideChars: number;
  droppedParagraphs: number;
} {
  const re = /<narrative-content>([\s\S]*?)<\/narrative-content>/g;
  const blocks: string[] = [];
  let lastIndex = 0;
  let outsideChars = 0;
  for (let match = re.exec(raw); match !== null; match = re.exec(raw)) {
    outsideChars += raw.slice(lastIndex, match.index).replace(/\s+/g, "").length;
    const inner = match[1]?.trim() ?? "";
    if (inner.length > 0) blocks.push(inner);
    lastIndex = match.index + match[0].length;
  }
  outsideChars += raw.slice(lastIndex).replace(/\s+/g, "").length;
  if (blocks.length === 0) return { blockCount: 0, outsideChars, droppedParagraphs: 0 };
  const joined = blocks.join("\n\n");
  const normalized = normalizeNarrative(joined, maxChars);
  return {
    ...(normalized.text.length > 0 ? { text: normalized.text } : {}),
    blockCount: blocks.length,
    outsideChars,
    droppedParagraphs: normalized.droppedParagraphs,
  };
}

export async function runAgentLoop(
  inv: LlmInvocation,
  deps: AgentLoopDeps,
): Promise<{ outcome: LlmOutcome; trace: LlmTrace }> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const budget = LlmBudgetSchema.parse(deps.budget ?? inv.budget);
  /**
   * 正文字符上限：模板在 `invoke.length` 里声明了篇幅就以它为准（章节小结 720 字这类），
   * 否则用逐拍旁白的 420。**不取 min** —— 声明更短时仍允许 420，避免模型已经写好却被砍掉半篇。
   */
  const narrativeMaxChars = Math.max(
    NARRATIVE_MAX_CHARS,
    inv.context.narrativeLength?.maxChars ?? 0,
  );
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
    // ADR-0038：唯一构造点 —— 整轮复用同一份 ctx，不在每个 tool call 里从 inv 重拼。
    // 这样「invocation 存续期间的权威描述」在物理上不会漂移。
    ...(inv.context.branchEventIds !== undefined
      ? { branchEventIds: [...inv.context.branchEventIds] }
      : {}),
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
  /** 本轮是否至少有一次写入被引擎接受（决定"自然退出"算完成还是失败）。 */
  /**
   * 模型实际发出的工具调用（按发出顺序，含同轮后来被校验拒绝的）：
   * `args` 保留 provider 解析后的对象，录制后可原样回放。
   * `callsHash` 只能证明"两次调用是否相同"，证明不了"它传了什么"。
   */
  const providerCalls: Array<{ tool: string; args: unknown }> = [];
  let wroteSomething = false;
  /** 本轮是否发生过只读查询（只读也算"模型真的在推进"，用于终止判定）。 */
  let readSomething = false;
  /** 跨轮累积的完整 content（正文只从 `<narrative-content>` 标签提取）。 */
  let accumulatedContent = "";
  /** 模型/脚本是否已显式发过 `agent.submit`（发过就不再补内部提交，避免多一条回执）。 */
  let submittedByModel = false;

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
    // 全量 content 必须留下来：`onDelta` 只是展示通道，收尾的正文块要从这里提取。
    if (completion.text !== undefined && completion.text.length > 0) {
      accumulatedContent += `${completion.text}\n`;
    }
    // `maxInputTokens` 是**单轮**上限、`maxTotalTokens` 才是累计口径
    // （REFACTOR-DESIGN §终止条件 4：「累计 token > maxTotalTokens 或单轮输入 > maxInputTokens」）。
    // 原来把累计值比到单轮上限：提示词每轮重发一遍，3 轮就必然超过 8000，
    // 于是任何需要 3 轮以上的 invocation 都会在第 3 轮被判 budget_exceeded。
    if (
      inputTokens + outputTokens > budget.maxTotalTokens ||
      completion.inputTokens > budget.maxInputTokens
    ) {
      record("budget_exceeded");
      end = { reason: "budget_exceeded", code: "budget_exceeded", detail: "token 预算耗尽" };
      break;
    }

    // 在 dispatch / 第 1 层校验之前落账：录的是模型**实际发出**的调用，
    // 不是引擎筛过一轮的 `valid`（否则 unknown_tool / 参数错误就看不到原始输入了）。
    for (const call of completion.toolCalls) {
      providerCalls.push({ tool: call.name, args: call.arguments });
    }

    if (completion.toolCalls.length === 0) {
      /**
       * **自然退出即完成**（2026-11-16 重设计，取消 `agent.submit` 工具）。
       *
       * 模型不再发 tool call ⇒ 它没有更多要写的了，这就是最可靠的终止信号。
       * 以前要求模型显式调 `content.submit`，于是多出一个真实故障模式：
       * 正文写好了但忘了提交 ⇒ 整轮作废。终止是**运行时的责任**，不是模型的责任。
       *
       * 判定：本轮只要有过被接受的写入，就算 committed；什么都没写才算失败。
       */
      const taggedNow = extractNarrativeContent(accumulatedContent, narrativeMaxChars);
      end =
        wroteSomething || readSomething || taggedNow.blockCount > 0
          ? { reason: "completed" }
          : {
              reason: "no_tool_calls",
              detail: "provider 只返回文本、未发起工具调用，且本轮没有任何成功的写入或叙事块",
            };
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
      // 诊断开关：真实模型接错参数时，trace 里只有错误码，看不到"它到底发了什么"。
      // 设 LIFE_SIM_DEBUG_LLM=1 才输出，默认静默（不影响生产日志）。
      if (process.env.LIFE_SIM_DEBUG_LLM === "1") {
        console.error(
          "[llm-fatal]",
          fatal.call.name,
          JSON.stringify(fatal.call.arguments).slice(0, 800),
          "|",
          fatal.detail,
        );
      }
      record(fatal.code);
      /**
       * 第 1 层失败**回灌给模型自己修**，不再直接判死。
       *
       * 理由（真实模型实测）：`glm-5.3` 第一次发 `story.submitBranch` 时 arguments 是
       * `{}`（空对象）——这不是"模型不会用工具"，而是**可修的一次格式错误**。原实现把它
       * 当 FATAL，结果是整轮 invocation 作废、玩家一个字都看不到；而模型只要看到
       * "缺 branch" 就能立刻补上。
       *
       * 边界：仍然受 `retryLimit` 约束（不额外消耗引擎 dispatch），且 `unknown_tool`
       * （模型编了个不存在的工具）也走这条路——把可用工具清单回灌比直接终止更有用。
       */
      messages.push({
        role: "assistant",
        toolCalls: [{ id: fatal.call.id, name: fatal.call.name, arguments: fatal.call.arguments }],
      });
      messages.push({
        role: "tool",
        toolCallId: fatal.call.id,
        name: fatal.call.name,
        content: JSON.stringify({
          outcome: "rejected",
          code: fatal.code,
          detail: fatal.detail,
          hint:
            fatal.code === "unknown_tool"
              ? `可用工具只有：${[...allowed].join(", ")}`
              : "参数未通过校验，请按工具 schema 补齐必填字段后重新调用。",
        }),
      });
      if (retries >= budget.retryLimit) {
        record("retry_exhausted");
        end = { reason: "retry_exhausted", code: "retry_exhausted", detail: "重试额度耗尽" };
        break;
      }
      retries += 1;
      continue;
    }

    /**
     * 回程分两路：
     * - **只读工具**不走 dispatch（它们不改世界），由 `deps.readWorld` 直接给答案；
     * - 其余一律 `engineApi.dispatch`（唯一权威写入口）。
     *
     * 两者都要回一条 tool 消息，且 callId 必须一一对应 —— 模型侧看到的是
     * "我发了 N 个调用，收到了 N 条结果"，否则下一轮会错位。
     */
    const readCalls = valid.filter((call) => isReadTool(call.name));
    const writeCalls = valid.filter((call) => !isReadTool(call.name));

    // 引擎侧 callId 保持 `inv:round:index` 形状（trace / 测试 / 回放都依赖它），
    // 再建一张 引擎 callId → provider call.id 的映射，供回填 tool 消息用。
    const writeEntries = writeCalls.map((call, index) => ({
      call,
      engineCallId: `${inv.invocationId}:${round}:${index}`,
    }));
    const calls: ApiCall[] = writeEntries.map((entry) =>
      toApiCall(entry.call.name, entry.call.arguments, { callId: entry.engineCallId }),
    );
    allCalls.push(...calls);

    const result =
      calls.length > 0 ? deps.engineApi.dispatch(calls, dispatchCtx) : { receipts: [] };
    receipts.push(...result.receipts);

    const receiptByEngineCallId = new Map(result.receipts.map((receipt) => [receipt.callId, receipt]));
    const receiptByProviderId = new Map(
      writeEntries.map((entry) => [entry.call.id, receiptByEngineCallId.get(entry.engineCallId)]),
    );
    if (result.receipts.some((receipt) => receipt.outcome === "accepted")) wroteSomething = true;
    // 兼容：模型/旧脚本若显式发了 `agent.submit`，就直接收工（它已不在工具面上，
    // 但内部调用与回放仍可能出现）。
    if (
      writeCalls.some(
        (call) =>
          call.name === "agent.submit" && receiptByProviderId.get(call.id)?.outcome === "accepted",
      )
    ) {
      submittedByModel = true;
      end = { reason: "submitted" };
      break;
    }
    // 只读查询也算"有产出"（模型确实在推进），但不算写入；单独给一个标记用于终止判定。
    if (readCalls.length > 0) readSomething = true;

    messages.push({
      role: "assistant",
      ...(completion.text !== undefined ? { content: completion.text } : {}),
      toolCalls: valid.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    });
    // 每个调用都要有一条 tool 消息，顺序与 assistant.toolCalls 一致。
    for (const call of valid) {
      if (isReadTool(call.name)) {
        const answer =
          deps.readWorld === undefined
            ? { error: "本运行时没有挂载只读查询（readWorld 未注入）" }
            : deps.readWorld(call.name, call.arguments);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify(answer),
        });
        continue;
      }
      const receipt = receiptByProviderId.get(call.id);
      if (receipt === undefined) continue;
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

  /**
   * 收尾：把"提交"作为**运行时内部动作**补上（`agent.submit` 已不在模型的工具面上）。
   *
   * 它的职责只剩引擎侧记账：写 `state.traceRef`、清 `pendingInvocation`。
   * 模型不需要知道这件事存在 —— 这正是"终止是运行时责任"的落点。
   */
  if (wroteSomething && !submittedByModel) {
    const submitCall = {
      callId: `${inv.invocationId}:auto-submit`,
      tool: "agent.submit",
      args: { blockIds: [] },
    };
    allCalls.push(submitCall);
    const submitted = deps.engineApi.dispatch([submitCall], dispatchCtx);
    receipts.push(...submitted.receipts);
  }

  if (end === null) {
    // 达到轮数上限：写过东西就算完成（内容已经在 trace 里），什么都没写才算失败。
    end = wroteSomething
      ? { reason: "completed" }
      : { reason: "max_tool_rounds", detail: `达到 ${budget.maxToolRounds} 轮上限` };
  }

  const outcome: "committed" | "fallback" =
    end.reason === "completed" || end.reason === "submitted" ? "committed" : "fallback";

  /**
   * 正文只认 `<narrative-content>` 标签：
   * - 有块 ⇒ 合成**一个** narrative ContentBlock 进 sink（trace 落盘，读侧按既有窗口投影）；
   * - 无块且本次没有别的 narrative 块 ⇒ 记 `narrative_tag_missing`（**含 fallback**：只要模型
   *   产出了文本就算不守规矩），**不**把标签外文本当正文（思维链 / 工具报错绝不透给玩家）；
   *   玩家侧回退模板事件文案。
   * - fallback 收尾不落块：前端会清掉草稿，避免半截正文。
   */
  const narrative = extractNarrativeContent(accumulatedContent, narrativeMaxChars);
  const hasNarrativeBlock = sink.list().some((block) => block.kind === "narrative");
  if (outcome === "committed" && narrative.text !== undefined) {
    const block: ContentBlock = {
      blockId: `${inv.invocationId}:narrative`,
      kind: "narrative",
      text: narrative.text,
      refs: [],
      visibility: "public",
      targetPerspective: "player",
    };
    sink.append(block);
  } else if (
    narrative.text === undefined &&
    !hasNarrativeBlock &&
    accumulatedContent.trim().length > 0
  ) {
    // 模型确实产出了文本但没有标签：即使整轮 fallback，也要把"不守规矩"记下来。
    record("narrative_tag_missing");
    if (process.env.LIFE_SIM_DEBUG_LLM === "1") {
      console.warn("[narrative-tag-missing]", { outsideChars: narrative.outsideChars });
    }
  }

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
    calls: providerCalls,
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
    calls: [],
  };
}
