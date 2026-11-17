import type { RelationEdge } from "@life-sim/shared";
import { buildRelationGraph, isKinshipKind, shortestPath } from "@life-sim/game-core";

/**
 * 多跳可达性（家族扩展用）。
 *
 * 「谁跟谁有亲缘」是**图的连通性**问题，不是称谓问题 —— 所以这些函数只回 id 集合，
 * 具体叫法由 `terms.ts` 回答，能不能上屏由内核回答。
 */

/** 便捷判据：`from` 是否至少有亲属链可达 `to`（不含自己）。 */
export function isKinshipReachable(edges: readonly RelationEdge[], from: string, to: string): boolean {
  if (from === to) return false;
  return shortestPath(buildRelationGraph(edges), from, to) !== null;
}

/**
 * 从 `from` 沿亲属边可达的节点 id（不含自己），按**最短跳数升序**返回。
 *
 * 用途单一：`extendRows` 用它找出「没有直接边、但血缘上确实够得着」的人，再补成推导行。
 *
 * 注意这里只做**一跳一跳的图扩张**（BFS），不做路径枚举 —— 路径枚举在 `terms.ts`
 * 的 `kinshipReadings` 里，且必须由调用方按 `(viewerId, withId)` 记忆化：
 * 十二人家族下不缓存足以把请求拖死（旧实现踩过）。
 */
export function reachableKinshipNodeIds(
  edges: readonly RelationEdge[],
  from: string,
  maxHops: number,
): string[] {
  const graph = buildRelationGraph(edges);
  const seen = new Set<string>([from]);
  const out: string[] = [];
  let frontier: string[] = [from];
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const e of graph.outgoing.get(node) ?? []) {
        if (!isKinshipKind(e.kind)) continue;
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        out.push(e.to);
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return out;
}
