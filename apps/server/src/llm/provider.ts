import type { NarrativeInput, NarrativeOutputSchemaLike } from "@life-sim/game-core";
import { MockProvider } from "./mock.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import { WorkBuddyCloudProvider } from "./workbuddyCloud.js";
import { DEFAULT_OPENAI_BASE_URL, type UserCredentials } from "./userCredentials.js";

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
  readonly id: "mock" | "workbuddy-cloud" | "openai-compatible";
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
  cloudSession?: string;
  cloudUrl?: string;
  /** 单次生成超时（毫秒），可由测试/调用方注入；provider 内部用 `AbortSignal.timeout`。 */
  timeoutMs?: number;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * 只读 env（R-LLM-06）：
 * - `LIFE_SIM_LLM_BASE_URL` / `LIFE_SIM_LLM_MODEL` / `LIFE_SIM_LLM_API_KEY` **三项缺任一即整组不可用**；
 * - `LIFE_SIM_WORKBUDDY_SESSION` / `LIFE_SIM_WORKBUDDY_CLOUD_URL` 为云端会话降级形态（见 OPEN_QUESTIONS #49）。
 * 密钥只在服务端 env 读取，返回对象之外的任何位置都不出现其字面量。
 */
export function readLLMConfig(env: Record<string, string | undefined> = process.env): LLMConfig {
  const baseUrl = nonEmpty(env.LIFE_SIM_LLM_BASE_URL);
  const model = nonEmpty(env.LIFE_SIM_LLM_MODEL);
  const apiKey = nonEmpty(env.LIFE_SIM_LLM_API_KEY);
  const cloudSession = nonEmpty(env.LIFE_SIM_WORKBUDDY_SESSION);
  const cloudUrl = nonEmpty(env.LIFE_SIM_WORKBUDDY_CLOUD_URL);
  const openaiReady = baseUrl !== undefined && model !== undefined && apiKey !== undefined;
  return {
    ...(openaiReady ? { baseUrl, model, apiKey } : {}),
    ...(cloudSession !== undefined ? { cloudSession } : {}),
    ...(cloudUrl !== undefined ? { cloudUrl } : {}),
  };
}

/**
 * 三层凭证路由工厂（R-LLM-02 / ADR-0027 决策 2）：
 * ① cloudSession + cloudUrl ⇒ workbuddy-cloud；② 三项 `LIFE_SIM_LLM_*` 齐备 ⇒ openai-compatible；
 * ③ 否则 ⇒ mock（无 env 无登录态的零回归默认）。
 * 返回的 `id` 是运行时真实选中的那个；加载期不得抛错，密钥绝不出现在任何日志 / 仓库文件。
 */
export function createLLMProvider(config: LLMConfig): LLMProvider {
  const cloudSession = config.cloudSession?.trim();
  const cloudUrl = config.cloudUrl?.trim();
  if (cloudSession && cloudUrl) {
    return new WorkBuddyCloudProvider({ cloudSession, cloudUrl, timeoutMs: config.timeoutMs });
  }
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
