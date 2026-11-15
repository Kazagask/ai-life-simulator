import type { TurnPipelineConfig } from "@life-sim/game-core";
import { RpgEngineAPI, projectSnapshotV2 } from "@life-sim/game-core";
import { AgentGateway, createAgentProvider } from "@life-sim/agent-runtime";
import type { WorldStateV2 } from "@life-sim/shared";
import { DEFAULT_OPENAI_BASE_URL, type UserCredentials } from "../llm/credentials.js";
import type { LLMConfig } from "../llm/provider.js";
import type { ReadyTemplateEntry } from "../templates.js";
import { appendTrace } from "../store.js";

/**
 * T-11（部分）· 回合结算尾的 LLM 网关注入（与 HTTP 层解耦以便单测）。
 *
 * 硬不变量：**没有可解析 provider ⇒ 原样返回 `entry.pipeline`（同一引用）**。
 * `runLlmHook` 在 `pipeline.gateway` 缺失时完全 no-op，故「无 key」路径与改前逐字段一致。
 */

/** 真实 provider 的三要素；缺任一 ⇒ 不注入网关。 */
export interface AgentProviderConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/**
 * 「provider 可解析」的唯一判据（与 `resolveProviderForRequest` 同源）：
 * ① 请求自带有效用户凭证（登录取 key）；
 * ② 否则 env 三项 `LIFE_SIM_LLM_*` 齐备。
 */
export function resolveAgentConfig(
  credentials: UserCredentials | undefined,
  env: LLMConfig,
): AgentProviderConfig | undefined {
  if (credentials) {
    const baseUrl = (credentials.baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
    return { baseUrl, model: credentials.model.trim(), apiKey: credentials.apiKey.trim() };
  }
  if (env.baseUrl !== undefined && env.model !== undefined && env.apiKey !== undefined) {
    return { baseUrl: env.baseUrl, model: env.model, apiKey: env.apiKey };
  }
  return undefined;
}

/**
 * 注入网关的回合管线。
 *
 * - 引擎 API 建在世界的**活状态**上：`advanceTurnV2` 原地改 `state`，网关在结算尾 dispatch
 *   时看到的就是本轮最新状态；
 * - `onTrace` 同步追加到 append-only `<worldId>.trace.jsonl`（agent-runtime 不落盘）；
 * - 规则（`rules.yaml`）同时作为触发器与工具画像来源传入。
 */
export function pipelineForTurn(
  world: WorldStateV2,
  entry: ReadyTemplateEntry,
  config: AgentProviderConfig | undefined,
): TurnPipelineConfig {
  const base = entry.pipeline;
  if (config === undefined) return base;
  const engineApi = new RpgEngineAPI({
    state: world,
    projectSnapshot: (s) => projectSnapshotV2(s, entry.template, entry.lookup),
    perspective: "world",
    targetPerspective: "player",
  });
  const gateway = new AgentGateway({
    provider: createAgentProvider(config),
    engineApi,
    templateRef: `${entry.ref.id}@${entry.ref.version}`,
    onTrace: (trace) => appendTrace(world.id, trace),
    ...(entry.rules !== undefined ? { rules: entry.rules } : {}),
  });
  return {
    ...base,
    gateway,
    ...(entry.rules !== undefined ? { rules: entry.rules } : {}),
    perspective: "world",
    targetPerspective: "player",
  };
}
