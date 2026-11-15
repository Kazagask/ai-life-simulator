import type { Rules, SetKnowledgeArgs, WorldStateV2 } from "@life-sim/shared";
import {
  derivedTriggerRng,
  evaluateAll,
  type ConditionEvalContext,
  type ConditionRegistry,
} from "./condition-evaluator.js";

/**
 * 知识授予（T-02）：按 `rules.yaml` 的 `knowledgeGrants[]` / `inferenceRules[]`
 * 数据条目，在事件结算时计算应落账的 `SetKnowledgeArgs[]`（批量）。
 *
 * 纯函数：只**计算**授权列表，不写 `WorldStateV2`；实际落账由引擎 API 的
 * `fact.setKnowledge` 经 `applyKnowledgeBatch` 完成（回程一律走 dispatch）。
 * `when` / `grant` 复用与 DAG / 触发器同一套 Condition DSL + ConditionRegistry。
 */
export function computeKnowledgeGrants(
  state: WorldStateV2,
  rules: Rules,
  registry: ConditionRegistry,
  turnIndex: number,
): SetKnowledgeArgs[] {
  const ctx: ConditionEvalContext = {
    state,
    rng: derivedTriggerRng(state.seed, turnIndex),
    turnIndex,
  };
  const out: SetKnowledgeArgs[] = [];
  for (const entry of [...rules.knowledgeGrants, ...rules.inferenceRules]) {
    if (!evaluateAll(entry.when, ctx, registry)) continue;
    for (const observer of entry.grant.observers) {
      for (const factRef of entry.grant.factRefs) {
        out.push({
          observer,
          factRef,
          level: entry.grant.level,
          source: entry.grant.source,
          sinceTurn: turnIndex,
        });
      }
    }
  }
  return out;
}
