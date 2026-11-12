import type { NarrativeInput, NarrativeOutputSchemaLike } from "@life-sim/game-core";

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
