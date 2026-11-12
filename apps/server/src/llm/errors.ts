/**
 * R2.7 · provider 侧可诊断错误（R-LLM-04）。
 * 错误对象与 message 中**绝不出现** apiKey / cloudSession / token 字面量；
 * 编排层据此把「超时」与「不可用」区分为两种 diagnostic 文案。
 */

/** 缺会话 / 端点不可达 / HTTP 非 2xx / 响应不合法 ⇒ 不可用（回退模板）。 */
export class LLMUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMUnavailableError";
  }
}

/** LLM 生成超时（编排层 Promise.race 守卫或 AbortSignal.timeout 抛出）。 */
export class LLMTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMTimeoutError";
  }
}

/** 统一判别：自定义超时错误、DOMException TimeoutError/AbortError、含超时语义的消息。 */
export function isTimeoutLike(err: unknown): boolean {
  if (err instanceof LLMTimeoutError) return true;
  if (err instanceof Error) {
    const name = err.name.toLowerCase();
    if (name.includes("timeout") || name.includes("abort")) return true;
    return /超时|timed?\s*out|timeout/i.test(err.message);
  }
  return false;
}
