import type { NpcAction, V2Npc, WorldStateV2 } from "@life-sim/shared";
import type { Rng } from "../rng.js";
import type { TemplateLookup } from "./lookup.js";
import { applyEffectsV2, checkAllConditions, type ConditionContext } from "./engine.js";
import { createTimeAdapter } from "./time.js";

export interface NpcActionResult {
  /** 玩家可见的行动摘要（{name} 已替换） */
  summaries: string[];
  /** NPC 行动效果中 startChain 触发的事件链 id（由路由层触发其起点事件） */
  startedChains: string[];
}

/** 冷却记录在 flags 中的命名空间前缀。 */
const COOLDOWN_PREFIX = "npcAction:";

/**
 * NPC 自主行动（A6）：触发式 + 效用评分 + 兜底随机。
 *
 * - 触发式：不是每轮全量轮询，行动受 cooldownTurns / probability /
 *   conditions / requireKnowledge 四重约束，只有满足才进入候选集；
 *   条件 DSL 支持世界 flag / 关系 / 时间等，可表达「事件发生后 NPC 才行动」。
 * - 效用评分：候选集内按 base + 目标匹配 + 性格偏好 + 随机抖动排序选最优。
 * - 信息差：requireKnowledge 约束 NPC 只能选择其 knowledge 覆盖的行动。
 *
 * 每个 NPC 每轮至多自主行动一次。
 */
export function runNpcActionsV2(state: WorldStateV2, lookup: TemplateLookup, rng: Rng): NpcActionResult {
  const summaries: string[] = [];
  const startedChains: string[] = [];
  const actions = lookup.template.npcActions ?? [];
  if (actions.length === 0) return { summaries, startedChains };

  const ctx: ConditionContext = { state, lookup, rng };
  for (const npc of state.npcs) {
    if (npc.isEnemy) continue;
    if (state.turnIndex - npc.lastActedAtTurn < 1) continue;

    const candidates = actions.filter((action) => {
      const t = action.trigger;
      if (t.requireKnowledge && !t.requireKnowledge.every((k) => npc.knowledge.includes(k))) return false;
      if (!checkAllConditions(t.conditions, ctx)) return false;
      if (t.probability !== undefined && rng() >= t.probability) return false;
      if (isOnCooldown(state, npc.id, action.id, t.cooldownTurns)) return false;
      return true;
    });

    if (candidates.length === 0) continue;

    const chosen = pickBest(candidates, npc, rng);
    if (!chosen) continue;

    npc.lastActedAtTurn = state.turnIndex;
    state.flags[`${COOLDOWN_PREFIX}${npc.id}:${chosen.id}`] = state.turnIndex;

    applyEffectsV2({ state, lookup, rng, logs: [], selfNpcId: npc.id, startedChains }, chosen.effects);
    const summary = chosen.summary.replaceAll("{name}", npc.name);
    summaries.push(summary);
    state.history.push({
      id: `t${state.turnIndex}-npc-${npc.id}`,
      turnIndex: state.turnIndex,
      worldTime: state.worldTime,
      formattedTime: createTimeAdapter(lookup.template).format(state.worldTime),
      type: "npc_action",
      summary,
    });
  }

  return { summaries, startedChains };
}

/** 效用评分：base + 目标匹配命中数 + 性格偏好命中数 + 随机抖动（0..1）。 */
function pickBest(candidates: NpcAction[], npc: V2Npc, rng: Rng): NpcAction | undefined {
  let best: NpcAction | undefined;
  let bestScore = -Infinity;
  for (const action of candidates) {
    const goalHits = (action.utility.goalMatch ?? []).filter((g) => npc.goals.includes(g)).length;
    const traitHits = (action.utility.traitAffinity ?? []).filter((t) => npc.traits.includes(t)).length;
    const score = action.utility.base + goalHits + traitHits + rng();
    if (score > bestScore) {
      bestScore = score;
      best = action;
    }
  }
  return best;
}

function isOnCooldown(state: WorldStateV2, npcId: string, actionId: string, cooldownTurns: number | undefined): boolean {
  if (cooldownTurns === undefined) return false;
  const last = state.flags[`${COOLDOWN_PREFIX}${npcId}:${actionId}`];
  if (typeof last !== "number") return false;
  return state.turnIndex - last < cooldownTurns;
}
