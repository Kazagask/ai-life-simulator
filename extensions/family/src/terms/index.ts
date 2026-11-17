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
 * → 收养（tier 3）。排序**跳数优先，tier 作平手裁决**：短路径先赢（「我老婆的哥哥」
 * 就是大舅子），同跳数时血亲先于拟制/收养。
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

/** 同跳数平手时，直系（没有同胞分叉）先于旁系。 */
function collateralRank(r: KinshipReading): number {
  return r.signature?.pattern.filter((a) => a.role === "sibling").length ?? 0;
}

/** kind 串字典序（模式一里与旧 `shortestPath` 的决胜口径一致：father 先于 mother）。 */
function lexLessKinds(a: readonly string[], b: readonly string[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    return a[i]! < b[i]!;
  }
  return a.length < b.length;
}

/** 不带长幼/不分性别的中性谱系词：同跳数时让位给更具体的读法。 */
const NEUTRAL_TERMS: ReadonlySet<string> = new Set([
  "兄弟",
  "姐妹",
  "叔伯",
  "姑姑",
  "舅舅",
  "姨妈",
  "姻亲",
  "养亲",
  "远亲",
  "继亲",
]);

/** 可见性合成：取路径上最保守的一档。 */
function composeVisibility(pathVis: readonly string[]): string {
  let min = "known";
  for (const v of pathVis) {
    if ((VIS_RANK[v] ?? 0) < (VIS_RANK[min] ?? 0)) min = v;
  }
  return min;
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
  /**
   * `kinshipTerm(pair)` **就是** `readings[0]`：同一比较器、同一套规则。
   *
   * 以前这里另走一条「最短移动路径」选择逻辑，会和 `kinshipReadings` 的首项不一致
   * （同一个「她」，事实行一个称谓、派生行另一个）。现在只保留一条选择路径。
   *
   * 事实行「只看这一条边」的场景请用 `termForEdge(edge)`，语义不同，名字也不同。
   */
  const rs = kinshipReadingsIn(graph, from, to, { maxHops: opts.maxHops ?? 8 });
  const best = rs[0];
  if (best === undefined) return null;
  return {
    term: best.term,
    alternatives: [best.term],
    tokens: best.tokens,
    gapped: best.gapped,
    exact: !isCoarseTerm(best.term) && !best.gapped,
  };
}

/**
 * 「这条边本身叫什么」——**只用于事实行**，与「这两个人之间怎么称呼」分开。
 *
 * 与 `kinshipTerm(pair)` 的差别在语义而不是实现：这里拿单边图跑同一套规则，
 * 所以 `father` 边出爸爸、`wife` 边出老婆，不会被同一对端点的其他身份挤掉。
 */
export function termForEdge(
  edge: RelationEdge,
  opts: { readonly maxHops?: number } = {},
): KinshipTerm | null {
  return kinshipTermIn(kinGraphFromEdges([edge]), edge.from, edge.to, {
    maxHops: opts.maxHops ?? 1,
  });
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
 * 顺序：**跳数升序 → tier 升序（血亲 → 拟制 → 收养）→ 精确词先于粗称谓 → 称谓字典序**。
 * 第一项即主称谓（`kinshipTerm(pair)` 就是它）。半血亲的「同父异母的」前缀在
 * 读法里加（一个读法就是一条路径）；只描述单条边的事实行请用 `termForEdge`。
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
        // 只跳过**共亲推断**的配偶（「儿子的妈妈」）：婚配状态没有落边，不能因此叫老婆。
        // 事实婚配（一跳妻子/丈夫）保留 —— `kinshipTerm(pair)` 就是 `readings[0]`，
        // 两口子之间「怎么称呼」本来就该是老婆/老公。
        if (
          resolved.atoms.length === 1 &&
          resolved.atoms[0]!.role === "spouse" &&
          resolved.atoms[0]!.inferred
        ) {
          continue;
        }

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

  // 排序：**跳数升序 → tier 升序 → 精确词先于粗称谓 → 有长幼先于中性词
  //        → 直系先于旁系 → kind 字典序 → 称谓字典序**。
  //
  // 跳数优先是语感：「我老婆的哥哥」就是大舅子，不会因为另有一条三跳血亲路径
  // 就被叫成远房表叔。tier 只在**同跳数**时裁决（同跳数血亲优先）。
  // 最后一条「有长幼先于中性词」是为了不让同跳数的 `爸爸/儿子` 用「兄弟」压掉
  // 另一条带 `elder-sister + elder-brother` 的「哥哥」—— 信息在就不要丢。
  const rank = (r: KinshipReading): number => r.signature?.tier ?? 1;
  const coarseRank = (r: KinshipReading): number => (isCoarseTerm(r.term) ? 1 : 0);
  const neutralRank = (r: KinshipReading): number =>
    NEUTRAL_TERMS.has(r.term.replace(/^同父异母的|^同母异父的/, "")) ? 1 : 0;
  collected.sort(
    (a, b) =>
      a.hops - b.hops ||
      rank(a) - rank(b) ||
      coarseRank(a) - coarseRank(b) ||
      neutralRank(a) - neutralRank(b) ||
      collateralRank(a) - collateralRank(b) ||
      (lexLessKinds(a.signature?.kinds ?? [], b.signature?.kinds ?? []) ? -1 : 0) ||
      (lexLessKinds(b.signature?.kinds ?? [], a.signature?.kinds ?? []) ? 1 : 0) ||
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
