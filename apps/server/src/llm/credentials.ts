/**
 * T-03 迁移位：与运行时解耦的凭证形状 / 默认端点常量。
 *
 * provider.ts / openaiCompatible.ts 后续整体迁往 `packages/agent-runtime` 时，本模块可
 * 随之整体搬走——它不依赖 `apps/server` 的任何运行时代码（无 Map 存储 / zod / node 依赖），
 * 从而避免 provider 侧继续 import `apps/server/src/llm/userCredentials.ts` 形成非法的
 * `packages → apps` 反向依赖。`userCredentials.ts` 保留「会话内存存储」这一服务端职责，
 * 仅从此处复用类型 / 常量。
 */
export interface UserCredentials {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

/** OpenAI 兼容默认端点；用户未填 baseUrl 时回落到此处。 */
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
