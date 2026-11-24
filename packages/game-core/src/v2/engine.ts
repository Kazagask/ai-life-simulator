import type {
  AttributeValue,
  AnyMatch,
  BattleResult,
  Condition,
  Effect,
  EquipmentInstance,
  Formula,
  OpenCondition,
  RelationScope,
  RelationVisibility,
  SimulationDuration,
  StatusInstance,
  TaskCondition,
  V2Npc,
  V2Player,
  WorldStateV2,
  WorldTemplateV2,
} from "@life-sim/shared";
import { createRng, pickWeighted, type Rng } from "../rng.js";
import { amountToMinutes, birthTimeFromAge, createTimeAdapter } from "./time.js";
import { evaluateDynamicModifier, type ModifierConditionGate } from "./equipment.js";
import type { TemplateLookup } from "./lookup.js";
// 调度器与效果执行器互为依赖（scheduler 读 checkAllConditions、engine 写入队），
// 但双方只在函数体内互相调用、无顶层求值，ESM 函数声明提升可保证初始化期安全。
import { enqueueCandidate, hasFired } from "./scheduler.js";
import { applyLadderGain, evaluateAttributeCondition, ladderResetFromAbsolute } from "./attribute-rules.js";
import { adjustResourceValue, computeMax } from "./resources.js";
import { EffectSchema, PLAYER_ID, isAttributeModifier, numericAttr } from "@life-sim/shared";
import { addEdge, freezeOnDeath, normalizeRelationEndpoint } from "./relations.js";
import { isAliveActor, selfIdOf, transplantActor, writableActorOf, type TransferableActor } from "./actors.js";
import { settledTierCount, statusFor, talentProgressOf } from "./talent.js";
import { anyMatchMet } from "./any-match.js";
import { resolveExtensionEffect, collectExtensionConditions } from "./extensions.js";
import {
  createConditionRegistry,
  type ConditionEvalContext,
  type ConditionRegistry,
} from "./condition-evaluator.js";

// ---------- 资源公式（规格 4.4：上限 = base + perLevel × growthLevel + Σ perAttribute[attr] × 基础属性值） ----------

/**
 * 资源上限统一计算（实现已迁至 `resources.ts`，那里同时服务自定义资源）。
 * 这里 re-export 保持既有调用点（战斗 / 测试）不变。
 */
export { computeMax } from "./resources.js";

/**
 * HP / MP 上限（ADR-074）：公式读的是**有效属性**，不是基础值。
 *
 * 为什么这一条必须改：属性转化把「某种资源属性」换走之后，mp 上限必须跟着变成 0；
 * 派生属性（总量）也一样 —— 只读基础值的实现会让「最终总量 = 0」的人在面板上
 * 仍然有 60 点 mp，那就等于换算没有发生。
 *
 * 第三参缺省 = 基础属性（旧调用点零迁移）；战斗/投影/开局这些有状态的调用点
 * 必须显式传 effective。
 */
export function maxHp(
  player: V2Player,
  template: WorldTemplateV2,
  attrs: Record<string, AttributeValue | number> = player.attributes,
): number {
  return computeMax(template.resources.hp, player.growthLevel, attrs as Record<string, AttributeValue>, 1);
}

export function maxMp(
  player: V2Player,
  template: WorldTemplateV2,
  attrs: Record<string, AttributeValue | number> = player.attributes,
): number {
  return computeMax(template.resources.mp, player.growthLevel, attrs as Record<string, AttributeValue>, 0);
}

// ---------- 心情档位 ----------

export function moodBand(mood: number, template: WorldTemplateV2) {
  return template.mood.bands.find((b) => mood >= b.min && mood <= b.max) ?? template.mood.bands[0];
}

// ---------- 有效属性：基础值 + 状态 simulation 面 + 装备动态状态 + 心情档位修正，再套 caps ----------

/** 属性求值链中条件求值用的确定性空 RNG（装备动态状态条件已在加载期禁用 random）。 */
export const zeroRng: Rng = () => 0;

/**
 * 有效属性求值链（协议 §19，顺序固定）：
 * 基础值 → 状态 × 层数 → 装备动态状态 → 心情档位 → caps。
 *
 * 第 5/6 参可选（保持既有 4 参调用兼容）：
 * - equipment：本局装备实例；每件装备的 dynamicModifier 按当前累加状态现算（R-EQ-04）。
 * - condGate：装备条件求值入口；由调用方注入（内部须用「不含装备」的基础有效属性
 *   求值 attribute 条件，避免递归）。未提供时带条件的词条当次不生效。
 */
/**
 * 派生属性（ADR-074）：`value = base + Σ perPoint × 依赖的最终值`。
 *
 * 顺序由 `derivedOrderOf` 给出拓扑序；模板加载期已拒掉循环依赖，
 * 这里对未校验的夹具（测试用 `as unknown` 铸造的模板）做一次兜底：
 * 遇到回边就跳过，宁可算错一个数，也不在上限计算里递归到栈溢出。
 */
const derivedOrderCache = new WeakMap<WorldTemplateV2, string[]>();

function derivedSpecsOf(template: WorldTemplateV2): Map<string, { base?: number; from: { attribute: string; perPoint: number }[]; min?: number; max?: number }> {
  const out = new Map<string, { base?: number; from: { attribute: string; perPoint: number }[]; min?: number; max?: number }>();
  for (const [key, def] of Object.entries(template.attributes.defs ?? {})) {
    if (def.kind === "number" && def.derived !== undefined) out.set(key, def.derived);
  }
  return out;
}

/** 派生属性的计算顺序（依赖在前）。只含派生属性自己。 */
export function derivedOrderOf(template: WorldTemplateV2): string[] {
  const cached = derivedOrderCache.get(template);
  if (cached !== undefined) return cached;
  const specs = derivedSpecsOf(template);
  const order: string[] = [];
  const mark = new Map<string, 1 | 2>();
  const visit = (key: string): void => {
    const state = mark.get(key);
    if (state !== undefined) return; // 2 = 已完成；1 = 回边（加载期应已拒载）
    mark.set(key, 1);
    for (const dep of specs.get(key)?.from ?? []) {
      if (specs.has(dep.attribute)) visit(dep.attribute);
    }
    mark.set(key, 2);
    order.push(key);
  };
  for (const key of specs.keys()) visit(key);
  derivedOrderCache.set(template, order);
  return order;
}

const roleCache = new WeakMap<WorldTemplateV2, Map<string, string>>();

/**
 * 按**角色**取属性 id（ADR-074）：引擎只认 `role`，不认属性叫什么名字。
 *
 * 世界把暴击率叫 `critRate`、`暴击`、`会心` 都行；没声明角色 ⇒ 这条通道不存在，
 * 引擎退回「世界/技能/状态」的暴击词条，不会去猜某个 id。
 */
export function attributeIdOfRole(template: WorldTemplateV2, role: string): string | undefined {
  let map = roleCache.get(template);
  if (map === undefined) {
    map = new Map<string, string>();
    for (const [id, def] of Object.entries(template.attributes.defs ?? {})) {
      if (def.kind === "number" && def.role !== undefined) map.set(def.role, id);
    }
    roleCache.set(template, map);
  }
  return map.get(role);
}

/** 派生属性 id 集合（投影层据此把「现值」盖到面板上）。 */
export function derivedAttributeKeys(template: WorldTemplateV2): Set<string> {
  return new Set(derivedSpecsOf(template).keys());
}

/**
 * 纯派生计算（给 NPC 面板用）：只吃一份属性表，不读状态/装备。
 *
 * 与 `effectiveAttributes` 用同一个 `derivedOrderOf`，所以「面板上看到的」
 * 与「战斗里算的」是同一套依赖顺序，不会两边各算一份。
 */
export function derivedAttributeValues(
  attrs: Record<string, AttributeValue>,
  template: WorldTemplateV2,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(attrs)) if (typeof value === "number") out[key] = value;
  const specs = derivedSpecsOf(template);
  for (const key of derivedOrderOf(template)) {
    const spec = specs.get(key)!;
    let value = spec.base ?? 0;
    for (const dep of spec.from) value += dep.perPoint * (out[dep.attribute] ?? 0);
    if (spec.min !== undefined) value = Math.max(spec.min, value);
    if (spec.max !== undefined) value = Math.min(spec.max, value);
    out[key] = value;
  }
  return out;
}

export function effectiveAttributes(
  attrs: Record<string, AttributeValue>,
  statuses: StatusInstance[],
  mood: number,
  lookup: TemplateLookup,
  equipment?: EquipmentInstance[],
  condGate?: ModifierConditionGate,
): Record<string, number> {
  const template = lookup.template;
  const specs = derivedSpecsOf(template);
  /** 有符号属性（`signed: true`）：负值合法，不参与「属性不为负」的兜底。 */
  const signed = new Set<string>();
  for (const [id, def] of Object.entries(template.attributes.defs ?? {})) {
    if (def.kind === "number" && def.signed === true) signed.add(id);
  }
  /**
   * ADR-003：文本属性不参与数值运算 —— 先把数值键拷出来，之后所有状态只落在它们上面。
   * 加载期已保证 `attributeModifiers` 不会指向文本属性；这里只是最后一道防线。
   * 派生属性的存档值**不参与**：它的值只能由公式与补正决定（ADR-074）。
   */
  const eff: Record<string, number> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "number" && !specs.has(key)) eff[key] = value;
  }
  /** 落在派生属性上的补正先存起来，等公式算完再加（否则会被公式覆盖）。 */
  const derivedMods: Record<string, number> = {};
  const addModifier = (key: string, delta: number): void => {
    if (specs.has(key)) derivedMods[key] = (derivedMods[key] ?? 0) + delta;
    else eff[key] = (eff[key] ?? 0) + delta;
  };
  for (const inst of statuses) {
    /**
     * ADR-018 D2：属性状态在**定义层**，不再住在 `simulation` 面里。
     *
     * 它本来就是模拟与战斗共用的（这条函数同时服务自由行动与 `buildUnit`），
     * 挂在 simulation 面里只让「战斗态不能改属性」和「面板与结算不一致」同时成立。
     */
    const modifiers = statusFor(lookup.status(inst.statusId), inst)?.attributeModifiers;
    if (!modifiers) continue;
    for (const [key, delta] of Object.entries(modifiers)) addModifier(key, delta * inst.stacks);
  }
  if (equipment?.length) {
    for (const inst of equipment) {
      const item = lookup.item(inst.itemId);
      if (item?.type !== "equipment") continue;
      // 2026-11-20：一件装备可以有多条词条；战斗轴那一支不进属性链（战斗侧自己算）。
      for (const spec of item.dynamicModifiers ?? []) {
        if (!isAttributeModifier(spec)) continue;
        const deltas = evaluateDynamicModifier(spec, { effAttrs: eff, statuses, condCtx: condGate });
        for (const [key, delta] of Object.entries(deltas)) addModifier(key, delta);
      }
    }
  }
  for (const [key, delta] of Object.entries(moodBand(mood, template).attributeModifiers)) {
    addModifier(key, delta);
  }
  /**
   * 属性转化（ADR-074）：把源属性的**最终值**按比例搬到目标属性，源归零。
   * 必须在派生计算之前 —— 源属性被清空之后，由它派生的属性也必须一起归零，
   * 否则「没有这份资源的人」还会残留一条派生值。
   */
  for (const inst of statuses) {
    const conversions = lookup.status(inst.statusId)?.conversion;
    if (conversions === undefined) continue;
    for (const conv of conversions) {
      if (specs.has(conv.from)) continue; // 派生属性不能被转化（加载期已拒）
      const value = eff[conv.from] ?? 0;
      eff[conv.from] = 0;
      if (value === 0) continue;
      for (const [to, ratio] of Object.entries(conv.to)) {
        if (specs.has(to)) continue;
        eff[to] = (eff[to] ?? 0) + value * ratio;
      }
    }
  }
  for (const key of derivedOrderOf(template)) {
    const spec = specs.get(key)!;
    let value = spec.base ?? 0;
    for (const dep of spec.from) value += dep.perPoint * (eff[dep.attribute] ?? 0);
    value += derivedMods[key] ?? 0;
    if (spec.min !== undefined) value = Math.max(spec.min, value);
    if (spec.max !== undefined) value = Math.min(spec.max, value);
    eff[key] = value;
  }
  const caps = template.attributes.caps;
  if (caps) {
    for (const [key, cap] of Object.entries(caps)) {
      if (eff[key] !== undefined) eff[key] = Math.min(eff[key], cap);
    }
  }
  /**
   * 数值属性没有负值（ADR-011 D2）。
   *
   * 状态可以写 `-8`（「出生时被拿走全部资源」这类设定就是这么写的），但「有效属性 -8」
   * 会真的一路算进命中骰与伤害公式，读起来像加法写错了。属性是量，量到 0 为止 ——
   * 「没有」和「欠着」在规则上是同一件事。
   */
  for (const key of Object.keys(eff)) {
    const value = eff[key]!;
    if (value < 0 && !signed.has(key)) eff[key] = 0;
  }
  return eff;
}

/** 有效属性求值所需的最小信息（玩家 / NPC / 未实例化的敌人卡都满足）。 */
export interface EffectiveAttributeSource {
  attributes: Record<string, AttributeValue>;
  statuses: StatusInstance[];
  mood: number;
  equipment?: EquipmentInstance[];
}

/**
 * 按固定链路算一个**任意演员**的有效属性（ADR-010 D3）。
 *
 * 存在的理由：NPC 的状态与装备以前在战斗构建时被整个跳过（`buildUnits` 直接读模板
 * `attributes` × levelScale），于是「穿了装备的甲」和「裸装的甲」数值一样。
 * 玩家与 NPC 现在走同一函数，不给 NPC 写第二套。
 */
export function effectiveAttributesOfActor(
  state: WorldStateV2,
  lookup: TemplateLookup,
  src: EffectiveAttributeSource,
): Record<string, number> {
  const equipment = src.equipment ?? [];
  if (equipment.length === 0) {
    return effectiveAttributes(src.attributes, src.statuses, src.mood, lookup);
  }
  // attribute 条件的求值基准 = 不含装备的基础有效属性（避免条件→属性→装备→条件递归）
  const baseEff = effectiveAttributes(src.attributes, src.statuses, src.mood, lookup);
  const condGate: ModifierConditionGate = (cond) =>
    checkCondition(cond, { state, lookup, rng: zeroRng, effAttrsOverride: baseEff });
  return effectiveAttributes(src.attributes, src.statuses, src.mood, lookup, equipment, condGate);
}

export function playerEffectiveAttributes(state: WorldStateV2, lookup: TemplateLookup): Record<string, number> {
  return effectiveAttributesOfActor(state, lookup, state.player);
}

function clampAttr(template: WorldTemplateV2, key: string, value: number): number {
  const cap = template.attributes.caps?.[key];
  return cap !== undefined ? Math.min(value, cap) : value;
}

/**
 * 绝对赋值（ADR-003）：`setAttribute` 效果与开局 commit 共用。
 *
 * - enum：必须是已声明选项 id（否则抛 `unknown_attribute_value`）；
 * - composite：只读派生（抛 `attribute_readonly`）；
 * - number / ladder：按 caps 夹取；reset 阶梯从首档起逐档扣减并写 `attributeTiers`。
 */
export function assignAttributeValue(
  state: WorldStateV2,
  template: WorldTemplateV2,
  attribute: string,
  value: number | string,
): void {
  const def = template.attributes.defs?.[attribute];
  if (def?.kind === "enum") {
    if (typeof value !== "string" || !def.values.some((v) => v.id === value)) {
      throw new Error(`unknown_attribute_value: ${attribute}=${String(value)}`);
    }
    state.player.attributes[attribute] = value;
    return;
  }
  if (def?.kind === "composite") {
    throw new Error(`attribute_readonly: ${attribute}（composite 是派生属性）`);
  }
  if (def?.kind === "number" && def.derived !== undefined) {
    throw new Error(`attribute_readonly: ${attribute}（派生属性由公式计算，不能直接赋值）`);
  }
  if (typeof value !== "number") {
    throw new Error(`attribute_not_numeric: ${attribute}（收到字符串值）`);
  }
  const clamped = clampAttr(template, attribute, value);
  if (def?.kind === "ladder" && def.mode === "reset") {
    const applied = ladderResetFromAbsolute(def, clamped);
    state.player.attributes[attribute] = applied.value;
    state.player.attributeTiers = {
      ...(state.player.attributeTiers ?? {}),
      [attribute]: applied.tierId,
    };
    return;
  }
  state.player.attributes[attribute] = clamped;
}

// ---------- 公式求值 ----------

/**
 * 公式求值（协议 §10.4）：fixed / scaled / stack-scaled 三种预设，结果即最终值。
 * 不叠加任何随机浮动——判定随机只发生在命中判定与转盘，保证同 seed 逐字段可复现。
 */
export function rollFormula(
  formulas: Formula[],
  effAttrs: Record<string, number>,
  casterStatuses: StatusInstance[],
  casterResources?: Record<string, number>,
): number {
  let total = 0;
  for (const f of formulas) {
    switch (f.preset) {
      case "fixed":
        total += f.value;
        break;
      case "scaled":
        total += f.base + (effAttrs[f.scaleBy] ?? 0) * f.multiplier;
        break;
      case "stack-scaled": {
        const stacks = casterStatuses.find((s) => s.statusId === f.status)?.stacks ?? 0;
        total += f.base + stacks * f.perStack;
        break;
      }
      case "resource-scaled": {
        // ADR-012 D10：读**消耗前**的池子；没有这张表（旧调用点）按 0 处理。
        total += f.base + (casterResources?.[f.resource] ?? 0) * f.perPoint;
        break;
      }
    }
  }
  return total;
}

// ---------- 状态施加（模拟域；战斗域由 battle.ts 处理） ----------

/**
 * 施加状态（模拟域）。
 *
 * 时长是**这次施加**的属性（ADR-009 D1/D2），状态定义上不再有任何时长。
 * `{ value, unit }` 换算成**绝对到期点** `expiresAt`（`worldTime` 分钟），到期判定是纯比较——
 * 所以事件 `advanceTo 4752 day` 之后它自己就过期了，不需要任何地方补 tick。
 *
 * `duration` 省略 = 永久（挂载 / 天赋）。只有 `kind: talent` 与挂载会这么调用：
 * 天赋没有时钟，挂载的状态是身份而不是「一次施加」（D5）。
 */
export function applyStatusTo(
  state: WorldStateV2,
  actor: V2Player | V2Npc,
  statusId: string,
  stacks: number,
  lookup: TemplateLookup,
  duration?: SimulationDuration,
): void {
  const def = lookup.status(statusId);
  if (!def) return;
  const now = state.worldTime;
  const expiresAt = duration === undefined ? undefined : now + amountToMinutes(duration);
  const existing = actor.statuses.find((s) => s.statusId === statusId);
  if (existing) {
    /**
     * 时长（ADR-011 D1 + D2）：**时钟的形态听这一次，数值只往后推**。
     *
     * 状态的时长是「这一次施加」的属性，不是状态类型的属性；实例上却只有一个
     * `expiresAt`。两条约束同时成立：
     *
     * ① 形态：这一次带时长 ⇒ 有时钟；这一次不带（挂载 / 天赋）⇒ 没有。
     * ② 数值：同种时钟**只增不减**。剩 5 天的丧失不该被一句轻话缩成 3 天——
     *    这和层数是两件事，`stack` 加层的同时也不许把钟往回拨。
     *
     * 已经永久（挂载）的实例**不会被一次有期施加降级**：身份不是「一次施加」。
     * 旧 `stacking: refresh` 退役后，本条与层数规则合成唯一的再施加语义。
     */
    const permanent = existing.expiresAt === undefined;
    existing.appliedTurn = state.turnIndex;
    existing.appliedAt = now;
    if (expiresAt === undefined) delete existing.expiresAt;
    else if (!permanent) existing.expiresAt = Math.max(existing.expiresAt ?? 0, expiresAt);
    if (def.stacking === "stack") existing.stacks += stacks;
    else existing.stacks = Math.max(1, existing.stacks);
    // 旧档 / 手工注入的成长型天赋：补一档初始进度（不补发阶 grant，理由同新建分支）。
    if (def.kind === "talent" && def.progress !== undefined && existing.progress === undefined) {
      existing.progress = def.progress.initial ?? 0;
      existing.tiersApplied = settledTierCount(def, existing.progress);
    }
  } else {
    /**
     * 成长型天赋的初始进度（ADR-075 §7）：按 `progress.initial` 初始化，
     * `tiersApplied` 直接记成"初始进度已覆盖的阶数" —— **不补发阶 grant**。
     * 开局自带成长型天赋的人已经在开局 DAG 加过点，再补一笔就是双计。
     */
    const progress =
      def.kind === "talent" && def.progress !== undefined ? (def.progress.initial ?? 0) : undefined;
    actor.statuses.push({
      statusId,
      stacks: Math.max(1, stacks),
      appliedTurn: state.turnIndex,
      appliedAt: now,
      ...(progress !== undefined
        ? { progress, tiersApplied: settledTierCount(def, progress) }
        : {}),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
  }
}

/**
 * 只作用于 self 的薄包装（历史调用点：开局创建链、战斗施加入口）。
 * 新代码请用 `applyStatusTo` + `who`。
 */
export function applyStatusToPlayer(
  state: WorldStateV2,
  statusId: string,
  stacks: number,
  lookup: TemplateLookup,
  duration?: SimulationDuration,
): void {
  applyStatusTo(state, state.player, statusId, stacks, lookup, duration);
}

/**
 * 剪掉已到期的模拟域状态（ADR-009 D2）。
 *
 * 调用点覆盖所有改变 `worldTime` 的位置：自由行动的时间步、`advanceBy` / `advanceTo` 效果、轮尾。
 * 「到期」是绝对时刻比较，不是递减计数 ⇒ 漏调一次不会让状态永远活着，只会晚一轮消失。
 */
export function pruneExpiredStatuses(state: WorldStateV2): void {
  const now = state.worldTime;
  // ADR-010 D2：NPC 现在也能被施加模拟域状态（下毒、治伤），所以剪枝要覆盖全部演员。
  for (const actor of [state.player, ...state.npcs]) {
    const statuses = actor.statuses;
    if (statuses.length === 0) continue;
    const kept = statuses.filter((inst) => inst.expiresAt === undefined || now < inst.expiresAt);
    if (kept.length !== statuses.length) actor.statuses = kept;
  }
}

export function cureStatusFrom(state: WorldStateV2, actor: V2Player | V2Npc, statusId: string): void {
  actor.statuses = actor.statuses.filter((s) => s.statusId !== statusId);
}

/** 只作用于 self 的薄包装（历史调用点）。 */
export function cureStatusFromPlayer(state: WorldStateV2, statusId: string): void {
  cureStatusFrom(state, state.player, statusId);
}

// ---------- 条件求值（数组内 AND） ----------

export interface ConditionContext {
  state: WorldStateV2;
  lookup: TemplateLookup;
  rng: Rng;
  /**
   * 属性条件求值基准（可选）：由调用方显式提供「不含装备」的基础有效属性，
   * 避免装备条件 → 属性 → 装备的递归求值；缺省时按全量管线现算。
   */
  effAttrsOverride?: Record<string, number>;
  /**
   * 战评 hooks 里刚生成的战果（ADR-075 §6）。`anyMatch` 的 `battle.*` 集合优先读它；
   * 缺省回退 `state.lastBattleResult`（死亡路由 / 普通事件）。
   */
  battleResult?: BattleResult;
}

export function checkCondition(cond: Condition, ctx: ConditionContext): boolean {
  const { state, lookup, rng } = ctx;
  if ("anyMatch" in cond) {
    return anyMatchMet((cond as { anyMatch: AnyMatch }).anyMatch, {
      state,
      battle: ctx.battleResult ?? state.lastBattleResult,
      template: lookup.template,
    });
  }
  if ("flag" in cond) {
    const value = state.flags[cond.flag];
    if (value === undefined) return false;
    return compareValues(value, cond);
  }
  if ("npcState" in cond) {
    // ADR-0012 决策 1 / ADR-0020：只匹配状态，不匹配 reasonCode。
    // 未知 npcId 一律 false（模板引用完整性由加载期校验负责，这里不做猜测）。
    const npc = state.npcs.find((n) => n.id === cond.npcState.npcId);
    return npc !== undefined && npc.lifecycle.state === cond.npcState.state;
  }
  if ("attribute" in cond) {
    /**
     * ADR-003：与触发器求值共用 `evaluateAttributeCondition`（kind / enum 选项 /
     * 阶梯 tier 只实现一次）。引擎侧用**有效值**（叠状态/装备），触发器侧用原始值，
     * 这是两处既有的口径差异，不由本函数抹平。
     */
    const eff = ctx.effAttrsOverride ?? playerEffectiveAttributes(state, lookup);
    return evaluateAttributeCondition(
      cond,
      state.player.attributes,
      eff,
      lookup.template,
      state.player.attributeTiers,
    );
  }
  if ("status" in cond) {
    const inst = state.player.statuses.find((s) => s.statusId === cond.status);
    if (cond.present !== undefined) return cond.present ? inst !== undefined : inst === undefined;
    return inst !== undefined && inst.stacks >= (cond.stacksGte ?? 1);
  }
  if ("inventory" in cond) {
    return (state.player.inventory[cond.inventory] ?? 0) >= cond.gte;
  }
  if ("mood" in cond) {
    if (cond.mood.gte !== undefined && state.player.mood < cond.mood.gte) return false;
    if (cond.mood.lte !== undefined && state.player.mood > cond.mood.lte) return false;
    return true;
  }
  if ("relation" in cond) {
    // R2.6 / ADR-0014：声明 kind 时读**关系边**，未声明 kind 时读标量，向后兼容。
    //
    // ADR-017 D1：两种写法**读的是同一个数**。端点是 self（「他视你如何」）时强度只住在
    // `npc.relationship` 标量里，所以带 kind 的条件也去读标量 —— 否则「卡片上写着好感 62、
    // 条件按边判 0」这种错位会一直存在（模板把 value 写在边上时才暴露）。
    if (cond.kind !== undefined) {
      // 缺省「玩家」= 当前 self（扮演模板角色时不是字面量 `"player"`，见 normalizeRelationEndpoint）。
      const to = normalizeRelationEndpoint(cond.to ?? PLAYER_ID, selfIdOf(state));
      const value =
        to === selfIdOf(state)
          ? (state.npcs.find((n) => n.id === cond.relation)?.relationship ?? 0)
          : (state.relations.find((e) => e.from === cond.relation && e.to === to && e.kind === cond.kind)?.value ?? 0);
      if (cond.gte !== undefined && value < cond.gte) return false;
      if (cond.lte !== undefined && value > cond.lte) return false;
      return true;
    }
    const npc = state.npcs.find((n) => n.id === cond.relation);
    if (!npc) return false;
    if (cond.gte !== undefined && npc.relationship < cond.gte) return false;
    if (cond.lte !== undefined && npc.relationship > cond.lte) return false;
    return true;
  }
  if ("requiresSkill" in cond) {
    return state.player.skills.includes(cond.requiresSkill);
  }
  if ("selfIs" in cond) {
    // 当前 self 单值 ⇒ 天然互斥。selfId 缺省回落 PLAYER_NODE_ID（旧档逐字段不变）。
    return selfIdOf(state) === cond.selfIs;
  }
  if ("selfIsNot" in cond) {
    // 排除式：给无 as 的兜底变体用，避免它与带 as 的变体同时通过 trigger.conditions 而串戏。
    return selfIdOf(state) !== cond.selfIsNot;
  }
  if ("random" in cond) {
    return rng() < cond.random;
  }
  if ("time" in cond) {
    const minutes = state.worldTime;
    if (cond.time.gte !== undefined && minutes < amountToMinutes(cond.time.gte)) return false;
    if (cond.time.lte !== undefined && minutes > amountToMinutes(cond.time.lte)) return false;
    if (cond.time.gt !== undefined && minutes <= amountToMinutes(cond.time.gt)) return false;
    if (cond.time.lt !== undefined && minutes >= amountToMinutes(cond.time.lt)) return false;
    return true;
  }
  return false;
}

/**
 * 条件数组内 AND（事件的 `conditions` / `missWhen` / `visibleWhen`、开局条件、结局条件
 * 与 NPC 刷新规则共用同一个入口）。
 *
 * 开放形 `{ op, args }` 与 `rules.yaml` 的触发器**同一张注册表**求值（内置 op +
 * 模板**已声明**扩展贡献的 op，见 `collectExtensionConditions`）——「这个 op 是什么语义」
 * 只允许有一个答案。注册表惰性构建：没有开放形条件时一次都不建。
 *
 * 未注册的 op ⇒ `false`（绝不静默当成 true）。加载期已按「模板声明的扩展」拒载
 * （`unknown_condition_op`），所以这里只可能是扩展在装配期被摘掉的防御路径。
 */
export function checkAllConditions(
  conditions: readonly TaskCondition[] | undefined,
  ctx: ConditionContext,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  let registry: ConditionRegistry | undefined;
  for (const cond of conditions) {
    if ("op" in cond) {
      registry ??= createConditionRegistry(collectExtensionConditions(ctx.lookup.template));
      const open = cond as OpenCondition;
      if (!registry.has(open.op)) return false;
      const evalCtx: ConditionEvalContext = {
        state: ctx.state,
        rng: ctx.rng,
        turnIndex: ctx.state.turnIndex,
      };
      if (!registry.evaluate(open.op, open.args, evalCtx)) return false;
      continue;
    }
    if (!checkCondition(cond, ctx)) return false;
  }
  return true;
}

function compareValues(value: boolean | number | string, cond: Extract<Condition, { flag: string }>): boolean {
  if (cond.eq !== undefined) return value === cond.eq;
  if (cond.ne !== undefined) return value !== cond.ne;
  if (typeof value !== "number") return false;
  return compareNumber(value, cond);
}

function compareNumber(
  value: number,
  cond: { eq?: number | string | boolean; ne?: number | string | boolean; gte?: number; lte?: number; gt?: number; lt?: number },
): boolean {
  if (cond.eq !== undefined && value !== cond.eq) return false;
  if (cond.ne !== undefined && value === cond.ne) return false;
  if (cond.gte !== undefined && value < cond.gte) return false;
  if (cond.lte !== undefined && value > cond.lte) return false;
  if (cond.gt !== undefined && value <= cond.gt) return false;
  if (cond.lt !== undefined && value >= cond.lt) return false;
  return true;
}

// ---------- 效果执行器（EffectSchema 全量白名单） ----------

/** 扩展效果在运行期的形状：内核只认 `type`，其余字段一律交给扩展自己的 schema。 */
export type UnknownEffect = { readonly type: string } & Record<string, unknown>;

/**
 * 内核认识的效果 type 集合 —— **直接从 `EffectSchema` 派生**，不手抄名单。
 *
 * 手抄一份 27 项的 Set 会在下次加效果时静默漂移（schema 放行、执行器当未知、
 * 或者反过来）。派生自 schema 的代价是 engine 依赖 schema 的值（不只是类型），
 * 换来「白名单 = 协议白名单」这条结构保证。
 */
const KNOWN_EFFECT_TYPES: ReadonlySet<string> = new Set(
  EffectSchema.options.map((option) => option.shape.type.value),
);

export interface EffectContextV2 {
  state: WorldStateV2;
  lookup: TemplateLookup;
  rng: Rng;
  /** log 效果的输出（玩家可见日志） */
  logs?: string[];
  /** 效果可能触发事件链推进，收集被触发的事件 id 供路由层处理 */
  startedChains?: string[];
  /** 当前执行行动的 NPC（adjustRelation 的 npcId 为 "__self__" 时解析为此） */
  selfNpcId?: string;
  /** advanceTime 效果执行后置 true，调用方据此在安全边界重新 drain 延时队列 */
  timeAdvanced?: boolean;
  /** enqueueEvent 效果入队的事件 id；调用方据此在同一次边界 drain 到期实例（入口 3） */
  enqueued?: string[];
  /** 战评钩子里刚生成的战果：`advanceTalent.amount` 的 metric 形态与 `anyMatch` 读它。 */
  battleResult?: BattleResult;
}

/**
 * 关系效果写下的知情人范围（ADR-007 D3）。
 *
 * 三档优先：显式 `scope` > 旧 `visibility` 折算 > 缺省 `private`。
 * 缺省取 private 而不是 public：运行期「刚建立」的关系不该被当成众所周知，
 * 要公开就明写 `scope: public`（模板里所有初始关系都明写了）。
 *
 * `limited` 没有名单 ⇒ 降级成 `private`（2026-11-19）：`RelationEdgeSchema` 明确拒绝
 * 「limited 却没有 knownBy」，照原样写进去就是一份**载不回来的存档**。降级方向取
 * 最严的那一档（没人看见），既不会凭空泄露，也不会让这一局打不开；
 * 作者该看到的是加载期的报错，不是运行期的静默。
 */
function scopeOfEffect(effect: {
  scope?: RelationScope;
  visibility?: RelationVisibility;
  knownBy?: readonly string[];
}): RelationScope {
  if (effect.scope !== undefined) {
    if (effect.scope === "limited" && (effect.knownBy === undefined || effect.knownBy.length === 0)) {
      return "private";
    }
    return effect.scope;
  }
  if (effect.visibility !== undefined) {
    return effect.visibility === "known" || effect.visibility === "inferred" ? "public" : "private";
  }
  return "private";
}

/**
 * 关系写入的判活辅助（ADR-0020）。实现在 `actors.ts`（演员表访问层）：
 * 玩家/实例的区分收敛到 `selfIdOf` + `actorOf` 一处，这里只保留调用点。
 * 语义见 `isAliveActor` 注释：只拦「**确知**非在世」，找不到的 id 按可写处理。
 */
function isAliveNode(state: WorldStateV2, nodeId: string): boolean {
  return isAliveActor(state, nodeId);
}

/**
 * 推进成长型天赋（ADR-075 §7）：**唯一写入口**。
 *
 * - 单调递增、夹 `progress.max`、不碰 RNG；
 * - `create: true` 时没有实例就建一个，**从 0 起算**再加（不重复计 `initial`）；
 * - 跨阶时从 `tiersApplied` 往后逐阶结算 `grant` 一次；`grant` 里禁止再写 `advanceTalent`
 *   （加载期已拒），所以这里不会有递归。
 */
export function advanceTalent(
  ctx: EffectContextV2,
  talentId: string,
  amount: number,
  create: boolean,
): void {
  if (amount <= 0) return;
  const { state, lookup } = ctx;
  const def = lookup.status(talentId);
  if (def === undefined) return; // 加载期已校验引用；运行期不猜
  if (def.kind !== "talent") throw new Error(`advanceTalent_not_talent: ${talentId}`);

  let inst = state.player.statuses.find((s) => s.statusId === talentId);
  if (inst === undefined) {
    if (!create) return;
    inst = {
      statusId: talentId,
      stacks: 1,
      appliedTurn: state.turnIndex,
      appliedAt: state.worldTime,
      progress: 0,
      tiersApplied: 0,
    };
    state.player.statuses.push(inst);
  } else if (inst.tiersApplied === undefined) {
    // 旧档 / 外部注入：把"当前进度已经覆盖的阶"记为已结算，避免补发旧阶的 grant。
    inst.tiersApplied = settledTierCount(def, talentProgressOf(def, inst));
  }

  const current = talentProgressOf(def, inst);
  const max = def.progress?.max ?? Number.POSITIVE_INFINITY;
  const next = Math.min(max, current + amount);
  if (next === current) return;
  inst.progress = next;

  const tiers = def.tiers ?? [];
  let applied = inst.tiersApplied ?? 0;
  const crossed: typeof tiers = [];
  while (applied < tiers.length && tiers[applied]!.at <= next) {
    crossed.push(tiers[applied]!);
    // 先记"已结算"再发效果：grant 里若有同 id 的幂等写入，不会把这一阶再走一遍。
    inst.tiersApplied = applied + 1;
    applied += 1;
  }
  applyTierGrants(ctx, crossed);
}

/**
 * 跨阶结算的 `grant`。
 *
 * **一次跨两阶必须合并加点**：`grantAllocation` 是「同一时刻只能挂一条」的待办，
 * 逐阶发会在 `pendingAllocation` 上撞车（`bf-1` 还没分完又来 `bf-4`，直接抛错）。
 * 而这两笔在语义上本来就是同一件事 —— 「这一场涨了两阶，一共给你 3 点」。
 *
 * 合并规则：`budget` 相加；`targets` 按属性去重（保留先出现的上下限）；
 * `id` 取最后一阶的（同阶重复结算由 `tiersApplied` 挡住，不靠 id 兜底）。
 */
function applyTierGrants(ctx: EffectContextV2, tiers: readonly { effects: { grant?: readonly (Effect | UnknownEffect)[] } }[]): void {
  const flat = tiers.flatMap((t) => t.effects.grant ?? []);
  if (flat.length === 0) return;
  const allocs = flat.filter(
    (e): e is Extract<Effect, { type: "grantAllocation" }> => e.type === "grantAllocation",
  );
  if (allocs.length <= 1) {
    applyEffectsV2(ctx, flat);
    return;
  }
  const budget = allocs.reduce((sum, a) => sum + a.budget, 0);
  const seen = new Set<string>();
  const targets: Extract<Effect, { type: "grantAllocation" }>["targets"] = [];
  for (const a of allocs) {
    for (const t of a.targets) {
      if (seen.has(t.attribute)) continue;
      seen.add(t.attribute);
      targets.push({ ...t });
    }
  }
  const last = allocs[allocs.length - 1]!;
  const merged: Extract<Effect, { type: "grantAllocation" }> = {
    type: "grantAllocation",
    id: last.id,
    budget,
    targets,
    ...(last.reason !== undefined ? { reason: last.reason } : {}),
  };
  applyEffectsV2(ctx, [...flat.filter((e) => e.type !== "grantAllocation"), merged]);
}

export function applyEffectsV2(
  ctx: EffectContextV2,
  effects: readonly (Effect | UnknownEffect)[] | undefined,
): void {
  if (!effects) return;
  const { state, lookup, rng } = ctx;
  for (const raw of effects) {
    // 白名单外的 type 一律交给扩展分发；没命中就是 unknown_effect（绝不静默 no-op）。
    if (!KNOWN_EFFECT_TYPES.has(raw.type)) {
      applyExtensionEffect(ctx, raw);
      continue;
    }
    const effect = raw as Effect;
    switch (effect.type) {
      case "setFlag":
        state.flags[effect.id] = effect.value;
        break;
      case "adjustFlag": {
        const current = state.flags[effect.id];
        state.flags[effect.id] = (typeof current === "number" ? current : 0) + effect.value;
        break;
      }
      case "clearFlag":
        delete state.flags[effect.id];
        break;
      case "adjustAttribute": {
        /**
         * ADR-003：数值属性才可增减。文本 / 复合属性在加载期已拒载，
         * 这里再抛一次（运行期动态接值也必须可诊断，不能静默把字符串当 0）。
         */
        const def = lookup.template.attributes.defs?.[effect.attribute];
        if (def?.kind === "enum" || def?.kind === "composite") {
          throw new Error(`attribute_not_numeric: ${effect.attribute}（${def.kind}）`);
        }
        const actor = writableActorOf(state, effect.who)?.actor;
        if (actor === undefined) break;
        const current = numericAttr(actor.attributes[effect.attribute]);
        if (def?.kind === "ladder" && def.mode === "reset") {
          const advanced = applyLadderGain(def, current, effect.value, actor.attributeTiers?.[effect.attribute]);
          actor.attributes[effect.attribute] = advanced.value;
          if (advanced.tierId !== undefined) {
            actor.attributeTiers = {
              ...(actor.attributeTiers ?? {}),
              [effect.attribute]: advanced.tierId,
            };
          }
          break;
        }
        actor.attributes[effect.attribute] = clampAttr(
          lookup.template,
          effect.attribute,
          current + effect.value,
        );
        break;
      }
      case "setAttribute": {
        assignAttributeValue(state, lookup.template, effect.attribute, effect.value);
        break;
      }
      case "adjustResource": {
        // hp/mp 与自定义资源共用一套夹取（ADR-003 D8）；未知 key 不写（加载期已拒载）。
        const actor = writableActorOf(state, effect.who)?.actor;
        if (actor === undefined) break;
        adjustResourceValue(actor, lookup.template, effect.resource, effect.value);
        break;
      }
      case "adjustMood": {
        const actor = writableActorOf(state, effect.who)?.actor;
        if (actor === undefined) break;
        actor.mood = clamp(actor.mood + effect.value, lookup.template.mood.min, lookup.template.mood.max);
        break;
      }
      case "grantAllocation": {
        /**
         * 世界内加点（ADR-019）：只**挂请求**，不改属性。
         *
         * 属性由玩家在面板里选完、走轮外端点一次写入 —— 直接 `adjustAttribute`
         * 等于替玩家做了选择，而且会绕过「这次分几点」的边界。
         */
        if (state.pendingAllocation !== undefined) {
          /**
           * 同 id ⇒ 幂等跳过（日常事件泡在池子里会反复给同一笔，比如每次切磋都给
           * `alloc-spar`）；不同 id ⇒ 直接抛，那是作者写错了两笔并存的局面，
           * 而「点确定」只能提交一笔。
           */
          if (state.pendingAllocation.id === effect.id) break;
          throw new Error(
            `grantAllocation 与未完成的加点冲突：${state.pendingAllocation.id}（同一时刻只能挂一条）`,
          );
        }
        state.pendingAllocation = {
          id: effect.id,
          budget: effect.budget,
          targets: effect.targets.map((t) => ({ ...t })),
          ...(effect.reason !== undefined ? { reason: effect.reason } : {}),
          sinceTurn: state.turnIndex,
          sinceWorldTime: state.worldTime,
        };
        break;
      }
      case "advanceTalent": {
        /**
         * ADR-075 §7。`amount` 的 metric 形态只在战评 hooks 里有意义（那里有 `BattleResult`）；
         * 世界效果没有战果上下文，静默当 0 会变成"给了但没涨"，所以直接拒。
         */
        const amount =
          typeof effect.amount === "number"
            ? effect.amount
            : ctx.battleResult !== undefined
              ? Math.min(
                  effect.amount.max ?? Number.POSITIVE_INFINITY,
                  ctx.battleResult.player.statusStacks[effect.amount.status] ?? 0,
                )
              : Number.NaN;
        if (!Number.isFinite(amount)) {
          throw new Error("advanceTalent_amount_metric_outside_evaluation");
        }
        advanceTalent(ctx, effect.talent, Math.floor(amount), effect.create === true);
        break;
      }
      case "playerDeath": {
        state.player.hp = 0;
        state.deathSignal = { ...(effect.reason !== undefined ? { reason: effect.reason } : {}) };
        break;
      }
      case "observeActor": {
        /**
         * 观察者切换（ADR-010 D4）：只改「以谁的眼睛看」，不换人。
         *
         * 以前 `viewerId` 只是 `projectWorld` 的第 7 个参数 —— 模板没有任何办法把
         * 镜头交给别人。现在写成 state 上的一格：行动 / 事件 / 时间表都能下发，
         * 下一帧投影自然按它判关系可见性。
         */
        if (effect.actorId === null) {
          delete state.viewerId;
          break;
        }
        const viewer = effect.actorId === "__self__" ? selfIdOf(state) : effect.actorId;
        if (viewer === selfIdOf(state) || state.npcs.some((n) => n.id === viewer)) {
          state.viewerId = viewer;
        }
        break;
      }
      case "setSkin": {
        /**
         * 换皮肤（2026-11-24 · 迭代 character-media）：**只写 `skinId`**。
         *
         * 作用域（外部评审核定）：只能改「已存在的、可写的人物实例」——
         * 不存在的 id、敌人这种**没有 NPC 实例的战斗临时单位**一律静默跳过（与 `inheritActor` 同策略）。
         * 不碰任何数值与身份字段；皮肤归属由加载期 `checkEffectRefs` 校验。
         */
        const target = writableActorOf(state, effect.who);
        if (target === null) break;
        if (effect.skinId === null) delete target.actor.skinId;
        else target.actor.skinId = effect.skinId;
        break;
      }
      case "inheritActor": {
        /**
         * 继承 / 夺舍（ADR-010 D7）：`transplantActor` 的唯一模板入口。
         *
         * 源可以是死者（继承本来就发生在人死之后），所以这里不走 `writableActorOf`
         * ——那个入口会以「非 alive」为由拒掉。目标必须活着：往死者身上搬字段没有意义。
         * 引用错误由加载期抓（`checkEffectRefs`），运行期找不到实例就静默跳过。
         */
        const source = effect.from === PLAYER_ID ? state.player : state.npcs.find((n) => n.id === effect.from);
        const target = effect.to === PLAYER_ID ? state.player : state.npcs.find((n) => n.id === effect.to);
        if (source !== undefined && target !== undefined && source !== target) {
          const targetAlive = effect.to === PLAYER_ID || (target.lifecycle?.state ?? "alive") === "alive";
          if (targetAlive) {
            transplantActor(source as unknown as TransferableActor, target as unknown as TransferableActor, effect.groups);
          }
        }
        break;
      }
      case "setIdentity": {
        // 开局创建链用：性别 / 起始年龄由玩家在事件里定下。
        // 年龄必须同时写回 playerAgeAtStart，否则下一次按公历推进时会被旧基准覆盖。
        // 名字（ADR-001 / R-NAME-02）：只写传入字段；改名后世界列表读 player.name 自然同步。
        if (effect.name !== undefined) state.player.name = effect.name;
        if (effect.gender !== undefined) state.player.gender = effect.gender;
        if (effect.age !== undefined) {
          state.player.age = effect.age;
          state.playerAgeAtStart = effect.age;
        }
        // 多开局模板的父母指针：只写传入的字段，不传 = 不详（不是清空）。
        // 引用完整性由模板加载期校验 characters[].id；运行期不二次猜人。
        if (effect.fatherId !== undefined) state.player.fatherId = effect.fatherId;
        if (effect.motherId !== undefined) state.player.motherId = effect.motherId;
        break;
      }
      case "adjustRelation": {
        // 形态 ①（兼容）：NPC→玩家 标量
        if (effect.fromId === undefined && effect.toId === undefined) {
          if (effect.npcId === undefined) {
            throw new Error("adjustRelation 需要 npcId（标量形态）或 fromId+toId+kind（关系边形态）");
          }
          const npcId = effect.npcId === "__self__" ? ctx.selfNpcId : effect.npcId;
          const npc = npcId ? state.npcs.find((n) => n.id === npcId) : undefined;
          // ADR-0020：非在世 NPC 的关系写入冻结（单向棘轮，复活不解冻）
          if (npc && npc.lifecycle.state === "alive") {
            npc.relationship = clamp(npc.relationship + effect.value, -100, 100);
          }
          break;
        }
        // 形态 ②（R2.6）：关系边增量调整；边不存在则按 value 建边
        if (effect.toId === undefined || effect.kind === undefined) {
          throw new Error("adjustRelation 关系边形态必须同时声明 toId 与 kind");
        }
        const selfId = selfIdOf(state);
        const fromId =
          effect.fromId === "__self__"
            ? ctx.selfNpcId
            : effect.fromId === undefined
              ? undefined
              : normalizeRelationEndpoint(effect.fromId, selfId);
        if (fromId === undefined) {
          throw new Error("adjustRelation 关系边形态的 fromId 无法解析（__self__ 时须有当前 NPC）");
        }
        const toId = normalizeRelationEndpoint(effect.toId, selfId);
        if (fromId === toId) break; // 归一成自环：同 addRelationEdge，丢弃不写
        // ADR-0020：任一端非在世即冻结该边的写入（新建与增量都挡）
        if (!isAliveNode(state, fromId) || !isAliveNode(state, toId)) break;
        const existing = state.relations.find(
          (e) => e.from === fromId && e.to === toId && e.kind === effect.kind,
        );
        // 死亡冻结的边不再被改动（T-B2 单向棘轮）
        if (existing?.frozen === true) break;
        /**
         * ADR-017 D1：**端点是 self 时，强度落在标量里**（`npc.relationship`），不进边的 `value`。
         *
         * 否则同一条「夏油视你为朋友」会有两个数字：卡片 chip 读标量，带 `kind` 的条件读边 ——
         * 事件改一个、另一个原地不动，玩家看到的面板与判定用的事实就此各说各话。
         * kind 仍然建边（那是**事实**：他是你的朋友），只是不带强度。
         * 冻结判据与下面那条共用（`existing.frozen`），所以「逝者的关系不再变」对两种形态同时成立。
         */
        if (toId === selfId) {
          const npc = state.npcs.find((n) => n.id === fromId);
          if (npc !== undefined) {
            npc.relationship = clamp(npc.relationship + effect.value, -100, 100);
          }
          if (!existing) {
            state.relations.push({
              from: fromId,
              to: toId,
              kind: effect.kind,
              source: "effect",
              scope: scopeOfEffect(effect),
              ...(effect.knownBy !== undefined ? { knownBy: [...effect.knownBy] } : {}),
            });
          }
          break;
        }
        if (!existing) {
          // 新建边默认 private（ADR-007 D3）：当事人自己知道，外人不知道。
          // 旧 `visibility` 写法仍认：known/inferred → public，其余 → private。
          state.relations.push({
            from: fromId,
            to: toId,
            kind: effect.kind,
            source: "effect",
            scope: scopeOfEffect(effect),
            ...(effect.knownBy !== undefined ? { knownBy: [...effect.knownBy] } : {}),
            value: clamp(effect.value, -100, 100),
          });
          break;
        }
        existing.value = clamp((existing.value ?? 0) + effect.value, -100, 100);
        break;
      }
      case "addRelationEdge": {
        const selfId = selfIdOf(state);
        const fromId = effect.fromId === "__self__" ? ctx.selfNpcId : normalizeRelationEndpoint(effect.fromId, selfId);
        if (fromId === undefined) {
          throw new Error("addRelationEdge 的 fromId 无法解析（__self__ 时须有当前 NPC）");
        }
        // 端点归一后可能撞成自环（`fromId` 与 `toId` 都写 `player`）——schema 禁止自环，
        // 写进去就是一份载不回来的存档。同 turn.ts 的声明边处理：丢掉，不写。
        const toId = normalizeRelationEndpoint(effect.toId, selfId);
        if (fromId === toId) break;
        // ADR-0020：任一端非在世不得新建关系边
        if (!isAliveNode(state, fromId) || !isAliveNode(state, toId)) break;
        /**
         * ADR-017 D1：指向 self 的强度只住在标量里（与 `adjustRelation` 同一口径）。
         * `addRelationEdge` 的 `value` 是**绝对赋值**，所以这里直接覆盖标量，而不是叠上去。
         */
        const strengthToScalar = toId === selfId;
        if (strengthToScalar && effect.value !== undefined) {
          const npc = state.npcs.find((n) => n.id === fromId);
          if (npc !== undefined) npc.relationship = clamp(effect.value, -100, 100);
        }
        state.relations = addEdge(state.relations, {
          from: fromId,
          to: toId,
          kind: effect.kind,
          source: "effect",
          scope: scopeOfEffect(effect),
          ...(effect.knownBy !== undefined ? { knownBy: [...effect.knownBy] } : {}),
          ...(effect.value !== undefined && !strengthToScalar ? { value: effect.value } : {}),
          ...(effect.gap !== undefined ? { gap: effect.gap } : {}),
        });
        break;
      }
      case "addSecret": {
        const npcId = effect.npcId === "__self__" ? ctx.selfNpcId : effect.npcId;
        if (npcId === undefined) {
          throw new Error("addSecret 的 npcId 无法解析（__self__ 时须有当前 NPC）");
        }
        const npc = state.npcs.find((n) => n.id === npcId);
        if (!npc) {
          // 引用不存在的 NPC 属配置错误：抛可诊断错误，不静默跳过
          throw new Error(`addSecret 指向未知 NPC：${npcId}`);
        }
        // append-only + 文本去重：同一效果重复命中不堆重复隐秘
        if (!npc.secrets.includes(effect.text)) npc.secrets.push(effect.text);
        break;
      }
      case "freezeRelationsOnDeath": {
        const npcId = effect.npcId === "__self__" ? ctx.selfNpcId : effect.npcId;
        if (npcId === undefined) {
          throw new Error("freezeRelationsOnDeath 的 npcId 无法解析（__self__ 时须有当前 NPC）");
        }
        state.relations = freezeOnDeath(state.relations, npcId);
        break;
      }
      case "spawnNpc": {
        // ADR-0010 决策 4 / ADR-0022：只凭**规则 id** 建实例，配置域定义不在运行时被拼装。
        const rule = state.spawnRules.find((r) => r.ruleId === effect.ruleId);
        if (!rule) {
          throw new Error(`spawnNpc 指向未知刷新规则：${effect.ruleId}`);
        }
        // 幂等：已出生过就不再重复建实例、不重复追加事实（模板可能重复触发同一效果）
        if (rule.status === "spawned") break;
        const npc = state.npcs.find((n) => n.id === rule.characterRef);
        if (!npc) {
          throw new Error(`spawnNpc 规则 ${rule.ruleId} 指向的角色没有实例：${rule.characterRef}`);
        }
        // 出生年龄：规则显式声明优先（0 = 新生儿），缺省沿用建世界期的年龄快照
        const ruleDef = (ctx.lookup.template.npcSpawnRules ?? []).find((r) => r.id === effect.ruleId);
        if (ruleDef?.age !== undefined) {
          npc.birthTime = state.worldTime + birthTimeFromAge(ruleDef.age, createTimeAdapter(ctx.lookup.template));
        }
        npc.lifecycle = {
          state: "alive",
          sinceTurn: state.turnIndex,
          sinceWorldTime: state.worldTime,
        };
        rule.status = "spawned";
        rule.spawnedTurn = state.turnIndex;
        rule.spawnedWorldTime = state.worldTime;
        // 事实层只追加（与 eventFires / missedEvents 同级），不写 flags
        state.spawnLog.push({
          npcId: npc.id,
          ruleId: rule.ruleId,
          turnIndex: state.turnIndex,
          worldTime: state.worldTime,
        });
        break;
      }
      case "setNpcLifecycle": {
        // ADR-0012 决策 1 / ADR-0020：复活 / 死亡 / 失联走同一入口，无特权通道。
        const npcId = effect.npcId === "__self__" ? ctx.selfNpcId : effect.npcId;
        if (npcId === undefined) {
          throw new Error("setNpcLifecycle 的 npcId 无法解析（__self__ 时须有当前 NPC）");
        }
        const npc = state.npcs.find((n) => n.id === npcId);
        if (!npc) {
          // 引用不存在的 NPC 属配置错误，抛可诊断错误而不是静默跳过
          throw new Error(`setNpcLifecycle 指向未知 NPC：${npcId}`);
        }
        npc.lifecycle = {
          state: effect.state,
          ...(effect.reasonCode !== undefined ? { reasonCode: effect.reasonCode } : {}),
          sinceTurn: state.turnIndex,
          sinceWorldTime: state.worldTime,
        };
        // 离开「在世」即冻结相连关系边（单向棘轮：复活不解冻，与 freezeRelationsOnDeath 一致）
        if (effect.state !== "alive") state.relations = freezeOnDeath(state.relations, npcId);
        break;
      }
      case "setNpcVisibility": {
        // 与生命周期正交：只改玩家人物列表的上屏门，不改死活、不冻关系。
        const npcId = effect.npcId === "__self__" ? ctx.selfNpcId : effect.npcId;
        if (npcId === undefined) {
          throw new Error("setNpcVisibility 的 npcId 无法解析（__self__ 时须有当前 NPC）");
        }
        const npc = state.npcs.find((n) => n.id === npcId);
        if (!npc) throw new Error(`setNpcVisibility 指向未知 NPC：${npcId}`);
        npc.visibility = effect.visibility;
        break;
      }
      case "grantItem": {
        const actor = writableActorOf(state, effect.who)?.actor;
        if (actor === undefined) break;
        actor.inventory[effect.itemId] = (actor.inventory[effect.itemId] ?? 0) + effect.count;
        break;
      }
      case "removeItem": {
        const actor = writableActorOf(state, effect.who)?.actor;
        if (actor === undefined) break;
        const left = (actor.inventory[effect.itemId] ?? 0) - effect.count;
        if (left > 0) actor.inventory[effect.itemId] = left;
        else delete actor.inventory[effect.itemId];
        break;
      }
      case "applyStatus": {
        const actor = writableActorOf(state, effect.who)?.actor;
        if (actor === undefined) break;
        applyStatusTo(state, actor, effect.status, effect.stacks ?? 1, lookup, effect.duration);
        break;
      }
      case "cureStatus": {
        const actor = writableActorOf(state, effect.who)?.actor;
        if (actor === undefined) break;
        cureStatusFrom(state, actor, effect.status);
        break;
      }
      case "unlockSkill": {
        const actor = writableActorOf(state, effect.who)?.actor;
        if (actor === undefined) break;
        if (!actor.skills.includes(effect.skillId)) actor.skills.push(effect.skillId);
        break;
      }
      case "adjustProficiency": {
        const target = writableActorOf(state, effect.who);
        if (target === null) break;
        // 旧档/旧模板的 key 不变；给了别人时才按演员分槽，避免两人的熟练度串在一起。
        const key = target.isSelf
          ? `proficiency:${effect.skillId}`
          : `proficiency:${target.actor.id}:${effect.skillId}`;
        const current = state.flags[key];
        state.flags[key] = (typeof current === "number" ? current : 0) + effect.value;
        break;
      }
      case "adjustGrowth": {
        const actor = writableActorOf(state, effect.who)?.actor;
        if (actor === undefined) break;
        // NPC 之前没有成长等级（ADR-010 D1 补齐），缺省按 0 起算。
        actor.growthLevel = (actor.growthLevel ?? 0) + effect.value;
        break;
      }
      case "advanceTo": {
        // R2.6（ADR-0013）：目标量经历法适配器换算（基准 0 = 相对世界起始，绝不倒退）。
        const cal = createTimeAdapter(lookup.template);
        state.worldTime = Math.max(state.worldTime, cal.toMinutes(effect.value, 0));
        state.player.age = state.playerAgeAtStart + cal.elapsedYears(state.worldTime);
        ctx.timeAdvanced = true;
        // 时间一跳，挂着的东西可能已经过期（ADR-009 D2）：就地剪掉，后续效果不必再猜。
        pruneExpiredStatuses(state);
        break;
      }
      case "advanceBy": {
        // R2.6（ADR-0013）：相对量经历法适配器换算（gregorian 12 年含闰日）。
        const cal = createTimeAdapter(lookup.template);
        state.worldTime += cal.toMinutes(effect.value, state.worldTime);
        state.player.age = state.playerAgeAtStart + cal.elapsedYears(state.worldTime);
        ctx.timeAdvanced = true;
        pruneExpiredStatuses(state);
        break;
      }
      case "startChain": {
        if (startChain(state, effect.chainId, lookup)) {
          (ctx.startedChains ??= []).push(effect.chainId);
        }
        break;
      }
      case "advanceChain":
        // ADR-0034 §5：链状态与 `alignChainStep` 已删除 ⇒ 本效果降级为 no-op。
        // 「下一步是谁」现在只由结算处的 `nextEventId` 占槽判定决定，没有可"推进"的游标。
        break;
      case "enqueueEvent": {
        // R-EV-08：延时入队的唯一声明式通道。门控（once/probability）在候选产生时求值，
        // 门控失败不产生实例、不记错失；delay 缺省由 enqueueCandidate 取相对 0 分钟。
        // R2.6（ADR-0013）：delay 换算经历法适配器（字符串字面量 / year-month 量）。
        const def = lookup.event(effect.eventId);
        if (!def) {
          throw new Error(`enqueueEvent 引用未知事件：${effect.eventId}（模板加载期应已拦截）`);
        }
        enqueueCandidate({
          state,
          definition: def,
          origin: { kind: "effect", id: effect.eventId },
          lookup,
          rng,
          calendar: createTimeAdapter(lookup.template),
          ...(effect.delay !== undefined ? { delay: effect.delay } : {}),
        });
        (ctx.enqueued ??= []).push(effect.eventId);
        break;
      }
      case "cancelChain":
        // ADR-0034 §5：`chains[]` 运行时状态已删除，"取消链"不再有落点。
        // 保留该效果类型（协议面不动）但降级为 no-op：模板若需要"停止后续"，
        // 应改用 `nextEventId` 不指、或条件/`missWhen` 表达。
        break;
      case "log":
        if (effect.visibility === "public") ctx.logs?.push(effect.text);
        break;
    }
  }
}

/**
 * 白名单外的 effect type 分发（`docs/EXTENSIONS.md` §2 保证 6）。
 *
 * 顺序：模板**已声明**的扩展里找同名 handler → 命中就调它（字段由扩展自己 parse）；
 * 没命中 ⇒ **抛 `unknown_effect`**（消息带 type 名），不静默 no-op。
 *
 * 为什么必须抛：schema 放行而 handler 忘注册时，静默跳过会表现为「效果凭空消失」，
 * 是最难查的一类 bug；抛出至少能在模板/测试第一次跑到时定位。
 *
 * `cancelChain` / `advanceChain` 不在此列 —— 它们是**协议内**的有意 no-op
 * （ADR-0034 §5 删掉了链游标），仍在 switch 里显式列着。
 */
function applyExtensionEffect(ctx: EffectContextV2, raw: UnknownEffect): void {
  const found = resolveExtensionEffect(raw.type, ctx.lookup.template);
  if (found === undefined) {
    throw new Error(
      `unknown_effect: 效果类型 "${raw.type}" 既不在内核白名单（${KNOWN_EFFECT_TYPES.size} 种），也没有任何已声明的扩展注册同名 handler`,
    );
  }
  found.handler.apply(ctx.state, raw, {
    selfId: selfIdOf(ctx.state),
    ...(ctx.selfNpcId !== undefined ? { selfNpcId: ctx.selfNpcId } : {}),
    config: found.config,
    ...(ctx.logs !== undefined ? { logs: ctx.logs } : {}),
  });
}

/**
 * 链起点（ADR-0034 §5）：`chains[]` 运行时状态已删除，本函数只做**收集**——
 * 把 chainId 交给路由层（`turn.ts` 的 `enqueueChainStarts`），由它把 `startEventId`
 * 以 `delay 0` 入队。**不直接写 `slot`**（ADR-0034 §4 R3：链起点不是"直接占槽"的入口）。
 *
 * 幂等：同一条链已经跑过（起点事件已触发）或已在队列/槽里 ⇒ 不再重复收集。
 */
function startChain(state: WorldStateV2, chainId: string, lookup: TemplateLookup): boolean {
  const def = lookup.chain(chainId);
  if (!def) return false;
  if (hasFired(state, def.startEventId)) return false;
  if (state.slot?.eventId === def.startEventId) return false;
  if (state.delayQueue.some((i) => i.definitionId === def.startEventId && i.status === "waiting")) return false;
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export { createRng, pickWeighted };
export type { Rng, V2Npc, V2Player };
