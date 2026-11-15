import type { NarrativeInput, NarrativeOutputSchemaLike } from "@life-sim/game-core";
import { MockProvider } from "./mock.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import { DEFAULT_OPENAI_BASE_URL, type UserCredentials } from "./credentials.js";

/**
 * R2.7 · LLMProvider 统一接口（R-LLM-01 / ADR-0027 决策 1）。
 * 定义在 `apps/server`（**不在** `packages/game-core`）：game-core 只保留「构造请求 + 校验候选」
 * 的导出纯函数，绝不引入任何 LLM SDK / 网络调用（AGENTS §1）。
 *
 * `complete` 返回**未校验**候选，校验统一交给 game-core 的 `validateNarrativeOutput`，
 * 保证 strict Zod + 证据白名单是单一事实来源；失败/超时一律抛错，由编排层转 fallback。
 */
export interface LLMProvider {
  /** 运行时真实选中的实现，供编排层短路（mock ⇒ 不调 complete、零回归）。 */
  readonly id: "mock" | "openai-compatible";
  complete(
    request: NarrativeInput,
    schema: NarrativeOutputSchemaLike,
    opts?: { timeoutMs?: number },
  ): Promise<unknown>;
}

/** 服务端 LLM 配置：全部来自 env 注入，绝不硬编码、绝不进仓库、绝不写日志。 */
export interface LLMConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  /** 单次生成超时（毫秒），可由测试/调用方注入；provider 内部用 `AbortSignal.timeout`。 */
  timeoutMs?: number;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * 只读 env（R-LLM-06；用户 2026-11-15 裁决：**取消 workbuddy-cloud 通道**）：
 * `LIFE_SIM_LLM_BASE_URL` / `LIFE_SIM_LLM_MODEL` / `LIFE_SIM_LLM_API_KEY` **三项缺任一即整组不可用**，
 * 回退 mock。密钥只在服务端 env 读取，返回对象之外的任何位置都不出现其字面量。
 */
export function readLLMConfig(env: Record<string, string | undefined> = process.env): LLMConfig {
  const baseUrl = nonEmpty(env.LIFE_SIM_LLM_BASE_URL);
  const model = nonEmpty(env.LIFE_SIM_LLM_MODEL);
  const apiKey = nonEmpty(env.LIFE_SIM_LLM_API_KEY);
  const openaiReady = baseUrl !== undefined && model !== undefined && apiKey !== undefined;
  return {
    ...(openaiReady ? { baseUrl, model, apiKey } : {}),
  };
}

/**
 * 凭证路由工厂（用户 2026-11-15 裁决：**取消 workbuddy-cloud 通道**）：
 * ① 三项 `LIFE_SIM_LLM_*` 齐备 ⇒ openai-compatible；② 否则 ⇒ mock（零回归默认）。
 * OpenAI 兼容（env / 用户自带 key）为唯一主通道。返回的 `id` 是运行时真实选中的那个；
 * 加载期不得抛错，密钥绝不出现在任何日志 / 仓库文件。
 */
export function createLLMProvider(config: LLMConfig): LLMProvider {
  const baseUrl = config.baseUrl?.trim();
  const model = config.model?.trim();
  const apiKey = config.apiKey?.trim();
  if (baseUrl && model && apiKey) {
    return new OpenAICompatibleProvider({ baseUrl, model, apiKey, timeoutMs: config.timeoutMs });
  }
  return new MockProvider();
}

/**
 * R2.8 · R-LLM-08：按**请求**解析 provider 的三级优先级。
 * ① 若请求携带有效用户凭证（登录页自带 key，服务端内存持有）⇒ 用 `OpenAICompatibleProvider` 代调；
 * ② 否则回退到启动期从 env 构造的全局 provider（platform-keyless / mock）。
 *
 * 用户 key 本次调用失败 ⇒ 由编排层（`generateNarrative`）回退模板，**不自动降级到 ②**；
 * 下次仍按 ① 优先。凭证错误不静默穿透到平台免密。
 */
export function resolveProviderForRequest(
  userCreds: UserCredentials | undefined,
  fallback: LLMProvider,
): LLMProvider {
  if (!userCreds) return fallback;
  const baseUrl = (userCreds.baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  return new OpenAICompatibleProvider({
    baseUrl,
    model: userCreds.model.trim(),
    apiKey: userCreds.apiKey.trim(),
  });
}
