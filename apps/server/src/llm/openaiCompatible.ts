import type { NarrativeInput, NarrativeOutputSchemaLike } from "@life-sim/game-core";
import type { LLMProvider } from "./provider.js";
import { LLMUnavailableError } from "./errors.js";

/**
 * R2.7 · OpenAI 兼容 provider（R-LLM-06）：仅用 Node 22 全局 `fetch` + `AbortSignal.timeout`，
 * **不新增任何运行时依赖**。密钥只从服务端 env 注入，绝不硬编码 / 提交 / 写日志。
 */
export interface OpenAICompatibleConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 从 chat/completions 响应里取 content；形状不符返回 null（不猜测、不吞异常）。 */
function readMessageContent(payload: unknown): string | null {
  const root = asRecord(payload);
  const choices = root?.choices;
  if (!Array.isArray(choices)) return null;
  const list: readonly unknown[] = choices;
  const message = asRecord(asRecord(list[0])?.message);
  const content = message?.content;
  return typeof content === "string" ? content : null;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id = "openai-compatible" as const;
  private readonly config: OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    this.config = config;
  }

  /**
   * 返回**未校验**候选（只做 JSON 解析），结构校验一律交给
   * `validateNarrativeOutput`（game-core 单一事实来源）。
   * 错误 / 超时原样抛出，由编排层转 fallback；错误对象不含 apiKey。
   */
  async complete(
    request: NarrativeInput,
    schema: NarrativeOutputSchemaLike,
    opts?: { timeoutMs?: number },
  ): Promise<unknown> {
    void schema; // 校验不在 provider 层，避免与 game-core 形成第二份真源
    const timeoutMs = opts?.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const body = {
      model: this.config.model,
      stream: false,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "只能输出严格 JSON，字段以给定 schema 为准，不得输出额外字段，不得编造未发生的事实",
        },
        { role: "user", content: JSON.stringify(request) },
      ],
    };

    // fetch 抛出的 TimeoutError/AbortError 直接上抛，保证编排层能区分「超时」与「不可用」。
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // 只带状态码，不回显响应体（可能含上游诊断文本），也绝不带 key。
      throw new LLMUnavailableError(`openai-compatible: HTTP ${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LLMUnavailableError("openai-compatible: 响应不是合法 JSON");
    }
    const content = readMessageContent(payload);
    if (content === null) {
      throw new LLMUnavailableError("openai-compatible: 响应缺少 choices[0].message.content");
    }
    try {
      return JSON.parse(content) as unknown;
    } catch {
      throw new LLMUnavailableError("openai-compatible: LLM 输出不是合法 JSON");
    }
  }
}
