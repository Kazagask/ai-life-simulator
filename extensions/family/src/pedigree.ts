import type { PedigreeEdgeView, PedigreeNodeView, PedigreeView } from "./contract.js";
import type { SnapshotDerivationContext } from "@life-sim/game-core";
import { parseFamilyConfig } from "./config.js";

/**
 * 族谱：**纯派生视图**（`docs/CLAN-DESIGN.md` 第一部分）。
 *
 * 只吃 `state.relations`（经内核收敛成 known/inferred 的 `visibleEdges`）与 actor 目录，
 * **不读任何宗族数据**、不写 state、不看随机数与时间 —— 同输入必然同输出。
 *
 * 四条决定（§1.2）：
 * 1. 世代**只按血缘**（`father/mother/son/daughter` 归一成 parent→child），婚姻不参与；
 * 2. 配偶边**无向**并按无序对去重（模板常同时写 `wife` 与 `husband`）；
 * 3. 子女挂 **parent 边**，不挂"夫妻对"（多妻/私生子/前妻之子全靠 parent 边定位）；
 * 4. `relative` 且 `gap: true` 的**不进树**，进 `looseEnds`。
 */

/** 目录里查不到人时的占位名（与 `game-core/actors.ts` 的 `UNKNOWN_ACTOR` 同值）。 */
const UNKNOWN_ACTOR = "（不明人物）";

type GenerationBasis = "blood" | "marriage" | "root";

/** 归一化后的 parent 边：`parent` 是父/母，`child` 是子女。 */
interface ParentEdge {
  readonly parent: string;
  readonly child: string;
  readonly role?: "father" | "mother";
  /** 在 `state.relations` 里的出现序（配偶序、稳定排序都靠它）。 */
  readonly order: number;
}

interface SpouseEdge {
  /** 无序对的字典序较小端（输出稳定）。 */
  readonly a: string;
  readonly b: string;
  readonly order: number;
}

interface SiblingEdge {
  readonly from: string;
  readonly to: string;
  readonly order: number;
}

interface Normalized {
  readonly parents: readonly ParentEdge[];
  readonly spouses: readonly SpouseEdge[];
  readonly siblings: readonly SiblingEdge[];
  /** 节点 id → 该节点配偶（按边出现序，去重）。 */
  readonly spousePartners: ReadonlyMap<string, readonly string[]>;
  /**
   * 父/母被隐藏的**可见**子女（不是布尔值）。
   *
   * 为什么要留 id 而不是当场定成 true：可见性判定在归一化阶段，而「谁真的上屏」要等
   * 世代窗口 / 规模上限截断之后才知道。一个被截掉的人有隐藏父母，不该让整张图挂上
   * 「父母不在已知范围内」——**只有活下来的节点才算**（`derivePedigree` 末尾再收口）。
   */
  readonly incompleteChildIds: ReadonlySet<string>;
  /** `gap: true` 的远亲（只保留可见端）。 */
  readonly looseEndIds: ReadonlySet<string>;
  readonly nodeIds: ReadonlySet<string>;
}

/**
 * 归一化：把关系边缩成「父子 / 配偶 / 兄弟」三类，顺手做可见性剔除。
 *
 * 可见性口径（§1.5 投影纪律）：**隐藏节点与它的所有连带边都不出现** —— 出现了就等于
 * 告诉玩家「有这么个人」。唯一的痕迹是 `incompleteChildIds`：某可见节点的父/母被隐藏，
 * UI 画 "?" 而不是把那个人补出来，也不把该节点错当根。
 *
 * 注意这条纪律的副作用（**是设计，不是 bug**）：既然隐藏端点整条被丢，走到最后的节点
 * 全部都是可见的 ⇒ `PedigreeNodeView.hasCard` 目前恒为 `true`。前端读 `!hasCard` 的
 * 分支因此是**保留分支**（给将来「可见但没卡」的节点，例如只听说过的某人），
 * **不是死代码、不要删**。
 */
/**
 * 族谱能看到的全部输入：**故意 `Omit` 掉 `extensionState`**。
 *
 * 「族谱不许读宗族数据」在 `docs/CLAN-DESIGN.md §3` 里是硬口径，但 `SnapshotDerivationContext`
 * 是同一个对象，族谱只要写一行 `ctx.extensionState` 就能偷看。所以在**类型上**把那个口封掉：
 * 要读宗族数据得先改这个签名，改签名会在 review 里被看见。纪律 → 约束。
 */
type PedigreeInput = Omit<SnapshotDerivationContext, "extensionState">;

/**
 * 同一对 `(parent, child)` 只留一条 parent 边（去重在归一化之后、派生之前）。
 *
 * 模板同时写 `{from: 子女, to: 父, kind: father}` 与 `{from: 父, to: 子女, kind: son}`
 * 是**合法输入**（两个方向表达同一事实），归一化后就成了两条重复边。输入口径不改，
 * 但画两条线就是重影，`edges` 条数也会失真 —— 所以去重是展示派生的事。
 *
 * 保留「信息更全」的那条，规则确定：
 * 1. 两条都带 `parentRole` 且不同 ⇒ 取 `father`（父系优先，与模板 `descent: patrilineal` 一致）；
 * 2. 一条带、一条不带 ⇒ 取带的；
 * 3. 都不带 ⇒ 取先出现的那条（`state.relations` 出现序）。
 * 结果按下标数组取回，不依赖 Map 迭代序。
 */
function dedupeParentEdges(parents: readonly ParentEdge[]): ParentEdge[] {
  const chosen = new Map<string, ParentEdge>();
  const keys: string[] = [];
  for (const e of parents) {
    const key = `${e.parent}\u0000${e.child}`;
    const prev = chosen.get(key);
    if (prev === undefined) {
      chosen.set(key, e);
      keys.push(key);
      continue;
    }
    chosen.set(key, preferRicherEdge(prev, e));
  }
  return keys.map((key) => chosen.get(key)!);
}

/** 两条同端点 parent 边取信息更全的一条（规则见 `dedupeParentEdges`）。 */
function preferRicherEdge(a: ParentEdge, b: ParentEdge): ParentEdge {
  if (a.role === b.role) return a;
  if (a.role === undefined) return b;
  if (b.role === undefined) return a;
  return a.role === "father" ? a : b;
}

function normalize(ctx: PedigreeInput): Normalized {
  const hidden = ctx.hiddenNodeIds;
  const visible = (id: string): boolean => !hidden.has(id);
  const parents: ParentEdge[] = [];
  const spouses: SpouseEdge[] = [];
  const siblings: SiblingEdge[] = [];
  const looseEndIds = new Set<string>();
  const spouseSeen = new Set<string>();
  const incompleteChildIds = new Set<string>();

  ctx.visibleEdges.forEach((edge, order) => {
    switch (edge.kind) {
      // `{from: 子女, to: 父/母}` —— `docs` 语义：kind 描述 from→to 的关系。
      case "father":
      case "mother": {
        if (!visible(edge.from)) return;
        if (!visible(edge.to)) {
          incompleteChildIds.add(edge.from);
          return;
        }
        parents.push({ parent: edge.to, child: edge.from, role: edge.kind, order });
        return;
      }
      // `{from: 父/母, to: 子女}`：方向相反，归一成 parent→child。
      case "son":
      case "daughter": {
        if (!visible(edge.to)) return;
        if (!visible(edge.from)) {
          incompleteChildIds.add(edge.to);
          return;
        }
        parents.push({ parent: edge.from, child: edge.to, order });
        return;
      }
      case "husband":
      case "wife": {
        if (!visible(edge.from) || !visible(edge.to)) return;
        const a = edge.from < edge.to ? edge.from : edge.to;
        const b = edge.from < edge.to ? edge.to : edge.from;
        const key = `${a}\u0000${b}`;
        if (spouseSeen.has(key)) return;
        spouseSeen.add(key);
        spouses.push({ a, b, order });
        return;
      }
      case "elder-brother":
      case "younger-brother":
      case "elder-sister":
      case "younger-sister": {
        if (!visible(edge.from) || !visible(edge.to)) return;
        siblings.push({ from: edge.from, to: edge.to, order });
        return;
      }
      case "relative": {
        // 只认「据称的远亲」：没标 gap 的 relative 既说不清代数又不该进树，直接丢弃
        // （没有展示位，也不许编一个世代出来）。
        if (edge.gap !== true) return;
        if (visible(edge.from)) looseEndIds.add(edge.from);
        if (visible(edge.to)) looseEndIds.add(edge.to);
        return;
      }
      default:
        // 社会边（师徒/朋友/…）没有辈分语义，不参与族谱。
        return;
    }
  });

  const nodeIds = new Set<string>([ctx.selfId]);
  for (const e of parents) {
    nodeIds.add(e.parent);
    nodeIds.add(e.child);
  }
  for (const e of spouses) {
    nodeIds.add(e.a);
    nodeIds.add(e.b);
  }
  for (const e of siblings) {
    nodeIds.add(e.from);
    nodeIds.add(e.to);
  }

  // 配偶序：按边出现序，逐人记「第几个配偶关系」（多妻/多夫时 UI 才需要）。
  const spousePartners = new Map<string, string[]>();
  for (const e of spouses) {
    const a = spousePartners.get(e.a);
    if (a) a.push(e.b);
    else spousePartners.set(e.a, [e.b]);
    const b = spousePartners.get(e.b);
    if (b) b.push(e.a);
    else spousePartners.set(e.b, [e.a]);
  }

  return {
    parents: dedupeParentEdges(parents),
    spouses,
    siblings,
    spousePartners,
    incompleteChildIds,
    looseEndIds,
    nodeIds,
  };
}

/**
 * 环检测：在**只含 parent 边**的子图上跑 DFS 三色（§1.3）。
 *
 * 不能直接用内核对亲属图的 `detectCycles` —— 那边把配偶也当亲缘边，会把
 * 「父女婚」这种合法输入误判成世代环；而且它只报环，不告诉你哪条是回边。
 *
 * 命中灰色节点 ⇒ 回边：该边**不参与世代计算**，且最终**整条不产出**（`docs/EXTENSIONS.md` §7.4）。
 * 节点按 id 升序起始、出边按输入顺序展开 ⇒ 结果稳定可复现（不依赖 Map 序）。
 */
function detectBackEdges(
  nodeIds: ReadonlySet<string>,
  parents: readonly ParentEdge[],
): Set<ParentEdge> {
  const children = new Map<string, ParentEdge[]>();
  for (const e of parents) {
    const list = children.get(e.parent);
    if (list) list.push(e);
    else children.set(e.parent, [e]);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const back = new Set<ParentEdge>();

  const visit = (node: string): void => {
    color.set(node, GRAY);
    for (const e of children.get(node) ?? []) {
      const c = color.get(e.child) ?? WHITE;
      if (c === GRAY) {
        back.add(e);
      } else if (c === WHITE) {
        visit(e.child);
      }
    }
    color.set(node, BLACK);
  };

  for (const node of [...nodeIds].sort()) {
    if ((color.get(node) ?? WHITE) === WHITE) visit(node);
  }
  return back;
}

/**
 * 世代 = 缩点后的最长路，按拓扑序 **O(V+E)** 一次扫完（§1.3）。
 *
 * **禁止 `while (changed)` 式 fixpoint**：那在环上不终止。回边已在调用方剔除，
 * 这里面对的是 DAG；万一还有残留环（不该发生），Kahn 走不完的节点回落到 seed 值，
 * 仍然给出有限且确定的世代（不抛、不挂死）。
 *
 * `seedOf` 提供「无父母节点」的起点：血缘上没人给它们定代，只能按配偶继承（§1.3 末条）。
 */
function longestPath(
  nodeIds: ReadonlySet<string>,
  parentEdgesOf: ReadonlyMap<string, readonly ParentEdge[]>,
  childrenOf: ReadonlyMap<string, readonly ParentEdge[]>,
  seedOf: (id: string) => number,
): Map<string, number> {
  const indegree = new Map<string, number>();
  for (const id of nodeIds) indegree.set(id, (parentEdgesOf.get(id) ?? []).length);

  const ready: string[] = [];
  for (const id of nodeIds) if ((indegree.get(id) ?? 0) === 0) ready.push(id);
  ready.sort();

  const gen = new Map<string, number>();
  while (ready.length > 0) {
    const id = ready.shift()!;
    const pe = parentEdgesOf.get(id) ?? [];
    gen.set(
      id,
      pe.length === 0 ? seedOf(id) : Math.max(...pe.map((e) => gen.get(e.parent) ?? 0)) + 1,
    );
    for (const e of childrenOf.get(id) ?? []) {
      const left = (indegree.get(e.child) ?? 1) - 1;
      indegree.set(e.child, left);
      if (left === 0) {
        ready.push(e.child);
        ready.sort();
      }
    }
  }

  for (const id of nodeIds) if (!gen.has(id)) gen.set(id, seedOf(id));
  return gen;
}

/** 无向邻接（BFS 截断用）：父子两向 + 配偶 + 兄弟。 */
function buildUndirected(
  parents: readonly ParentEdge[],
  spouses: readonly SpouseEdge[],
  siblings: readonly SiblingEdge[],
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    const sa = adj.get(a);
    if (sa) sa.add(b);
    else adj.set(a, new Set([b]));
    const sb = adj.get(b);
    if (sb) sb.add(a);
    else adj.set(b, new Set([a]));
  };
  for (const e of parents) link(e.parent, e.child);
  for (const e of spouses) link(e.a, e.b);
  for (const e of siblings) link(e.from, e.to);
  return adj;
}

/** BFS 距离（自 `selfId` 起；不可达 = `Infinity`）。节点顺序不影响结果。 */
function bfsDistances(adj: ReadonlyMap<string, ReadonlySet<string>>, from: string): Map<string, number> {
  const dist = new Map<string, number>([[from, 0]]);
  let frontier = [from];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const other of [...(adj.get(node) ?? [])].sort()) {
        if (dist.has(other)) continue;
        dist.set(other, (dist.get(node) ?? 0) + 1);
        next.push(other);
      }
    }
    frontier = next;
  }
  return dist;
}

const KIND_RANK: Record<PedigreeEdgeView["kind"], number> = { parent: 0, spouse: 1, sibling: 2 };

/**
 * 推导族谱视图。**纯函数**：不读时间、不写 state、不用模块级缓存。
 *
 * 截断（§1.4）两步都确定性：
 * 1. 世代窗口：保留 `|generation - selfGeneration| < maxGenerations`（以玩家为中轴）；
 * 2. 规模上限：从 self BFS，按「距离 → 世代距离 → id 升序」取前 `maxNodes`。
 *    **禁止按 Map 迭代序截断**（跨引擎不稳定）。
 */
export function derivePedigree(ctx: PedigreeInput): PedigreeView {
  const cfg = parseFamilyConfig(ctx.config);
  const norm = normalize(ctx);

  const back = detectBackEdges(norm.nodeIds, norm.parents);
  /** 世代计算用的 DAG：剔除回边（它们只做标记，不参与定代）。 */
  const dagParents = norm.parents.filter((e) => !back.has(e));
  const parentEdgesOf = new Map<string, ParentEdge[]>();
  const childrenOf = new Map<string, ParentEdge[]>();
  for (const e of dagParents) {
    const pc = parentEdgesOf.get(e.child);
    if (pc) pc.push(e);
    else parentEdgesOf.set(e.child, [e]);
    const ch = childrenOf.get(e.parent);
    if (ch) ch.push(e);
    else childrenOf.set(e.parent, [e]);
  }

  // 血缘世代：无父母者的来源值先占位 0（下一趟用配偶世代覆盖）。
  const bloodGen = longestPath(norm.nodeIds, parentEdgesOf, childrenOf, () => 0);

  const seed = new Map<string, number>();
  const basis = new Map<string, GenerationBasis>();
  for (const id of norm.nodeIds) {
    if ((parentEdgesOf.get(id) ?? []).length > 0) {
      basis.set(id, "blood");
      continue;
    }
    let inherited: number | null = null;
    const partnerGens: number[] = [];
    for (const partner of norm.spousePartners.get(id) ?? []) {
      // 配偶自己也没有父母 ⇒ 两边都没血缘锚点，互相继承只会得到无意义的 g0。
      if ((parentEdgesOf.get(partner) ?? []).length === 0) continue;
      const g = bloodGen.get(partner);
      if (g !== undefined) partnerGens.push(g);
    }
    if (partnerGens.length > 0) {
      /**
       * 上限 = 最小子女世代 - 1：外来配偶可以跟到配偶那一代，但**不能比自己的子女还晚**
       * （父女婚这种：配偶是 g1、子女也是 g1 ⇒ 取 0，血缘仍压过婚姻，§1.2 第 1 条）。
       */
      const childGens = (childrenOf.get(id) ?? []).map((e) => bloodGen.get(e.child) ?? 0);
      const cap = childGens.length > 0 ? Math.min(...childGens) - 1 : Number.POSITIVE_INFINITY;
      inherited = Math.max(0, Math.min(Math.max(...partnerGens), cap));
    }
    if (inherited !== null) {
      seed.set(id, inherited);
      basis.set(id, "marriage");
    } else {
      seed.set(id, 0);
      basis.set(id, "root");
    }
  }
  const generation = longestPath(
    norm.nodeIds,
    parentEdgesOf,
    childrenOf,
    (id) => seed.get(id) ?? 0,
  );

  const selfGeneration = generation.get(ctx.selfId) ?? 0;
  const adj = buildUndirected(norm.parents, norm.spouses, norm.siblings);
  const distance = bfsDistances(adj, ctx.selfId);

  // ---- 截断：世代窗口 → 规模上限（两步都确定性） ----
  const generationOf = (id: string): number => generation.get(id) ?? 0;
  const inWindow = [...norm.nodeIds].filter(
    (id) => Math.abs(generationOf(id) - selfGeneration) < cfg.maxGenerations,
  );
  const ordered = inWindow
    .slice()
    .sort(
      (a, b) =>
        (distance.get(a) ?? Number.POSITIVE_INFINITY) -
          (distance.get(b) ?? Number.POSITIVE_INFINITY) ||
        Math.abs(generationOf(a) - selfGeneration) - Math.abs(generationOf(b) - selfGeneration) ||
        (a < b ? -1 : a > b ? 1 : 0),
    );
  const kept = new Set(ordered.slice(0, cfg.maxNodes));
  const truncated = kept.size < norm.nodeIds.size;

  /**
   * `incomplete` 与 `truncated` 分工（别混回去）：
   *
   * - `truncated`：**有人没上屏**（世代窗口 / 规模上限截断）。
   * - `incomplete`：**上屏的人里**有人缺父/母 —— 那个父/母已知但被隐藏（`hiddenNodeIds`）。
   *
   * 因此 `incomplete` 只能在截断**之后**、按 `kept`（最终渲染的节点）判定：拿归一化阶段的
   * 全量图去算，会把「压根没画出来的人缺的父母」也算进来，面板就会对着只有玩家一个节点的
   * 图说「谱系不完整」。父母只是被世代窗口截掉**不算** `incomplete`（那是 `truncated`）。
   */
  let incomplete = false;
  for (const id of kept) {
    if (norm.incompleteChildIds.has(id)) {
      incomplete = true;
      break;
    }
  }

  // ---- 节点 ----
  const nodes: PedigreeNodeView[] = [...kept]
    .sort((a, b) => generationOf(a) - generationOf(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map((id) => {
      const actor = ctx.actors.get(id);
      const lifeState = actor?.lifeState ?? (actor?.alive === false ? "inactive" : "alive");
      const spouseOrdinal = spouseOrdinalOf(id, norm.spousePartners);
      return {
        // `id` 只作 React key / 跳转键，显示名一律取 `name`（绝不用裸 id）。
        id,
        name: actor?.name ?? UNKNOWN_ACTOR,
        isSelf: id === ctx.selfId,
        // 恒为 `true`：隐藏端点的边在 `normalize` 里整条被剔除 ⇒ 走到这里的节点必然可见。
        // 字段留着固定视图契约（将来「可见但没卡」的模式才有 false），前端 `!hasCard`
        // 分支是保留分支，不是死代码。
        hasCard: !ctx.hiddenNodeIds.has(id),
        genderLabel: actor?.genderLabel ?? "",
        age: actor?.age ?? 0,
        lifeStageLabel: actor?.lifeStageLabel ?? "",
        generation: generationOf(id),
        generationBasis: basis.get(id) ?? "blood",
        lifecycle: {
          state: lifeState,
          ...(actor?.reasonCode !== undefined ? { reasonCode: actor.reasonCode } : {}),
        },
        ...(spouseOrdinal !== undefined ? { spouseOrdinal } : {}),
      };
    });

  // ---- 边 ----
  const edges: PedigreeEdgeView[] = [];
  const push = (edge: PedigreeEdgeView): void => {
    if (!kept.has(edge.from) || !kept.has(edge.to)) return;
    edges.push(edge);
  };

  // 兄弟边只在**没有共同父边**时保留（有共同父母时，血缘关系已由 parent 边表达）。
  const parentSetOf = new Map<string, Set<string>>();
  for (const e of dagParents) {
    const set = parentSetOf.get(e.child);
    if (set) set.add(e.parent);
    else parentSetOf.set(e.child, new Set([e.parent]));
  }
  const shareParent = (a: string, b: string): boolean => {
    const pa = parentSetOf.get(a);
    if (pa === undefined) return false;
    const pb = parentSetOf.get(b);
    if (pb === undefined) return false;
    for (const p of pa) if (pb.has(p)) return true;
    return false;
  };

  /**
   * 回边**整条不产出**（`docs/EXTENSIONS.md` §7.4）：不是标个 flag 让 UI 忽略，而是连
   * 边都不给 —— 现实里人不可能是自己的祖先，画出来只会让玩家看到「引擎出错的样子」。
   */
  for (const e of norm.parents) {
    if (back.has(e)) continue;
    push({
      from: e.parent,
      to: e.child,
      kind: "parent",
      ...(e.role !== undefined ? { parentRole: e.role } : {}),
    });
  }

  /**
   * 继亲边：父/母的另一位配偶（不是自己的父/母）⇒ 继父/继母。
   *
   * 这正是 §1.2 第 3 条要防的那件事的**正解**：前妻之女不能挂到继母名下的「母」位，
   * 但继母确实是父的配偶 —— 画成点线（`step`），不占用血缘世代。
   */
  for (const e of norm.parents) {
    for (const partner of norm.spousePartners.get(e.parent) ?? []) {
      if (partner === e.child) continue;
      const otherParents = parentSetOf.get(e.child);
      if (otherParents?.has(partner) === true) continue;
      if (norm.parents.some((p) => p.parent === partner && p.child === e.child)) continue;
      push({
        from: partner,
        to: e.child,
        kind: "parent",
        step: true,
        affinal: true,
        derived: true,
      });
    }
  }

  for (const e of norm.spouses) push({ from: e.a, to: e.b, kind: "spouse", affinal: true });

  for (const e of norm.siblings) {
    if (shareParent(e.from, e.to)) continue;
    push({ from: e.from, to: e.to, kind: "sibling" });
  }

  edges.sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
      (a.to < b.to ? -1 : a.to > b.to ? 1 : 0),
  );

  // ---- 根 / 世代区间 / 远亲 ----
  const generations = nodes.map((n) => n.generation);
  const min = generations.length > 0 ? Math.min(...generations) : 0;
  const max = generations.length > 0 ? Math.max(...generations) : 0;
  const rootIds = nodes
    .filter((n) => n.generation === min)
    .map((n) => n.id)
    .sort();

  const keptNodeIds = new Set(nodes.map((n) => n.id));
  const looseEnds = [...norm.looseEndIds]
    .filter((id) => !keptNodeIds.has(id))
    .sort()
    .map((id) => ({
      id,
      name: ctx.actors.get(id)?.name ?? UNKNOWN_ACTOR,
      gap: true as const,
    }));

  return {
    rootIds,
    nodes,
    edges,
    generationRange: { min, max },
    ...(incomplete ? { incomplete: true } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(looseEnds.length > 0 ? { looseEnds } : {}),
  };
}

/**
 * 「此人是其配偶的第几位配偶」（1 起，§1.2 第 2 条：用**边出现序**，不用年龄——年龄会漂）。
 *
 * 只有多配偶时才下发：普通一对夫妻没有歧义，给每个人挂个 "第 1 位" 只是噪音。
 */
function spouseOrdinalOf(
  id: string,
  spousePartners: ReadonlyMap<string, readonly string[]>,
): number | undefined {
  const partners = spousePartners.get(id) ?? [];
  if (partners.length === 0) return undefined;
  const primary = partners[0]!;
  const siblingsInMarriage = spousePartners.get(primary) ?? [];
  if (siblingsInMarriage.length < 2) return undefined;
  const at = siblingsInMarriage.indexOf(id);
  return at >= 0 ? at + 1 : undefined;
}
