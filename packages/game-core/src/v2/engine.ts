import type {
  Condition,
  Effect,
  EquipmentInstance,
  Formula,
  StatusInstance,
  V2Npc,
  V2Player,
  WorldStateV2,
  WorldTemplateV2,
  ChainStateV2,
} from "@life-sim/shared";
import { createRng, pickWeighted, type Rng } from "../rng.js";
import { amountToMinutes, createTimeAdapter } from "./time.js";
import { evaluateDynamicModifier, type ModifierConditionGate } from "./equipment.js";
import type { TemplateLookup } from "./lookup.js";

// ---------- 资源公式（规格 4.4：上限 = base + perLevel × growthLevel + Σ perAttribute[attr] × 基础属性值） ----------

/**
 * 资源上限统一计算。属性贡献使用**基础属性**（不含补正/心情档位修正）：
 * 上限若随临时状态波动，回血 clamp 与扣除语义都会漂移。
 * 玩家传 growthLevel，敌人传 0（敌人成长体现在 levelScale）。
 */
export function computeMax(
  def: { base: number; perLevel?: number; perAttribute?: Record<string, number> },
  growthLevel: number,
  baseAttrs: Record<string, number>,
  floor: number,
): number {
  let value = def.base + (def.perLevel ?? 0) * growthLevel;
  for (const [attr, coef] of Object.entries(def.perAttribute ?? {})) {
    value += coef * (baseAttrs[attr] ?? 0);
  }
  return Math.max(floor, Math.round(value));
}

export function maxHp(player: V2Player, template: WorldTemplateV2): number {
  return computeMax(template.resources.hp, player.growthLevel, player.attributes, 1);
}

export function maxMp(player: V2Player, template: WorldTemplateV2): number {
  return computeMax(template.resources.mp, player.growthLevel, player.attributes, 0);
}

// ---------- 心情档位 ----------

export function moodBand(mood: number, template: WorldTemplateV2) {
  return template.mood.bands.find((b) => mood >= b.min && mood <= b.max) ?? template.mood.bands[0];
}

// ---------- 有效属性：基础值 + 补正 simulation 面 + 装备动态补正 + 心情档位修正，再套 caps ----------

/** 属性求值链中条件求值用的确定性空 RNG（装备动态补正条件已在加载期禁用 random）。 */
export const zeroRng: Rng = () => 0;

/**
 * 有效属性求值链（协议 §19，顺序固定）：
 * 基础值 → 状态补正 × 层数 → 装备动态补正 → 心情档位 → caps。
 *
 * 第 5/6 参可选（保持既有 4 参调用兼容）：
 * - equipment：本局装备实例；每件装备的 dynamicModifier 按当前累加状态现算（R-EQ-04）。
 * - condGate：装备条件求值入口；由调用方注入（内部须用「不含装备」的基础有效属性
 *   求值 attribute 条件，避免递归）。未提供时带条件的词条当次不生效。
 */
export function effectiveAttributes(
  attrs: Record<string, number>,
  statuses: StatusInstance[],
  mood: number,
  lookup: TemplateLookup,
  equipment?: EquipmentInstance[],
  condGate?: ModifierConditionGate,
): Record<string, number> {
  const eff: Record<string, number> = { ...attrs };
  for (const inst of statuses) {
    const modifiers = lookup.status(inst.statusId)?.simulation?.attributeModifiers;
    if (!modifiers) continue;
    for (const [key, delta] of Object.entries(modifiers)) {
      eff[key] = (eff[key] ?? 0) + delta * inst.stacks;
    }
  }
  if (equipment?.length) {
    for (const inst of equipment) {
      const item = lookup.item(inst.itemId);
      const spec = item?.type === "equipment" ? item.dynamicModifier : undefined;
      if (!spec) continue;
      const deltas = evaluateDynamicModifier(spec, { effAttrs: eff, statuses, condCtx: condGate });
      for (const [key, delta] of Object.entries(deltas)) {
        eff[key] = (eff[key] ?? 0) + delta;
      }
    }
  }
  for (const [key, delta] of Object.entries(moodBand(mood, lookup.template).attributeModifiers)) {
    eff[key] = (eff[key] ?? 0) + delta;
  }
  const caps = lookup.template.attributes.caps;
  if (caps) {
    for (const [key, cap] of Object.entries(caps)) {
      if (eff[key] !== undefined) eff[key] = Math.min(eff[key], cap);
    }
  }
  return eff;
}

export function playerEffectiveAttributes(state: WorldStateV2, lookup: TemplateLookup): Record<string, number> {
  const equipment = state.player.equipment ?? [];
  if (equipment.length === 0) {
    return effectiveAttributes(state.player.attributes, state.player.statuses, state.player.mood, lookup);
  }
  // attribute 条件的求值基准 = 不含装备的基础有效属性（避免条件→属性→装备→条件递归）
  const baseEff = effectiveAttributes(state.player.attributes, state.player.statuses, state.player.mood, lookup);
  const condGate: ModifierConditionGate = (cond) =>
    checkCondition(cond, { state, lookup, rng: zeroRng, effAttrsOverride: baseEff });
  return effectiveAttributes(state.player.attributes, state.player.statuses, state.player.mood, lookup, equipment, condGate);
}

function clampAttr(template: WorldTemplateV2, key: string, value: number): number {
  const cap = template.attributes.caps?.[key];
  return cap !== undefined ? Math.min(value, cap) : value;
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
    }
  }
  return total;
}

// ---------- 补正施加（模拟域；战斗域由 battle.ts 处理） ----------

export function applyStatusToPlayer(state: WorldStateV2, statusId: string, stacks: number, lookup: TemplateLookup): void {
  const def = lookup.status(statusId);
  if (!def) return;
  const existing = state.player.statuses.find((s) => s.statusId === statusId);
  const turnsLeft = "turns" in def.duration ? def.duration.turns : undefined;
  if (existing) {
    switch (def.stacking) {
      case "refresh":
        existing.appliedTurn = state.turnIndex;
        existing.stacks = Math.max(1, stacks);
        if (turnsLeft !== undefined) existing.turnsLeft = turnsLeft;
        break;
      case "stack":
        existing.stacks += stacks;
        break;
      case "unique":
        existing.stacks = Math.max(1, existing.stacks);
        break;
    }
  } else {
    state.player.statuses.push({
      statusId,
      stacks: Math.max(1, stacks),
      appliedTurn: state.turnIndex,
      turnsLeft,
    });
  }
}

export function cureStatusFromPlayer(state: WorldStateV2, statusId: string): void {
  state.player.statuses = state.player.statuses.filter((s) => s.statusId !== statusId);
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
}

export function checkCondition(cond: Condition, ctx: ConditionContext): boolean {
  const { state, lookup, rng } = ctx;
  if ("flag" in cond) {
    const value = state.flags[cond.flag];
    if (value === undefined) return false;
    return compareValues(value, cond);
  }
  if ("attribute" in cond) {
    const eff = ctx.effAttrsOverride ?? playerEffectiveAttributes(state, lookup);
    return compareNumber(eff[cond.attribute] ?? 0, cond);
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
    const npc = state.npcs.find((n) => n.id === cond.relation);
    if (!npc) return false;
    if (cond.gte !== undefined && npc.relationship < cond.gte) return false;
    if (cond.lte !== undefined && npc.relationship > cond.lte) return false;
    return true;
  }
  if ("requiresSkill" in cond) {
    return state.player.skills.includes(cond.requiresSkill);
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

export function checkAllConditions(conditions: Condition[] | undefined, ctx: ConditionContext): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((c) => checkCondition(c, ctx));
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
  /** advanceTime 效果执行后置 true，调用方据此重新结算时间事件（schedule） */
  timeAdvanced?: boolean;
}

export function applyEffectsV2(ctx: EffectContextV2, effects: Effect[] | undefined): void {
  if (!effects) return;
  const { state, lookup, rng } = ctx;
  for (const effect of effects) {
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
        const current = state.player.attributes[effect.attribute] ?? 0;
        state.player.attributes[effect.attribute] = clampAttr(lookup.template, effect.attribute, current + effect.value);
        break;
      }
      case "adjustResource": {
        if (effect.resource === "hp") {
          state.player.hp = clamp(state.player.hp + effect.value, 1, maxHp(state.player, lookup.template));
        } else {
          state.player.mp = clamp(state.player.mp + effect.value, 0, maxMp(state.player, lookup.template));
        }
        break;
      }
      case "adjustMood":
        state.player.mood = clamp(state.player.mood + effect.value, lookup.template.mood.min, lookup.template.mood.max);
        break;
      case "adjustRelation": {
        const npcId = effect.npcId === "__self__" ? ctx.selfNpcId : effect.npcId;
        const npc = npcId ? state.npcs.find((n) => n.id === npcId) : undefined;
        if (npc) npc.relationship = clamp(npc.relationship + effect.value, -100, 100);
        break;
      }
      case "grantItem":
        state.player.inventory[effect.itemId] = (state.player.inventory[effect.itemId] ?? 0) + effect.count;
        break;
      case "removeItem": {
        const left = (state.player.inventory[effect.itemId] ?? 0) - effect.count;
        if (left > 0) state.player.inventory[effect.itemId] = left;
        else delete state.player.inventory[effect.itemId];
        break;
      }
      case "applyStatus":
        applyStatusToPlayer(state, effect.status, effect.stacks ?? 1, lookup);
        break;
      case "cureStatus":
        cureStatusFromPlayer(state, effect.status);
        break;
      case "unlockSkill":
        if (!state.player.skills.includes(effect.skillId)) state.player.skills.push(effect.skillId);
        break;
      case "adjustProficiency": {
        const key = `proficiency:${effect.skillId}`;
        const current = state.flags[key];
        state.flags[key] = (typeof current === "number" ? current : 0) + effect.value;
        break;
      }
      case "adjustGrowth":
        state.player.growthLevel += effect.value;
        break;
      case "advanceTo":
        state.worldTime = Math.max(state.worldTime, amountToMinutes(effect.value));
        state.player.age = state.playerAgeAtStart + createTimeAdapter(lookup.template).elapsedYears(state.worldTime);
        ctx.timeAdvanced = true;
        break;
      case "advanceBy":
        state.worldTime += amountToMinutes(effect.value);
        state.player.age = state.playerAgeAtStart + createTimeAdapter(lookup.template).elapsedYears(state.worldTime);
        ctx.timeAdvanced = true;
        break;
      case "startChain": {
        if (startChain(state, effect.chainId, lookup)) {
          (ctx.startedChains ??= []).push(effect.chainId);
        }
        break;
      }
      case "advanceChain":
        // 推进到下一步（nextTurn 型链由轮次管线触发事件）
        {
          const chainState = state.chains.find((c) => c.id === effect.chainId);
          if (chainState) chainState.stepIndex += 1;
        }
        break;
      case "cancelChain": {
        const chainState = state.chains.find((c) => c.id === effect.chainId);
        if (chainState) chainState.status = "completed";
        break;
      }
      case "log":
        if (effect.visibility === "public") ctx.logs?.push(effect.text);
        break;
    }
  }
}

/**
 * 注册事件链为 active。不在此处触发起点事件——起点事件由路由层（turn.ts 的
 * triggerChainStarts）按 kind 路由：normal 入待决队列、random 即时结算、combat 建战斗。
 * 这样能避免把非 normal 起点事件塞进 pendingEvents 导致「pendingEventView 返回 null 卡死」。
 */
function startChain(state: WorldStateV2, chainId: string, lookup: TemplateLookup): boolean {
  if (state.chains.some((c) => c.id === chainId)) return false;
  const def = lookup.chain(chainId);
  if (!def) return false;
  const chainState: ChainStateV2 = {
    id: chainId,
    stepIndex: 0,
    status: "active",
    startedTurn: state.turnIndex,
  };
  state.chains.push(chainState);
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export { createRng, pickWeighted };
export type { Rng, V2Npc, V2Player };
