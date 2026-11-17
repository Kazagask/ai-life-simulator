import type { KinshipKind, RelationEdge } from "@life-sim/shared";
import { kinGraphFromEdges, movesOf, type KinGraph } from "./kingraph.js";
import {
  signatureOfMoves,
  type KinMove,
  type MoveKind,
  type RelationSignature,
} from "./signature.js";
import {
  COARSE_ADOPTIVE_TERM,
  COARSE_AFFINAL_TERM,
  COARSE_BLOOD_TERM,
  COARSE_STEP_TERM,
  isCoarseTerm,
  nameAtoms,
} from "./table.js";

/**
 * 中文称谓推导（家族扩展的解释层）。**纯函数、无 IO、无随机、无 `Date`**。
 *
 * 管线：`KinGraph`（边或指针 + 婚配 + 收养）→ 简单路径 → 结构签名 → 中文表。
 *
 * 推导按三层走（`docs/FAMILY-GRAPH.md` §4.5）：血亲（tier 1）→ 拟制/婚配（tier 2）
 * → 收养（tier 3）。排序**层号升序优先**，再比跳数，所以血亲读法天然排在
 * 拟制/收养前面，展示层不需要再过滤。
 *
 * 公开接口与旧实现（`src/terms.ts`，保留作对照）逐字段一致；额外提供
 * `kinshipTermIn` / `kinshipReadingsIn` 直接吃 `KinGraph`（指针模型用）。
 */

/** 亲属边 → 关系链记号（诊断用，与旧实现同一套记号）。 */
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
  relative: "亲戚",
};

/** 移动 → 诊断记号（收养不属 `KinshipKind`）。 */
export const MOVE_TOKEN: Record<MoveKind, string> = {
  ...KINSHIP_TOKEN,
  "adoptive-father": "养父",
  "adoptive-mother": "养母",
  "adoptive-son": "养子",
  "adoptive-daughter": "养女",
};

/** 断代 / 表外时的粗称谓：明确「不猜代数」，不抛错、不静默返回空串。 */
export const COARSE_KINSHIP_TITLE = COARSE_BLOOD_TERM;

/** 自己对自己的称谓。 */
export const SELF_TITLE = "自己";

export interface KinshipTerm {
  /** 主称谓。 */
  readonly term: string;
  /** 全部候选称谓（本实现按结构取名，通常只有一项）。 */
  readonly alternatives: readonly string[];
  /** 推导所用的关系链记号，如 `["爸爸","妈妈"]`；回退粗称谓时仍保留以便诊断。 */
  readonly tokens: readonly string[];
  /** 路径含断代边。 */
  readonly gapped: boolean;
  /** true = 由结构签名精确取名；false = 断代/表外回退粗称谓。 */
  readonly exact: boolean;
}

/**
 * 一段亲缘的**一种读法**：一条具体路径 + 它给出的称谓。
 *
 * 「一人多角」的本质就是同一对端点存在多条路径，每条路径各自成立。
 */
export interface KinshipReading {
  /** 该路径推出的称谓 */
  readonly term: string;
  /** 关系链记号，如 ["妈妈","妈妈"] */
  readonly tokens: readonly string[];
  readonly hops: number;
  readonly gapped: boolean;
  /**
   * 该读法的可见性 = **所经全部边的合成**（取最保守的一档）。
   * 任何一条边 unknown / hidden ⇒ 整条读法不可见，调用方不得投影。
   */
  readonly visibility: string;
  /**
   * true = 路径含配偶步/继亲/收养（非纯血亲）。
   */
  readonly affinal: boolean;
  /** 半血亲标记（仅同胞称谓）。 */
  readonly half?: "同父异母" | "同母异父";
  /** 该读法的结构签名（诊断用；调用方不应依赖它上屏）。 */
  readonly signature?: RelationSignature;
}

const VIS_RANK: Record<string, number> = { known: 3, inferred: 2, unknown: 1, hidden: 0 };

/** 可见性合成：取路径上最保守的一档。 */
function composeVisibility(pathVis: readonly string[]): string {
  let min = "known";
  for (const v of pathVis) {
    if ((VIS_RANK[v] ?? 0) < (VIS_RANK[min] ?? 0)) min = v;
  }
  return min;
}

/** 关系链字典序比较（等长路径决胜，与 core 的 `shortestPath` 同一口径）。 */
function lexLess(a: readonly string[], b: readonly string[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    return a[i]! < b[i]!;
  }
  return a.length < b.length;
}

interface MovePath {
  readonly moves: readonly KinMove[];
  /** 等长决胜用的 kind 串（不是中文记号）。 */
  readonly keys: readonly string[];
  /** 路径的推导层（1 血亲 / 2 拟制 / 3 收养）：**先比层，再比字典序**。 */
  readonly tier: 1 | 2 | 3;
  readonly gapped: boolean;
}

/** 单步带来的层：血亲 1、婚配/继亲 2、收养 3。 */
function moveTier(kind: KinMove["kind"]): 1 | 2 | 3 {
  if (kind === "adoptive-father" || kind === "adoptive-mother" || kind === "adoptive-son" || kind === "adoptive-daughter") {
    return 3;
  }
  if (kind === "husband" || kind === "wife") return 2;
  return 1;
}

/**
 * 最短移动路径（BFS 逐层，等长取 kind 字典序最小）。
 *
 * 与 core 的 `shortestPath` 同算法，只是走 `KinGraph` 的移动表，
 * 因此收养也能进路径。`from === to` 返回空路径；不可达返回 `null`。
 */
function shortestMoves(
  graph: KinGraph,
  from: string,
  to: string,
  maxHops: number,
): MovePath | null {
  if (from === to) return { moves: [], keys: [], tier: 1, gapped: false };
  const best = new Map<string, MovePath>();
  let frontier = new Map<string, MovePath>([[from, { moves: [], keys: [], tier: 1, gapped: false }]]);

  for (let hop = 0; hop < maxHops && frontier.size > 0; hop++) {
    const next = new Map<string, MovePath>();
    for (const [node, st] of frontier) {
      for (const mv of movesOf(graph, node)) {
        if (mv.to === from) continue; // 简单路径：不折返起点
        if (best.has(mv.to)) continue; // 已更短到达
        const stepTier = moveTier(mv.kind);
        const cand: MovePath = {
          moves: [...st.moves, mv],
          keys: [...st.keys, mv.kind],
          tier: (st.tier > stepTier ? st.tier : stepTier) as 1 | 2 | 3,
          gapped: st.gapped || mv.gapped === true,
        };
        const prev = next.get(mv.to);
        // 同长度路径：层号小的优先（血亲 > 拟制 > 收养），再按 kind 字典序定夺。
        if (prev === undefined || cand.tier < prev.tier || (cand.tier === prev.tier && lexLess(cand.keys, prev.keys))) {
          next.set(mv.to, cand);
        }
      }
    }
    for (const [node, st] of next) best.set(node, st);
    const hit = best.get(to);
    if (hit !== undefined) return hit;
    frontier = next;
  }
  return null;
}

// ---------------- kinshipTerm ----------------

/**
 * 求 `from` 对 `to` 的中文称谓（`KinGraph` 版）。
 *
 * 回退：断代边（gap）/ 签名不可归约 / 表覆盖不到 ⇒ `COARSE_KINSHIP_TITLE`，`exact: false`。
 * 不可达返回 `null`（不是「不认识」的证据，只表示图里没有亲属链）。
 */
export function kinshipTermIn(
  graph: KinGraph,
  from: string,
  to: string,
  opts: { readonly maxHops?: number } = {},
): KinshipTerm | null {
  if (from === to) {
    return { term: SELF_TITLE, alternatives: [SELF_TITLE], tokens: [], gapped: false, exact: true };
  }
  const maxHops = opts.maxHops ?? 8;
  const path = shortestMoves(graph, from, to, maxHops);
  if (path === null) return null;

  const tokens = path.moves.map((m) => MOVE_TOKEN[m.kind]);
  const coarse = (gapped: boolean): KinshipTerm => ({
    term: COARSE_KINSHIP_TITLE,
    alternatives: [COARSE_KINSHIP_TITLE],
    tokens,
    gapped,
    exact: false,
  });

  if (path.gapped || tokens.length === 0) return coarse(path.gapped);

  const facts = graph.facts;
  const resolved = signatureOfMoves(path.moves, facts, from, path.gapped);
  if (resolved.kind === "signed") {
    // 主称谓不带「同父异母的」前缀：半血亲读法仍会出现在 `kinshipReadings` 里。
    const term = nameAtoms(resolved.atoms, facts, from, { halfPrefix: false });
    if (term !== null) return { term, alternatives: [term], tokens, gapped: false, exact: true };
  }

  /**
   * 最短路径不可命名时的兜底：回头枚举读法，取第一条**能命名**的。
   *
   * 同长度路径按 kind 字典序决胜，可能恰好选中一条结构上不成立的路径，
   * 而同一对端点其实还有一条可命名的同长度路径。只在这一档付出枚举代价。
   */
  const rs = kinshipReadingsIn(graph, from, to, { maxHops });
  const best = rs.find((r) => !isCoarseTerm(r.term)) ?? rs[0];
  if (best !== undefined) {
    return {
      term: best.term,
      alternatives: [best.term],
      tokens: best.tokens,
      gapped: best.gapped,
      exact: !isCoarseTerm(best.term) && !best.gapped,
    };
  }
  return coarse(path.gapped);
}

/**
 * 求 `from` 对 `to` 的中文称谓（事实边集版，模式一）。
 *
 * 与 `kinshipTermIn` 相同，只是先把边集归一成 `KinGraph`。
 */
export function kinshipTerm(
  edges: readonly RelationEdge[],
  from: string,
  to: string,
  opts: { readonly maxHops?: number } = {},
): KinshipTerm | null {
  return kinshipTermIn(kinGraphFromEdges(edges), from, to, opts);
}

// ---------------- kinshipReadings ----------------

/**
 * 枚举 `from → to` 的**全部读法**（简单路径，跳数 ≤ maxHops）。
 *
 * 顺序：**tier 升序（血亲 → 拟制 → 收养）→ 跳数升序 → 称谓字典序**。
 * 第一项即主称谓。半血亲的「同父异母的」前缀在这里加（一个读法就是一条路径）；
 * `kinshipTerm` 的主称谓不加。
 */
export function kinshipReadingsIn(
  graph: KinGraph,
  from: string,
  to: string,
  opts: { readonly maxHops?: number } = {},
): KinshipReading[] {
  const maxHops = opts.maxHops ?? 3;
  if (from === to) return [];
  const facts = graph.facts;

  /**
   * 精确读法与粗称谓分开收集。
   *
   * · 姻亲/收养粗称谓（「姻亲」「养亲」）**永远保留**：中文对「兄弟的妻子（长幼未知）」
   *   没有中性词，但「说姻亲」也比「整条读法消失」好（产品口径）。
   * · 血亲粗称谓（「远亲」）只在**一条都命不了名**时兜底，避免混进附加身份。
   */
  const precise: KinshipReading[] = [];
  const coarseAffinal: KinshipReading[] = [];
  const coarseBlood: KinshipReading[] = [];

  /**
   * 首跳的「主边」约束。
   *
   * 近亲婚配会造出平行边：某人既是我的母亲、又是我的姐姐（父亲娶了自己的女儿）。
   * 这类平行边只在**一跳事实行**里成立——拿来当中转去推第三人必然失真：
   * `布兰奇 → 塞西莉[姐姐] → 玛蒂尔达[妈妈]` 会得出「妈妈」，可塞西莉本身就是她母亲，
   * 正解是「外婆」。所以：首跳目标若同时是本体的直接父母/子女，只允许父/母（子/女）边中转。
   */
  const canonicalFirst = new Map<string, ReadonlySet<string>>();
  for (const mv of movesOf(graph, from)) {
    const role =
      mv.kind === "father" || mv.kind === "mother"
        ? "parent"
        : mv.kind === "son" || mv.kind === "daughter"
          ? "child"
          : null;
    if (role === null) continue;
    const set = new Set(canonicalFirst.get(mv.to) ?? []);
    set.add(role);
    canonicalFirst.set(mv.to, set);
  }

  const walk = (
    node: string,
    path: readonly KinMove[],
    used: Set<string>,
    hops: number,
    vis: string[],
    gapped: boolean,
  ): void => {
    if (hops >= maxHops) return;
    for (const mv of movesOf(graph, node)) {
      if (used.has(mv.to)) continue;
      // 主边约束只挡「拿平行边当中转」，不挡一跳事实本身：
      // 同一个端点同时是生父与养父时，两条一跳读法都要保留。
      if (hops === 0 && mv.to !== to) {
        const canonical = canonicalFirst.get(mv.to);
        if (canonical !== undefined) {
          const isParentEdge = mv.kind === "father" || mv.kind === "mother";
          const isChildEdge = mv.kind === "son" || mv.kind === "daughter";
          if (canonical.has("parent") && !isParentEdge) continue;
          if (canonical.has("child") && !isChildEdge) continue;
        }
      }

      const nextPath = [...path, mv];
      const nextVis = [...vis, mv.visibility ?? "known"];
      const nextGapped = gapped || mv.gapped === true;

      if (mv.to === to) {
        const resolved = signatureOfMoves(nextPath, facts, from, nextGapped);
        // 结构上不成立的路径（如「我女儿的同胞」并不是我的孩子）：整条丢弃。
        if (resolved.kind === "invalid") continue;
        if (resolved.kind === "coarse") {
          coarseBlood.push({
            term: COARSE_KINSHIP_TITLE,
            tokens: nextPath.map((m) => MOVE_TOKEN[m.kind]),
            hops: hops + 1,
            gapped: nextGapped,
            visibility: composeVisibility(nextVis),
            affinal: false,
          });
          continue;
        }
        // 直接配偶（一跳妻子/丈夫，或「儿子的妈妈」这种共亲）不在这里取名：
        // 它就是事实行本身，或是一条推测出来的婚配 —— 交给事实行/主称谓。
        if (resolved.atoms.length === 1 && resolved.atoms[0]!.role === "spouse") continue;

        const term = nameAtoms(resolved.atoms, facts, from);
        const fallbackTerm =
          resolved.signature.stepKind === "adoptive"
            ? COARSE_ADOPTIVE_TERM
            : resolved.signature.stepKind !== null
              ? COARSE_STEP_TERM
              : resolved.signature.affinal
                ? COARSE_AFFINAL_TERM
                : COARSE_KINSHIP_TITLE;
        const finalTerm = term ?? fallbackTerm;
        if (finalTerm === SELF_TITLE) continue;
        const signature = resolved.signature;
        const half =
          finalTerm.startsWith("同父异母的")
            ? ("同父异母" as const)
            : finalTerm.startsWith("同母异父的")
              ? ("同母异父" as const)
              : undefined;
        const reading: KinshipReading = {
          term: finalTerm,
          tokens: nextPath.map((m) => MOVE_TOKEN[m.kind]),
          hops: hops + 1,
          gapped: nextGapped,
          visibility: composeVisibility(nextVis),
          affinal: signature.affinal,
          ...(half !== undefined ? { half } : {}),
          signature,
        };
        if (!isCoarseTerm(finalTerm)) precise.push(reading);
        else if (reading.affinal) coarseAffinal.push(reading);
        else coarseBlood.push(reading);
        continue;
      }

      used.add(mv.to);
      walk(mv.to, nextPath, used, hops + 1, nextVis, nextGapped);
      used.delete(mv.to);
    }
  };

  walk(from, [], new Set<string>([from]), 0, [], false);

  // 姻亲/收养粗称谓始终保留；血亲粗称谓仅在没有任何精确读法时兜底。
  const collected =
    precise.length > 0 ? [...precise, ...coarseAffinal] : [...coarseAffinal, ...coarseBlood];

  // 排序：tier 升序 → 跳数升序 → 称谓字典序。
  const rank = (r: KinshipReading): number => r.signature?.tier ?? 1;
  collected.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.hops - b.hops ||
      (a.term < b.term ? -1 : a.term > b.term ? 1 : 0),
  );
  const seen = new Set<string>();
  const out: KinshipReading[] = [];
  for (const r of collected) {
    if (seen.has(r.term)) continue;
    seen.add(r.term);
    out.push(r);
  }
  return out;
}

/** 枚举读法（事实边集版，模式一）。 */
export function kinshipReadings(
  edges: readonly RelationEdge[],
  from: string,
  to: string,
  opts: { readonly maxHops?: number } = {},
): KinshipReading[] {
  return kinshipReadingsIn(kinGraphFromEdges(edges), from, to, opts);
}

export {
  birthSeniority,
  combineSeniority,
  isChildOf,
  isSpouseOf,
  kinshipFacts,
  moveRole,
  moveSex,
  roleOfKind,
  seniorityOfKind,
  sexOfKind,
  sharedParentBreadth,
  sharedParentOf,
  signatureOfMoves,
  signatureOfPath,
  type AtomRole,
  type InternalAtom,
  type KinMove,
  type KinshipFacts,
  type MoveKind,
  type RelationSignature,
  type Seniority,
  type Sex,
  type SharedParent,
  type SharedParentBreadth,
  type SignatureAtom,
  type SignatureResult,
  type StepKind,
} from "./signature.js";
export {
  isMoveKind,
  kinGraphFromEdges,
  kinGraphFromPointers,
  movesOf,
  type KinAdoption,
  type KinChild,
  type KinGraph,
  type KinParent,
  type KinPerson,
  type KinSpouse,
} from "./kingraph.js";
export {
  ancestorTerm,
  descendantTerm,
  isCoarseTerm,
  nameAtoms,
  siblingTerm,
  COARSE_ADOPTIVE_TERM,
  COARSE_AFFINAL_TERM,
  COARSE_BLOOD_TERM,
  COARSE_STEP_TERM,
  type NameOptions,
} from "./table.js";
