import {
  ContentBlockSchema,
  DIAGNOSTIC_CODES,
  SetKnowledgeArgsSchema,
  TaskDagSchema,
  type ApiCall,
  type CallReceipt,
  type ContentBlock,
  type DiagnosticCode,
  type DispatchContext,
  type DispatchResult,
  type EngineApiHandle,
  type FactChange,
  type LlmBudget,
  type Perspective,
  type PerspectiveFactView,
  type SetKnowledgeArgs,
  type SlotScene,
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
 * `fact.enqueueEvent`：把**模板里已存在**的事件实例化进延时队列（DAG 分支的落地动作）。
 *
 * 设计口径（§3.4「(b) 需要上桌事件 ⇒ fact.enqueueEvent → delayQueue」）：
 * - LLM **只能选用模板已有事件**，不能凭空发明事件内容 —— `eventId` 必须是
 *   `env.lookupRefs`（模板 ref 全集）成员，否则 `unknown_reference`（FATAL）。
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
 * `content.submit`：invocation 正常落地的终止点。
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
  map.set("fact.enqueueEvent", enqueueEvent);
  for (const name of [
    "content.writeNarrative",
    "content.writeMemory",
    "content.writeOption",
    "content.writeFlavor",
    "content.referenceAsset",
  ]) {
    map.set(name, writeContent);
  }
  map.set("content.submit", submitContent);
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
