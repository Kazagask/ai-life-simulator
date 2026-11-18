/**
 * 前实例化开局会话内核（ADR-001 / R-OP-01..07）。
 *
 * 设计纪律：
 * - 这里**没有 WorldStateV2、没有 NPC 实例、没有 delayQueue**——会话只在 `results` 里记
 *   「每一步抽到/选到什么」，commit 时才一次建世界。所以不需要 NPC 生成补丁 / 事件冻结补丁。
 * - 不重放 effect DSL：每一步的 `set` 是**参数赋值**，commit 时按引擎闭集落点直接写状态。
 * - roll 的随机源按节点派生（`deriveOpeningSeed`），不消耗世界 RNG 主流；同 node 重算同结果。
 * - v1 不支持 `weightBy`（D-4 裁决）：加载期已拒载，这里也防御性忽略。
 */
import type {
  OpeningBranchDag,
  OpeningBranchNode,
  OpeningBranchOption,
  OpeningStepResult,
  WorldTemplateV2,
} from "@life-sim/shared";
import { RelationKindSchema } from "@life-sim/shared";
import { createRng, deriveOpeningSeed, pickWeighted } from "../rng.js";
import type { TurnGain, UiConfig } from "@life-sim/shared";
import { resolveStyle } from "./presentation/style.js";
import {
  durationLabel,
  equipmentEffectSummaries,
  itemEffectSummaries,
  skillEffectSummaries,
  statusEffectSummaries,
} from "./presentation/effects.js";
import { applyStatusToPlayer, maxHp, maxMp } from "./engine.js";
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

export interface OpeningNodeView {
  nodeId: string;
  title: string;
  text?: string;
  mode: OpeningBranchNode["mode"];
  /** choose 节点：等玩家点选；roll 节点：已由服务端决定，前端只演动画。 */
  options: Array<{ id: string; text: string; weight?: number }>;
  /** allocate 节点：点数规格（param id + budget + targets）。 */
  allocation?: { param: string; budget: number; targets: Array<{ attribute: string; min?: number; max?: number }> };
}

/** 呈现给前端的节点描述。roll 节点在这里**不掷**——掷发生在 resolveStep。 */
export function describeNode(dag: OpeningBranchDag, session: OpeningSessionCore): OpeningNodeView | null {
  const node = currentNode(dag, session);
  if (!node) return null;
  const options = (node.options ?? []).map((o) => ({ id: o.id, text: o.text, weight: o.weight }));
  let allocation: OpeningNodeView["allocation"];
  if (node.mode === "allocate") {
    const pid = node.param;
    const decl = pid ? dag.params.find((p) => p.id === pid) : undefined;
    allocation = {
      param: pid ?? "",
      budget: decl?.budget ?? 0,
      targets: (decl?.targets ?? []).map((t) => ({ attribute: t.attribute, min: t.min, max: t.max })),
    };
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
    option = pickWeighted(options, (o) => o.weight ?? 1, random) ?? options[0];
    result = { nodeId: node.node, optionId: option.id, rollIndex: options.indexOf(option) };
  } else if (node.mode === "choose" && input.kind === "choose") {
    option = (node.options ?? []).find((o) => o.id === input.optionId);
    if (!option) throw new Error(`opening_option_not_found: ${input.optionId}`);
    result = { nodeId: node.node, optionId: option.id };
  } else if (node.mode === "allocate" && input.kind === "allocate") {
    // allocate：校验分配总额 = budget，且各属性在 [min,max]。
    const pid = node.param;
    const decl = pid ? dag.params.find((p) => p.id === pid) : undefined;
    if (!decl || decl.budget === undefined) throw new Error(`opening_allocate_no_spec: ${node.node}`);
    const allocation: Record<string, number> = input.allocation;
    const values = Object.values(allocation);
    if (values.reduce((sum, v) => sum + v, 0) !== decl.budget) throw new Error("opening_allocation_budget_mismatch");
    for (const target of decl.targets ?? []) {
      const v = allocation[target.attribute] ?? 0;
      if (target.min !== undefined && v < target.min) throw new Error("opening_allocation_below_min");
      if (target.max !== undefined && v > target.max) throw new Error("opening_allocation_above_max");
    }
    // 形状 = paramId -> attribute -> value（与 shared 契约一致）。
    result = { nodeId: node.node, allocation: { [pid ?? ""]: { ...allocation } } };
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
      if (a?.mode === "set" && typeof a.id === "string" && typeof a.value === "number") {
        state.player.attributes[a.id] = a.value;
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
 * **这一生开局拿到了什么**——技能 / 物品 / 补正 / 初始属性。
 *
 * 同一函数服务两处：`/step`（每步预览，界面上的「已经落定」）与 `/commit`（最终面板）。
 * 只有一份实现，预览与结果不会对不上。
 *
 * 属性：`mode: set` 记为 `action: "set"`（展示成「咒力 126」，中性色），
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
    if (typeof a?.id !== "string" || typeof a.value !== "number") continue;
    const mode = a.mode === "set" ? "set" : a.value >= 0 ? "up" : "down";
    out.push({
      category: "attribute",
      action: mode,
      id: a.id,
      name: lookup.attributeLabel(a.id),
      amount: a.value,
    });
  }

  for (const { value } of byKind.get("status") ?? []) {
    for (const spec of Array.isArray(value) ? value : [value]) {
      const id = typeof spec === "string" ? spec : asRecord(spec)?.id;
      if (typeof id !== "string") continue;
      const stacks = typeof asRecord(spec)?.stacks === "number" ? (asRecord(spec)?.stacks as number) : 1;
      const def = lookup.status(id);
      const style = resolveStyle(def?.style, def?.quality, ui);
      out.push({
        category: "status",
        action: "gain",
        id,
        name: def?.name ?? id,
        stacks,
        ...(def?.quality !== undefined ? { quality: def.quality } : {}),
        ...(style !== undefined ? { style } : {}),
        ...(def?.description !== undefined ? { description: def.description } : {}),
        ...(def !== undefined ? { effects: statusEffectSummaries(def, lookup), durationLabel: durationLabel(def) } : {}),
      });
    }
  }

  for (const { value } of byKind.get("skill") ?? []) {
    for (const id of Array.isArray(value) ? value : [value]) {
      if (typeof id !== "string") continue;
      const def = lookup.skill(id);
      const style = resolveStyle(def?.style, def?.quality, ui);
      out.push({
        category: "skill",
        action: "gain",
        id,
        name: def?.name ?? id,
        ...(def?.quality !== undefined ? { quality: def.quality } : {}),
        ...(style !== undefined ? { style } : {}),
        ...(def?.description !== undefined ? { description: def.description } : {}),
        ...(def !== undefined ? { effects: skillEffectSummaries(def, lookup) } : {}),
      });
    }
  }

  for (const { value } of byKind.get("item") ?? []) {
    const it = asRecord(value);
    if (typeof it?.itemId !== "string") continue;
    const count = typeof it.count === "number" ? it.count : 1;
    const def = lookup.item(it.itemId);
    const style = resolveStyle(def?.style, def?.quality, ui);
    out.push({
      category: "item",
      action: "gain",
      id: it.itemId,
      name: def?.name ?? it.itemId,
      amount: count,
      ...(def?.quality !== undefined ? { quality: def.quality } : {}),
      ...(style !== undefined ? { style } : {}),
      ...(def?.description !== undefined ? { description: def.description } : {}),
      ...(def !== undefined
        ? { effects: def.type === "equipment" ? equipmentEffectSummaries(def, lookup) : itemEffectSummaries(def, lookup) }
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
      attributes: (asRecord(obj.attributes) ?? {}) as Record<string, number>,
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
  // 附加属性不区分 self 形态：复用 / 新建都照常叠加。
  for (const { value } of byKind.get("attribute") ?? []) {
    const a = asRecord(value);
    if (a === undefined) continue;
    if ((a.mode === "add" || a.mode === undefined) && typeof a.id === "string" && typeof a.value === "number") {
      state.player.attributes[a.id] = (state.player.attributes[a.id] ?? 0) + a.value;
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
      applyStatusToPlayer(state, s.id, typeof s.stacks === "number" ? Math.max(1, s.stacks) : 1, lookup);
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
          visibility: "known", // 模板显式声明的开局关系，作者意图即玩家已知。
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
      if (typeof v === "number") state.player.attributes[attrId] = (state.player.attributes[attrId] ?? 0) + v;
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
