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
 * - 只用全局 `fetch` + `AbortSignal.timeout`，零新依赖。
 * - 工具调用**只**从结构化 `choices[0].message.tool_calls` 读取，
 *   `function.arguments` 逐条 `JSON.parse`；解析失败 ⇒ `invalid_arguments`（FATAL 语义）。
 * - 任何日志 / 错误文本都不得包含 apiKey。
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
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

interface OpenAiMessage {
  content?: unknown;
  tool_calls?: unknown;
}

interface OpenAiResponse {
  choices?: Array<{ message?: OpenAiMessage; finish_reason?: unknown }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function toOpenAiMessages(messages: readonly AgentMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      return {
        role: "assistant",
        content: message.content ?? null,
        tool_calls: message.toolCalls!.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
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

function toOpenAiTools(tools: readonly ToolDescriptor[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  }));
}

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 2));

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
    const body = {
      model: this.options.model,
      messages: toOpenAiMessages(req.messages),
      tools: toOpenAiTools(req.tools),
      tool_choice: "auto",
      temperature: 0,
    };

    let response: Response;
    try {
      response = await doFetch(this.endpoint(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: req.signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: unknown } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new AgentProviderError("timeout", "provider 请求超时");
      }
      throw new AgentProviderError("provider_unavailable", "provider 网络不可用");
    }

    if (!response.ok) {
      throw new AgentProviderError(
        response.status === 400 ? "invalid_arguments" : "provider_unavailable",
        `provider HTTP ${response.status}`,
      );
    }

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

    const rawCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as OpenAiToolCall[]) : [];
    const toolCalls: ToolCallRequest[] = rawCalls.map((raw, index) => {
      const name = raw.function?.name;
      if (typeof name !== "string" || name.length === 0) {
        throw new AgentProviderError("invalid_arguments", "tool_call 缺少 function.name");
      }
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

    const text = typeof message.content === "string" ? message.content : undefined;
    const finish = choice?.finish_reason;
    const finishReason: AgentCompletion["finishReason"] =
      toolCalls.length > 0 ? "tool_calls" : finish === "length" ? "length" : "stop";

    const promptTokens = root.usage?.prompt_tokens;
    const completionTokens = root.usage?.completion_tokens;
    return {
      toolCalls,
      ...(text !== undefined ? { text } : {}),
      inputTokens: typeof promptTokens === "number" ? promptTokens : estimateTokens(JSON.stringify(req.messages)),
      outputTokens:
        typeof completionTokens === "number" ? completionTokens : estimateTokens(text ?? JSON.stringify(toolCalls)),
      finishReason,
    };
  }
}
