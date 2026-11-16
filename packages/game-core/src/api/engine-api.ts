import {
  ContentBlockSchema,
  DIAGNOSTIC_CODES,
  EventV2Schema,
  SetKnowledgeArgsSchema,
  SubmitBranchArgsSchema,
  type BranchEffect,
  TaskDagSchema,
  TaskEdgeSchema,
  TaskNodeSchema,
  type ApiCall,
  type CallReceipt,
  type ContentBlock,
  type DiagnosticCode,
  type DispatchContext,
  type DispatchResult,
  type Effect,
  type EngineApiHandle,
  type EventV2,
  type FactChange,
  type LlmBudget,
  type Perspective,
  type PerspectiveFactView,
  type SetKnowledgeArgs,
  type SlotScene,
  type TaskDag,
  type TaskEdge,
  type TaskNode,
  type TaskStatus,
  type V2Snapshot,
  type WorldStateV2,
} from "@life-sim/shared";
import {
  allowedContentRefs,
  applyKnowledgeBatch,
  buildFacts as computeFacts,
} from "./perspective.js";
import { validateDag, type DagValidationResult } from "../v2/task-dag.js";
import { enqueueScheduled } from "../v2/scheduler.js";
import type { ConditionRegistry } from "../v2/condition-evaluator.js";
import { createContentSink, type ContentSink } from "../v2/narrative.js";

/**
 * T-01：唯一权威写入口 `RpgEngineAPI.dispatch`。
 *
 * 硬不变量：「无 API 调用即无事实变更」——`dispatch([], ctx)` 返回同一 state（逐字段相等），
 * 因为空调用不触发任何 handler、不克隆、不写任何字段。
 *
 * 设计要点：
 * - 工具注册表 **数据化**（Map 查表），引擎不 switch on 工具名；新增工具只需注册。
 * - 13 个 `DiagnosticCode` 全可判别（DIAGNOSTIC_META 覆盖），RETRYABLE 带 `factsHint` 回灌。
 * - 幂等：`idempotencyKey` 重复 ⇒ `idempotency_conflict`（FATAL）。
 * - `CallReceipt` 带 `changes` / `factsHint`。
 * - `state.slot` 的唯一写入收敛到本文件的 `assignSlot`（见 turn.ts 收敛）。
 * - F3：叙事正文只进 `ContentSink`（trace），绝不进 `WorldStateV2`；`content.*` 的 refs
 *   经 `allowedContentRefs` 做窗口校验，越窗 ⇒ `visibility_violation`（RETRYABLE）。
 * - F4：窗口计算（buildFacts）由 game-core 拥有，agent-runtime 不得自建判据。
 */

/** 13 码全覆盖：每个诊断码的 RETRYABLE / FATAL 分类（v2 §5.2 / §5.3）。 */
export const DIAGNOSTIC_META: Record<DiagnosticCode, { retryable: boolean }> = {
  unknown_tool: { retryable: false },
  invalid_arguments: { retryable: false },
  unknown_reference: { retryable: true },
  precondition_failed: { retryable: true },
  numeric_out_of_range: { retryable: true },
  state_conflict: { retryable: true },
  visibility_violation: { retryable: true },
  idempotency_conflict: { retryable: false },
  budget_exceeded: { retryable: true },
  timeout: { retryable: true },
  provider_unavailable: { retryable: true },
  retry_exhausted: { retryable: true },
  duplicate_invocation: { retryable: false },
};

export function isRetryable(code: DiagnosticCode): boolean {
  return DIAGNOSTIC_META[code].retryable;
}

/**
 * 不可重试码的选择（ADR-0035 IO-1）。
 *
 * 踩过的坑，记在这里：原本用 `state_conflict` + 在回执上覆盖 `retryable: false`，
 * 但 `CallReceiptSchema` **没有 `retryable` 字段**，而 `loop.ts` 判可重试读的是
 * `isRetryable(receipt.code)` —— 也就是**只看码表，不看回执**。所以那个覆盖是死代码：
 * `state_conflict` 在码表里 `retryable: true`，循环照样会重试，白烧 `retryLimit`。
 *
 * 因此跨回合只能选一个**码表里本就不可重试**的码。`idempotency_conflict`
 * （"这次写入不该再发生"）是 13 码里唯一语义贴合的：重试一万次，那一轮也已经过去了。
 */
export const CROSS_TURN_CODE = "idempotency_conflict" as const;

/**
 * ADR-0035 IO-1：结构写入不得跨回合。
 *
 * 判据是「写入时刻的世界轮次」与「创作这一轮的上下文轮次」是否相等。二者不等只有一种成因：
 * invocation 晚到（异步 LLM），于是它基于 A 轮状态算出来的事件/DAG 被写进了 A+n 轮的世界
 * —— 那就是"已死 npc 诈尸"，或（加 missWhen 后）静默的"错误错过"。两种都不可接受。
 *
 * `ctx.turnIndex` 在 agent loop 起始处固定（`loop.ts` 的 `dispatchCtx`），早于任何 await，
 * 所以它恒等于"创作轮"。编排层的事务边界（per-world 锁）保证这条守卫永远不该被触发；
 * 它被触发就说明有人绕过了事务 ⇒ 必须拒绝，不能降级放行。
 */
function crossTurnViolation(state: WorldStateV2, ctx: { turnIndex: number }): ToolRunResult | null {
  if (state.turnIndex === ctx.turnIndex) return null;
  return rejected(
    CROSS_TURN_CODE,
    `结构写入跨回合（ADR-0035 IO-1）：写入时 state.turnIndex=${state.turnIndex}，创作轮 ctx.turnIndex=${ctx.turnIndex}`,
    { stateTurnIndex: state.turnIndex, ctxTurnIndex: ctx.turnIndex },
  );
}

/**
 * 回灌信息结构化（v2 §2.3）：changes = { path, before?, after? }[]，
 * factsHint = Record<string, unknown>（当前正确事实片段）。均不再是 string[]。
 */
export type ToolRunResult =
  | { ok: true; changes: FactChange[]; factsHint?: Record<string, unknown> }
  | {
      ok: false;
      code: DiagnosticCode;
      detail?: string;
      factsHint?: Record<string, unknown>;
      retryable: boolean;
    };

export interface ToolRunEnv {
  registry?: ConditionRegistry;
  lookupRefs?: ReadonlySet<string>;
  sink: ContentSink;
}

export interface ToolHandler {
  run(
    state: WorldStateV2,
    args: unknown,
    ctx: DispatchContext,
    env: ToolRunEnv,
  ): ToolRunResult;
}

/** 数据化工具注册表：key = 工具名，value = 处理器；引擎按名查表，不 switch on 工具名。 */
export type ToolRegistry = ReadonlyMap<string, ToolHandler>;

const accepted = (
  changes: FactChange[],
  factsHint?: Record<string, unknown>,
): ToolRunResult => ({
  ok: true,
  changes,
  ...(factsHint !== undefined ? { factsHint } : {}),
});

const rejected = (
  code: DiagnosticCode,
  detail: string,
  factsHint?: Record<string, unknown>,
): ToolRunResult => ({
  ok: false,
  code,
  detail,
  ...(factsHint !== undefined ? { factsHint } : {}),
  retryable: isRetryable(code),
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** fact.setKnowledge 参数：单条 `SetKnowledgeArgs` 或 `{ entries: SetKnowledgeArgs[] }` 批量。 */
function parseSetKnowledgeArgs(args: unknown): SetKnowledgeArgs[] | null {
  if (isRecord(args) && Array.isArray(args.entries)) {
    const out: SetKnowledgeArgs[] = [];
    for (const e of args.entries) {
      const parsed = SetKnowledgeArgsSchema.safeParse(e);
      if (!parsed.success) return null;
      out.push(parsed.data);
    }
    return out;
  }
  const parsed = SetKnowledgeArgsSchema.safeParse(args);
  return parsed.success ? [parsed.data] : null;
}

// ---------- 内置工具处理器（注册为数据，非分支） ----------

const setKnowledge: ToolHandler = {
  run(state, args, ctx) {
    // ADR-0035 IO-1：知识授予同样是结构写入，跨回合落账会让观察者窗口与事实时间错位。
    const violation = crossTurnViolation(state, ctx);
    if (violation !== null) return violation;
    const grants = parseSetKnowledgeArgs(args);
    if (grants === null) return rejected("invalid_arguments", "fact.setKnowledge 参数不合法");
    const result = applyKnowledgeBatch(state.observationLedger, grants);
    if (result.conflicts.length > 0) {
      return rejected(
        "state_conflict",
        "对同一 (observer, factRef) 重复授互斥 level",
        { conflicts: result.conflicts.map((c) => c.factRef) },
      );
    }
    // 权威写入（observationLedger）只在本文件发生。
    state.observationLedger = result.ledger;
    return accepted(
      result.applied.map((a) => ({
        path: `observationLedger.${a.observer}.${a.factRef}`,
        after: a.level,
      })),
    );
  },
};

const advanceDag: ToolHandler = {
  run(state, args, ctx, env) {
    // ADR-0035 IO-1：DAG 是整份覆盖写（`state.taskDag = parsed.data`），
    // 跨回合落账会把 A 轮的分支形态盖到 A+n 轮的世界上 —— 结构性破坏比事件更严重。
    const violation = crossTurnViolation(state, ctx);
    if (violation !== null) return violation;
    if (!isRecord(args) || !("dag" in args)) {
      return rejected("invalid_arguments", "fact.advanceDag 需要 { dag }");
    }
    const parsed = TaskDagSchema.safeParse(args.dag);
    if (!parsed.success) return rejected("invalid_arguments", "dag 未通过 TaskDagSchema");
    const validation: DagValidationResult = validateDag(parsed.data, {
      ...(env.registry ? { registry: env.registry } : {}),
      ...(env.lookupRefs ? { lookupRefs: env.lookupRefs } : {}),
    });
    if (!validation.ok) {
      return rejected(
        validation.code ?? "state_conflict",
        `validateDag 第 ${validation.step} 步：${validation.message}`,
        { dagIssues: validation.factsHint ?? [] },
      );
    }
    // 权威写入（taskDag）只在本文件发生。
    state.taskDag = parsed.data;
    return accepted(
      parsed.data.nodes.map((n) => ({ path: `taskDag.nodes.${n.id}`, after: n.status })),
    );
  },
};

/**
 * 结构化深比较用的规范化序列化（ADR-0037 D14.2 的「无变化短路」）。
 *
 * 键名排序 ⇒ 不依赖对象字面量字段顺序；数组保持原序（节点 / 边的顺序是语义）。
 * 不用 `JSON.stringify` 直接比：同一份结构经不同构造路径可能得到不同的键序，
 * 那会把一次空操作误判成「有变化」，version 白涨一格。
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * 节点状态的**单调序**（IO-9）：只允许前进，never 回退。
 * `ready` / `active` / `in_progress` 视为同一档（模板从不区分它们是"进行中"的不同阶段）。
 */
const DAG_STATUS_RANK: Record<TaskStatus, number> = {
  draft: 0,
  ready: 1,
  active: 1,
  in_progress: 1,
  completed: 3,
  expired: 3,
  cancelled: 3,
};

const edgeKey = (e: TaskEdge): string => `${e.from}\u0000${e.to}\u0000${e.kind}`;

/**
 * `fact.upsertDagBranch`（ADR-0037 D4）：**增量**续写分支结构。
 *
 * 为什么不是 `fact.advanceDag` 那样的整份覆盖：world 窗口只剩增量（LLM 只看得见自己
 * 新增/改写的部分语义），整份覆盖会静默丢掉它没看见的 `guards` / `completion` / `edges`。
 *
 * 语义（与 ADR §2 D4、§11 D14 一致）：
 * 1. 已存在的节点只允许改 `status` / `guards` / `completion` / `due` / `visibility`；
 *    `kind` / `title` 被改写 ⇒ `state_conflict`（防语义被静默重定义）。
 * 2. `status` 单调（IO-9）：不允许从终态 / 更后档回退。
 * 3. `edges` 按 `(from,to,kind)` 去重追加 ⇒ 幂等（IO-11）。
 * 4. 合并结果与现状**深度相等** ⇒ `accepted([])` 且**不 bump version**（D14.2）。
 * 5. 合并结果跑 `validateDag`（id 唯一 / 端点 / 自环 / 重复边 / 无环 / templateRefs ⊆ lookupRefs）
 *    ⇒ 不过则整体拒绝、`state.taskDag` 逐字段不变（IO-12）。
 * 6. `version = max(当前 + 1, 入参 version ?? 0)`；`issuedBy` 只在实质变化时置 `"llm"`；
 *    `dagId` 永不取自入参（取 state）。
 * 7. 永不删除节点 / 边。
 */
const upsertDagBranch: ToolHandler = {
  run(state, args, ctx, env) {
    // ADR-0035 IO-1：结构写入必须与本回合同事务（与 fact.advanceDag 同一条守卫）。
    const violation = crossTurnViolation(state, ctx);
    if (violation !== null) return violation;
    if (!isRecord(args)) {
      return rejected("invalid_arguments", "fact.upsertDagBranch 需要 { nodes?, edges?, version? }");
    }

    const rawNodes = args.nodes ?? [];
    if (!Array.isArray(rawNodes)) {
      return rejected("invalid_arguments", "nodes 必须是数组");
    }
    const rawEdges = args.edges ?? [];
    if (!Array.isArray(rawEdges)) {
      return rejected("invalid_arguments", "edges 必须是数组");
    }
    if (
      args.version !== undefined &&
      (typeof args.version !== "number" || !Number.isInteger(args.version) || args.version < 0)
    ) {
      return rejected("invalid_arguments", "version 必须是非负整数");
    }

    const incomingNodes: TaskNode[] = [];
    for (const raw of rawNodes) {
      const parsed = TaskNodeSchema.safeParse(raw);
      if (!parsed.success) {
        return rejected("invalid_arguments", "nodes[] 未通过 TaskNodeSchema（新节点必须是完整节点）");
      }
      incomingNodes.push(parsed.data);
    }
    const incomingEdges: TaskEdge[] = [];
    for (const raw of rawEdges) {
      const parsed = TaskEdgeSchema.safeParse(raw);
      if (!parsed.success) {
        return rejected("invalid_arguments", "edges[] 未通过 TaskEdgeSchema");
      }
      incomingEdges.push(parsed.data);
    }

    const nextNodes: TaskNode[] = state.taskDag.nodes.map((n) => ({ ...n }));
    for (const incoming of incomingNodes) {
      const index = nextNodes.findIndex((n) => n.id === incoming.id);
      if (index < 0) {
        nextNodes.push(incoming);
        continue;
      }
      const existing = nextNodes[index]!;
      if (existing.kind !== incoming.kind || existing.title !== incoming.title) {
        return rejected(
          "state_conflict",
          `节点 ${incoming.id} 的 kind/title 不允许改写（ADR-0037 D4.1）`,
          { nodeId: incoming.id, kind: existing.kind, title: existing.title },
        );
      }
      if (DAG_STATUS_RANK[incoming.status] < DAG_STATUS_RANK[existing.status]) {
        return rejected(
          "state_conflict",
          `节点 ${incoming.id} 的状态不允许回退：${existing.status} → ${incoming.status}（IO-9 单调）`,
          { nodeId: incoming.id, status: existing.status },
        );
      }
      nextNodes[index] = {
        ...existing,
        status: incoming.status,
        guards: incoming.guards,
        completion: incoming.completion,
        visibility: incoming.visibility,
        // `due` 可改可留：入参省略 = 不动（避免一次遗漏把截止时间清空）。
        ...(incoming.due !== undefined ? { due: incoming.due } : {}),
      };
    }

    const seenEdges = new Set(state.taskDag.edges.map(edgeKey));
    const nextEdges: TaskEdge[] = state.taskDag.edges.map((e) => ({ ...e }));
    for (const edge of incomingEdges) {
      const key = edgeKey(edge);
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      nextEdges.push(edge);
    }

    // D14.2：无实质变化 ⇒ 幂等返回，不 bump version（否则同一 branch 两次会 +2）。
    if (
      canonicalJson(nextNodes) === canonicalJson(state.taskDag.nodes) &&
      canonicalJson(nextEdges) === canonicalJson(state.taskDag.edges)
    ) {
      return accepted([]);
    }

    const merged: TaskDag = {
      dagId: state.taskDag.dagId,
      version: Math.max(
        state.taskDag.version + 1,
        typeof args.version === "number" ? args.version : 0,
      ),
      issuedBy: "llm",
      nodes: nextNodes,
      edges: nextEdges,
    };
    const parsedDag = TaskDagSchema.safeParse(merged);
    if (!parsedDag.success) {
      return rejected("invalid_arguments", "合并后的 DAG 未通过 TaskDagSchema");
    }
    const validation: DagValidationResult = validateDag(parsedDag.data, {
      ...(env.registry ? { registry: env.registry } : {}),
      ...(env.lookupRefs ? { lookupRefs: env.lookupRefs } : {}),
    });
    if (!validation.ok) {
      return rejected(
        validation.code ?? "state_conflict",
        `validateDag 第 ${validation.step} 步：${validation.message}`,
        { dagIssues: validation.factsHint ?? [] },
      );
    }
    // 权威写入（taskDag）只在本文件发生。
    state.taskDag = parsedDag.data;
    return accepted([
      ...incomingNodes.map((n) => ({ path: `taskDag.nodes.${n.id}`, after: n.status })),
      ...incomingEdges.map((e) => ({ path: `taskDag.edges.${edgeKey(e)}`, after: e.kind })),
    ]);
  },
};
/**
 * `fact.enqueueEvent`：把**模板里已存在**的事件实例化进延时队列（DAG 分支的落地动作）。
 *
 * 设计口径（§3.4「(b) 需要上桌事件 ⇒ fact.enqueueEvent → delayQueue」）：
 * - LLM **只能选用模板已有事件**，不能凭空发明事件内容 —— `eventId` 必须是
 *   `env.lookupRefs`（模板 ref 全集）成员，否则 `unknown_reference`（FATAL）。
 * - ADR-0038：还必须命中 `ctx.branchEventIds` 白名单。未声明 / 空数组 / 不在列表
 *   三者一律 `unknown_reference`（「两拒一放」）—— 模板作者没声明的事件，
 *   模型"想摆"也不许摆。
 * - 只入队、**不直接占槽**（ADR-0034 §4 R3：写 `slot` 的唯一后继路径是 `applySuccessor`），
 *   时间锚固在 `state.worldTime` ⇒ 当轮即可被扫描取到，但顺序仍由队列排序决定。
 * - 权威写入（delayQueue / enqueueSeqCounter）只在本文件发生（调度器只做纯入队构造）。
 */
const enqueueEvent: ToolHandler = {
  run(state, args, ctx, env) {
    // ADR-0035 IO-1：事件入队是「诈尸」的直接成因，必须先过跨回合守卫，再谈幂等。
    const violation = crossTurnViolation(state, ctx);
    if (violation !== null) return violation;
    if (!isRecord(args) || typeof args.eventId !== "string" || args.eventId.length === 0) {
      return rejected("invalid_arguments", "fact.enqueueEvent 需要 { eventId }");
    }
    const eventId = args.eventId;
    const refs = env.lookupRefs;
    if (refs !== undefined && !refs.has(eventId)) {
      return rejected("unknown_reference", `eventId 不在模板 ref 集合内：${eventId}`, {
        allowedRefs: [...refs].filter((r) => r.startsWith("evt:")).slice(0, 50),
      });
    }
    /**
     * ADR-0038：分支白名单 —— 「两拒一放」。
     *
     * 白名单是**能力**不是用途：未声明 = 没有分支能力（沉默），显式空数组 = **同样拒绝**
     * （唯一要防的退化是把 `[]` 当成"不限制"）。只有非空且命中才放行。
     *
     * 校验顺序固定在 `lookupRefs` 之后：模板全集优先 —— 自造 id 无论白名单怎么写都是
     * `unknown_reference`，调用方拿到的诊断码不变（同为 `unknown_reference`，不需要区分）。
     *
     * 权威性：`ctx.branchEventIds` 只能来自 core 求值写进 `LlmInvocation` 的那一份，
     * 不接收模型输出 / HTTP 请求体。
     */
    const allowlist = ctx.branchEventIds;
    if (allowlist === undefined || allowlist.length === 0) {
      return rejected(
        "unknown_reference",
        allowlist === undefined
          ? "本 invocation 未声明 branchEventIds（沉默 = 没有分支能力）"
          : "本 invocation 的 branchEventIds 为空数组（空 ≠ 不限制）",
        { allowedRefs: [] },
      );
    }
    if (!allowlist.includes(eventId)) {
      return rejected(
        "unknown_reference",
        `eventId 不在本次 invocation 的 branchEventIds 白名单内：${eventId}`,
        { allowedRefs: [...allowlist] },
      );
    }
    /**
     * 幂等：同一事件已在队列里 waiting ⇒ 不重复入队。
     *
     * 这是「玩家点得快」的直接防线：invocation 是 fire-and-forget，连续几轮各自触发时，
     * 模型可能对同一个 `eventId` 各入队一次，队列里会叠出多个同源实例（`once` 事件的
     * 一次性语义随之失效）。已排队就当作成功返回（幂等语义，回灌 receipt 而非错误）。
     */
    const queued = state.delayQueue.find(
      (i) => i.definitionId === eventId && i.status === "waiting",
    );
    if (queued !== undefined) {
      return accepted([{ path: `delayQueue.${queued.instanceId}`, after: "waiting" }]);
    }
    const instance = enqueueScheduled({
      state,
      definitionId: eventId,
      // origin.kind 是封闭枚举；模板效果与 LLM 提议在引擎里同属「效果驱动入队」。
      origin: { kind: "effect", id: eventId },
      /**
       * 时间锚必须取 **本次 dispatch 的上下文**，不是 `state.worldTime`。
       *
       * 这两者只在「写入与本回合同一事务」时才相等。一旦写入晚到（异步 LLM），
       * `state.worldTime` 已经被后续回合推走 —— 事件会被锚到「落地那一刻」，
       * 而不是「它被设想的那一刻」，于是出现「A 轮设想的事件出现在 A+n 轮」。
       * `ctx.worldTime` 在 agent loop 起始处固定（`loop.ts` 的 dispatchCtx），
       * 保证锚点永远是创作它的那一轮。
       *
       * 注意：这只是**必要条件**，不是充分条件。真正杜绝「诈尸」要靠事务边界
       * （见 ADR-0035）：结构写入必须在同一回合的临界区内落账，晚到即不许落。
       */
      absoluteStart: ctx.worldTime,
    });
    return accepted([{ path: `delayQueue.${instance.instanceId}`, after: "waiting" }]);
  },
};

/**
 * `story.submitBranch`（AGENTIC-GM 重构 · 设计 §4/§5）：提交**一整条独立分支**。
 *
 * 边界（用户裁定，硬约束）：
 * - LLM **永远不入队、不占槽**：本 handler 只把定义写进 `state.generatedEvents`，
 *   排不排、什么时候排，由回合边界的引擎调度决定。
 * - **引擎上必须独立**：不引用、不修改任何既有事件；`goto` 只能指向本次提交内的 node。
 * - 全局 id / 选项 id 由引擎分配（`gen:<invocationId>:<node>`），模型只给局部别名，
 *   防止伪造引用。
 * - **原子性**：整条分支要么全落、要么全不落（任何一块不合 schema 即整体拒绝）。
 */
/**
 * 分支的**扁平效果** → 引擎规范 `Effect`。
 *
 * 对外协议故意只有三种形状（`{flag,value}` / `{mood}` / `{hp}|{mp}`）：
 * 真实模型记不住 24 变体的判别联合，会反复写错字段名。这里做一次映射，
 * 把"作者语言"翻译成"引擎语言"。
 */
function toCanonicalEffects(list: readonly BranchEffect[]): Effect[] {
  return list.map((effect) => {
    if ("flag" in effect) return { type: "setFlag", id: effect.flag, value: effect.value };
    if ("mood" in effect) return { type: "adjustMood", value: effect.mood };
    if ("hp" in effect) return { type: "adjustResource", resource: "hp", value: effect.hp };
    return { type: "adjustResource", resource: "mp", value: effect.mp };
  });
}

const submitBranch: ToolHandler = {
  run(state, args, ctx) {
    // 结构写入必须与本回合同事务（与 fact.* 同一条守卫）。
    const violation = crossTurnViolation(state, ctx);
    if (violation !== null) return violation;

    const parsed = SubmitBranchArgsSchema.safeParse(args);
    if (!parsed.success) {
      return rejected(
        "invalid_arguments",
        `story.submitBranch 参数未通过 schema：${parsed.error.issues[0]?.path.join(".") ?? "?"} ${parsed.error.issues[0]?.message ?? ""}`.trim(),
      );
    }
    const { trigger, branch } = parsed.data;

    // 局部别名唯一
    const aliases = new Set<string>();
    for (const node of branch) {
      if (aliases.has(node.node)) {
        return rejected("invalid_arguments", `节点别名重复：${node.node}（同一次提交内必须唯一）`);
      }
      aliases.add(node.node);
    }
    // goto 闭合：只能指向本次提交内的节点（跨提交一律拒）
    for (const node of branch) {
      for (const option of node.options) {
        if (option.goto !== undefined && !aliases.has(option.goto)) {
          return rejected(
            "unknown_reference",
            `goto 指向本次提交之外的节点：${option.goto}（分支必须自洽，不可接续既有剧情）`,
            { allowedRefs: [...aliases] },
          );
        }
      }
    }

    const prefix = `gen:${ctx.invocationId}:`;
    const compiled: EventV2[] = [];
    for (const [index, node] of branch.entries()) {
      const event: EventV2 = {
        id: `${prefix}${node.node}`,
        title: node.title,
        narrative: node.text,
        kind: "normal",
        /**
         * **只有入口节点（`branch[0]`）参与调度**；下游节点一律 `chain`，
         * 只能由上一节的选项 `goto` 到达。
         *
         * 为什么必须这样（2026-11-16 实测事故）：起初整条分支的每个节点都编译成
         * `schedule`，于是回合边界那一次扫描把三节**同时入队**；而玩家选选项时
         * `goto` 又按链边再入队一次 ⇒ 同一幕被播放多次（存档里 n4c 出现 3 次：
         * 两次 fired + 一次仍在 waiting）。两套入口撞在一起。
         */
        trigger:
          index > 0
            ? { source: "chain" }
            : trigger.mode === "certain"
              ? {
                  source: "schedule",
                  /**
                   * 相对入队时刻换算 ⇒ 下一轮扫描即到期（不是"世界时间 0"）。
                   * `TimeAmountSchema` 要求 `value` 是**正整数**，`value: 0` 会被拒；
                   * 1 分钟已经小于任何一轮的默认步长（10 分钟），等价于"入队即到期"。
                   */
                  window: { start: { value: 1, unit: "minute" } },
                }
              : {
                  source: "pool",
                  weight: 1,
                },
        settle: {
          normal: {
            options: node.options.map((option, index) => ({
              id: `opt-gen-${index + 1}`,
              text: option.text,
              // 显式给 [] 而不是省略：省略的语义是"这个选项什么也不做"，
              // 而缺省语义将来一变就是静默改行为。
              effects: toCanonicalEffects(option.effects ?? []),
              ...(option.goto !== undefined ? { nextEventId: `${prefix}${option.goto}` } : {}),
            })),
          },
        },
      } as EventV2;

      // 用与模板事件**同一个** schema 校验：生成事件必须与模板事件同形，
      // 否则调度器/投影/前端会各走一条特殊路径。
      const check = EventV2Schema.safeParse(event);
      if (!check.success) {
        return rejected(
          "invalid_arguments",
          `节点 ${node.node} 编译后未通过 EventV2Schema：${check.error.issues[0]?.message ?? "?"}`,
        );
      }
      compiled.push(check.data as EventV2);
    }

    // 追加式：注册后不再修改（与"不能在已有结构上打补丁"同一条纪律）。
    state.generatedEvents = [...(state.generatedEvents ?? []), ...compiled];
    return accepted([{ path: "generatedEvents", after: compiled.map((e) => e.id).join(",") }]);
  },
};

/**
 * content.* 共用处理器（F4，追加2）：窗口校验 + 正文进 sink（不写 state）+ 媒体锚点。
 *
 * 硬不变量：**绝不采信 args 自带的窗口**。dispatch 第 2 层只以 ctx.targetPerspective
 * 为权威验收窗口；args 里若带 targetPerspective 且 !== ctx.targetPerspective，
 * 立即 visibility_violation（RETRYABLE，带 factsHint）。refs[] 也只比对该权威窗口。
 */
const writeContent: ToolHandler = {
  run(state, args, ctx, env) {
    const parsed = ContentBlockSchema.safeParse(args);
    if (!parsed.success) return rejected("invalid_arguments", "content 块未通过 ContentBlockSchema");
    const block: ContentBlock = parsed.data;
    const target: Perspective = ctx.targetPerspective;
    if (block.targetPerspective !== target) {
      return rejected(
        "visibility_violation",
        `args.targetPerspective (${block.targetPerspective}) 不等于权威窗口 ${target}（F4）`,
        { targetPerspective: target, received: block.targetPerspective },
      );
    }
    const allowed = allowedContentRefs(state, target);
    const violations = block.refs.filter((r) => !allowed.has(r));
    if (violations.length > 0) {
      return rejected(
        "visibility_violation",
        `refs 越出 ${target} 窗口：${violations.join(", ")}`,
        { allowedRefs: [...allowed], violations },
      );
    }
    env.sink.append(block);
    const changes: FactChange[] = [
      { path: `trace.contentBlocks.${block.blockId}`, after: block.blockId },
    ];
    if (block.assetId !== undefined && block.slot !== undefined) {
      state.media = [...(state.media ?? []), { slot: block.slot, assetId: block.assetId }];
      changes.push({ path: `media.${block.slot}`, after: block.assetId });
    }
    return accepted(changes);
  },
};

/**
 * `agent.submit`：invocation 正常落地的终止点。
 *
 * F3：traceRef 是 trace 的引用锚；正文仍只在 sink，不进 state。
 * 同时清掉本轮的在飞标记（只在 id 匹配时清 —— 见 `EngineApiHandle.clearPending`）。
 */
const submitContent: ToolHandler = {
  run(state, _args, ctx) {
    const traceRef = `trace:${ctx.invocationId ?? "local"}`;
    state.traceRef = traceRef;
    if (
      ctx.invocationId !== undefined &&
      state.pendingInvocation?.invocationId === ctx.invocationId
    ) {
      state.pendingInvocation = undefined;
    }
    return accepted([{ path: "traceRef", after: traceRef }]);
  },
};

function defaultToolRegistry(): Map<string, ToolHandler> {
  const map = new Map<string, ToolHandler>();
  map.set("fact.setKnowledge", setKnowledge);
  map.set("fact.advanceDag", advanceDag);
  map.set("fact.upsertDagBranch", upsertDagBranch);
  map.set("fact.enqueueEvent", enqueueEvent);
  map.set("story.submitBranch", submitBranch);
  /**
   * 叙事写入只留两个：`narrative.write`（正文）/ `narrative.flavor`（环境旁注）。
   *
   * 删除的三个，理由各不相同：
   * - `content.writeOption`：**"写一个选项"在语义上就是错的** —— 选项是事件块里的
   *   `options`，由引擎分配 id、由事件面板呈现；它不是叙事，不该有"写"的入口。
   * - `content.writeMemory`：记忆是**知识台账**，由模板 `knowledgeGrants` 授予。
   * - `content.referenceAsset`：媒体挂载不是叙事；将来接资产应作为 `narrative.write`
   *   的可选参数（`assetId`），而不是独立工具。
   */
  for (const name of ["narrative.write", "narrative.flavor"]) {
    map.set(name, writeContent);
  }
  map.set("agent.submit", submitContent);
  return map;
}

export interface EngineApiDeps {
  state: WorldStateV2;
  /** 追加 / 覆盖工具（数据化注册，不 switch）。 */
  toolRegistry?: ToolRegistry;
  /** 条件注册表（DAG guard 可解析性 / 知识授予）。 */
  conditionRegistry?: ConditionRegistry;
  /** templateRefs 合法集合（DAG 步 6）。 */
  lookupRefs?: ReadonlySet<string>;
  sink?: ContentSink;
  /** 注入完整投影（Wave 2 server 注入 projectSnapshotV2）；缺省用 player 窗口最小投影。 */
  projectSnapshot?: (state: WorldStateV2) => V2Snapshot;
  budget?: LlmBudget;
  perspective?: Perspective;
  targetPerspective?: Perspective;
}

/**
 * 引擎 API 实现 `EngineApiHandle`。所有 `WorldStateV2` 权威字段写入都发生在本类的方法 /
 * `assignSlot` 内（源码守卫据此断言）。
 */
export class RpgEngineAPI implements EngineApiHandle {
  readonly state: WorldStateV2;
  readonly sink: ContentSink;
  private readonly tools: Map<string, ToolHandler>;
  private readonly env: ToolRunEnv;
  private readonly deps: EngineApiDeps;
  private readonly seenIdempotency = new Set<string>();

  constructor(deps: EngineApiDeps) {
    this.deps = deps;
    this.state = deps.state;
    this.sink = deps.sink ?? createContentSink();
    this.tools = defaultToolRegistry();
    if (deps.toolRegistry) {
      for (const [name, handler] of deps.toolRegistry) this.tools.set(name, handler);
    }
    this.env = {
      ...(deps.conditionRegistry ? { registry: deps.conditionRegistry } : {}),
      ...(deps.lookupRefs ? { lookupRefs: deps.lookupRefs } : {}),
      sink: this.sink,
    };
  }

  /** 唯一权威写入口。空调用 ⇒ 零写入、返回同一 state（硬不变量）。 */
  dispatch(calls: ApiCall[], ctx: DispatchContext): DispatchResult {
    const receipts: CallReceipt[] = [];
    for (const call of calls) receipts.push(this.runOne(call, ctx));
    return { receipts, state: this.state };
  }

  private runOne(call: ApiCall, ctx: DispatchContext): CallReceipt {
    const callId = call.callId;
    const idem = "idempotencyKey" in call ? call.idempotencyKey : undefined;
    if (idem !== undefined && this.seenIdempotency.has(idem)) {
      return {
        callId,
        outcome: "rejected",
        code: "idempotency_conflict",
        detail: "重复 idempotencyKey",
      };
    }
    const handler = this.tools.get(call.tool);
    if (!handler) {
      return { callId, outcome: "rejected", code: "unknown_tool", detail: call.tool };
    }
    let result: ToolRunResult;
    try {
      result = handler.run(this.state, call.args, ctx, this.env);
    } catch (err) {
      return {
        callId,
        outcome: "rejected",
        code: "precondition_failed",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (result.ok) {
      if (idem !== undefined) this.seenIdempotency.add(idem);
      const receipt: CallReceipt = { callId, outcome: "accepted" };
      if (result.changes.length > 0) receipt.changes = result.changes;
      if (result.factsHint !== undefined) receipt.factsHint = result.factsHint;
      return receipt;
    }
    const receipt: CallReceipt = { callId, outcome: "rejected", code: result.code };
    if (result.detail !== undefined) receipt.detail = result.detail;
    if (result.factsHint !== undefined) receipt.factsHint = result.factsHint;
    return receipt;
  }

  /** snapshot ≡ player 窗口投影（永远不含 world 隐秘 / 叙事正文）。 */
  snapshot(): V2Snapshot {
    if (this.deps.projectSnapshot) return this.deps.projectSnapshot(this.state);
    const view = computeFacts(this.state, "player");
    const state = this.state;
    // P0 默认最小 player 窗口投影（Wave 2 注入 projectSnapshotV2 得到完整 V2Snapshot）。
    // 结构上只含 player 可见事实，不含任何 hidden 原文 / 叙事正文字段。
    return {
      worldId: state.id,
      templateId: state.templateId,
      worldName: state.id,
      turnIndex: state.turnIndex,
      worldTime: state.worldTime,
      formattedTime: "",
      lifeStage: "",
      lifeStageLabel: "",
      startYear: 0,
      labels: { resources: {}, attributes: {}, mood: "" },
      player: {
        id: "player",
        name: state.player.name,
        age: state.player.age,
        gender: state.player.gender,
        genderLabel: "",
        hp: state.player.hp,
        maxHp: state.player.hp,
        mp: state.player.mp,
        maxMp: state.player.mp,
        mood: state.player.mood,
        moodBandLabel: "",
        attributes: { ...state.player.attributes },
        statuses: [],
        skills: [],
        inventory: [],
      },
      npcs: [],
      slotEvent: null,
      battle: null,
      history: [],
      evaluation: { dimensions: [], summary: "", summarySource: "template", overall: 0 },
      media: (state.media ?? []).map((m) => ({ ...m, url: "", alt: "" })),
      llmPending: state.pendingInvocation !== undefined,
      playerFacts: view.facts,
    } as unknown as V2Snapshot;
  }

  buildFacts(perspective: Perspective): PerspectiveFactView {
    return computeFacts(this.state, perspective);
  }

  /**
   * 清「在飞 invocation」标记（见 `EngineApiHandle.clearPending`）。
   * 只在 id 匹配时清：玩家可能在 LLM 回来之前推进了回合，此 `pendingInvocation`
   * 已经是新一轮的，清空会让新一轮的 `llmPending` 凭空消失。
   */
  clearPending(invocationId: string): void {
    if (this.state.pendingInvocation?.invocationId !== invocationId) return;
    this.state.pendingInvocation = undefined;
  }

  /** 供回放 / 调用方取得当前权威状态（同一引用，dispatch 原地写）。 */
  getState(): WorldStateV2 {
    return this.state;
  }
}

/**
 * `state.slot` 的唯一写入点（ADR-0034 §12-1）。
 * turn.ts 的 6+ 处 `state.slot =` 全部收敛到本函数，源码守卫据此断言
 * 「权威字段写入只出现在 api/engine-api.ts」。
 */
export function assignSlot(state: WorldStateV2, slot: SlotScene | null): void {
  state.slot = slot;
}

/** 把 spec 里注入的 pendingInvocation 落账（回程一律走 dispatch 语义，此处仅封装写入）。 */
export function assignPendingInvocation(
  state: WorldStateV2,
  invocation: WorldStateV2["pendingInvocation"],
): void {
  state.pendingInvocation = invocation;
}

/**
 * ADR-0036：触发器边沿历史（`triggerFireLedger`）的唯一写入点。
 *
 * 与 `assignSlot` / `assignPendingInvocation` 同一条「权威字段写入集中在
 * api/engine-api.ts」约束 —— turn.ts 只能调用本函数，不得直接给 state 字段赋值。
 * 整份替换（而非 merge）：ledger 是「本轮全部触发器的求值快照」，merge 会把已删除 /
 * 改名的触发器残留成幽灵历史。
 */
export function assignTriggerFireLedger(
  state: WorldStateV2,
  ledger: WorldStateV2["triggerFireLedger"],
): void {
  state.triggerFireLedger = ledger;
}

/** 诊断码封闭集合（转出，便于源码守卫 / 测试断言 13 码）。 */
export const ENGINE_DIAGNOSTIC_CODES = DIAGNOSTIC_CODES;

/**
 * ADR-0037 D1：建世界期把模板 `fallbackDag` 种进 `state.taskDag` 的唯一写入点。
 *
 * `structuredClone` 是**硬要求**：`entry.rules` 是跨世界共享的缓存对象，直接赋引用会让
 * 一个世界的 `upsertDagBranch` 改动漂到另一个世界，也破坏同 seed 回放的确定性。
 * 同一 `fallbackDag` 重复种入 ⇒ 逐字段一致（IO-8）。
 */
export function assignTaskDagSeed(state: WorldStateV2, dag: TaskDag): void {
  state.taskDag = structuredClone(dag);
}

/**
 * ADR-0037 D2：节点状态迁移的唯一写入点（引擎权威，LLM 不参与）。
 *
 * 只改 `status` 这一个字段，其余（`guards` / `completion` / `templateRefs`…）保持不动。
 * 迁移列表由纯函数 `advanceDagProgress` 基于**本轮开始时的快照**算出，本函数只负责落账。
 */
export function assignDagNodeStatus(
  state: WorldStateV2,
  nodeId: string,
  status: TaskStatus,
): void {
  state.taskDag = {
    ...state.taskDag,
    nodes: state.taskDag.nodes.map((n) => (n.id === nodeId ? { ...n, status } : n)),
  };
}

/**
 * 结算 tail 的知识授予落账（T-02 / F4）。
 *
 * 计算委托纯函数 `computeKnowledgeGrants`（turn.ts 调用），**写入只在本文件发生** ——
 * 与 `assignSlot` / `assignPendingInvocation` 同一条「权威写入集中在 api/engine-api.ts」约束。
 * 冲突（同一 `(observer, factRef)` 互斥 level）按 rules 声明顺序先到先得、不抛错：
 * 授予是模板数据而非玩家意图，不该因为模板自身写重而中断整回合结算。
 */
export function assignKnowledgeGrants(
  state: WorldStateV2,
  grants: readonly SetKnowledgeArgs[],
): void {
  if (grants.length === 0) return;
  const result = applyKnowledgeBatch(state.observationLedger, grants);
  state.observationLedger = result.ledger;
}
