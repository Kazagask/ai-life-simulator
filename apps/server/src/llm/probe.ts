import { DEFAULT_LLM_BUDGET } from "@life-sim/shared";
import { resolveAgentConfig } from "../agent/pipeline.js";
import type { UserCredentials } from "./credentials.js";
import { readLLMConfig } from "./provider.js";

/**
 * R2.8 · R-LLM-07 补充：用户填完 key 之后的**连通性探测**。
 *
 * 为什么要单独一条最小请求：真 key 下「打一回合看有没有叙事」等于盲猜——失败可能来自 key、
 * 端点、模型名、限流、超时，用户无法区分。本模块只回答「这个配置能不能打穿」。
 *
 * 硬约束：
 * - 与真实调用**同一套判据**算 baseUrl（复用 `resolveAgentConfig`，含去尾斜杠），
 *   否则「探测通过、打回合失败」会变成新的坑；
 * - 只发 `max_tokens: 1` 的最小真实请求，不产出/不消费任何叙事；
 * - **探测失败不是 HTTP 错误**：`ok:false` 一律 200 返回（前端要能区分「我填错了」与「服务端炸了」）；
 * - apiKey 绝不出现在任何返回字段（含 detail / 上游错误体），见 `scrub`。
 */

/** 超时上限与单次真实调用的预算同源（20s），避免「探测比真调用更宽松」的错觉。 */
export const PROBE_TIMEOUT_MS = DEFAULT_LLM_BUDGET.perCallTimeoutMs;

/** 上游诊断文本的保留上限：只够定位，不够泄漏。 */
const DETAIL_MAX_CHARS = 300;

export type LlmProbeFailureReason = "unauthorized" | "network" | "timeout" | "bad_response";

export type LlmProbeResult =
  | { ok: true; model: string; latencyMs: number }
  | {
      ok: false;
      reason: LlmProbeFailureReason;
      /** 状态码 / provider 错误 type / 超时毫秒数；已脱敏、已截断。 */
      detail: string;
    };

export interface LlmProbeOptions {
  /** 测试注入点；生产走 Node 内置 fetch。 */
  fetchImpl?: typeof fetch;
  /** 仅供测试缩短等待；对外恒为 `PROBE_TIMEOUT_MS`。 */
  timeoutMs?: number;
}

/** `sk-...` 形态的密钥字面量（OpenAI / 多数兼容网关）。 */
const KEY_LIKE = /\bsk-[A-Za-z0-9_-]{4,}/g;

/**
 * 脱敏 + 截断。三道防线，任一命中都不再泄漏：
 * ① 精确抹掉本次 apiKey 原文；② 抹掉一切 `sk-...` 形态；③ 压平空白并截断到 300 字符。
 * 顺序不能颠倒：先抹再截，否则截断可能把长 key 切成「看不出是 key 的前缀」。
 */
export function scrub(text: string, apiKey: string): string {
  let out = text;
  const key = apiKey.trim();
  if (key.length >= 4) out = out.split(key).join("[redacted]");
  out = out.replace(KEY_LIKE, "[redacted]");
  return out.replace(/\s+/g, " ").trim().slice(0, DETAIL_MAX_CHARS);
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

/** 只取 provider 的错误 `type`/`code`（字符串），不搬运 message：message 里常含 key 尾号。 */
function errorTypeOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const record = error as { type?: unknown; code?: unknown };
  for (const candidate of [record.type, record.code]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return null;
}

async function providerErrorType(response: Response): Promise<string | null> {
  try {
    return errorTypeOf(await response.json());
  } catch {
    return null;
  }
}

/**
 * 探测一次。返回三态（通 / 探测失败 / 不可解析），**从不抛错**。
 *
 * `unauthorized` 覆盖 401/403；其余非 2xx（限流、模型不存在、网关 5xx）归 `bad_response`，
 * 因为它们不是「鉴权错」，前端提示语不同。
 */
export async function probeLlmConnectivity(
  credentials: UserCredentials,
  opts: LlmProbeOptions = {},
): Promise<LlmProbeResult> {
  const config = resolveAgentConfig(credentials, readLLMConfig());
  if (config === undefined) {
    // 表单校验已挡掉空 key/model；这里只可能是调用方绕过 HTTP 层直接调本函数。
    return { ok: false, reason: "bad_response", detail: "provider config unresolved" };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const startedAt = performance.now();

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 1,
        stream: false,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      return { ok: false, reason: "timeout", detail: `timeout after ${timeoutMs}ms` };
    }
    const message = error instanceof Error ? `${error.name}: ${error.message}` : "fetch failed";
    return { ok: false, reason: "network", detail: scrub(message, credentials.apiKey) };
  }

  if (!response.ok) {
    const type = await providerErrorType(response);
    const reason: LlmProbeFailureReason =
      response.status === 401 || response.status === 403 ? "unauthorized" : "bad_response";
    const detail = type === null ? `HTTP ${response.status}` : `HTTP ${response.status} (${type})`;
    return { ok: false, reason, detail: scrub(detail, credentials.apiKey) };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: "bad_response", detail: `HTTP ${response.status} (invalid JSON)` };
  }
  const choices =
    typeof payload === "object" && payload !== null ? (payload as { choices?: unknown }).choices : undefined;
  if (!Array.isArray(choices) || choices.length === 0) {
    return { ok: false, reason: "bad_response", detail: `HTTP ${response.status} (no choices)` };
  }

  return { ok: true, model: config.model, latencyMs: Math.round(performance.now() - startedAt) };
}
