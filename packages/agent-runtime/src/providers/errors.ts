import type { DiagnosticCode } from "@life-sim/shared";

/**
 * Provider 层可诊断错误：把网络 / 解析失败映射到封闭的 13 码之一，
 * 让 `runAgentLoop` 不必猜字符串。绝不携带 apiKey / 完整 prompt。
 */
export class AgentProviderError extends Error {
  readonly code: DiagnosticCode;

  constructor(code: DiagnosticCode, message: string) {
    super(message);
    this.name = "AgentProviderError";
    this.code = code;
  }
}
