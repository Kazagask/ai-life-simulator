import type { Rules, TaskDag, TaskStatus, WorldStateV2 } from "@life-sim/shared";
import { createRng, deriveTurnSeed } from "../rng.js";
import {
  evaluateAll,
  type ConditionDiagnostic,
  type ConditionRegistry,
} from "./condition-evaluator.js";

/**
 * DAG 校验器（T-02 / v2 §3.5，纯函数，O(V+E)）。
 *
 * 加载期对模板 `fallbackDag` 预跑、运行期 `fact.advanceDag` 提交 LLM DAG
 * **共用本文件的同一份 `validateDag` 实现**（`validateFallbackDag` 即其别名），不写两份。
 * 失败码按 §3.5 表：`unknown_reference` / `state_conflict`，均为 RETRYABLE，
 * 带 `factsHint`（悬空端点 / 环上剩余节点 / 不可解析 guard 等）回灌重生成。
 */

export type DagValidationCode = "unknown_reference" | "state_conflict";

export interface DagValidationResult {
  ok: boolean;
  /** 命中失败的校验步（1–6）；ok 时为 undefined。 */
  step?: number;
  code?: DagValidationCode;
  /** 回灌给 LLM 的当前正确事实片段。 */
  factsHint?: string[];
  message: string;
}

export interface ValidateDagOptions {
  /** 步 6：开放形 guard 的 op 必须已注册（未提供则跳过该子检查）。 */
  registry?: ConditionRegistry;
  /** 步 6：templateRefs 必须落在 lookup 内的 id 集合（未提供则跳过该子检查）。 */
  lookupRefs?: ReadonlySet<string>;
}

const OK: DagValidationResult = { ok: true, message: "ok" };

function fail(
  step: number,
  code: DagValidationCode,
  message: string,
  factsHint?: string[],
): DagValidationResult {
  return { ok: false, step, code, message, ...(factsHint !== undefined ? { factsHint } : {}) };
}

function isOpenGuard(g: unknown): g is { op: string; args: Record<string, unknown> } {
  return typeof g === "object" && g !== null && "op" in g && typeof (g as { op: unknown }).op === "string";
}

/**
 * 六步校验：
 * 1 端点完整性 / 2 id 唯一 / 3 自环 / 4 重复边 / 5 Kahn 拓扑排序 / 6 guards 可解析 + templateRefs。
 */
export function validateDag(dag: TaskDag, opts: ValidateDagOptions = {}): DagValidationResult {
  const nodes = dag.nodes;
  const edges = dag.edges;

  // 步 2：节点 id 唯一（先做，避免重复 id 污染后续端点集合）。
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.id)) return fail(2, "state_conflict", `重复节点 id：${n.id}`, [n.id]);
    seen.add(n.id);
  }

  // 步 1：端点完整性。
  const dangling = new Set<string>();
  for (const e of edges) {
    if (!seen.has(e.from)) dangling.add(e.from);
    if (!seen.has(e.to)) dangling.add(e.to);
  }
  if (dangling.size > 0)
    return fail(1, "unknown_reference", "悬空端点不在 nodes[].id 集合内", [...dangling]);

  // 步 3：自环 from === to。
  for (const e of edges) {
    if (e.from === e.to) return fail(3, "state_conflict", `自环边：${e.from}`, [e.from]);
  }

  // 步 4：重复边三元组 (from, to, kind)。
  const edgeKeys = new Set<string>();
  for (const e of edges) {
    const key = `${e.from}\u0000${e.to}\u0000${e.kind}`;
    if (edgeKeys.has(key))
      return fail(4, "state_conflict", `重复边：${e.from}→${e.to} (${e.kind})`, [e.from, e.to]);
    edgeKeys.add(key);
  }

  // 步 5：Kahn 拓扑排序，出队数 < 节点数 ⇒ 有环。
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const adjacency = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    adjacency.get(e.from)!.push(e.to);
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }
  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed += 1;
    for (const to of adjacency.get(id) ?? []) {
      const d = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, d);
      if (d === 0) queue.push(to);
    }
  }
  if (processed < nodes.length) {
    const remaining = nodes.filter((n) => (indegree.get(n.id) ?? 0) > 0).map((n) => n.id);
    return fail(5, "state_conflict", "DAG 存在环（Kahn 未出队全部节点）", remaining);
  }

  // 步 6：guards / completion 可解析 + templateRefs 在 lookup 内。
  if (opts.registry || opts.lookupRefs) {
    for (const n of nodes) {
      for (const guard of [...n.guards, ...n.completion]) {
        if (isOpenGuard(guard) && opts.registry && !opts.registry.has(guard.op)) {
          return fail(6, "unknown_reference", `不可解析的 guard op：${guard.op}`, [n.id, guard.op]);
        }
      }
      if (opts.lookupRefs) {
        for (const ref of n.templateRefs) {
          if (!opts.lookupRefs.has(ref)) {
            return fail(6, "unknown_reference", `templateRef 不在 lookup 内：${ref}`, [n.id, ref]);
          }
        }
      }
    }
  }

  return OK;
}

/** 加载期入口：与运行期 `fact.advanceDag` 共用同一函数（此处即别名，字面同一实现）。 */
export const validateFallbackDag: typeof validateDag = validateDag;

/** 便捷：把校验结果映射为回执所需的失败码 + factsHint。 */
export function dagFailureToDiagnostic(result: DagValidationResult): {
  code: DagValidationCode;
  factsHint: string[];
} {
  return {
    code: result.code ?? "state_conflict",
    factsHint: result.factsHint ?? [],
  };
}

// ---------- ADR-0037 D2：引擎权威的节点推进 ----------

/**
 * DAG 推进的独立派生流盐（与触发器的 `seed + 37` 隔离）。
 *
 * 为什么不复用触发器流：推进段在触发器**之前**执行（D8 顺序），共用一条流会让
 * `random.flavor` 的骰子随节点数移动 —— ADR-0036 D4 的 ~9% 预算就失效了。
 */
export const DAG_RNG_SALT = 53;

/** 单节点的一次迁移（一轮至多一格）。 */
export interface DagNodeTransition {
  nodeId: string;
  from: TaskStatus;
  to: TaskStatus;
}

export interface DagProgressResult {
  transitions: DagNodeTransition[];
  diagnostics: ConditionDiagnostic[];
}

/** 终态：永不回退、也不再次求值（IO-9 单调）。 */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "expired", "cancelled"]);

/**
 * ADR-0037 D2：按 `guards` / `completion` 推进节点状态（纯函数，不写 state）。
 *
 * 迁移表（确定性、单调、有界）：
 * | 当前 | 条件 | 迁移 |
 * |---|---|---|
 * | `draft` | `guards` 全真（**空数组视为无前置条件**） | `ready` |
 * | `ready` / `active` / `in_progress` | `completion` **非空**且全真 | `completed` |
 * | `completed` / `expired` / `cancelled` | — | 不动（终态） |
 *
 * ## 同轮跑到不动点（fixpoint，D13 修订）
 *
 * 单趟「先 guards 再 completion」有一个致命的顺序洞：本趟刚 `draft→ready` 的节点
 * **不参与本趟的 completion 求值**。用 `eventResolved` 做完成判据时这不是"晚一拍"，
 * 而是**永久错过** —— `resolvedEventIds` 只含**本轮**结算的事件（`turn.ts`
 * `new Set(result.triggered.map(...))`），下一轮集合里已经没有那个事件，节点永远停在
 * `ready`。同理 `guards: nodeCompleted n1` 也会晚一拍，`draft→ready` 的迟到会继续
 * 往链尾传。
 *
 * 所以本函数在**同一个 turn boundary** 内循环「guards → completion → 再 guards …」
 * 直到没有任何新迁移。级联三步（n1 completed ⇒ n2 ready ⇒ n2 用同一份快照求 completion
 * ⇒ n2 completed）必须同轮完成。
 *
 * 三条硬约束：
 * 1. **`resolvedEventIds` 全程同一份冻结快照**：循环里不重算、不换集合。这是 D13 的
 *    真正落点 —— 冻结的不是"节点状态"（那正是要级联的），而是**事件判据**。
 * 2. **`completion: []` ⇒ 不可自动完成**：`[].every(...) === true`，不特判会让所有
 *    占位节点（如 `n3.hiddenSeed`）瞬间 `completed`。
 * 3. **有界**：一个节点一轮最多走两步（`draft→ready→completed`），故 `2 * nodes.length`
 *    次迭代必达不动点；再 +1 次用于确认"本轮无新迁移"。作者写出判据互相喂养的环时，
 *    上限截断（终态节点不参与，正常模板远达不到）。
 *
 * 求值用的"状态视图"每轮按 `projected` 状态重投影（`nodeCompleted` 据此看见同轮
 * 已完成的节点），而 `state` 本身**全程不写** —— 写入仍由调用方按返回的 `transitions`
 * 落账，源码守卫（`wave1b.min.test.ts`）继续成立。
 *
 * 确定性：节点遍历顺序 = `state.taskDag.nodes` 的声明序；每轮用**同一派生种子**
 * 新建 RNG（`random` 型判据在每轮读到同一序列，不会因迭代次数改变结果）；
 * 输出按声明序、每节点最多一条净迁移（`from` = 入口状态，`to` = 收敛状态）。
 */
export function advanceDagProgress(
  state: WorldStateV2,
  rules: Rules | undefined,
  registry: ConditionRegistry,
  resolvedEventIds: ReadonlySet<string>,
  turnIndex: number,
): DagProgressResult {
  // IO-10：无 rules（模板没有 rules.yaml）⇒ 整段 no-op。
  if (rules === undefined) return { transitions: [], diagnostics: [] };

  const nodes = state.taskDag.nodes;
  if (nodes.length === 0) return { transitions: [], diagnostics: [] };

  const rngSeed = deriveTurnSeed(state.seed + DAG_RNG_SALT, turnIndex);
  /** 入口状态（落账时的 `from`）与收敛状态（`to`）分开存，输出净迁移。 */
  const entry = new Map<string, TaskStatus>(nodes.map((n) => [n.id, n.status]));
  const projected = new Map<string, TaskStatus>(entry);
  const transitions: DagNodeTransition[] = [];
  const rawDiagnostics: ConditionDiagnostic[] = [];

  // 每轮按 projected 重投影一个只读视图；`state` 本身不写（纯函数契约）。
  const viewState = (): WorldStateV2 => ({
    ...state,
    taskDag: {
      ...state.taskDag,
      nodes: nodes.map((n) => {
        const status = projected.get(n.id) ?? n.status;
        return status === n.status ? n : { ...n, status };
      }),
    },
  });

  const MAX_ITERATIONS = 2 * nodes.length + 1;
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    // 同一派生种子 ⇒ `random` 判据每轮读到同一序列（迭代次数不影响结果）。
    const ctx = {
      state: viewState(),
      rng: createRng(rngSeed),
      turnIndex,
      resolvedEventIds,
    };
    let changed = false;

    for (const node of nodes) {
      const current = projected.get(node.id) ?? node.status;
      if (TERMINAL_STATUSES.has(current)) continue;

      if (current === "draft") {
        // 空 guards = 没有前置条件 ⇒ 可 ready（D13 显式口径）。
        if (evaluateAll(node.guards, ctx, registry, rawDiagnostics)) {
          projected.set(node.id, "ready");
          changed = true;
        }
        continue;
      }

      // ready / active / in_progress：空 completion ≠ 已完成（占位节点只能外部推动）。
      if (
        node.completion.length > 0 &&
        evaluateAll(node.completion, ctx, registry, rawDiagnostics)
      ) {
        projected.set(node.id, "completed");
        changed = true;
      }
    }

    if (!changed) break;
  }

  // 净迁移：仅保留状态真的变了的节点，按声明序输出（每节点至多一条）。
  for (const node of nodes) {
    const to = projected.get(node.id) ?? node.status;
    if (to !== node.status) transitions.push({ nodeId: node.id, from: node.status, to });
  }

  // 同一个未注册 op 只报一次（与 evaluateTriggersDetailed 同口径），保持首次出现顺序。
  const seenOps = new Set<string>();
  const diagnostics: ConditionDiagnostic[] = [];
  for (const d of rawDiagnostics) {
    if (seenOps.has(d.op)) continue;
    seenOps.add(d.op);
    diagnostics.push(d);
  }
  return { transitions, diagnostics };
}
