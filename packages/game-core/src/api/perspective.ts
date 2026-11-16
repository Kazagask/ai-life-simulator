import type {
  DagNodeView,
  KnowledgeEntry,
  ObservationLedger,
  Perspective,
  PerspectiveFactItem,
  PerspectiveFactView,
  SetKnowledgeArgs,
  TaskStatus,
  WorldStateV2,
} from "@life-sim/shared";

/**
 * 统一透视窗口（T-01 / T-05a，v2 §6.3）。F4 硬规则：窗口计算**只归 game-core**，
 * agent-runtime 不得自建可见性判据。本文件全部为纯函数 / 只读投影，不写 `WorldStateV2`；
 * 台账写入由 `applyKnowledgeBatch` 计算新值，赋值动作留给 `api/engine-api.ts`。
 *
 * - world：全量权威事实 + 全部隐秘 + hidden DAG 节点 + **全部观察者知识台账**。
 * - player / npc:<id>：只含该观察者在统一台账中 `known` / `inferred` 的事实；
 *   不同 NPC 窗口互不可见对方的 secret，NPC 与玩家共用同一台账与同一 `buildFacts`。
 */

/** 结构化事实引用 id：flag / npc 隐秘 / DAG 节点。 */
export function worldFactRefs(state: WorldStateV2): string[] {
  const refs: string[] = [];
  for (const key of Object.keys(state.flags)) refs.push(`flag:${key}`);
  for (const npc of state.npcs) {
    for (const secret of npc.secrets) refs.push(secret);
  }
  for (const node of state.taskDag.nodes) refs.push(`dag:${node.id}`);
  return refs;
}

/** world 窗口独有的隐秘引用（npc 隐秘 + hidden DAG 节点）；player / npc 窗口默认不含。 */
export function collectHiddenRefs(state: WorldStateV2): string[] {
  const hidden: string[] = [];
  for (const npc of state.npcs) {
    for (const secret of npc.secrets) hidden.push(secret);
  }
  for (const node of state.taskDag.nodes) {
    if (node.visibility === "hidden") hidden.push(`dag:${node.id}`);
  }
  return hidden;
}

function resolveFactValue(state: WorldStateV2, factRef: string): unknown {
  if (factRef.startsWith("flag:")) return state.flags[factRef.slice(5)];
  const node = state.taskDag.nodes.find((n) => `dag:${n.id}` === factRef);
  if (node) return { nodeId: node.id, status: node.status, visibility: node.visibility };
  // npc 隐秘：只回引用 id，不回原文（隐秘原文靠 trace 掩码，不进任何窗口值）。
  return factRef;
}

function cloneLedger(ledger: ObservationLedger): ObservationLedger {
  return Object.fromEntries(
    Object.entries(ledger).map(([observer, entries]) => [
      observer,
      entries.map((e) => ({ ...e })),
    ]),
  ) as ObservationLedger;
}

/**
 * ADR-0037 D3：world 窗口的节点形状（编译期完整性）。
 *
 * `DagNodeView` 的 world-only 字段是 optional（为了不分裂成 union），所以这里用一份
 * 更严的内部接口承接 world 分支的构造 —— 少抄一个字段会在**编译期**报错，而不是等到
 * LLM 拿到残缺视图后盲写。
 */
interface WorldDagNodeView extends DagNodeView {
  title: string;
  kind: string;
  status: TaskStatus;
  visibility: "public" | "hidden";
  templateRefs: string[];
}

/**
 * `buildFacts(perspective)`：三/多类窗口唯一实现。
 * world 携带 ledger（v2 §6.3.2 仅 world 允许），player / npc 不携带（否则
 * `PerspectiveFactViewSchema` 的 superRefine 会拒收）。
 *
 * DAG 节点的裁法（ADR-0037 D3）：
 * - world：全量（含 hidden）+ 顶层 `edges`；
 * - player：仅 `visibility === "public"`（隐藏任务不泄露，ADR-0026 老账）；
 * - npc:<id>：**以该 NPC 的台账为准** —— 只有 `dag:<id>` 出现在其 known/inferred 条目里才可见
 *   （与 facts 段同一口径：台账是该观察者知识的唯一权威）。
 */
export function buildFacts(
  state: WorldStateV2,
  perspective: Perspective,
): PerspectiveFactView {
  if (perspective === "world") {
    const facts: PerspectiveFactItem[] = [
      ...worldFactRefs(state).map((factRef) => ({
        factRef,
        value: resolveFactValue(state, factRef),
      })),
    ];
    const dagNodes: WorldDagNodeView[] = state.taskDag.nodes.map((n) => ({
      nodeId: n.id,
      title: n.title,
      kind: n.kind,
      status: n.status,
      visibility: n.visibility,
      templateRefs: [...n.templateRefs],
    }));
    return {
      perspective: "world",
      facts,
      dagNodes,
      // 深拷贝：窗口是只读投影，调用方改它不能反向改 state。
      edges: state.taskDag.edges.map((e) => ({ ...e })),
      ledger: cloneLedger(state.observationLedger),
    };
  }

  const entries: KnowledgeEntry[] = state.observationLedger[perspective] ?? [];
  const facts: PerspectiveFactItem[] = entries.map((e) => ({
    factRef: e.factRef,
    value: resolveFactValue(state, e.factRef),
    level: e.level,
  }));
  const dagNodes: DagNodeView[] = visibleDagNodeIds(state, perspective).flatMap((id) => {
    const node = state.taskDag.nodes.find((n) => n.id === id);
    return node === undefined ? [] : [{ nodeId: node.id, status: node.status }];
  });
  return { perspective, facts, dagNodes };
}

/**
 * 受限窗口可见的 DAG 节点 id（**声明序**，去重）。
 *
 * player：public 节点；npc:<id>：该观察者台账里出现过的 `dag:<id>`（known / inferred 已经
 * 由 `KnowledgeLevelSchema` 限定，不需要在过滤时再判一次）。
 * 遍历 ledger 用的是数组顺序而不是 `Object.keys` —— 顺序必须只由模板 / 台账决定。
 */
function visibleDagNodeIds(state: WorldStateV2, perspective: Perspective): string[] {
  if (perspective === "world") return state.taskDag.nodes.map((n) => n.id);
  if (perspective === "player") {
    return state.taskDag.nodes.filter((n) => n.visibility === "public").map((n) => n.id);
  }
  const known = new Set<string>();
  for (const entry of state.observationLedger[perspective] ?? []) {
    if (entry.factRef.startsWith("dag:")) known.add(entry.factRef.slice(4));
  }
  return state.taskDag.nodes.filter((n) => known.has(n.id)).map((n) => n.id);
}

/** 某窗口可见的事实引用集合（content.* 的 refs[] 必须落在此集合内，否则越窗）。 */
export function visibleFactRefs(state: WorldStateV2, perspective: Perspective): Set<string> {
  return new Set(buildFacts(state, perspective).facts.map((f) => f.factRef));
}

/**
 * content.* 可引用的事实集合：窗口可见事实 + 公有结构引用（flag / public DAG 节点）。
 * world 额外允许全部隐秘引用。用于 `dispatch` 第 2 层 `visibility_violation` 判定。
 */
export function allowedContentRefs(state: WorldStateV2, perspective: Perspective): Set<string> {
  const allowed = visibleFactRefs(state, perspective);
  for (const key of Object.keys(state.flags)) allowed.add(`flag:${key}`);
  for (const node of state.taskDag.nodes) {
    if (node.visibility === "public") allowed.add(`dag:${node.id}`);
  }
  if (perspective === "world") {
    for (const ref of collectHiddenRefs(state)) allowed.add(ref);
  }
  return allowed;
}

export interface KnowledgeBatchResult {
  ledger: ObservationLedger;
  /** 对同一 (observer, factRef) 重复授互斥 level 的冲突项（state_conflict）。 */
  conflicts: SetKnowledgeArgs[];
  applied: SetKnowledgeArgs[];
}

/**
 * 纯函数：批量落账计算，返回**新的** ledger（不改动入参）。
 * 同一 (observer, factRef) 已存在且 level 不同 ⇒ 记为冲突（不改台账，交由 API 报
 * `state_conflict`）；完全相同则幂等去重。`assign` 动作在 engine-api.ts 完成。
 */
export function applyKnowledgeBatch(
  ledger: ObservationLedger,
  grants: readonly SetKnowledgeArgs[],
): KnowledgeBatchResult {
  const next: ObservationLedger = cloneLedger(ledger);
  const conflicts: SetKnowledgeArgs[] = [];
  const applied: SetKnowledgeArgs[] = [];
  for (const g of grants) {
    const list = next[g.observer] ?? (next[g.observer] = []);
    const existing = list.find((e) => e.factRef === g.factRef);
    if (existing && existing.level !== g.level) {
      conflicts.push(g);
      continue;
    }
    if (!existing) {
      list.push({
        factRef: g.factRef,
        level: g.level,
        source: g.source,
        sinceTurn: g.sinceTurn,
        ...(g.confidence !== undefined ? { confidence: g.confidence } : {}),
      });
      applied.push(g);
    }
  }
  return { ledger: next, conflicts, applied };
}

/**
 * player 窗口兼容别名（T-05a）：`isPlayerVisible` 在读取侧降级为「该 factRef 是否在
 * player 窗口可见」。装饰 / 归档 / 人生档案三处统一按此 player 窗口投影，不另立 hidden 判据。
 */
export function isPlayerWindowVisible(state: WorldStateV2, factRef: string): boolean {
  return visibleFactRefs(state, "player").has(factRef);
}
