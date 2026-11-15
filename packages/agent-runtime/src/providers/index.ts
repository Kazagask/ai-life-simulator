import type { AgentProvider } from "../tool-registry.js";
import { MockAgentProvider } from "./mock.js";
import { OpenAiCompatibleProvider } from "./openai-tools.js";

export { AgentProviderError } from "./errors.js";
export { MockAgentProvider } from "./mock.js";
export { OpenAiCompatibleProvider } from "./openai-tools.js";
export type { OpenAiCompatibleOptions } from "./openai-tools.js";

export interface CreateAgentProviderOptions {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

/**
 * provider 选择：`baseUrl` / `model` / `apiKey` 三者齐备才走真实 OpenAI 兼容端点，
 * 否则回落到确定性 mock —— 这就是「无 key 也能玩」的开关。绝不打日志泄露 key。
 */
export function createAgentProvider(opts?: CreateAgentProviderOptions): AgentProvider {
  const baseUrl = opts?.baseUrl;
  const model = opts?.model;
  const apiKey = opts?.apiKey;
  if (
    typeof baseUrl === "string" &&
    baseUrl.length > 0 &&
    typeof model === "string" &&
    model.length > 0 &&
    typeof apiKey === "string" &&
    apiKey.length > 0
  ) {
    return new OpenAiCompatibleProvider({ baseUrl, model, apiKey });
  }
  return new MockAgentProvider();
}
