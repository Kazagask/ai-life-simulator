import type {
  LlmBudget,
  LlmInvocation,
  Perspective,
  Rules,
  TaskCondition,
  WorldStateV2,
} from "@life-sim/shared";
import { DEFAULT_LLM_BUDGET } from "@life-sim/shared";
import { createRng, deriveTurnSeed, type Rng } from "../rng.js";
import { buildFacts } from "../api/perspective.js";

/**
 * 条件求值器（T-02，纯函数）。
 *
 * - 复用 `common.ts` 的声明式 Condition DSL（经 `TaskConditionSchema` 暴露为本文件的
 *   `TaskCondition` 联合：扁平形 ∪ { op, args } 开放形），不另立第三套语法。
 * - 开放形 `op` 的语义一律交给 `ConditionRegistry`（数据化 Map）解释；
 *   **引擎不 switch on op**，只做 `registry.evaluate(op, ...)` 查表。注册表是前向 seam。
 * - 随机触发走 `deriveTurnSeed(seed + 37, turnIndex)` 派生流，不扰动主轮 RNG。
 */

/** 触发判定用的独立派生流盐（v2 §3.5 / ADR-0034 的 `seed + 37` 先例）。 */
export const TRIGGER_RNG_SALT = 37;

export interface ConditionEvalContext {
  state: WorldStateV2;
  rng: Rng;
  turnIndex: number;
  /**
   * 本轮已结算的事件 id 集合（`eventResolved` 求值用）。
   * 可选：缺省 = 本轮无结算，`eventResolved` 一律 false。做成可选是为了既有调用方不改即编译。
   */
  resolvedEventIds?: ReadonlySet<string>;
}

export type ConditionEvalFn = (
  args: Record<string, unknown>,
  ctx: ConditionEvalContext,
) => boolean;

export interface ConditionRegistry {
  has(op: string): boolean;
  evaluate(op: string, args: Record<string, unknown>, ctx: ConditionEvalContext): boolean;
  register(op: string, fn: ConditionEvalFn): void;
}

/**
 * 数据化条件注册表：内置几条结构化 op（仍以 Map 数据注册，不是 switch），
 * 模板可通过 `register` / `extra` 扩展新 op，符合「条件集合不写死枚举」。
 */
export function createConditionRegistry(
  extra: Record<string, ConditionEvalFn> = {},
): ConditionRegistry {
  const ops = new Map<string, ConditionEvalFn>(
    Object.entries({
      always: () => true,
      random: (args, ctx) =>
        ctx.rng() < (typeof args.probability === "number" ? args.probability : 1),
      flagSet: (args, ctx) => ctx.state.flags[String(args.flag)] === (args.value ?? true),
      nodeCompleted: (args, ctx) =>
        ctx.state.taskDag.nodes.some((n) => n.id === args.nodeId && n.status === "completed"),
      // 「事件结算后」触发（设计 §3.4 列的第五类）：只认**本轮**结算过的事件，
      // 不查历史 eventFires —— 否则同一条规则会在之后每一轮重复命中。
      eventResolved: (args, ctx) => ctx.resolvedEventIds?.has(String(args.eventId)) ?? false,
      ...extra,
    }),
  );
  return {
    has: (op) => ops.has(op),
    evaluate: (op, args, ctx) => ops.get(op)?.(args, ctx) ?? false,
    register: (op, fn) => {
      ops.set(op, fn);
    },
  };
}

/** 派生流：与主管线 `deriveTurnSeed(state.seed, turnIndex)` 完全隔离。 */
export function derivedTriggerRng(seed: number, turnIndex: number): Rng {
  return createRng(deriveTurnSeed(seed + TRIGGER_RNG_SALT, turnIndex));
}

// 扁平声明式形：按「首个识别到的判别键」查数据表求值，不 switch on 维度 / op。
interface FlatEvaluator {
  probe: (c: TaskCondition) => boolean;
  eval: (c: TaskCondition, ctx: ConditionEvalContext) => boolean;
}

const numeric = (v: unknown): number => (typeof v === "number" ? v : 0);

const FLAT_EVALUATORS: readonly FlatEvaluator[] = [
  {
    probe: (c) => "random" in c,
    eval: (c, ctx) => ctx.rng() < numeric((c as { random: number }).random),
  },
  {
    probe: (c) => "flag" in c,
    eval: (c, ctx) => {
      const f = c as { flag: string; eq?: unknown; ne?: unknown };
      const value = ctx.state.flags[f.flag];
      if (f.ne !== undefined) return value !== f.ne;
      if (f.eq !== undefined) return value === f.eq;
      return value !== undefined;
    },
  },
  {
    probe: (c) => "requiresSkill" in c,
    eval: (c, ctx) =>
      ctx.state.player.skills.includes((c as { requiresSkill: string }).requiresSkill),
  },
  {
    probe: (c) => "attribute" in c,
    eval: (c, ctx) => {
      const a = c as { attribute: string; gte?: number; lte?: number };
      const value = ctx.state.player.attributes[a.attribute] ?? 0;
      if (a.gte !== undefined && value < a.gte) return false;
      if (a.lte !== undefined && value > a.lte) return false;
      return true;
    },
  },
  {
    probe: (c) => "status" in c,
    eval: (c, ctx) =>
      ctx.state.player.statuses.some(
        (s) => s.statusId === (c as { status: string }).status,
      ),
  },
  {
    probe: (c) => "inventory" in c,
    eval: (c, ctx) => {
      const i = c as { inventory: string; gte: number };
      return (ctx.state.player.inventory[i.inventory] ?? 0) >= i.gte;
    },
  },
  {
    probe: (c) => "time" in c,
    eval: (_c, ctx) => ctx.state.worldTime >= 0,
  },
];

/** R11：未注册开放形 op 的诊断（不得静默跳过、不得当成 false 放过）。 */
export interface ConditionDiagnostic {
  code: "unknown_reference";
  op: string;
}

/**
 * 详细求值（纯函数）：
 * 1. 优先解释 ConditionSchema 扁平分支（P0 主体，§11.2⑥ 复用现行 DSL）；
 * 2. OpenConditionSchema 分支的 op 必须已在 ConditionRegistry 注册才求值；
 * 3. **未注册 ⇒ 产出 unknown_reference 诊断**，绝不静默放过（R11 教训）。
 * 引擎不 switch on op 名（扁平形查 FLAT_EVALUATORS 数据表，开放形查 registry）。
 */
export function evaluateConditionDetailed(
  cond: TaskCondition,
  ctx: ConditionEvalContext,
  registry: ConditionRegistry,
): { matched: boolean; diagnostic?: ConditionDiagnostic } {
  if ("op" in cond) {
    const open = cond as { op: string; args: Record<string, unknown> };
    if (!registry.has(open.op)) {
      return { matched: false, diagnostic: { code: "unknown_reference", op: open.op } };
    }
    return { matched: registry.evaluate(open.op, open.args, ctx) };
  }
  for (const e of FLAT_EVALUATORS) {
    if (e.probe(cond)) return { matched: e.eval(cond, ctx) };
  }
  return { matched: false };
}

/** boolean 兼容版（保留既有调用点签名）。 */
export function evaluateCondition(
  cond: TaskCondition,
  ctx: ConditionEvalContext,
  registry: ConditionRegistry,
): boolean {
  return evaluateConditionDetailed(cond, ctx, registry).matched;
}

/** 条件数组内 AND；可选地把未注册 op 的诊断累积到 diagnostics（不静默）。 */
export function evaluateAll(
  conds: readonly TaskCondition[],
  ctx: ConditionEvalContext,
  registry: ConditionRegistry,
  diagnostics?: ConditionDiagnostic[],
): boolean {
  let all = true;
  for (const c of conds) {
    const r = evaluateConditionDetailed(c, ctx, registry);
    if (r.diagnostic) diagnostics?.push(r.diagnostic);
    if (!r.matched) all = false;
  }
  return all;
}

export interface TriggerOptions {
  seed: number;
  turnIndex: number;
  budget?: LlmBudget;
  perspective?: Perspective;
  targetPerspective?: Perspective;
  /** 本轮已结算的事件 id（透传给 `eventResolved`；缺省 = 本轮无结算）。 */
  resolvedEventIds?: ReadonlySet<string>;
}

/**
 * 触发点求值（turn.ts 结算 tail 的唯一 hook 会调用它）：纯函数，返回本轮应发出的
 * `LlmInvocation[]`。非触发回合返回空数组（invocations.length === 0）。
 * 同 (seed, turnIndex, rules) 两次调用结果一致（派生流确定性）。
 *
 * ⚠ 本函数做的是**当轮真值求值**（纯 level 语义，无历史）；生产路径请用
 * `evaluateTriggersEdge`（ADR-0036）。保留本函数是为了既有调用点 / 测试零回归。
 */
export function evaluateTriggers(
  state: WorldStateV2,
  rules: Rules,
  registry: ConditionRegistry,
  opts: TriggerOptions,
): LlmInvocation[] {
  const ctx = createTriggerContext(state, opts);
  const out: LlmInvocation[] = [];
  rules.llmTriggers.forEach((trigger, i) => {
    if (!evaluateAll(trigger.when, ctx, registry)) return;
    out.push(buildTriggerInvocation(state, rules, trigger, i, opts));
  });
  return out;
}

/** 触发器求值的公共上下文（派生流按 seed+37 / turnIndex 隔离，不扰动主轮 RNG）。 */
function createTriggerContext(
  state: WorldStateV2,
  opts: TriggerOptions,
): ConditionEvalContext {
  return {
    state,
    rng: derivedTriggerRng(opts.seed, opts.turnIndex),
    turnIndex: opts.turnIndex,
    ...(opts.resolvedEventIds !== undefined ? { resolvedEventIds: opts.resolvedEventIds } : {}),
  };
}

/** 把一条命中的触发器规格构造为 `LlmInvocation`（invocationId 格式 = `inv-${turn}-${index}`）。 */
function buildTriggerInvocation(
  state: WorldStateV2,
  rules: Rules,
  trigger: Rules["llmTriggers"][number],
  index: number,
  opts: TriggerOptions,
): LlmInvocation {
  const tools = (rules.toolProfile[trigger.invoke.toolProfile] ?? []).map((name) => ({ name }));
  const perspective = opts.perspective ?? trigger.invoke.perspective;
  const targetPerspective = opts.targetPerspective ?? trigger.invoke.targetPerspective;
  // LlmContext（v2 §6.1 分层）：facts 段由 core 的 buildFacts(inv.perspective) 投影，
  // 编排层不得裁剪。此处在 core 构造 LlmInvocation 时即投影完毕。
  return {
    invocationId: `inv-${opts.turnIndex}-${index}`,
    reason: trigger.invoke.reason,
    context: {
      stablePrefix: "",
      facts: buildFacts(state, perspective),
      recentTurns: [],
      invocationReason: trigger.invoke.reason,
      ...(trigger.invoke.contextHints !== undefined
        ? { contextHints: trigger.invoke.contextHints }
        : {}),
    },
    tools,
    budget: opts.budget ?? DEFAULT_LLM_BUDGET,
    replyTo: "dispatch",
    perspective,
    targetPerspective,
  };
}

/** 带诊断的触发求值结果（追加 R11）。 */
export interface TriggerEvaluation {
  invocations: LlmInvocation[];
  diagnostics: ConditionDiagnostic[];
}

/**
 * 带诊断的触发求值（追加 R11 验收纯函数）：除 invocations 外，扫描规则中
 * when / guards / completion 的**全部**开放形 op，凡未在 ConditionRegistry 注册
 * ⇒ unknown_reference 诊断。规则含未注册 op 时 diagnostics 必非空（不是空结果、
 * 不是静默通过）。不 new 语法、引擎不 switch on op。
 */
export function evaluateTriggersDetailed(
  state: WorldStateV2,
  rules: Rules,
  registry: ConditionRegistry,
  opts: TriggerOptions,
): TriggerEvaluation {
  const diagnostics: ConditionDiagnostic[] = [];
  const seen = new Set<string>();
  const ctx: ConditionEvalContext = {
    state,
    rng: derivedTriggerRng(opts.seed, opts.turnIndex),
    turnIndex: opts.turnIndex,
  };
  const collect = (conds: readonly TaskCondition[]) => {
    for (const c of conds) {
      const r = evaluateConditionDetailed(c, ctx, registry);
      if (r.diagnostic && !seen.has(r.diagnostic.op)) {
        seen.add(r.diagnostic.op);
        diagnostics.push(r.diagnostic);
      }
    }
  };
  for (const t of rules.llmTriggers) collect(t.when);
  for (const g of [...rules.knowledgeGrants, ...rules.inferenceRules]) collect(g.when);
  for (const n of rules.fallbackDag.nodes) {
    collect(n.guards);
    collect(n.completion);
  }
  return { invocations: evaluateTriggers(state, rules, registry, opts), diagnostics };
}

/** ADR-0036：边沿求值结果。 */
export interface TriggerEdgeEvaluation {
  /** 本轮按边沿判据**应当发出**的 invocation（声明序）。执行哪几条由调用方按 D3 决定。 */
  invocations: LlmInvocation[];
  /** 本轮所有触发器的求值快照（**含假值**：假值必须落账，否则下次真值会被当成"刚刚变真"）。 */
  fireLedger: Record<string, { turnIndex: number; hit: boolean }>;
  /** 求值为真但被**边沿判据**抑制的 key（`${reason}#${index}`），供诊断。 */
  suppressed: string[];
}

/**
 * ADR-0036：触发器**边沿语义**求值（生产路径）。
 *
 * 判据：`fireMode: edge`（缺省）仅当「上一轮为假、本轮为真」时发 invocation；
 * `fireMode: level` 命中即发（旧行为）。`previous` 缺省 = 无历史 ⇒ 本轮真值一律视为
 * **刚刚变真**（至多多发一次，绝不永久抑制 —— 旧档兼容）。
 *
 * ⚠ `random`（p=0.1）在 edge 下退化为 ~9%：边沿要求「上次假」⇒ 0.1 × 0.9。这是**期望行为**
 * （避免连续两轮 flavor 轰炸），但排预算时别按 10% 算。
 *
 * 纯函数：不写 state；ledger 由调用方经 `assignTriggerFireLedger` 落账（权威写入集中在
 * api/engine-api.ts）。同 (state, rules, previous, opts) 两次调用结果一致。
 */
export function evaluateTriggersEdge(
  state: WorldStateV2,
  rules: Rules,
  registry: ConditionRegistry,
  opts: TriggerOptions,
  previous?: WorldStateV2["triggerFireLedger"],
): TriggerEdgeEvaluation {
  const ctx = createTriggerContext(state, opts);
  const invocations: LlmInvocation[] = [];
  const fireLedger: Record<string, { turnIndex: number; hit: boolean }> = {};
  const suppressed: string[] = [];
  rules.llmTriggers.forEach((trigger, i) => {
    const hit = evaluateAll(trigger.when, ctx, registry);
    const key = `${trigger.invoke.reason}#${i}`;
    // 假值也落账：否则「真 → 假 → 真」的第二次真永远不会被认成边沿。
    fireLedger[key] = { turnIndex: opts.turnIndex, hit };
    if (!hit) return;
    if ((trigger.fireMode ?? "edge") === "level") {
      invocations.push(buildTriggerInvocation(state, rules, trigger, i, opts));
      return;
    }
    // edge：上一轮已为真 ⇒ 不是边沿，抑制（不执行、也不重复落账之外的任何动作）。
    if (previous?.[key]?.hit === true) {
      suppressed.push(key);
      return;
    }
    invocations.push(buildTriggerInvocation(state, rules, trigger, i, opts));
  });
  return { invocations, fireLedger, suppressed };
}
