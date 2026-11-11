import type { KinshipKind, RelationEdge } from "@life-sim/shared";

/**
 * R2.6 关系图谱内核（ADR-0014 · T-B2）。
 *
 * 纯函数、无 IO、无随机、无 `Date`：同输入必然同输出（确定性硬约束）。
 * 本文件只管**图的拓扑**（建图/增删/最短路径/环检测/断代/冻结）；
 * 中文称谓推导（需引 `relationship.js`）在 T-B3 追加，保持本层零依赖。
 *
 * 边语义（见 `schema/relation.ts`）：`{ from: A, to: B, kind: "father" }`
 * 读作「B 是 A 的父亲」，因此**从 A 向外出边**即「A 的 <kind>」。
 */

/** 玩家在关系图中的固定节点 id（与 `schema/relation.ts` 的 PLAYER_ID 同值）。 */
export const PLAYER_NODE_ID = "player";

/** 亲属边 → 关系链记号（与 `relationship.js` 词表对齐，多跳用「的」连接）。 */
export const KINSHIP_TOKEN: Record<KinshipKind, string> = {
  father: "爸爸",
  mother: "妈妈",
  son: "儿子",
  daughter: "女儿",
  husband: "丈夫",
  wife: "妻子",
  "elder-brother": "哥哥",
  "younger-brother": "弟弟",
  "elder-sister": "姐姐",
  "younger-sister": "妹妹",
};

const KINSHIP_KINDS = new Set<string>(Object.keys(KINSHIP_TOKEN));

/** 是否亲属边（只有亲属边参与称谓推导；社会边只作图查询与叙事标签）。 */
export function isKinshipKind(kind: string): kind is KinshipKind {
  return KINSHIP_KINDS.has(kind);
}

/** 邻接图：出边/入边双向索引，节点集合为所有边端点的并集。 */
export interface RelationGraph {
  readonly edges: readonly RelationEdge[];
  readonly outgoing: ReadonlyMap<string, readonly RelationEdge[]>;
  readonly incoming: ReadonlyMap<string, readonly RelationEdge[]>;
  readonly nodes: ReadonlySet<string>;
}

/** 由边表构建邻接图（保持输入顺序，保证遍历确定性）。 */
export function buildRelationGraph(edges: readonly RelationEdge[]): RelationGraph {
  const outgoing = new Map<string, RelationEdge[]>();
  const incoming = new Map<string, RelationEdge[]>();
  const nodes = new Set<string>();
  for (const e of edges) {
    nodes.add(e.from);
    nodes.add(e.to);
    const out = outgoing.get(e.from);
    if (out) out.push(e);
    else outgoing.set(e.from, [e]);
    const inc = incoming.get(e.to);
    if (inc) inc.push(e);
    else incoming.set(e.to, [e]);
  }
  return { edges, outgoing, incoming, nodes };
}

// ---------------- 增删改（纯函数，返回新数组） ----------------

/**
 * 追加边。同一 `(from, to, kind)` 视为同一条边：已存在则合并
 * （新值覆盖旧值，`gap` 取「或」），不产生重复边。
 */
export function addEdge(edges: readonly RelationEdge[], edge: RelationEdge): RelationEdge[] {
  const idx = edges.findIndex((e) => e.from === edge.from && e.to === edge.to && e.kind === edge.kind);
  if (idx < 0) return [...edges, edge];
  const prev = edges[idx];
  const merged: RelationEdge = {
    ...prev,
    ...edge,
    gap: prev.gap === true || edge.gap === true ? true : edge.gap,
    // 冻结为单向棘轮：一旦冻结不可被后续写入解冻
    frozen: prev.frozen === true || edge.frozen === true ? true : edge.frozen,
  };
  const next = edges.slice();
  next[idx] = merged;
  return next;
}

/** 删除边；`kind` 省略时删除该 `(from, to)` 上的全部边。 */
export function removeEdge(
  edges: readonly RelationEdge[],
  from: string,
  to: string,
  kind?: RelationEdge["kind"],
): RelationEdge[] {
  return edges.filter((e) => {
    if (e.from !== from || e.to !== to) return true;
    if (kind === undefined) return false;
    return e.kind !== kind;
  });
}

/** 查询直接边；`kind` 省略时返回该 `(from, to)` 上的第一条。 */
export function queryEdge(
  edges: readonly RelationEdge[],
  from: string,
  to: string,
  kind?: RelationEdge["kind"],
): RelationEdge | undefined {
  return edges.find((e) => e.from === from && e.to === to && (kind === undefined || e.kind === kind));
}

/** 与某节点相连的全部边（出 + 入），按输入顺序去重。 */
export function relationsOf(graph: RelationGraph, nodeId: string): RelationEdge[] {
  const seen = new Set<RelationEdge>();
  for (const e of graph.outgoing.get(nodeId) ?? []) seen.add(e);
  for (const e of graph.incoming.get(nodeId) ?? []) seen.add(e);
  return [...seen];
}

// ---------------- 最短路径（BFS，等长取字典序最小） ----------------

export interface RelationPath {
  /** 逐跳边（从 from 出发向外的顺序）。 */
  readonly edges: readonly RelationEdge[];
  /** 逐跳关系链记号，如 `["爸爸","妈妈"]`。 */
  readonly tokens: readonly string[];
  /** 路径上是否经过断代边（gap）——命中则只允许粗称谓，不猜代数。 */
  readonly gapped: boolean;
}

interface PathState {
  readonly edges: RelationEdge[];
  readonly tokens: string[];
  readonly gapped: boolean;
}

/** 关系链字典序比较（用于等长路径决胜，保证「不唯一取最短 + 字典序」）。 */
function lexLess(a: readonly string[], b: readonly string[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i];
  }
  return a.length < b.length;
}

/**
 * 最短关系路径（BFS 逐层，等长路径取关系链字典序最小 ⇒ 完全确定）。
 * 默认只沿**亲属边**向外走（社会边无称谓语义）；`maxHops` 默认 8 跳防爆。
 * `from === to` 返回空路径（自己）；不可达返回 `null`。
 */
export function shortestPath(
  graph: RelationGraph,
  from: string,
  to: string,
  opts: { readonly kinshipOnly?: boolean; readonly maxHops?: number } = {},
): RelationPath | null {
  const kinshipOnly = opts.kinshipOnly ?? true;
  const maxHops = opts.maxHops ?? 8;
  if (from === to) return { edges: [], tokens: [], gapped: false };

  // best: node -> 已确定的最短路径（按层落定，先到者即最短）
  const best = new Map<string, PathState>();
  let frontier = new Map<string, PathState>([[from, { edges: [], tokens: [], gapped: false }]]);

  for (let hop = 0; hop < maxHops && frontier.size > 0; hop++) {
    const next = new Map<string, PathState>();
    for (const [node, st] of frontier) {
      for (const e of graph.outgoing.get(node) ?? []) {
        if (kinshipOnly && !isKinshipKind(e.kind)) continue;
        if (kinshipOnly && e.to === from) continue; // 简单路径：不折返回起点
        if (best.has(e.to)) continue; // 已更短到达
        const token = isKinshipKind(e.kind) ? KINSHIP_TOKEN[e.kind] : e.kind;
        const cand: PathState = {
          edges: [...st.edges, e],
          tokens: [...st.tokens, token],
          gapped: st.gapped || e.gap === true,
        };
        const prev = next.get(e.to);
        if (!prev || lexLess(cand.tokens, prev.tokens)) next.set(e.to, cand);
      }
    }
    for (const [node, st] of next) best.set(node, st);
    const hit = best.get(to);
    if (hit) return { edges: hit.edges, tokens: hit.tokens, gapped: hit.gapped };
    frontier = next;
  }
  return null;
}

/** 路径上的断代边数（0 = 代数可精确推导）。 */
export function ancestorGaps(graph: RelationGraph, from: string, to: string, maxHops = 8): number {
  const path = shortestPath(graph, from, to, { maxHops });
  if (!path) return 0;
  let gaps = 0;
  for (const e of path.edges) if (e.gap === true) gaps++;
  return gaps;
}

// ---------------- 环检测（亲属图不应成环） ----------------

export interface RelationCycle {
  /** 环上的节点序列（首尾相同，如 `[a,b,c,a]`）。 */
  readonly nodes: readonly string[];
  /** 环上的边（与 `nodes` 逐跳对应，长度 = nodes.length - 1）。 */
  readonly edges: readonly RelationEdge[];
}

/**
 * 亲属子图环检测（DFS 三色标记）。
 * 只报**亲属边**构成的环——社会边（师徒/朋友）成环是正常现象，不算谱系错误。
 * 节点按 id 升序起始、出边按输入顺序展开 ⇒ 输出稳定可复现。
 */
export function detectCycles(graph: RelationGraph): RelationCycle[] {
  const cycles: RelationCycle[] = [];
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of [...graph.nodes].sort()) color.set(n, WHITE);

  const stackNodes: string[] = [];
  const stackEdges: RelationEdge[] = [];

  const visit = (node: string): void => {
    color.set(node, GRAY);
    stackNodes.push(node);
    for (const e of graph.outgoing.get(node) ?? []) {
      if (!isKinshipKind(e.kind)) continue;
      const c = color.get(e.to) ?? WHITE;
      if (c === GRAY) {
        // 回边：从栈中截出环
        const at = stackNodes.indexOf(e.to);
        if (at >= 0) {
          const cycNodes = stackNodes.slice(at).concat(e.to);
          const cycEdges = stackEdges.slice(at).concat(e);
          cycles.push({ nodes: cycNodes, edges: cycEdges });
        }
      } else if (c === WHITE) {
        stackEdges.push(e);
        visit(e.to);
        stackEdges.pop();
      }
    }
    stackNodes.pop();
    color.set(node, BLACK);
  };

  for (const n of [...graph.nodes].sort()) {
    if ((color.get(n) ?? WHITE) === WHITE) visit(n);
  }
  return cycles;
}

// ---------------- 死亡冻结 ----------------

/**
 * 角色死亡时冻结与之相连的关系边（T-B4 的 `freezeRelationsOnDeath` 底层）。
 *
 * 语义：死者的人际关系不再被后续 `adjustRelation` / 事件效果改动，
 * 但**仍参与称谓推导**——逝去的祖父依旧是祖父。
 */
export function freezeOnDeath(edges: readonly RelationEdge[], nodeId: string): RelationEdge[] {
  return edges.map((e) => (e.from === nodeId || e.to === nodeId ? { ...e, frozen: true } : e));
}

// ---------------- 可见性投影 ----------------

/** 玩家可见的关系边：`known` / `inferred` 可见；`unknown` / `hidden` 一律不投影（R-OP-05）。 */
export function projectVisibleRelations(edges: readonly RelationEdge[]): RelationEdge[] {
  return edges
    .filter((e) => e.visibility === "known" || e.visibility === "inferred")
    .map((e) => ({ ...e }));
}
