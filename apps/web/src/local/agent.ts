import { RpgEngineAPI, createLookup, projectSnapshotV2 } from "@life-sim/game-core";
import { AgentGateway, createAgentProvider, worldSkeletonOf } from "@life-sim/agent-runtime";
import type { TemplateBundle } from "@life-sim/template-loader";
import type { WorldStateV2 } from "@life-sim/shared";

/**
 * 浏览器内的 LLM 网关（ADR-070 第三期 · T6）。
 *
 * 与服务端 `pipelineForTurn` 是**同一个网关、同一套工具**：引擎 API 建在世界活状态上，
 * `story.submitBranch` 仍是唯一写入口；差别只在 provider —— 这里用玩家自己填的 key
 * 直连 OpenAI 兼容端点，不经中转。
 *
 * 没有 key ⇒ 返回 null，调用方不接线：回合走模板兜底（"无 key 可跑"仍是正式路径）。
 */
export interface ClientAgentConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface ClientAgentHooks {
  /** 叙事增量（已由服务端同款过滤器剥标签；本地直接用原文）。 */
  onDelta?: (text: string) => void;
  onTrace?: (trace: unknown) => void;
  signal?: AbortSignal;
}

export function createClientGateway(
  bundle: TemplateBundle,
  state: WorldStateV2,
  config: ClientAgentConfig | null,
  hooks: ClientAgentHooks = {},
): AgentGateway | null {
  if (config === null || config.apiKey === "" || config.model === "") return null;
  const lookup = createLookup(bundle.template).withGenerated(state.generatedEvents);
  const engineApi = new RpgEngineAPI({
    state,
    // GM 看到的 facts / 槽位描述也要能读到生成事件（与投影同一份查表）。
    projectSnapshot: (s) => projectSnapshotV2(s, bundle.template, lookup.withGenerated(s.generatedEvents)),
    lookup,
  });
  return new AgentGateway({
    provider: createAgentProvider({
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
    }),
    engineApi,
    templateRef: bundle.template.meta.id,
    template: bundle.template,
    worldSkeleton: worldSkeletonOf(bundle.template),
    onTrace: (trace) => hooks.onTrace?.(trace),
    onDelta: (chunk) => hooks.onDelta?.(chunk.text ?? ""),
    ...(hooks.signal !== undefined ? { signal: hooks.signal } : {}),
    ...(bundle.rules !== undefined ? { rules: bundle.rules } : {}),
  });
}
