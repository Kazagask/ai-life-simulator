import type { NarrativeInput, NarrativeOutputSchemaLike } from "@life-sim/game-core";
import type { LLMProvider } from "./provider.js";
import { LLMUnavailableError } from "./errors.js";

export { LLMUnavailableError } from "./errors.js";

/**
 * R2.7 · WorkBuddy 云端免密钥 LLM 的**可运行降级形态**（主理人裁决 1 / OPEN_QUESTIONS #49）。
 *
 * ADR-0027 草案写「登录会话 → 云端 SDK」，但 ADR-0025 明确服务端零凭据、登录会话只在
 * 浏览器 SDK 中，且该 SDK 仅支持 streaming；`apps/server` 没有该依赖。故本轮**不宣称接通**，
 * 落地为：服务端 env 注入 `LIFE_SIM_WORKBUDDY_SESSION` + `LIFE_SIM_WORKBUDDY_CLOUD_URL`
 * （或占位默认端点）→ 全局 `fetch` 调 `/.cloud/llm/chat/completions`（stream:true）→
 * 解析 `text/event-stream` 的 `data:` 行收集 `choices[0].delta.content` → `JSON.parse`。
 *
 * **未注入 session 即抛 `LLMUnavailableError` 并回退模板，绝不假装成功**；
 * 不可达 / 超时一律抛错由编排层回退。真实「登录用户 → 服务端免密钥」链路仍待用户裁决。
 * 严禁 import `@tencent-ai/workbuddy-cloud-sdk`（server 无此依赖）。
 */
export interface WorkBuddyCloudConfig {
  cloudSession?: string;
  cloudUrl?: string;
  timeoutMs?: number;
}

/**
 * 占位默认端点：真实平台端点未定（OPEN_QUESTIONS #49）。未显式配置 cloudUrl 时该地址
 * 通常不可达 ⇒ 抛错回退模板；它的存在只为让「注入了 session」的形态可运行、可诊断。
 */
const DEFAULT_CLOUD_URL = "http://127.0.0.1:8787";
const DEFAULT_TIMEOUT_MS = 8000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 解析 SSE：跳过空 data 与 [DONE]，收集每个 chunk 的 choices[0].delta.content。 */
export function collectSseContent(text: string): string {
  let out = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      continue; // 非 JSON 的注释/心跳行不构成候选，跳过即可（错误可诊断由编排层兜底）
    }
    const choices = asRecord(parsed)?.choices;
    if (!Array.isArray(choices)) continue;
    const list: readonly unknown[] = choices;
    const content = asRecord(asRecord(list[0])?.delta)?.content;
    if (typeof content === "string") out += content;
  }
  return out;
}

export class WorkBuddyCloudProvider implements LLMProvider {
  readonly id = "workbuddy-cloud" as const;
  private readonly session: string;
  private readonly cloudUrl: string;
  private readonly timeoutMs: number;

  constructor(config: WorkBuddyCloudConfig = {}) {
    this.session = config.cloudSession?.trim() ?? "";
    this.cloudUrl = (config.cloudUrl?.trim() || DEFAULT_CLOUD_URL).replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async complete(
    request: NarrativeInput,
    schema: NarrativeOutputSchemaLike,
    opts?: { timeoutMs?: number },
  ): Promise<unknown> {
    void schema; // 校验统一在 game-core 的 validateNarrativeOutput
    if (this.session === "") {
      throw new LLMUnavailableError(
        "WorkBuddy 云端 LLM 未注入登录会话（LIFE_SIM_WORKBUDDY_SESSION），不可用；真实登录态链路待用户裁决",
      );
    }
    const url = `${this.cloudUrl}/.cloud/llm/chat/completions`;
    const body = {
      stream: true,
      messages: [
        {
          role: "system",
          content: "只能输出严格 JSON，字段以给定 schema 为准，不得输出额外字段，不得编造未发生的事实",
        },
        { role: "user", content: JSON.stringify(request) },
      ],
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.session}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? this.timeoutMs),
    });
    if (!response.ok) {
      throw new LLMUnavailableError(`workbuddy-cloud: HTTP ${response.status}`);
    }
    const collected = collectSseContent(await response.text());
    if (collected === "") {
      throw new LLMUnavailableError("workbuddy-cloud: 流式响应未收集到 content");
    }
    try {
      return JSON.parse(collected) as unknown;
    } catch {
      throw new LLMUnavailableError("workbuddy-cloud: 汇总文本不是合法 JSON");
    }
  }
}
