/**
 * 前实例化开局会话内核（ADR-001 / R-OP-01..07）。
 *
 * 设计纪律：
 * - 这里**没有 WorldStateV2、没有 NPC 实例、没有 delayQueue**——会话只在 `results` 里记
 *   「每一步抽到/选到什么」，commit 时才一次建世界。所以不需要 NPC 生成补丁 / 事件冻结补丁。
 * - 不重放 effect DSL：每一步的 `set` 是**参数赋值**，commit 时按引擎闭集落点直接写状态。
 * - roll 的随机源按节点派生（`deriveOpeningSeed`），不消耗世界 RNG 主流；同 node 重算同结果。
 * - v1 不支持 `weightBy`（D-4 裁决）：加载期已拒载，这里也防御性忽略。
 *   按**本会话已落定参数**调制的 `weightByParam` 是 D-4 的修订（ADR-001 D7），见 `optionWeights`。
 */
import { normalizeAllocation } from "./allocation.js";
import type {
  OpeningBranchDag,
  OpeningBranchNode,
  OpeningBranchOption,
  OpeningParamDecl,
  OpeningStepResult,
  ResolvedStyle,
  WorldTemplateV2,
} from "@life-sim/shared";
import { RelationKindSchema, SimulationDurationSchema, numericAttr } from "@life-sim/shared";
import { createRng, deriveOpeningSeed, pickWeighted } from "../rng.js";
import type { TurnGain, UiConfig } from "@life-sim/shared";
import {
  resolveEntityStyle,
  resolveEntityTags,
  resolveStyle,
  tagIdsOf,
} from "./presentation/style.js";
import {
  durationLabel,
  equipmentEffectSummaries,
  itemEffectSummaries,
  skillEffectSummaries,
  statusEffectSummaries,
} from "./presentation/effects.js";
import { applyStatusToPlayer, assignAttributeValue, maxHp, maxMp } from "./engine.js";
import { createLookup } from "./lookup.js";
import { createWorldV2, type SelfSelectionV2 } from "./turn.js";
import { createTimeAdapter, type TimeUnit } from "./time.js";
import type { TimeAmount, WorldStateV2 } from "@life-sim/shared";

/** 内核侧会话（不含 server 资源字段 id / templateRef，那些由 server 层包）。 */
export interface OpeningSessionCore {
  openingId: string;
  seed: number;
  nodeId: string;
  results: OpeningStepResult[];
  done: boolean;
}

export function createOpeningSession(dag: OpeningBranchDag, seed: number): OpeningSessionCore {
  return { openingId: dag.openingId, seed, nodeId: dag.entry, results: [], done: false };
}

/** 当前节点（done 时为 null）。 */
export function currentNode(dag: OpeningBranchDag, session: OpeningSessionCore): OpeningBranchNode | null {
  if (session.done) return null;
  return dag.nodes.find((n) => n.node === session.nodeId) ?? null;
}

export interface OpeningAllocationTargetView {
  attribute: string;
  /** 展示名：target.label > world.yaml attributes.labels > 属性 id。 */
  label: string;
  min?: number;
  max?: number;
  /** 属性名着色（ADR-004 D6）：模板在 target 上声明，由投影解析后下发。 */
  style?: ResolvedStyle;
}

export interface OpeningNodeView {
  nodeId: string;
  title: string;
  text?: string;
  mode: OpeningBranchNode["mode"];
  /** choose 节点：等玩家点选；roll 节点：已由服务端决定，前端只演动画。 */
  options: Array<{ id: string; text: string; weight?: number }>;
  /** allocate 节点：点数规格（param id + budget + targets）。 */
  allocation?: { param: string; budget: number; targets: OpeningAllocationTargetView[] };
}

/** describeNode 的可选上下文：只有带上 template/ui 才能解析 label 与 style。 */
export interface OpeningDescribeContext {
  template: WorldTemplateV2;
  ui?: UiConfig;
}

/**
 * 解析 allocate 节点的预算（ADR-004 D2）。
 *
 * 有 `budgetFrom` ⇒ 取该参数在**本会话**的落定值（由前面的 roll/choose 写入）。
 * 没落定、不是数字、不是非负整数 ⇒ 直接报错而不是回退 0：静默按 0 处理会让
 * 「先加点后抽点」这类模板顺序错误表现成「面板说 0 点」，玩家只能干瞪眼。
 */
export function resolveAllocationBudget(
  dag: OpeningBranchDag,
  session: OpeningSessionCore,
  decl: OpeningParamDecl,
): number {
  if (decl.budgetFrom === undefined) return decl.budget ?? 0;
  const params = resolveParamMap(dag, session);
  const raw = params[decl.budgetFrom];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new Error(`opening_allocate_budget_unavailable: ${decl.budgetFrom}`);
  }
  return raw;
}

/**
 * 解包参数落定值（ADR-001 D7）。
 *
 * `resolveParamMap` 存的是 `option.set` 原样：flag / attribute 参数的形状是
 * `{ id, value, mode? }`，只有 `kind: number` 之类才是裸数字。权重调制要的是「值」本身，
 * 所以先剥掉对象壳：**对象且带 `value` 键 ⇒ 取 `.value`**，否则用原值。
 */
function unwrapParamValue(raw: unknown): unknown {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && "value" in raw) {
    return (raw as Record<string, unknown>).value;
  }
  return raw;
}

/**
 * 计算 roll 节点各选项在**本会话**下的最终权重（ADR-001 D7），与 `node.options` 等长。
 *
 * `final = max(0, weight + Σ(数值参数值 × 系数) + Σ(枚举参数查表值))`，
 * 与事件侧 `settle.random.wheel.segments[].weightBy` 同一套算法，只把取值源换成 param map。
 *
 * 参数缺失 / 类型不匹配 / 枚举查表键不存在 ⇒ 该条偏置计 0，**不抛错**：
 * 「没抽过这个参数」在语义上等于「没有偏向」。
 */
export function optionWeights(
  dag: OpeningBranchDag,
  session: OpeningSessionCore,
  node: OpeningBranchNode,
): number[] {
  const params = resolveParamMap(dag, session);
  return (node.options ?? []).map((option) => {
    let weight = option.weight ?? 1;
    for (const [paramId, spec] of Object.entries(option.weightByParam ?? {})) {
      const value = unwrapParamValue(params[paramId]);
      if (typeof value === "number") {
        // 数值参数：系数；写成查表 = 类型不匹配，计 0。
        if (typeof spec === "number") weight += value * spec;
      } else if (typeof value === "string") {
        // 枚举参数：查表；写成裸系数 = 类型不匹配，计 0。
        if (typeof spec !== "number") weight += spec[value] ?? 0;
      }
      // 布尔 / 对象 / 缺失 ⇒ 没有可用的数值语义，计 0。
    }
    return Math.max(0, weight);
  });
}

/** 呈现给前端的节点描述。roll 节点在这里**不掷**——掷发生在 resolveStep。 */
export function describeNode(
  dag: OpeningBranchDag,
  session: OpeningSessionCore,
  ctx?: OpeningDescribeContext,
): OpeningNodeView | null {
  const node = currentNode(dag, session);
  if (!node) return null;
  // ADR-001 D7：roll 节点必须下发**本会话算出的最终权重**，否则转盘扇区面积与实际概率
  // 不一致——玩家看到的就是假盘。choose 节点的权重不参与决策，保持静态声明即可。
  const rollWeights = node.mode === "roll" ? optionWeights(dag, session, node) : undefined;
  const options = (node.options ?? []).map((o, i) => ({
    id: o.id,
    text: o.text,
    weight: rollWeights !== undefined ? rollWeights[i] : o.weight,
  }));
  let allocation: OpeningNodeView["allocation"];
  if (node.mode === "allocate") {
    const pid = node.param;
    const decl = pid ? dag.params.find((p) => p.id === pid) : undefined;
    if (decl !== undefined) {
      const lookup = ctx !== undefined ? createLookup(ctx.template) : undefined;
      allocation = {
        param: pid ?? "",
        budget: resolveAllocationBudget(dag, session, decl),
        targets: (decl.targets ?? []).map((t) => ({
          attribute: t.attribute,
          label: t.label ?? lookup?.attributeLabel(t.attribute) ?? t.attribute,
          ...(t.min !== undefined ? { min: t.min } : {}),
          ...(t.max !== undefined ? { max: t.max } : {}),
          ...(t.style !== undefined && ctx !== undefined
            ? { style: resolveStyle(t.style, undefined, ctx.ui) }
            : {}),
        })),
      };
    } else {
      // 加载期已拒载「allocate 没有 param / param 不存在」；这里只保证形状不炸。
      allocation = { param: pid ?? "", budget: 0, targets: [] };
    }
  }
  return {
    nodeId: node.node,
    title: node.title,
    ...(node.text !== undefined ? { text: node.text } : {}),
    mode: node.mode,
    // allocate 不展示选项；roll 的选项只用于"转盘扇区"呈现（权重已公开给玩家，与现有转盘一致）。
    options: node.mode === "allocate" ? [] : options,
    ...(allocation !== undefined ? { allocation } : {}),
  };
}

export type ResolveInput =
  | { kind: "roll" }
  | { kind: "choose"; optionId: string }
  | { kind: "allocate"; allocation: Record<string, number> };

export interface StepOutcome {
  session: OpeningSessionCore;
  /** 本步抽到/选到的选项（roll 用；前端据此演动画）。 */
  resolved?: { nodeId: string; optionId: string; text: string; set: Record<string, unknown> };
}

function nextNodeId(dag: OpeningBranchDag, node: OpeningBranchNode, option?: OpeningBranchOption): string | null {
  const target = option?.goto ?? node.goto;
  if (target !== undefined) return target;
  const i = dag.nodes.findIndex((n) => n.node === node.node);
  return i >= 0 && i + 1 < dag.nodes.length ? dag.nodes[i + 1].node : null;
}

/** 推进一步。roll 自动掷并立即前进；choose / allocate 必须给对应 input。 */
export function resolveStep(
  dag: OpeningBranchDag,
  session: OpeningSessionCore,
  input: ResolveInput,
): StepOutcome {
  const node = currentNode(dag, session);
  if (!node) throw new Error("opening_session_done");
  if (node.mode === "roll" && input.kind !== "roll") throw new Error("opening_step_expects_roll");
  if (node.mode === "choose" && input.kind !== "choose") throw new Error("opening_step_expects_choose");
  if (node.mode === "allocate" && input.kind !== "allocate") throw new Error("opening_step_expects_allocate");

  let option: OpeningBranchOption | undefined;
  let result: OpeningStepResult;
  if (node.mode === "roll") {
    const options = node.options ?? [];
    if (options.length === 0) throw new Error(`opening_roll_no_options: ${node.node}`);
    // 按 node 派生 ⇒ 同 seed + 同 node 重算同结果；不消耗主流。
    const random = createRng(deriveOpeningSeed(session.seed, dag.openingId, node.node));
    // ADR-001 D7：权重按本会话已落定参数调制；缺值/类型不符的偏置计 0（不抛错）。
    const weights = optionWeights(dag, session, node);
    option =
      pickWeighted(
        options.map((o, i) => ({ option: o, weight: weights[i] })),
        (item) => item.weight,
        random,
      )?.option ?? options[0];
    result = { nodeId: node.node, optionId: option.id, rollIndex: options.indexOf(option) };
  } else if (node.mode === "choose" && input.kind === "choose") {
    option = (node.options ?? []).find((o) => o.id === input.optionId);
    if (!option) throw new Error(`opening_option_not_found: ${input.optionId}`);
    result = { nodeId: node.node, optionId: option.id };
  } else if (node.mode === "allocate" && input.kind === "allocate") {
    // ADR-004 D2/D4：预算由模板声明（字面或参数），分配逐条校验后再记入 results。
    const pid = node.param;
    const decl = pid ? dag.params.find((p) => p.id === pid) : undefined;
    if (!decl || decl.kind !== "points") throw new Error(`opening_allocate_no_spec: ${node.node}`);
    const budget = resolveAllocationBudget(dag, session, decl);
    // 与游戏内加点**同一个校验器**（2026-11-20）：两处各写一份，反馈迟早分叉。
    const checked = normalizeAllocation(input.allocation, { budget, targets: decl.targets ?? [] });
    if (!checked.ok) throw new Error(`opening_allocation_${checked.code}: ${checked.detail}`);
    // 形状 = paramId -> attribute -> value（与 shared 契约一致）。
    result = { nodeId: node.node, allocation: { [pid ?? ""]: checked.points } };
  } else {
    throw new Error("opening_step_invalid_input");
  }

  const next = nextNodeId(dag, node, option);
  if (next !== null && !dag.nodes.some((n) => n.node === next)) throw new Error(`opening_goto_not_found: ${next}`);
  const nextSession: OpeningSessionCore = {
    ...session,
    nodeId: next ?? session.nodeId,
    results: [...session.results, result],
    done: next === null,
  };
  return {
    session: nextSession,
    ...(option !== undefined
      ? { resolved: { nodeId: node.node, optionId: option.id, text: option.text, set: option.set } }
      : {}),
  };
}

/** 把 results 顺序折叠成参数表（后者覆盖前者，纯赋值/增量，无副作用链）。 */
export function resolveParamMap(dag: OpeningBranchDag, session: OpeningSessionCore): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const r of session.results) {
    if (r.allocation !== undefined) {
      // allocation 已按 paramId 分桶：{ paramId: { attribute: value } }
      Object.assign(map, r.allocation);
      continue;
    }
    const node = dag.nodes.find((n) => n.node === r.nodeId);
    const option = node?.options?.find((o) => o.id === r.optionId);
    if (option) Object.assign(map, option.set);
  }
  return map;
}

function currentParamForNode(dag: OpeningBranchDag, nodeId: string): string | undefined {
  return dag.nodes.find((n) => n.node === nodeId)?.param;
}

/** 自检：会话未完成不得 commit。 */
export function assertSessionDone(session: OpeningSessionCore): void {
  if (!session.done) throw new Error("opening_session_not_done");
}

/**
 * commit：一次建世界 + 按闭集落点写参数。
 *
 * `self` 为复用时，name / gender / age / attribute(set) 这些**基本属性整组被忽略**
 * （createWorldV2 已从角色模板取基线）；skill / item / relation / flag / points / attribute(add)
 * 这些**附加属性照常叠加**。
 */
export function commitOpening(
  dag: OpeningBranchDag,
  session: OpeningSessionCore,
  template: WorldTemplateV2,
  worldId: string,
): WorldStateV2 {
  assertSessionDone(session);
  const params = resolveParamMap(dag, session);
  // 模板侧 param id 是别名，不是世界字段：必须经声明表的 kind 决定引擎落点。
  const byKind = paramsByKind(dag, params);
  const selfValue = byKind.get("self")?.at(-1)?.value;
  const selfSelection = selfSelectionFromValue(selfValue);
  const reuse = selfSelection.kind === "reuse";
  const name = stringValue(byKind.get("name"));
  const state = createWorldV2(
    { templateId: template.meta.id, playerName: name, self: selfSelection },
    template,
    worldId,
  );
  // 基本属性（非复用路径）：createWorldV2 用 playerTemplate 建基线，这里覆盖开局参数。
  if (!reuse) {
    if (name !== undefined) state.player.name = name;
    const gender = stringValue(byKind.get("gender"));
    if (gender !== undefined) state.player.gender = gender;
    const age = numberValue(byKind.get("age"));
    if (age !== undefined) {
      state.player.age = age;
      state.playerAgeAtStart = age;
    }
    for (const { value } of byKind.get("attribute") ?? []) {
      const a = asRecord(value);
      if (a?.mode !== "set" || typeof a.id !== "string") continue;
      // ADR-003：set 既可写数值也可写 enum 选项 id；类型校验由 assignAttributeValue 统一负责。
      if (typeof a.value === "number" || typeof a.value === "string") {
        assignAttributeValue(state, template, a.id, a.value);
      }
    }
  }
  // 时间锚：替代旧 13 步里的 advanceTo，由模板声明、引擎闭集换算（不重放 effect DSL）。
  const timeAdapter = createTimeAdapter(template);
  for (const { value } of byKind.get("time") ?? []) {
    const t = asRecord(value);
    if (t === undefined || typeof t.value !== "number" || typeof t.unit !== "string") continue;
    const amount: TimeAmount = { value: t.value, unit: t.unit as TimeUnit };
    state.worldTime = timeAdapter.toMinutes(amount, state.worldTime);
  }
  // 附加属性：两种 self 形态都叠加。
  applyAdditiveParams(state, template, byKind);
  // 开局记录落可选 state 切片（results 只记结果，不落任何中间世界）。
  state.opening = { openingId: dag.openingId, results: session.results };
  // 前实例化开局本身就是交接：commit 之后不存在「还在开局」的世界，
  // 等价于旧管线的 handoff()。漏了这一行，进世界后第一次行动会被 NOT_ACTIVE 拒
  // （表现得像「刷新后未开局」）。
  state.openingCompleted = true;
  return state;
}


/**
 * 开局所得（ADR-002 D4 的开局版本）。
 *
 * 与世界的「回合增量」不同：开局没有「前一个状态」，玩家要看的不是差分而是
 * **这一生开局拿到了什么**——技能 / 物品 / 状态 / 初始属性。
 *
 * 同一函数服务两处：`/step`（每步预览，界面上的「已经落定」）与 `/commit`（最终面板）。
 * 只有一份实现，预览与结果不会对不上。
 *
 * 属性：`mode: set` 记为 `action: "set"`（展示成「力量 126」，中性色），
 * `mode: add` 记为 up/down（展示成「幸运 +2」，绿/红）。
 */
export function collectOpeningGains(
  dag: OpeningBranchDag,
  session: OpeningSessionCore,
  template: WorldTemplateV2,
  ui?: UiConfig,
): TurnGain[] {
  const params = resolveParamMap(dag, session);
  const byKind = paramsByKind(dag, params);
  const lookup = createLookup(template);
  const out: TurnGain[] = [];

  for (const { value } of byKind.get("attribute") ?? []) {
    const a = asRecord(value);
    if (typeof a?.id !== "string") continue;
    if (typeof a.value === "number") {
      const mode = a.mode === "set" ? "set" : a.value >= 0 ? "up" : "down";
      out.push({
        category: "attribute",
        action: mode,
        id: a.id,
        name: lookup.attributeLabel(a.id),
        amount: a.value,
      });
      continue;
    }
    // ADR-003：enum 属性的开局赋值（如身份类的文本属性）。展示选项 label + 选项样式。
    if (typeof a.value === "string") {
      const def = template.attributes.defs?.[a.id];
      const option = def?.kind === "enum" ? def.values.find((v) => v.id === a.value) : undefined;
      const style = resolveStyle(option?.style, undefined, ui);
      out.push({
        category: "attribute",
        action: "set",
        id: a.id,
        name: lookup.attributeLabel(a.id),
        value: option?.label ?? String(a.value),
        ...(style !== undefined ? { style } : {}),
      });
    }
  }

  // ADR-004 D7：加点结果也进「开局所得」——否则玩家提交后再也看不见自己点在哪。
  // 0 不产条目（没点就是没点，与属性 diff 的口径一致）。
  for (const { value } of byKind.get("points") ?? []) {
    const allocation = asRecord(value);
    if (allocation === undefined) continue;
    for (const [attribute, amount] of Object.entries(allocation)) {
      if (typeof amount !== "number" || amount === 0) continue;
      const target = dag.params
        .filter((p) => p.kind === "points")
        .flatMap((p) => p.targets ?? [])
        .find((t) => t.attribute === attribute);
      const style = target?.style !== undefined ? resolveStyle(target.style, undefined, ui) : undefined;
      out.push({
        category: "attribute",
        action: amount > 0 ? "up" : "down",
        id: attribute,
        name: target?.label ?? lookup.attributeLabel(attribute),
        amount,
        ...(style !== undefined ? { style } : {}),
      });
    }
  }

  for (const { value } of byKind.get("status") ?? []) {
    for (const spec of Array.isArray(value) ? value : [value]) {
      const id = typeof spec === "string" ? spec : asRecord(spec)?.id;
      if (typeof id !== "string") continue;
      const stacks = typeof asRecord(spec)?.stacks === "number" ? (asRecord(spec)?.stacks as number) : 1;
      const def = lookup.status(id);
      const style = resolveEntityStyle(def, ui);
      const tags = resolveEntityTags(def, ui);
      out.push({
        category: "status",
        action: "gain",
        id,
        name: def?.name ?? id,
        stacks,
        ...(def?.quality !== undefined ? { quality: def.quality } : {}),
        ...(style !== undefined ? { style } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(def?.description !== undefined ? { description: def.description } : {}),
        ...(def !== undefined
          ? {
              effects: statusEffectSummaries(def, lookup, ui),
              /**
               * 开局挂上的特质默认永久（ADR-009 D5）；参数显式给了时长才照实说。
               *
               * 天赋**整行都不给**（ADR-018 D1）：它没有时钟，开局罗盘上写「持续：直到
               * 被移除」等于给一个不存在的问题配了个答案 —— 同理个人页与详情页。
               */
              ...(def.kind === "talent"
                ? {}
                : {
                    durationLabel: (() => {
                      const parsed = SimulationDurationSchema.safeParse(asRecord(spec)?.duration);
                      return parsed.success ? durationLabel(parsed.data) : "直到被移除";
                    })(),
                  }),
            }
          : {}),
      });
    }
  }

  for (const { value } of byKind.get("skill") ?? []) {
    for (const id of Array.isArray(value) ? value : [value]) {
      if (typeof id !== "string") continue;
      const def = lookup.skill(id);
      const style = resolveStyle(def?.style, def?.quality, ui, undefined, tagIdsOf(def));
      out.push({
        category: "skill",
        action: "gain",
        id,
        name: def?.name ?? id,
        ...(def?.quality !== undefined ? { quality: def.quality } : {}),
        ...(style !== undefined ? { style } : {}),
        ...(def?.description !== undefined ? { description: def.description } : {}),
        ...(def !== undefined ? { effects: skillEffectSummaries(def, lookup, ui) } : {}),
      });
    }
  }

  for (const { value } of byKind.get("item") ?? []) {
    const it = asRecord(value);
    if (typeof it?.itemId !== "string") continue;
    const count = typeof it.count === "number" ? it.count : 1;
    const def = lookup.item(it.itemId);
    const style = resolveEntityStyle(def, ui);
    const tags = resolveEntityTags(def, ui);
    out.push({
      category: "item",
      action: "gain",
      id: it.itemId,
      name: def?.name ?? it.itemId,
      amount: count,
      ...(def?.quality !== undefined ? { quality: def.quality } : {}),
      ...(style !== undefined ? { style } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(def?.description !== undefined ? { description: def.description } : {}),
      ...(def !== undefined
        ? { effects: def.type === "equipment" ? equipmentEffectSummaries(def, lookup) : itemEffectSummaries(def, lookup, ui) }
        : {}),
    });
  }

  return out;
}

type ParamEntries = Array<{ id: string; value: unknown }>;
type ParamsByKind = Map<string, ParamEntries>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function stringValue(entries: ParamEntries | undefined): string | undefined {
  const value = entries?.at(-1)?.value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function numberValue(entries: ParamEntries | undefined): number | undefined {
  const value = entries?.at(-1)?.value;
  return typeof value === "number" ? value : undefined;
}
function paramsByKind(dag: OpeningBranchDag, params: Record<string, unknown>): ParamsByKind {
  const kindOf = new Map(dag.params.map((p) => [p.id, p.kind]));
  const out: ParamsByKind = new Map();
  for (const [id, value] of Object.entries(params)) {
    const kind = kindOf.get(id);
    if (kind === undefined) continue; // 未声明的 param 不属于闭集，加载期已拒，这里保守丢弃。
    const list = out.get(kind) ?? [];
    list.push({ id, value });
    out.set(kind, list);
  }
  return out;
}

/** 由 self 参数值解析选择（R-OP-04：有复用角色 ⇒ 基本属性整组取角色）。 */
export function selfSelectionFromValue(value: unknown): SelfSelectionV2 {
  const obj = asRecord(value);
  if (obj?.kind === "reuse" && typeof obj.characterId === "string") {
    return { kind: "reuse", characterId: obj.characterId };
  }
  if (obj?.kind === "new" && typeof obj.id === "string") {
    return {
      kind: "new",
      id: obj.id,
      name: typeof obj.name === "string" && obj.name.length > 0 ? obj.name : "无名氏",
      gender: typeof obj.gender === "string" ? obj.gender : "",
      age: typeof obj.age === "number" ? obj.age : 16,
      attributes: (asRecord(obj.attributes) ?? {}) as Record<string, number | string>,
      skills: Array.isArray(obj.skills) ? (obj.skills as string[]) : [],
    };
  }
  return { kind: "default" };
}

/** 兼容旧调用方（传整个 params map 的场景）。 */
export function selfSelectionFromParams(params: Record<string, unknown>): SelfSelectionV2 {
  return selfSelectionFromValue(params.self);
}

function applyAdditiveParams(
  state: WorldStateV2,
  template: WorldTemplateV2,
  byKind: ParamsByKind,
): void {
  // 附加属性不区分 self 形态：复用 / 新建都照常叠加（add 只对数值属性有意义）。
  for (const { value } of byKind.get("attribute") ?? []) {
    const a = asRecord(value);
    if (a === undefined) continue;
    if ((a.mode === "add" || a.mode === undefined) && typeof a.id === "string" && typeof a.value === "number") {
      state.player.attributes[a.id] = numericAttr(state.player.attributes[a.id]) + a.value;
    }
  }
  // 特质（status）在 commit 时统一获得，turnIndex=0；形态支持 id / id[] / {id,stacks}。
  // 走既有 applyStatusToPlayer，沿用模板的 duration / stacking 定义，不重放 effect DSL。
  const lookup = createLookup(template);
  for (const { value } of byKind.get("status") ?? []) {
    for (const spec of Array.isArray(value) ? value : [value]) {
      if (typeof spec === "string") {
        applyStatusToPlayer(state, spec, 1, lookup);
        continue;
      }
      const s = asRecord(spec);
      if (typeof s?.id !== "string") continue;
      // 开局参数里的 `duration` 走模拟域词表（ADR-009）：`{value,unit}` 或 `{untilCured}`。
      // 不写 = 永久——开局挂上的特质是身份，不是「一次施加」。
      const parsed = s.duration === undefined ? undefined : SimulationDurationSchema.safeParse(s.duration);
      const duration = parsed?.success ? parsed.data : undefined;
      applyStatusToPlayer(
        state,
        s.id,
        typeof s.stacks === "number" ? Math.max(1, s.stacks) : 1,
        lookup,
        duration,
      );
    }
  }
  for (const { value } of byKind.get("skill") ?? []) {
    const ids = Array.isArray(value) ? value : [value];
    for (const id of ids) {
      if (typeof id === "string" && !state.player.skills.includes(id)) state.player.skills.push(id);
    }
  }
  for (const { value } of byKind.get("item") ?? []) {
    const it = asRecord(value);
    if (typeof it?.itemId === "string") {
      state.player.inventory[it.itemId] =
        (state.player.inventory[it.itemId] ?? 0) + (typeof it.count === "number" ? it.count : 1);
    }
  }
  for (const { value } of byKind.get("relation") ?? []) {
    const r = asRecord(value);
    if (typeof r?.with !== "string" || typeof r.value !== "number") continue;
    /**
     * 复用原作人物时，模板里写死的「和某个角色有关系」可能正好指向**你扮演的那个人**
     * （某条路线的同行者就会写 `with: <角色 id>`）。自环关系在 schema 层非法
     * （「关系边不允许自环」），写进去就是一份**载不回来的存档**——直接跳过这条：
     * 「某人和自己是同事」本来也没有语义。
     */
    if (r.with === state.player.id) continue;
    const target = state.npcs.find((n) => n.id === r.with);
    if (target) {
      target.relationship = Math.max(-100, Math.min(100, target.relationship + r.value));
    }
    if (typeof r.kind === "string") {
      // kind 是闭集枚举：加载期已校验，这里再兜一层——放行非法值会写坏 state.relations，
      // 存档下次启动直接载不回来（比 500 更糟）。
      const parsedKind = RelationKindSchema.safeParse(r.kind);
      if (!parsedKind.success) {
        throw new Error(`开局 relation kind 不在闭集内：${r.kind}（目标 ${r.with}）`);
      }
      const kind = parsedKind.data;
      const edge = state.relations.find((e) => e.from === state.player.id && e.to === r.with && e.kind === kind);
      if (edge) edge.value = Math.max(-100, Math.min(100, (edge.value ?? 0) + r.value));
      else {
        state.relations.push({
          from: state.player.id,
          to: r.with,
          kind,
          source: "effect",
          scope: "public", // 模板显式声明的开局关系：作者写了就是要大家都知道。
          value: Math.max(-100, Math.min(100, r.value)),
        });
      }
    }
  }
  for (const { value } of byKind.get("flag") ?? []) {
    const f = asRecord(value);
    if (typeof f?.id === "string") state.flags[f.id] = f.value as boolean | number | string;
  }
  for (const { value } of byKind.get("points") ?? []) {
    const p = asRecord(value);
    if (!p) continue;
    for (const [attrId, v] of Object.entries(p)) {
      if (typeof v === "number") state.player.attributes[attrId] = numericAttr(state.player.attributes[attrId]) + v;
    }
  }
  for (const { value } of byKind.get("extensions") ?? []) {
    const e = asRecord(value);
    if (e) state.extensions = { ...(state.extensions ?? {}), ...e };
  }
  // 资源上限随属性变化重新夹取。
  state.player.hp = Math.max(1, Math.min(state.player.hp, maxHp(state.player, template)));
  state.player.mp = Math.max(0, Math.min(state.player.mp, maxMp(state.player, template)));
}
