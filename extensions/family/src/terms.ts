import relationship from "relationship.js";
import type { KinshipKind, RelationEdge } from "@life-sim/shared";
import { buildRelationGraph, isKinshipKind, shortestPath } from "@life-sim/game-core";
import { kinshipCoefficient } from "./coefficient.js";

/**
 * 中文称谓推导（家族扩展的解释层）。**纯函数、无 IO、无随机、无 `Date`**。
 *
 * 输入永远是**事实边集**与两个节点 id，输出是「该怎么称呼」。
 * 事实、可见性、上屏判定都不归这里 —— 见 `docs/EXTENSIONS.md` §1 的边界表。
 */

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
  relative: "亲戚",
};

// ---------------- 姻亲（配偶边）与半血亲的结构化处理 ----------------

/**
 * 配偶边记号。路径里出现它，这条读法就是**姻亲**，不是血亲。
 *
 * 这一区分必须显式存在，因为 `relationship.js` 会把姻亲折叠成血亲：
 * 实测 `爸爸的妻子 => ["妈妈"]`、`妈妈的丈夫 => ["爸爸"]`、
 * `妈妈的丈夫的女儿 => ["妹妹"]`（继妹被说成亲妹）。库的词表里没有「继」这一档，
 * 所以凡含配偶边的路径，都不能直接采信它的返回值。
 */
const SPOUSE_TOKENS: ReadonlySet<string> = new Set(["丈夫", "妻子"]);

/** 「某人的配偶」→ 称谓。仅在配偶边落在**路径末位**时查表合成。 */
const SPOUSE_OF: Readonly<Record<string, string>> = {
  爸爸: "继母",
  妈妈: "继父",
  儿子: "儿媳",
  女儿: "女婿",
  哥哥: "嫂子",
  弟弟: "弟媳",
  姐姐: "姐夫",
  妹妹: "妹夫",
  公公: "婆婆",
  婆婆: "公公",
  岳父: "岳母",
  岳母: "岳父",
};

/**
 * 库能给出的**姻亲词**白名单（配偶边不在末位时使用）。
 * 不在表内的返回值一律丢弃 —— 那种情况基本是「把姻亲折叠成血亲」的错误，
 * 宁可少一行，也不要写一个错称谓。
 */
const AFFINAL_TERMS: ReadonlySet<string> = new Set([
  "公公",
  "婆婆",
  "岳父",
  "岳母",
  "继父",
  "继母",
  "继子",
  "继女",
  "儿媳",
  "女婿",
  "嫂子",
  "弟媳",
  "姐夫",
  "妹夫",
  "小姑子",
  "小叔子",
  "大伯子",
  "小舅子",
  "大姨子",
  "小姨子",
  "连襟",
  "妯娌",
]);

/** 「继」字辈（多读法展示时允许与血亲并列，其它姻亲随口称呼不占位置）。 */
export const STEP_TERMS: ReadonlySet<string> = new Set([
  "继父",
  "继母",
  "继子",
  "继女",
  "继兄弟",
  "继姐妹",
  "儿媳",
  "女婿",
  "嫂子",
  "弟媳",
  "姐夫",
  "妹夫",
]);

/** 同胞称谓：只有这些才谈得上「同父异母 / 同母异父」。 */
const SIBLING_TERMS: ReadonlySet<string> = new Set(["哥哥", "弟弟", "姐姐", "妹妹"]);

/** 同胞边的 kind（用于半血亲中转判定）。 */
const SIBLING_KINDS: ReadonlySet<string> = new Set([
  "elder-brother",
  "younger-brother",
  "elder-sister",
  "younger-sister",
]);

/** 父母称谓：按定义只能一跳，多跳出现即说明链里把某个平行身份折叠掉了。 */
const PARENT_TERMS: ReadonlySet<string> = new Set(["爸爸", "妈妈", "父亲", "母亲"]);

/** 子女称谓：同上，我的孩子只能是一跳。`爸爸的女儿的儿子 ⇒ 儿子` 是折叠，不是亲缘。 */
const CHILD_TERMS: ReadonlySet<string> = new Set(["儿子", "女儿"]);

/** 配偶称谓：婚配是事实边或姻亲路径的产物，不该由血亲链猜出来。 */
const SPOUSE_TERMS: ReadonlySet<string> = new Set(["丈夫", "妻子", "老公", "老婆"]);

interface ParentSet {
  readonly fathers: ReadonlySet<string>;
  readonly mothers: ReadonlySet<string>;
}

/**
 * 直接亲代集合（只认 `子 → 父/母` 方向的边，因为反方向 `父 → 子` 不带性别信息，
 * 拿来猜父亲还是母亲会把半血亲判反 —— 宁可不判）。
 */
function parentSetOf(edges: readonly RelationEdge[], nodeId: string): ParentSet {
  const fathers = new Set<string>();
  const mothers = new Set<string>();
  for (const e of edges) {
    if (e.from !== nodeId) continue;
    if (e.kind === "father") fathers.add(e.to);
    else if (e.kind === "mother") mothers.add(e.to);
  }
  return { fathers, mothers };
}

/**
 * 半血亲判定：双方各有完整的一父一母，且**只共享其中一位**。
 *
 * 这是 `kind` 枚举刻意不表达的东西（枚举只到 `elder-brother` 这一层），
 * 但它完全由两条父边 + 两条母边算得出来，不需要新字段。
 * 信息不足时一律不标 —— 不猜。
 */
function halfSiblingWith(
  a: ParentSet,
  b: ParentSet,
): "同父异母" | "同母异父" | null {
  if (a.fathers.size !== 1 || a.mothers.size !== 1 || b.fathers.size !== 1 || b.mothers.size !== 1) {
    return null;
  }
  const [af] = a.fathers;
  const [am] = a.mothers;
  const [bf] = b.fathers;
  const [bm] = b.mothers;
  const sameFather = af === bf;
  const sameMother = am === bm;
  if (sameFather && !sameMother && am !== bm) return "同父异母";
  if (sameMother && !sameFather && af !== bf) return "同母异父";
  return null;
}

function halfSiblingLabel(
  edges: readonly RelationEdge[],
  from: string,
  to: string,
): "同父异母" | "同母异父" | null {
  return halfSiblingWith(parentSetOf(edges, from), parentSetOf(edges, to));
}

/**
 * 姻亲路径的称谓合成。返回 `null` = 这条读法不可命名，调用方丢弃。
 *
 * 三段式处理，因为姻亲的可命名程度取决于配偶边落在哪：
 * 1. **配偶边在末位** —— 「我某个血亲的配偶」，可直接由前缀称谓查 `SPOUSE_OF`；
 * 2. **配偶边在中间 + 子女收尾** —— 「继兄弟 / 继姐妹」（同户口、不同血）；
 * 3. **其余** —— 只接受库给的姻亲词，不接受任何血亲词。
 */
function affinalTerm(
  tokens: readonly string[],
  edges: readonly RelationEdge[],
  from: string,
  to: string,
): string | null {
  let lastSpouse = -1;
  for (let i = 0; i < tokens.length; i++) if (SPOUSE_TOKENS.has(tokens[i]!)) lastSpouse = i;
  if (lastSpouse < 0) return null;

  // 1) 配偶边在末位
  if (lastSpouse === tokens.length - 1) {
    const prefix = tokens.slice(0, -1);
    if (prefix.length === 0) return null; // 直接配偶：那就是事实行本身
    const base = relationshipCached(prefix.join("的"))[0];
    if (!base) return null;
    if (base === "爸爸" || base === "父亲" || base === "妈妈" || base === "母亲") {
      // 「父之妻 = 母」只在目标**本来就是生父母**时成立（库的默认假设）。
      // 否则就必须说「继」，这正是前任主称谓出错的根源。
      if (isDirectParent(edges, from, to)) return base;
      return base === "爸爸" || base === "父亲" ? "继母" : "继父";
    }
    return SPOUSE_OF[base] ?? null;
  }

  // 2) 配偶边在中间，且以子女边收尾：只认两种形状，其余交给白名单，不硬造词。
  //    形状一 `[配偶, 子女]` —— 我配偶的孩子 ⇒ 继子 / 继女；
  //    形状二 `[…, 父/母, 配偶, 子女]` —— 父/母的配偶的孩子 ⇒ 继兄弟 / 继姐妹。
  //    放宽到「任意含配偶边的路径 + 子女收尾」会造出「老公的妈妈的女儿 ⇒ 继女」这种错词。
  const tail = tokens[tokens.length - 1];
  if (tail === "儿子" || tail === "女儿") {
    if (tokens.length === 2 && lastSpouse === 0) return tail === "儿子" ? "继子" : "继女";
    const beforeSpouse = tokens[lastSpouse - 1];
    if (lastSpouse >= 1 && (beforeSpouse === "爸爸" || beforeSpouse === "妈妈")) {
      return tail === "儿子" ? "继兄弟" : "继姐妹";
    }
  }

  // 3) 其余姻亲：只认库给的姻亲词
  const raw = relationshipCached(tokens.join("的"));
  for (const t of [...new Set(raw)].sort()) if (AFFINAL_TERMS.has(t)) return t;
  return null;
}

/** `to` 是否为 `from` 的直接父母（生亲）。 */
function isDirectParent(edges: readonly RelationEdge[], from: string, to: string): boolean {
  for (const e of edges) {
    if (e.from === from && e.to === to && (e.kind === "father" || e.kind === "mother")) return true;
    if (e.from === to && e.to === from && (e.kind === "son" || e.kind === "daughter")) return true;
  }
  return false;
}

/**
 * relationship.js 的查表缓存。
 *
 * 同一个关系链记号会被反复求解：一次投影要遍历每张卡 × 每一行 × 每条路径，
 * 而链记号是高度重复的（同一个「爸爸的妈妈」在几十处出现）。无缓存时
 * 一个十二人、六十条边的家族能跑出十万次库调用，直接把请求拖死（实测超时）。
 *
 * 缓存键是**纯字符串**（与图无关），所以放模块级不会跨卡串味 ——
 * 与 `memo`（多跳路径枚举，按卡建）是两件事。
 */
const RELATION_CACHE = new Map<string, readonly string[]>();
const RELATION_CACHE_MAX = 4096;

function relationshipCached(text: string): readonly string[] {
  const hit = RELATION_CACHE.get(text);
  if (hit !== undefined) return hit;
  const v = relationship({ text });
  if (RELATION_CACHE.size < RELATION_CACHE_MAX) RELATION_CACHE.set(text, v);
  return v;
}

// ---------------- 单跳 / 最短路径称谓 ----------------

/** 断代 / 库无解时的粗称谓：明确「不猜代数」，不抛错、不静默返回空串。 */
export const COARSE_KINSHIP_TITLE = "远亲";

/** 自己对自己的称谓。 */
export const SELF_TITLE = "自己";

export interface KinshipTerm {
  /** 主称谓（多解时取字典序最小 ⇒ 确定性）。 */
  readonly term: string;
  /** 全部候选称谓（字典序）。 */
  readonly alternatives: readonly string[];
  /** 推导所用的关系链记号，如 `["爸爸","妈妈"]`；回退粗称谓时仍保留以便诊断。 */
  readonly tokens: readonly string[];
  /** 路径含断代边。 */
  readonly gapped: boolean;
  /** true = 由 relationship.js 精确推导；false = 断代/无解回退粗称谓。 */
  readonly exact: boolean;
}

/**
 * 求 `from` 对 `to` 的中文称谓。
 *
 * 管线：最短亲属路径 → 关系链记号（`爸爸的的妈妈`）→ `relationship.js` → 称谓。
 * 确定性：路径等长取字典序最小（core 的 `shortestPath` 保证），库多解再按字典序取最小。
 * 回退：断代边（gap）/ 库无解 ⇒ `COARSE_KINSHIP_TITLE`，`exact: false`。
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

  // core 的 `shortestPath` 回的是边 kind；称呼记号由本扩展翻译。
  const tokens = path.tokens.map((kind) => KINSHIP_TOKEN[kind as KinshipKind] ?? kind);
  if (path.gapped || tokens.length === 0) {
    return {
      term: COARSE_KINSHIP_TITLE,
      alternatives: [COARSE_KINSHIP_TITLE],
      tokens,
      gapped: path.gapped,
      exact: false,
    };
  }

  const raw = relationshipCached(tokens.join("的"));
  const alternatives = [...new Set(raw)].sort();
  if (alternatives.length === 0) {
    return {
      term: COARSE_KINSHIP_TITLE,
      alternatives: [COARSE_KINSHIP_TITLE],
      tokens,
      gapped: false,
      exact: false,
    };
  }
  return { term: alternatives[0], alternatives, tokens, gapped: false, exact: true };
}

/**
 * 一段亲缘的**一种读法**：一条具体路径 + 它给出的称谓。
 *
 * 「一人多角」的本质就是同一对端点存在多条路径，每条路径各自成立。
 * 例如某人既是「女儿」（经母亲）又是「孙女」（经父亲那条线），
 * 这不是两个关系，是同一个亲缘的两条路。
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
   * 这与“推导出来的关系另算一档”相反：推导不是新事实，它继承事实边的属性。
   */
  readonly visibility: string;
  /**
   * true = 路径经过配偶边 ⇒ 姻亲读法。
   *
   * 血亲与姻亲必须分开排序：血亲身份是主身份（「外婆」），姻亲是附加身份（「继母」）。
   * 混在一起排，就会出现「父亲的妻子」把「母亲的母亲」挤掉 —— 前者被库硬编码成「妈妈」，
   * 在字典序上还恰好赢过「外婆」。
   */
  readonly affinal: boolean;
  /** 半血亲标记（仅同胞称谓；`kind` 枚举不表达，由父边 + 母边算出）。 */
  readonly half?: "同父异母" | "同母异父";
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
 * 枚举 `from → to` 的**全部读法**（简单路径，跳数 ≤ maxHops）。
 *
 * 与 `kinshipTerm` 的区别：那个只回一条最短路径 + 同义叫法；这个按路径分开，
 * 一条路一个称谓。**先收集、后排序、最后去重**，顺序是：
 * 血亲优先 → 跳数升序 → 称谓字典序。第一项即主称谓。
 *
 * 旧实现是「边搜边去重」，DFS 先到达的那条会挤掉后到达的：布兰奇 → 玛蒂尔达 的
 * 2 跳血亲路径 `妈妈的妈妈 ⇒ 外婆` 位于「妈妈」分支，而 3 跳的 `爸爸的妻子 ⇒ 妈妈`
 * 位于「爸爸」分支，DFS 先走到底，于是主称谓被 3 跳的姻亲读法抢走。
 * 这不是「取了最小路径」，是「取了先到的那条」。
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
  const collected: KinshipReading[] = [];
  const half = halfSiblingLabel(edges, from, to);
  /**
   * 血亲门槛：r = 0 的两个人之间不存在血亲称谓。
   *
   * 这条判据独立于链记号（走父代映射 + Wright 路径），因此能挡住链式推导看不见的折叠：
   * `希尔达 → 女儿 → 弟弟` 会给出「儿子」，可库默认同胞同父母，而戈弗雷是继室所出，
   * 希尔达是他的继母不是生母（r = 0）。链看不见这件事，系数看得见。
   */
  const shareBlood = kinshipCoefficient(edges, from, to) > 0;

  /**
   * 首跳的「主边」约束。
   *
   * 近亲婚配会造出平行边：某人既是我的母亲、又是我的姐姐（父亲娶了自己的女儿）。
   * 这类平行边只在**一跳事实行**里成立——拿来当中转去推第三人必然失真：
   * `布兰奇 → 塞西莉[姐姐] → 玛蒂尔达[妈妈]` 会得出「妈妈」，可塞西莉本身就是她母亲，
   * 正解是「外婆」。所以：首跳目标若同时是本体的直接父母/子女，只允许父/母（子/女）边中转。
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

  /**
   * 半血亲不得当作推理中转。
   *
   * 库默认「兄弟」是同父同母，所以 `妈妈的弟弟的妈妈` 一律算成「外婆」。
   * 可同父异母的舅舅，其母亲是另一支的人 —— 继续从舅舅往上走就会认错亲。
   * 因此：路径中途经过一对半血亲同胞时，整条读法作废（端点本身是半血亲则照常，只是加前缀）。
   */
  const parentCache = new Map<string, ParentSet>();
  const parentsOf = (id: string): ParentSet => {
    const hit = parentCache.get(id);
    if (hit !== undefined) return hit;
    const v = parentSetOf(edges, id);
    parentCache.set(id, v);
    return v;
  };
  const halfSiblingByKey = new Map<string, "同父异母" | "同母异父">();
  for (const e of graph.edges) {
    if (!SIBLING_KINDS.has(e.kind)) continue;
    const key = `${e.from}>${e.to}`;
    if (halfSiblingByKey.has(key)) continue;
    const label = halfSiblingWith(parentsOf(e.from), parentsOf(e.to));
    if (label) halfSiblingByKey.set(key, label);
  }

  const walk = (
    node: string,
    tokens: string[],
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
      // 半血亲同胞只能作为**终点**，不能当中转：库默认同胞同父母，
      // 从这里继续往上走会把另一支的长辈认成自己的长辈。
      if (SIBLING_KINDS.has(e.kind) && e.to !== to && halfSiblingByKey.has(`${node}>${e.to}`)) {
        continue;
      }
      const nextTokens = [...tokens, KINSHIP_TOKEN[e.kind]];
      const nextVis = [...vis, e.visibility];
      const nextGapped = gapped || e.gap === true;
      if (e.to === to) {
        const affinal = nextTokens.some((t) => SPOUSE_TOKENS.has(t));
        const term = affinal
          ? affinalTerm(nextTokens, edges, from, to)
          : (() => {
              const raw = relationshipCached(nextTokens.join("的"));
              const all = [...new Set(raw)].sort();
              return all.length > 0 ? all[0]! : COARSE_KINSHIP_TITLE;
            })();
        // 姻亲路径给不出可信称谓时整条丢弃：宁可少一个身份，也不写错一个亲缘。
        if (term === null) continue;
        // 血亲读法必须过 r > 0（见上方 shareBlood）。
        if (!affinal && !shareBlood) continue;
        // 词与路必须同质（双向）：血亲路径不得产出姻亲词。
        // `女儿的儿子 … 的爸爸 ⇒ 女婿` 是同一类折叠 —— 库假定孙辈的父亲是我的女婿，
        // 而孙辈也可能是儿子的孩子。没有配偶边，就不该出现姻亲称谓。
        if (!affinal && (AFFINAL_TERMS.has(term) || SPOUSE_TERMS.has(term))) continue;
        // 父母称谓按定义是一跳。多跳算出「妈妈」，说明链里折叠了平行身份
        // （布兰奇 → 奥德里克[爸爸] → 休[儿子] → 玛蒂尔达[妈妈] ⇒ 库按「儿子=亲生」推出妈妈，
        // 而休与她只是同父异母：玛蒂尔达是她父亲的妻子，不是她母亲）。
        if (PARENT_TERMS.has(term) && hops + 1 > 1) continue;
        if (CHILD_TERMS.has(term) && hops + 1 > 1) continue;
        // 配偶只能来自事实边或姻亲路径；由「儿子的妈妈」推出「老婆」是猜测，不投影。
        if (!affinal && SPOUSE_TERMS.has(term)) continue;
        // 绕回本体的路径不是身份。
        if (term === SELF_TITLE) continue;
        const tagged = half && SIBLING_TERMS.has(term) ? `${half}的${term}` : term;
        collected.push({
          term: tagged,
          tokens: nextTokens,
          hops: hops + 1,
          gapped: nextGapped,
          visibility: composeVisibility(nextVis),
          affinal,
          ...(half && SIBLING_TERMS.has(term) ? { half } : {}),
        });
        continue;
      }
      used.add(e.to);
      walk(e.to, nextTokens, used, hops + 1, nextVis, nextGapped);
      used.delete(e.to);
    }
  };

  walk(from, [], new Set<string>([from]), 0, [], false);

  // 排序分层：血亲 → 「继」字辈 → 其余姻亲；同层内按跳数 → 称谓字典序。
  // 注意「继」只在**姻亲层内**优先：若拿它当全局键，血亲的「外孙」会被
  // 三跳的姻亲词「女婿」挤下去（那正是旧排序的问题）。
  const rank = (r: KinshipReading): number =>
    r.affinal ? (r.term.startsWith("继") ? 1 : 2) : 0;
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
