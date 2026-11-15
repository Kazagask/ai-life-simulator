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
  run(state, args) {
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
  run(state, args, _ctx, env) {
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

const submitContent: ToolHandler = {
  run(state, _args, ctx) {
    // F3：traceRef 是 trace 的引用锚；正文仍只在 sink，不进 state。
    const traceRef = `trace:${ctx.invocationId ?? "local"}`;
    state.traceRef = traceRef;
    return accepted([{ path: "traceRef", after: traceRef }]);
  },
};

function defaultToolRegistry(): Map<string, ToolHandler> {
  const map = new Map<string, ToolHandler>();
  map.set("fact.setKnowledge", setKnowledge);
  map.set("fact.advanceDag", advanceDag);
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

/** 诊断码封闭集合（转出，便于源码守卫 / 测试断言 13 码）。 */
export const ENGINE_DIAGNOSTIC_CODES = DIAGNOSTIC_CODES;
