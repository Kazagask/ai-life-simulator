import type { TurnPipelineConfig } from "@life-sim/game-core";
import { RpgEngineAPI, projectSnapshotV2 } from "@life-sim/game-core";
import { AgentGateway, createAgentProvider } from "@life-sim/agent-runtime";
import type { WorldStateV2 } from "@life-sim/shared";
import { DEFAULT_OPENAI_BASE_URL, type UserCredentials } from "../llm/credentials.js";
import type { LLMConfig } from "../llm/provider.js";
import type { ReadyTemplateEntry } from "../templates.js";
import { appendTrace } from "../store.js";
import { beginNarrativeInvocation } from "../narrative/stream.js";

/**
 * T-11 · 回合结算尾的 LLM 网关注入（与 HTTP 层解耦以便单测）。
 *
 * 注入判据（两条，任一成立即注入）：
 * ① 有**真实** provider（用户凭证 / env 三要素）；
 * ② **模板声明了 `rules.yaml`**（`entry.rules !== undefined`）——此时用 `createAgentProvider({})`
 *    得到的**确定性 mock** provider。
 *
 * ②不是装饰性兜底，而是 F1 验收「无 key 可跑」的产品路径：点击式 demo 必须在没有 API key 时
 * 也能产出叙事 + 可点选项。mock provider 无网络、同一 invocation + 同一状态 ⇒ 逐字节相同输出。
 *
 * 硬不变量：**既没有 provider、模板也没有 rules.yaml ⇒ 原样返回 `entry.pipeline`（同一引用）**。
 * `runLlmHook` 在 `pipeline.gateway` 缺失时完全 no-op，故这类模板（如 `jjk-2006`）的回合结算
 * 与改前逐字段一致（零回归）。
 */

/** 真实 provider 的三要素；缺任一 ⇒ 用 mock（若模板声明了 rules.yaml）。 */
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
 * - 规则（`rules.yaml`）同时作为触发器与工具画像来源传入；
 * - `config` 缺省 ⇒ `createAgentProvider({})` 返回 mock（零 key demo 路径：无网络、确定性）。
 */
export function pipelineForTurn(
  world: WorldStateV2,
  entry: ReadyTemplateEntry,
  config: AgentProviderConfig | undefined,
): TurnPipelineConfig {
  const base = entry.pipeline;
  // 真·零回归分支：没有 provider **且**模板没有 rules.yaml ⇒ 没有触发源，注入毫无意义。
  if (config === undefined && entry.rules === undefined) return base;
  const engineApi = new RpgEngineAPI({
    state: world,
    projectSnapshot: (s) => projectSnapshotV2(s, entry.template, entry.lookup),
    perspective: "world",
    targetPerspective: "player",
  });
  // 正文增量的转发频道：只把碎片推到内存频道（SSE 路由负责下发），
  // trace 仍然只在 onTrace 收尾时一次性落盘（F3：中途不落盘、不进 sink）。
  const narrativeStream = beginNarrativeInvocation(world.id);
  const gateway = new AgentGateway({
    // 无 key ⇒ mock：这是「无 key 可跑」的正式路径，不是缺省占位。
    provider: createAgentProvider(config ?? {}),
    engineApi,
    templateRef: `${entry.ref.id}@${entry.ref.version}`,
    onTrace: (trace) => {
      appendTrace(world.id, trace);
      narrativeStream.done(trace);
    },
    onDelta: (chunk) => {
      narrativeStream.delta(chunk.text ?? "");
    },
    signal: narrativeStream.signal,
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
