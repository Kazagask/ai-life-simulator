import type {
  AnyMatch,
  LlmBudget,
  LlmInvocation,
  Perspective,
  Rules,
  TaskCondition,
  TimeAmount,
  WorldStateV2,
  WorldTemplateV2,
} from "@life-sim/shared";
import {
  DEFAULT_LLM_BUDGET,
  HISTORY_TYPE_LABELS,
  isPlayerVisible,
  numericAttr,
  PLAYER_ID,
} from "@life-sim/shared";
import { createRng, deriveTurnSeed, type Rng } from "../rng.js";
import { buildFacts } from "../api/perspective.js";
import { evaluateAttributeCondition } from "./attribute-rules.js";
import { selfIdOf } from "./actors.js";
import { normalizeRelationEndpoint } from "./relations.js";
import { amountToMinutes } from "./time.js";
import { anyMatchMet } from "./any-match.js";

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
   * 模板（ADR-003）：属性条件需要查 `defs` 才知道 kind / enum 选项 / 阶梯档位。
   * 可选是为了兼容既有调用点；缺省时属性条件退化为「原文比较 + 数值比较」。
   */
  template?: WorldTemplateV2;
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
 * 内核内置条件 op（`{ op, args }` 开放形的白名单底座）。
 *
 * 与扩展贡献的 op 同表求值（`createConditionRegistry` 先铺这张，再叠扩展）。
 * **导出**是因为模板加载期要拿它做 fail-fast 判据（`apps/server/src/templates.ts`）：
 * 「这个 op 有没有人实现」必须与运行期读同一份名单，否则扫描会漂移。
 */
export const BUILTIN_CONDITION_EVALUATORS: Readonly<Record<string, ConditionEvalFn>> = {
  always: () => true,
  random: (args, ctx) =>
    ctx.rng() < (typeof args.probability === "number" ? args.probability : 1),
  flagSet: (args, ctx) => ctx.state.flags[String(args.flag)] === (args.value ?? true),
  // 「事件结算后」触发（设计 §3.4 列的第五类）：只认**本轮**结算过的事件，
  // 不查历史 eventFires —— 否则同一条规则会在之后每一轮重复命中。
  eventResolved: (args, ctx) => ctx.resolvedEventIds?.has(String(args.eventId)) ?? false,
};

/** 内置 op 名单（从求值表派生，不手抄）。 */
export const BUILTIN_CONDITION_OPS: readonly string[] = Object.keys(BUILTIN_CONDITION_EVALUATORS);

/**
 * 数据化条件注册表：内置几条结构化 op（仍以 Map 数据注册，不是 switch），
 * 模板可通过 `register` / `extra` 扩展新 op，符合「条件集合不写死枚举」。
 */
export function createConditionRegistry(
  extra: Record<string, ConditionEvalFn> = {},
): ConditionRegistry {
  const ops = new Map<string, ConditionEvalFn>(
    Object.entries({ ...BUILTIN_CONDITION_EVALUATORS, ...extra }),
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
    // ADR-075 §6：集合 + 字段谓词。触发期没有"刚打完的那一场"之外的新战果，
    // 所以 `battle.*` 读 `lastBattleResult`；没有它 ⇒ 空集合 ⇒ false。
    probe: (c) => "anyMatch" in c,
    eval: (c, ctx) =>
      anyMatchMet((c as unknown as { anyMatch: AnyMatch }).anyMatch, {
        state: ctx.state,
        battle: ctx.state.lastBattleResult,
        ...(ctx.template !== undefined ? { template: ctx.template } : {}),
      }),
  },
  {
    probe: (c) => "random" in c,
    eval: (c, ctx) => ctx.rng() < numeric((c as { random: number }).random),
  },
  {
    probe: (c) => "flag" in c,
    eval: (c, ctx) => {
      const f = c as { flag: string; eq?: unknown; ne?: unknown };
      const value = ctx.state.flags[f.flag];
      // 与 `engine.checkCondition` 同一口径：旗标不存在就是假，**不**先过 eq/ne
      // （否则 `{flag: 未发生过的事, ne: 1}` 会被判真，与引擎相反）。
      if (value === undefined) return false;
      if (f.ne !== undefined) return value !== f.ne;
      if (f.eq !== undefined) return value === f.eq;
      return true;
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
      /**
       * ADR-003：属性条件与引擎 `checkCondition` 共用一份实现（attribute-rules）。
       * 这里传的是**原始属性**（触发器求值历来不叠状态/装备），保持既有语义；
       * 文本属性、阶梯 tier 都只依赖原始值，不需要有效值链。
       */
      const raw = ctx.state.player.attributes;
      const numericView: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "number") numericView[k] = v;
      }
      if (ctx.template !== undefined) {
        return evaluateAttributeCondition(
          c as { attribute: string; eq?: number | string; ne?: number | string; gte?: number; lte?: number; gt?: number; lt?: number; tier?: string },
          raw,
          numericView,
          ctx.template,
          ctx.state.player.attributeTiers,
        );
      }
      // 无模板退化路径（只在测试 / 旧调用点出现）：只做原文与数值比较，tier 一律不匹配。
      const a = c as { attribute: string; eq?: number | string; ne?: number | string; gte?: number; lte?: number; gt?: number; lt?: number; tier?: string };
      if (a.tier !== undefined) return false;
      const value = raw[a.attribute] ?? 0;
      if (a.eq !== undefined && value !== a.eq) return false;
      if (a.ne !== undefined && value === a.ne) return false;
      const num = numericAttr(value);
      if (a.gte !== undefined && num < a.gte) return false;
      if (a.lte !== undefined && num > a.lte) return false;
      if (a.gt !== undefined && num <= a.gt) return false;
      if (a.lt !== undefined && num >= a.lt) return false;
      return true;
    },
  },
  {
    probe: (c) => "status" in c,
    eval: (c, ctx) => {
      const cond = c as { status: string; present?: boolean; stacksGte?: number };
      const inst = ctx.state.player.statuses.find((s) => s.statusId === cond.status);
      if (cond.present !== undefined) return cond.present ? inst !== undefined : inst === undefined;
      return inst !== undefined && (inst.stacks ?? 1) >= (cond.stacksGte ?? 1);
    },
  },
  {
    probe: (c) => "inventory" in c,
    eval: (c, ctx) => {
      const i = c as { inventory: string; gte: number };
      return (ctx.state.player.inventory[i.inventory] ?? 0) >= i.gte;
    },
  },
  {
    probe: (c) => "mood" in c,
    eval: (c, ctx) => {
      const cond = (c as { mood: { gte?: number; lte?: number } }).mood;
      if (cond.gte !== undefined && ctx.state.player.mood < cond.gte) return false;
      if (cond.lte !== undefined && ctx.state.player.mood > cond.lte) return false;
      return true;
    },
  },
  {
    probe: (c) => "relation" in c,
    eval: (c, ctx) => {
      /**
       * 与 `engine.checkCondition` 逐行同义（两边都读同一个数）：
       * - 声明 `kind` ⇒ 读**关系边**；端点缺省是当前 self（不是字面量 `player`）；
       * - 未声明 `kind` ⇒ 读 `npc.relationship` 标量（「他视你如何」）。
       *
       * 触发器以前**整支缺失**：`relation` 条件在 rules.yaml 里恒为假，且不报诊断。
       */
      const cond = c as { relation: string; kind?: string; to?: string; gte?: number; lte?: number };
      const selfId = selfIdOf(ctx.state);
      if (cond.kind !== undefined) {
        const to = normalizeRelationEndpoint(cond.to ?? PLAYER_ID, selfId);
        const value =
          to === selfId
            ? (ctx.state.npcs.find((n) => n.id === cond.relation)?.relationship ?? 0)
            : (ctx.state.relations.find(
                (e) => e.from === cond.relation && e.to === to && e.kind === cond.kind,
              )?.value ?? 0);
        if (cond.gte !== undefined && value < cond.gte) return false;
        if (cond.lte !== undefined && value > cond.lte) return false;
        return true;
      }
      const npc = ctx.state.npcs.find((n) => n.id === cond.relation);
      if (npc === undefined) return false;
      if (cond.gte !== undefined && npc.relationship < cond.gte) return false;
      if (cond.lte !== undefined && npc.relationship > cond.lte) return false;
      return true;
    },
  },
  {
    probe: (c) => "selfIs" in c,
    eval: (c, ctx) => selfIdOf(ctx.state) === (c as { selfIs: string }).selfIs,
  },
  {
    probe: (c) => "selfIsNot" in c,
    eval: (c, ctx) => selfIdOf(ctx.state) !== (c as { selfIsNot: string }).selfIsNot,
  },
  {
    probe: (c) => "npcState" in c,
    eval: (c, ctx) => {
      const cond = (c as { npcState: { npcId: string; state: string } }).npcState;
      const npc = ctx.state.npcs.find((n) => n.id === cond.npcId);
      return npc !== undefined && npc.lifecycle.state === cond.state;
    },
  },
  {
    probe: (c) => "time" in c,
    eval: (c, ctx) => {
      // 以前这里是 `worldTime >= 0` 的占位（永远为真）⇒ 时间条件在触发器上静默失效。
      const cond = (c as { time: { gte?: TimeAmount; lte?: TimeAmount; gt?: TimeAmount; lt?: TimeAmount } }).time;
      const minutes = ctx.state.worldTime;
      if (cond.gte !== undefined && minutes < amountToMinutes(cond.gte)) return false;
      if (cond.lte !== undefined && minutes > amountToMinutes(cond.lte)) return false;
      if (cond.gt !== undefined && minutes <= amountToMinutes(cond.gt)) return false;
      if (cond.lt !== undefined && minutes >= amountToMinutes(cond.lt)) return false;
      return true;
    },
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
  /** 模板（ADR-003）：属性条件需要 defs 解释 kind / enum / 阶梯。 */
  template?: WorldTemplateV2;
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
    out.push(buildTriggerInvocation(state, rules, trigger, i, opts, registry));
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
    ...(opts.template !== undefined ? { template: opts.template } : {}),
    ...(opts.resolvedEventIds !== undefined ? { resolvedEventIds: opts.resolvedEventIds } : {}),
  };
}

/**
 * 条件 instruction 的解析（2026-11-21）：单字符串原样返回；变体数组取**声明序第一条命中**的。
 *
 * 命中 = `as`（当前 self 是不是这个人/这组人）+ `when`（条件数组）**同时**成立。
 * `as` 是**快捷写法**，与事件节点级的同名语法同一套语义：
 * `as: npc-riko` ⇔ `when: [{ selfIs: npc-riko }]`；数组形式
 * `as: [npc-a, npc-b]` ⇔ 「self 是其中任意一个」，不渲染成任何身份前缀 ——
 * 它只决定「这句话给谁看」，不改变句子本身。
 *
 * 有 `as` 变体却没有兜底 ⇒ 加载期已拒（`InstructionSchema` 的 superRefine），
 * 所以这里 `find` 不到只可能是"条件变体都不满足且无兜底"的旧档，返回 undefined 即可。
 */
function asMatches(as: string | string[] | undefined, selfId: string): boolean {
  if (as === undefined) return true;
  return Array.isArray(as) ? as.includes(selfId) : as === selfId;
}

function resolveInstruction(
  instruction: Rules["llmTriggers"][number]["invoke"]["instruction"],
  ctx: ConditionEvalContext,
  registry: ConditionRegistry,
): string | undefined {
  if (instruction === undefined) return undefined;
  if (typeof instruction === "string") return instruction;
  const selfId = selfIdOf(ctx.state);
  const variant = instruction.find(
    (candidate) =>
      asMatches(candidate.as, selfId) &&
      (candidate.when === undefined ||
        candidate.when.length === 0 ||
        evaluateAll(candidate.when, ctx, registry)),
  );
  return variant?.text;
}

/** 把一条命中的触发器规格构造为 `LlmInvocation`（invocationId 格式 = `inv-${turn}-${index}`）。 */
function buildTriggerInvocation(
  state: WorldStateV2,
  rules: Rules,
  trigger: Rules["llmTriggers"][number],
  index: number,
  opts: TriggerOptions,
  registry: ConditionRegistry,
): LlmInvocation {
  // 只传工具**名**：参数 schema 归 agent-runtime（`buildToolDescriptors`）。
  // 曾在 core 侧造过 `{ name }` 这种"空 schema"的工具表，导致模型收到 `parameters: {}`
  // 只能瞎猜参数（真实模型实测直接发空对象 ⇒ 整轮作废）。
  const tools = (rules.toolProfile[trigger.invoke.toolProfile] ?? []).map((name) => ({ name }));
  /**
   * 条件 instruction（2026-11-21）：按 `when` 选第一条命中的变体。
   *
   * 用**独立派生流**（salt 53 + 触发器下标）而不是 `createTriggerContext` 的那条：
   * 变体条件里可能写 `random`，共用一条流会让"选哪句提示词"偷偷改变触发器本身的
   * 随机序列（同一 seed 的既有对局会漂）。分开之后，instruction 的选择只影响它自己。
   */
  const instruction = resolveInstruction(
    trigger.invoke.instruction,
    { ...createTriggerContext(state, opts), rng: derivedTriggerRng(opts.seed + 53 + index, opts.turnIndex) },
    registry,
  );
  /**
   * 滚动历史（v2 §6.1 的 `[4] recentTurns`）：**玩家可见的历史摘要**。
   *
   * 这里原本硬编码 `[]` —— 编排层没有别的注入点（`gateway.deps.history` 无人赋值），
   * 于是模型实际上只在 facts 与工具里看得到世界，看不到"刚刚发生了什么"。
   * 逐拍旁白还能靠 facts 硬撑，章节回顾则必然写成空话或流水账。
   *
   * 可见性用 `isPlayerVisible`（R-VS-01 的唯一判定入口），不自己比较 `visibility`。
   */
  const historyLimit = trigger.invoke.historyTurns ?? opts.budget?.recentTurns ?? 6;
  const recentTurns = state.history
    .filter((entry) => isPlayerVisible(entry))
    .slice(-historyLimit)
    .map((entry) => ({
      turnIndex: entry.turnIndex,
      time: entry.formattedTime,
      kind: entry.type,
      // 机器枚举旁边给人话：模型会把 `npc_action` 直接写进正文，读不懂时又只会绕开。
      kindLabel: HISTORY_TYPE_LABELS[entry.type] ?? entry.type,
      summary: entry.summary,
    }));
  /**
   * 白名单的可读版：`branchEventIds` 是闸门，但只给 id 等于只给了变量名。
   * 标题从模板事件 / LLM 生成事件里取（同一份来源，生成事件也能解析）；都没有就回退 id。
   */
  const branchEvents =
    trigger.invoke.branchEventIds === undefined
      ? undefined
      : trigger.invoke.branchEventIds.map((id) => ({
          id,
          title:
            opts.template?.events.find((event) => event.id === id)?.title ??
            state.generatedEvents?.find((event) => event.id === id)?.title ??
            id,
        }));
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
      recentTurns,
      invocationReason: trigger.invoke.reason,
      ...(trigger.invoke.contextHints !== undefined
        ? { contextHints: trigger.invoke.contextHints }
        : {}),
      ...(instruction !== undefined ? { instruction } : {}),
      ...(trigger.invoke.mode !== undefined ? { narrativeMode: trigger.invoke.mode } : {}),
      ...(trigger.invoke.length !== undefined ? { narrativeLength: trigger.invoke.length } : {}),
      // ADR-0038：白名单随 invocation 一起快照 —— 规则在 invocation 存续期间被改，
      // 不影响已经发出的这一份（它是这次调用的权威描述）。
      ...(trigger.invoke.branchEventIds !== undefined
        ? { branchEventIds: [...trigger.invoke.branchEventIds] }
        : {}),
      ...(branchEvents !== undefined ? { branchEvents } : {}),
    },
    tools,
    // 画像名必须随 invocation 下传，runtime 才能重建**带参数 schema** 的工具表。
    toolProfile: trigger.invoke.toolProfile,
    /**
     * 预算：`historyTurns` 要一起改 `budget.recentTurns`，否则编排层会按缺省 6 条再切一次
     * （`buildLlmContext` 的 `slice(-inv.budget.recentTurns)`），core 这边填多长都白填。
     */
    budget:
      trigger.invoke.historyTurns !== undefined
        ? { ...(opts.budget ?? DEFAULT_LLM_BUDGET), recentTurns: trigger.invoke.historyTurns }
        : (opts.budget ?? DEFAULT_LLM_BUDGET),
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
      invocations.push(buildTriggerInvocation(state, rules, trigger, i, opts, registry));
      return;
    }
    // edge：上一轮已为真 ⇒ 不是边沿，抑制（不执行、也不重复落账之外的任何动作）。
    if (previous?.[key]?.hit === true) {
      suppressed.push(key);
      return;
    }
    invocations.push(buildTriggerInvocation(state, rules, trigger, i, opts, registry));
  });
  return { invocations, fireLedger, suppressed };
}
