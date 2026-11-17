import type { KinshipKind, RelationEdge } from "@life-sim/shared";
import { buildRelationGraph, isKinshipKind, shortestPath } from "@life-sim/game-core";
import { kinshipFacts, signatureOfPath, type RelationSignature } from "./signature.js";
import {
  COARSE_AFFINAL_TERM,
  COARSE_BLOOD_TERM,
  COARSE_STEP_TERM,
  isCoarseTerm,
  nameAtoms,
} from "./table.js";

/**
 * 中文称谓推导（家族扩展的解释层）。**纯函数、无 IO、无随机、无 `Date`**。
 *
 * 这条实现**不再依赖 `relationship.js`**：输入是事实边集，先枚举路径，
 * 再把每条路径归约成结构签名（`signature.ts`），最后查我们自己的中文表
 * （`table.ts`）。公开接口与旧实现（`src/terms.ts`，保留作对照）逐字段一致。
 *
 * 边界不变：事实、可见性、上屏判定都不归这里 —— 见 `docs/EXTENSIONS.md` §1。
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
   * true = 路径含配偶步，或是继亲读法。
   *
   * 血亲与姻亲必须分开排序：血亲身份是主身份（「外婆」），姻亲是附加身份（「继母」）。
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

/**
 * 求 `from` 对 `to` 的中文称谓。
 *
 * 管线：最短亲属路径 → 结构签名 → 中文表。确定性：路径等长取字典序最小
 * （core 的 `shortestPath` 保证）；取名是纯函数。
 * 回退：断代边（gap）/ 签名不可归约 / 表覆盖不到 ⇒ `COARSE_KINSHIP_TITLE`，`exact: false`。
 * 不可达返回 `null`（不是「不认识」的证据，只表示图里没有亲属链）。
 */
export function kinshipTerm(
  edges: readonly RelationEdge[],
  from: string,
  to: string,
  opts: { readonly maxHops?: number } = {},
): KinshipTerm | null {
  if (from === to) {
    return { term: SELF_TITLE, alternatives: [SELF_TITLE], tokens: [], gapped: false, exact: true };
  }
  const graph = buildRelationGraph(edges);
  const path = shortestPath(graph, from, to, { maxHops: opts.maxHops ?? 8 });
  if (!path) return null;

  const tokens = path.tokens.map((kind) => KINSHIP_TOKEN[kind as KinshipKind] ?? kind);
  const coarse = (gapped: boolean): KinshipTerm => ({
    term: COARSE_KINSHIP_TITLE,
    alternatives: [COARSE_KINSHIP_TITLE],
    tokens,
    gapped,
    exact: false,
  });

  if (path.gapped || tokens.length === 0) return coarse(path.gapped);

  const knots = path.tokens as readonly KinshipKind[];
  const nodes = [path.edges[0]!.from, ...path.edges.map((e) => e.to)];
  const facts = kinshipFacts(edges);
  const resolved = signatureOfPath(knots, nodes, facts, from, path.gapped);

  if (resolved.kind === "signed") {
    // 主称谓不带「同父异母的」前缀：半血亲读法仍会出现在 `kinshipReadings` 里。
    const term = nameAtoms(resolved.atoms, facts, from, { halfPrefix: false });
    if (term !== null) return { term, alternatives: [term], tokens, gapped: false, exact: true };
  }

  /**
   * 最短路径不可命名时的兜底：回头枚举读法，取第一条**能命名**的。
   *
   * `shortestPath` 在同长度路径间按记号字典序决胜，可能恰好选中一条
   * 结构上不成立的路径（如「我父亲之子的同母姐姐」并不是我的姐姐），
   * 而同一对端点其实还有一条可命名的同长度路径。这时候直接给「远亲」
   * 会把有名字的亲戚说成没名字 —— 所以再枚举一次，只在这一档付出代价。
   */
  const rs = kinshipReadings(edges, from, to, { maxHops: opts.maxHops ?? 8 });
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
 * 枚举 `from → to` 的**全部读法**（简单路径，跳数 ≤ maxHops）。
 *
 * 与 `kinshipTerm` 的区别：那个只回一条最短路径 + 一个主称谓；这个按路径分开，
 * 一条路一个称谓。**先收集、后排序、最后去重**，顺序是：
 * 血亲优先 → 继亲 → 其余姻亲 → 跳数升序 → 称谓字典序。第一项即主称谓。
 *
 * 「血亲优先」不是排序偏好，而是结构事实：签名里有配偶步的读法永远排在后面，
 * 而且它们只可能从姻亲表取词（`table.ts` 的两张表互不相通）。
 */
export function kinshipReadings(
  edges: readonly RelationEdge[],
  from: string,
  to: string,
  opts: { readonly maxHops?: number } = {},
): KinshipReading[] {
  const maxHops = opts.maxHops ?? 3;
  if (from === to) return [];
  const graph = buildRelationGraph(edges);
  const facts = kinshipFacts(edges);
  /**
   * 精确读法与粗称谓分开收集。
   *
   * · 姻亲粗称谓（「姻亲」）**永远保留**：中文对「兄弟的妻子（长幼未知）」没有中性词，
   *   但「说姻亲」也比「整条读法消失」好（这一条是产品口径）。
   * · 血亲粗称谓（「远亲」）只在**一条都命不了名**时兜底，避免把「远亲」
   *   混进附加身份（`pickExtras` 只过滤姻亲，不过滤血亲）。
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
   *
   * 这是**路径枚举**规则，不是取名规则：它挡的是「同一对人两条平行边」被当成两跳。
   */
  const canonicalFirst = new Map<string, ReadonlySet<string>>();
  for (const e of graph.outgoing.get(from) ?? []) {
    const role =
      e.kind === "father" || e.kind === "mother"
        ? "parent"
        : e.kind === "son" || e.kind === "daughter"
          ? "child"
          : null;
    if (role === null) continue;
    const set = new Set(canonicalFirst.get(e.to) ?? []);
    set.add(role);
    canonicalFirst.set(e.to, set);
  }

  const walk = (
    node: string,
    kinds: KinshipKind[],
    nodePath: string[],
    used: Set<string>,
    hops: number,
    vis: string[],
    gapped: boolean,
  ): void => {
    if (hops >= maxHops) return;
    for (const e of graph.outgoing.get(node) ?? []) {
      if (!isKinshipKind(e.kind)) continue;
      if (used.has(e.to)) continue;
      if (hops === 0) {
        const canonical = canonicalFirst.get(e.to);
        if (canonical !== undefined) {
          const isParentEdge = e.kind === "father" || e.kind === "mother";
          const isChildEdge = e.kind === "son" || e.kind === "daughter";
          if (canonical.has("parent") && !isParentEdge) continue;
          if (canonical.has("child") && !isChildEdge) continue;
        }
      }

      const nextKinds = [...kinds, e.kind as KinshipKind];
      const nextNodes = [...nodePath, e.to];
      const nextVis = [...vis, e.visibility];
      const nextGapped = gapped || e.gap === true;

      if (e.to === to) {
        const resolved = signatureOfPath(nextKinds, nextNodes, facts, from, nextGapped);
        // 结构上不成立的路径（如「我女儿的同胞」并不是我的孩子）：整条丢弃。
        if (resolved.kind === "invalid") continue;
        if (resolved.kind === "coarse") {
          coarseBlood.push({
            term: COARSE_KINSHIP_TITLE,
            tokens: nextKinds.map((k) => KINSHIP_TOKEN[k]),
            hops: hops + 1,
            gapped: nextGapped,
            visibility: composeVisibility(nextVis),
            affinal: false,
          });
          continue;
        }
        // 直接配偶（一跳妻子/丈夫，或「儿子的妈妈」这种共亲）不在这里取名：
        // 它就是事实行本身，或是一条推测出来的婚配 —— 交给事实行/主称谓，
        // 不把「老婆」混进派生读法（旧实现同一口径，见 terms.ts 的 affinalTerm 分支 1）。
        if (resolved.atoms.length === 1 && resolved.atoms[0]!.role === "spouse") continue;

        // 表外：血亲给「远亲」，姻亲给「姻亲」，绝不编词。
        const term = nameAtoms(resolved.atoms, facts, from);
        const fallbackTerm =
          resolved.signature.stepKind !== null
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
          tokens: nextKinds.map((k) => KINSHIP_TOKEN[k]),
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

      used.add(e.to);
      walk(e.to, nextKinds, nextNodes, used, hops + 1, nextVis, nextGapped);
      used.delete(e.to);
    }
  };

  walk(from, [], [from], new Set<string>([from]), 0, [], false);

  // 姻亲粗称谓始终保留；血亲粗称谓仅在没有任何精确读法时兜底。
  const collected = precise.length > 0 ? [...precise, ...coarseAffinal] : [...coarseAffinal, ...coarseBlood];

  // 排序分层：血亲 → 继亲 → 其余姻亲；同层内按跳数 → 称谓字典序。
  const rank = (r: KinshipReading): number =>
    r.affinal ? (r.signature?.stepKind != null ? 1 : 2) : 0;
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

export {
  kinshipFacts,
  signatureOfPath,
  sexOfKind,
  roleOfKind,
  seniorityOfKind,
  sharedParentBreadth,
  sharedParentOf,
  isChildOf,
  isSpouseOf,
  type InternalAtom,
  type KinshipFacts,
  type RelationSignature,
  type SignatureResult,
  type Seniority,
  type Sex,
  type SharedParent,
  type SharedParentBreadth,
  type SignatureAtom,
  type StepKind,
} from "./signature.js";
export {
  ancestorTerm,
  descendantTerm,
  isCoarseTerm,
  nameAtoms,
  siblingTerm,
  COARSE_AFFINAL_TERM,
  COARSE_BLOOD_TERM,
  COARSE_STEP_TERM,
  type NameOptions,
} from "./table.js";
