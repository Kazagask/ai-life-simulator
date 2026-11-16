import {
  type AgentChatRequest,
  type AgentCompletion,
  type AgentMessage,
  type AgentProvider,
  type ToolCallRequest,
  type ToolDescriptor,
} from "../tool-registry.js";
import { AgentProviderError } from "./errors.js";

/**
 * 真实 OpenAI 兼容 chat-completions（`tools` + `tool_choice: "auto"`）。
 *
 * 两条路径，**产出形状完全一致**（`AgentCompletion`）：
 * - 完整响应（缺省，`stream: false`）：解析 `choices[0].message.tool_calls`；
 * - 流式（调用方提供 `req.onDelta` 时，`stream: true`）：逐行解析 SSE，
 *   `delta.content` 累积并即时回调，`delta.tool_calls` 按 `index` 累积拼装，
 *   流结束后走**同一套**收尾逻辑生成 `AgentCompletion`。
 *
 * 硬不变量：
 * - 只用全局 `fetch` + `AbortSignal.timeout` + 内置 `ReadableStream`，零新依赖。
 * - 工具调用**只**从结构化 `tool_calls` / `delta.tool_calls` 读取；
 *   `function.arguments` 是**字符串分片**，必须按序拼完再 `JSON.parse`（中途 parse 必炸）。
 * - `usage` 在流式下常缺失 ⇒ 与完整响应共用 `estimateTokens` 回退，绝不出 `undefined`。
 * - 任何日志 / 错误文本都不包含 apiKey（provider 错误体也做脱敏）。
 */

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 测试注入用；缺省走全局 fetch。 */
  fetchImpl?: typeof fetch;
}

interface OpenAiToolCall {
  id?: unknown;
  /** 流式分片才有：同一条 tool_call 的分片索引。 */
  index?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

interface OpenAiMessage {
  content?: unknown;
  tool_calls?: unknown;
}

interface OpenAiDelta {
  content?: unknown;
  tool_calls?: unknown;
}

interface OpenAiUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
}

interface OpenAiResponse {
  choices?: Array<{
    message?: OpenAiMessage;
    delta?: OpenAiDelta;
    finish_reason?: unknown;
  }>;
  usage?: OpenAiUsage;
}

/** 流式累积中的一条 tool_call：`name` / `arguments` 都是逐片拼接的字符串。 */
interface ToolCallAccumulator {
  id?: string;
  name: string;
  args: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asUsage = (v: unknown): OpenAiUsage | undefined =>
  isRecord(v) ? (v as OpenAiUsage) : undefined;

function toOpenAiMessages(messages: readonly AgentMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      return {
        role: "assistant",
        content: message.content ?? null,
        tool_calls: message.toolCalls!.map((call) => ({
          id: call.id,
          type: "function",
          // 与 `toOpenAiTools` 同一张映射：回放的 assistant 历史里也必须用出网名，
          // 否则网关会看到「历史里叫 content.writeNarrative、工具表里叫
          // content_writeNarrative」两套名字，重试轮直接 400。
          function: { name: toWireName(call.name), arguments: JSON.stringify(call.arguments) },
        })),
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId ?? message.name ?? "unknown",
        content: message.content ?? "",
      };
    }
    return { role: message.role, content: message.content ?? "" };
  });
}

/**
 * 工具名出网映射：OpenAI 规范（以及绝大多数兼容网关）要求 function name 只含
 * `[a-zA-Z0-9_-]`、最长 64，**不允许点号**。我们内部用点号分层（`content.writeNarrative`
 * / `fact.enqueueEvent`），这是可读性与分组的好处，但在线上一律转成下划线：
 * `content_writeNarrative`。
 *
 * 只在**这一层边界**转换：内部（模板画像、注册表、trace、测试）仍用点号，模型看到的
 * 是下划线，收回来时按同一张表转回。不转的话实测会被网关直接 400：
 * `tool name "content.writeNarrative" is invalid (allowed: letters, digits, "_" and "-")`
 * —— 这条以前被 mock 掩盖了（mock 不校验名字）。
 */
function toWireName(name: string): string {
  return name.replace(/\./g, "_");
}

/** 本次请求的 出网名 → 内部名 反查表（由 tools 列表唯一确定，不依赖全局约定）。 */
function wireNameMap(tools: readonly ToolDescriptor[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of tools) map.set(toWireName(tool.name), tool.name);
  return map;
}

function toOpenAiTools(tools: readonly ToolDescriptor[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: toWireName(tool.name),
      description: tool.description ?? "",
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  }));
}

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 2));

/**
 * 完整响应与流式共用的收尾：raw calls → `ToolCallRequest[]` + token 统计 + finishReason。
 * 两条路径都走这里，保证 `AgentCompletion` 形状 / 校验 / 回退口径只有一份。
 */
function buildCompletion(input: {
  rawCalls: readonly OpenAiToolCall[];
  text: string | undefined;
  finish: unknown;
  usage: OpenAiUsage | undefined;
  req: AgentChatRequest;
}): AgentCompletion {
  const toolCalls: ToolCallRequest[] = input.rawCalls.map((raw, index) => {
    const wireName = raw.function?.name;
    if (typeof wireName !== "string" || wireName.length === 0) {
      throw new AgentProviderError("invalid_arguments", "tool_call 缺少 function.name");
    }
    // 出网名 → 内部名（点号形式）。未知名字原样保留，交给第 1 层校验报 unknown_tool。
    const name = wireNameMap(input.req.tools).get(wireName) ?? wireName;
    const rawArgs = raw.function?.arguments;
    let parsedArgs: unknown;
    if (typeof rawArgs === "string") {
      if (rawArgs.trim().length === 0) {
        parsedArgs = {};
      } else {
        try {
          parsedArgs = JSON.parse(rawArgs);
        } catch {
          throw new AgentProviderError(
            "invalid_arguments",
            `tool_call ${name} 的 arguments 不是合法 JSON`,
          );
        }
      }
    } else if (isRecord(rawArgs)) {
      parsedArgs = rawArgs;
    } else {
      parsedArgs = {};
    }
    if (!isRecord(parsedArgs)) {
      throw new AgentProviderError("invalid_arguments", `tool_call ${name} 的 arguments 不是对象`);
    }
    return {
      id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : `tool-${index}`,
      name,
      arguments: parsedArgs,
    };
  });

  const finishReason: AgentCompletion["finishReason"] =
    toolCalls.length > 0 ? "tool_calls" : input.finish === "length" ? "length" : "stop";

  const promptTokens = input.usage?.prompt_tokens;
  const completionTokens = input.usage?.completion_tokens;
  return {
    toolCalls,
    ...(input.text !== undefined ? { text: input.text } : {}),
    inputTokens:
      typeof promptTokens === "number"
        ? promptTokens
        : estimateTokens(JSON.stringify(input.req.messages)),
    outputTokens:
      typeof completionTokens === "number"
        ? completionTokens
        : estimateTokens(input.text ?? JSON.stringify(toolCalls)),
    finishReason,
  };
}

export class OpenAiCompatibleProvider implements AgentProvider {
  readonly id = "openai-compatible" as const;
  private readonly options: OpenAiCompatibleOptions;

  constructor(options: OpenAiCompatibleOptions) {
    this.options = options;
  }

  private endpoint(): string {
    const base = this.options.baseUrl.replace(/\/+$/, "");
    return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  }

  async chat(req: AgentChatRequest): Promise<AgentCompletion> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const timeoutMs = Math.max(1, req.timeoutMs);
    // 只有调用方显式要增量才走流式；缺省（loop / 现有测试）行为零变化。
    const streaming = req.onDelta !== undefined;
    const body = {
      model: this.options.model,
      messages: toOpenAiMessages(req.messages),
      tools: toOpenAiTools(req.tools),
      tool_choice: "auto",
      temperature: 0,
      ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}),
    };

    let response: Response;
    if (process.env.LIFE_SIM_DEBUG_LLM === "1") {
      // 诊断：把实际出网请求（脱敏后）打到 stderr，定位"模型为什么发空参数"这类问题。
      console.error("[llm-req]", this.redact(JSON.stringify(body)).slice(0, 2500));
    }
    try {
      // 外部取消信号（客户端断开）与单次调用超时**取并集**：传 signal 不等于放弃时限。
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      response = await doFetch(this.endpoint(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: req.signal === undefined ? timeoutSignal : AbortSignal.any([req.signal, timeoutSignal]),
      });
    } catch (err) {
      throw transportError(err);
    }

    // 流式请求失败时 provider 常返回普通 JSON 错误体；两条路径共用同一份映射。
    if (!response.ok) {
      throw await this.httpError(response);
    }

    return streaming ? this.readStream(response, req) : this.readJson(response, req);
  }

  /** 非流式：一次性读完 JSON，交给 `buildCompletion`。 */
  private async readJson(response: Response, req: AgentChatRequest): Promise<AgentCompletion> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AgentProviderError("provider_unavailable", "provider 响应不是合法 JSON");
    }
    const root = isRecord(payload) ? (payload as OpenAiResponse) : {};
    const choice = root.choices?.[0];
    const message = choice?.message;
    if (message === undefined) {
      throw new AgentProviderError("provider_unavailable", "provider 响应缺少 choices[0].message");
    }

    return buildCompletion({
      rawCalls: Array.isArray(message.tool_calls) ? (message.tool_calls as OpenAiToolCall[]) : [],
      text: typeof message.content === "string" ? message.content : undefined,
      finish: choice?.finish_reason,
      usage: root.usage,
      req,
    });
  }

  /**
   * 流式：逐行解析 SSE（`data: {...}`，`[DONE]` 结束）。
   * - `delta.content` 累积并即时 `onDelta`；
   * - `delta.tool_calls` 按 `index` 累积（`id` 取首片，`name` / `arguments` 按序拼接）；
   * - 流中断（提前关闭 / 缺 `[DONE]`）⇒ 已流出的正文不回收，整批 tool_calls 丢弃，
   *   折算成 `provider_unavailable`（由 loop 捕获成诊断，不向外抛原始异常）。
   */
  private async readStream(response: Response, req: AgentChatRequest): Promise<AgentCompletion> {
    const stream = response.body;
    if (stream === null) {
      throw new AgentProviderError("provider_unavailable", "provider 流式响应缺少 body");
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const accumulators = new Map<number, ToolCallAccumulator>();
    let text = "";
    let finish: unknown;
    let usage: OpenAiUsage | undefined;
    let buffer = "";
    let sawDone = false;

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      // 空行是事件分隔符；`:` 开头是 SSE 注释（keep-alive）。
      if (trimmed.length === 0 || trimmed.startsWith(":")) return;
      if (!trimmed.startsWith("data:")) return; // event: / id: / retry: 一律忽略
      const data = trimmed.slice("data:".length).trim();
      if (data.length === 0) return;
      if (data === "[DONE]") {
        sawDone = true;
        return;
      }

      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        throw new AgentProviderError("provider_unavailable", "流式分片不是合法 JSON");
      }
      const root = isRecord(chunk) ? (chunk as OpenAiResponse) : {};
      const chunkUsage = asUsage(root.usage);
      if (chunkUsage !== undefined) usage = chunkUsage;

      const choice = root.choices?.[0];
      if (choice === undefined) return;
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        finish = choice.finish_reason;
      }
      const delta = choice.delta;
      if (delta === undefined) return;

      if (typeof delta.content === "string" && delta.content.length > 0) {
        text += delta.content;
        req.onDelta?.({ text: delta.content });
      }

      const calls = Array.isArray(delta.tool_calls)
        ? (delta.tool_calls as OpenAiToolCall[])
        : [];
      for (const call of calls) {
        const index = typeof call.index === "number" ? call.index : 0;
        let slot = accumulators.get(index);
        if (slot === undefined) {
          slot = { name: "", args: "" };
          accumulators.set(index, slot);
        }
        if (typeof call.id === "string" && call.id.length > 0 && slot.id === undefined) {
          slot.id = call.id;
        }
        const nameDelta = call.function?.name;
        if (typeof nameDelta === "string") slot.name += nameDelta;
        const argsDelta = call.function?.arguments;
        if (typeof argsDelta === "string") slot.args += argsDelta;
      }
    };

    try {
      while (!sawDone) {
        const { value, done } = await reader.read();
        if (done === true) break;
        if (value === undefined) continue;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0 && !sawDone) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          handleLine(line);
          newline = buffer.indexOf("\n");
        }
      }
      // 末行可能没有换行符；`[DONE]` 之后不再处理残余。
      if (!sawDone && buffer.trim().length > 0) handleLine(buffer);
    } catch (err) {
      if (err instanceof AgentProviderError) throw err;
      // 连接中断 / abort / 超时在 read() 里表现为 DOMException，统一折算。
      throw transportError(err);
    } finally {
      if (!sawDone) {
        try {
          await reader.cancel();
        } catch {
          // 已关闭的流 cancel 会抛；忽略。
        }
      }
    }

    if (!sawDone) {
      // 半截 tool_calls 的 arguments 没有意义 ⇒ 整批丢弃；正文已由 onDelta 送达。
      throw new AgentProviderError("provider_unavailable", "流式响应意外结束（缺少 [DONE]）");
    }

    const rawCalls: OpenAiToolCall[] = [...accumulators.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, slot]) => ({
        ...(slot.id !== undefined ? { id: slot.id } : {}),
        type: "function",
        function: { name: slot.name, arguments: slot.args },
      }));

    return buildCompletion({ rawCalls, text: text.length > 0 ? text : undefined, finish, usage, req });
  }

  /** HTTP 非 2xx → 诊断码（两条路径唯一一份映射），错误体脱敏后附在 message 尾部。 */
  private async httpError(response: Response): Promise<AgentProviderError> {
    const code = response.status === 400 ? "invalid_arguments" : "provider_unavailable";
    let suffix = "";
    try {
      const raw = (await response.text()).trim();
      if (raw.length > 0) suffix = `: ${this.redact(raw).slice(0, 200)}`;
    } catch {
      // 读不到 body 不影响诊断码
    }
    return new AgentProviderError(code, `provider HTTP ${response.status}${suffix}`);
  }

  private redact(text: string): string {
    const key = this.options.apiKey;
    return key.length === 0 ? text : text.split(key).join("***");
  }
}

/** 网络层异常 → 诊断码（超时 / 不可用），绝不把原始异常抛给 loop 之外的调用方。 */
function transportError(err: unknown): AgentProviderError {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new AgentProviderError("timeout", "provider 请求超时");
  }
  return new AgentProviderError("provider_unavailable", "provider 网络不可用");
}
