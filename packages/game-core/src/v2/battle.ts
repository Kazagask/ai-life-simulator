import type {
  AttributeValue,
  BattleCommand,
  BattleCondition,
  BattleEnemy,
  BattleSide,
  BattleState,
  Character,
  CombatSkill,
  CombatSettle,
  CombatDuration,
  Effect,
  EquipmentInstance,
  Formula,
  Reinforcement,
  StatusApplication,
  StatusInstance,
  SummonSpec,
  RecallSpec,
  SacrificeSpec,
  V2Player,
  V2Npc,
  WorldStateV2,
} from "@life-sim/shared";
import { isCoreEffect, summonLimitOfTier, type RegenAmount } from "@life-sim/shared";
import { forkRng, pickWeighted, type Rng } from "../rng.js";
import { computeMax, effectiveAttributes, effectiveAttributesOfActor, maxHp, maxMp, moodBand, rollFormula, applyStatusTo, applyStatusToPlayer, checkCondition, zeroRng } from "./engine.js";
import { EMPTY_EQUIPMENT_COMBAT, equipmentCombatOf, type EquipmentCombat } from "./equipment.js";
import { buildPublicConditionContext, decide } from "./combat-ai.js";
import { selfIdOf } from "./actors.js";
import type { ModifierConditionGate } from "./equipment.js";
import { amountToMinutes, createTimeAdapter } from "./time.js";
import type { TemplateLookup } from "./lookup.js";
import { combatUnitResourceMax, resolveRegenAmount, resourceMax } from "./resources.js";

/**
 * 战斗内的三条独立随机流，全部从本回合新建的根流 fork（游标固定为 0）：
 *
 * - `resolve`：命中 / 闪避 / 状态概率 / 援军概率 / 逃跑 —— 旧称「战斗判定」；
 * - `ai`：选技能 —— 旧称「战斗 AI」；
 * - `target`：选目标。它不从 `ai` 再分叉，否则 AI 多抽一次就会把目标序列整体挪位。
 *
 * 模拟主线（事件调度 / 开局转盘 / 结算队列）**不在这里**，它的 RNG 消费逐字不变。
 * 传普通 `Rng` 的旧调用点退化为三条流共用同一游标（legacy 行为），
 * 生产入口 `battleActionV2` 用 `createBattleRng` 显式拆流。
 */
export interface BattleRng {
  resolve: Rng;
  ai: Rng;
  target: Rng;
}

type AiTargetPolicy = "lowest" | "random";

export function createBattleRng(rng: Rng): BattleRng {
  return {
    resolve: forkRng(rng, "battle.resolve"),
    ai: forkRng(rng, "battle.ai"),
    target: forkRng(rng, "battle.target"),
  };
}

function battleRngOf(rng: Rng | BattleRng): BattleRng {
  return "resolve" in rng ? rng : { resolve: rng, ai: rng, target: rng };
}

// ---------- 战斗内施法者抽象（玩家镜像与敌人统一结算） ----------

/**
 * 战斗内可结算的物品效果白名单（协议 §12 的子集）。
 * 未列出的效果类型必须可诊断地拒绝——不允许静默忽略（AGENTS.md §2）。
 */
const BATTLE_ITEM_EFFECTS = new Set<Effect["type"]>(["adjustResource", "cureStatus", "adjustMood", "applyStatus"]);

interface Combatant {
  /**
   * 玩家取 `selfIdOf(state)`（默认 `"player"`，扮演模板角色时是该角色 id）；
   * 敌人/友军/中立为其 instanceId。
   */
  id: string;
  name: string;
  isPlayer: boolean;
  /** ADR-012 D5：第三方阵营与敌我并列，`campsOf` 里对所有人敌对。 */
  team: "ally" | "enemy" | "neutral";
  hp: number;
  mp: number;
  /** 自定义资源（ADR-003 D8）；玩家取战斗镜像，敌人/友军取实例。 */
  resources: Record<string, number>;
  attributes: Record<string, AttributeValue>;
  statuses: StatusInstance[];
  skillCooldowns: Record<string, number>;
  mood: number;
  /** 召唤者的 instanceId（只有召唤物有；真实单位 / 玩家没有）。合法目标判定读它。 */
  summonedBy?: string;
  /** 装备的战斗轴合计（2026-11-20）；缺省 = 没有装备词条。 */
  gear: EquipmentCombat;
}

function playerCombatant(state: WorldStateV2, battle: BattleState, lookup?: TemplateLookup): Combatant {
  return {
    id: selfIdOf(state),
    name: state.player.name,
    isPlayer: true,
    team: "ally",
    hp: battle.player.hp,
    mp: battle.player.mp,
    resources: battle.player.resources,
    attributes: state.player.attributes,
    statuses: battle.player.statuses,
    skillCooldowns: battle.player.skillCooldowns,
    mood: state.player.mood,
    /**
     * 玩家的装备在 `state.player` 上：开场算一次（战斗中不能换装）。
     *
     * `lookup` 可缺省：目标合法性（`legalTargetsForPlayer`）与阵营划分不需要装备词条，
     * 为了它们把 lookup 一路穿下去只会让签名变脏 —— 缺省给空词条即可。
     */
    gear:
      lookup === undefined
        ? EMPTY_EQUIPMENT_COMBAT
        : equipmentCombatOf(state.player.equipment, lookup, (cond) =>
            checkCondition(cond, { state, lookup, rng: zeroRng }),
          ),
  };
}

function unitCombatant(unit: BattleEnemy, team: "ally" | "enemy" | "neutral"): Combatant {
  return {
    id: unit.instanceId,
    name: unit.name,
    isPlayer: false,
    team,
    hp: unit.hp,
    mp: unit.mp,
    resources: unit.resources ?? {},
    attributes: unit.attributes,
    statuses: unit.statuses,
    skillCooldowns: unit.skillCooldowns,
    mood: unit.mood ?? 50,
    gear: unit.gear ?? EMPTY_EQUIPMENT_COMBAT,
    ...(unit.summonedBy !== undefined ? { summonedBy: unit.summonedBy } : {}),
  };
}

function enemyCombatant(enemy: BattleEnemy): Combatant {
  return unitCombatant(enemy, "enemy");
}

function allyCombatant(ally: BattleEnemy): Combatant {
  return unitCombatant(ally, "ally");
}

function neutralCombatant(unit: BattleEnemy): Combatant {
  return unitCombatant(unit, "neutral");
}

/** 阵营数组的唯一映射（写回、死亡标记、回合结算都从这里取，免得三处各写一遍三分支）。 */
function unitsOf(battle: BattleState, team: "ally" | "enemy" | "neutral"): BattleEnemy[] {
  return team === "enemy" ? battle.enemies : team === "neutral" ? (battle.neutrals ?? []) : battle.allies;
}

function writeBack(battle: BattleState, c: Combatant): void {
  if (c.isPlayer) {
    battle.player.hp = c.hp;
    battle.player.mp = c.mp;
    battle.player.resources = c.resources;
    battle.player.statuses = c.statuses;
  } else {
    const unit = unitsOf(battle, c.team).find((u) => u.instanceId === c.id);
    if (unit) {
      unit.hp = c.hp;
      unit.mp = c.mp;
      unit.resources = c.resources;
      unit.statuses = c.statuses;
    }
  }
}

// ---------- 控制/状态辅助 ----------

/** 场上全部非玩家单位（敌 / 友 / 中立）。找单位时一律走这里，别各写一份。 */
function allUnits(battle: BattleState): BattleEnemy[] {
  return [...battle.enemies, ...battle.allies, ...(battle.neutrals ?? [])];
}

/**
 * 目标 HP 上限：玩家按模板资源公式计算，敌人/友军取战斗实例的 maxHp。
 * 用于治疗 clamp——超出上限的血量会被 finishBattle 持久化，下一轮 regen 再裁掉，属静默数据污染。
 */
function maxHpOf(target: Combatant, state: WorldStateV2, battle: BattleState, lookup: TemplateLookup): number {
  if (target.isPlayer) return maxHp(state.player, lookup.template);
  const unit = allUnits(battle).find((u) => u.instanceId === target.id);
  return unit?.maxHp ?? target.hp;
}

/**
 * 控制类状态判定（协议 §6.3）：状态实例里任一 `combat.control` 含该语义即为真。
 *
 * **规则只写一处**（D-08）：引擎的 performBattleAction 与本模块外部的投影层
 * （projection.ts 的 canUseItems）都调用本函数，投影不得自行查 status id 复制判定，
 * 否则「引擎会拒、投影不告知」的漂移会再次出现。
 */
export function controlOf(statuses: StatusInstance[], semantic: string, lookup: TemplateLookup): boolean {
  return statuses.some((inst) => {
    const control = lookup.status(inst.statusId)?.combat?.control;
    return control?.includes(semantic as never) ?? false;
  });
}

/** 攻击性技能：以敌方为目标或带伤害公式；cannot_attack 只拦这一类，不拦增益/治疗。 */
export function isAttackSkill(skill: CombatSkill): boolean {
  return skill.target === "enemy" || skill.target === "all_enemies" || (skill.damage?.length ?? 0) > 0;
}

/**
 * 战斗面状态的定值累加（ADR-012 D6）。
 *
 * `stacksPerLayer` 为真时乘层数；缺省是定值口径（叠层只影响时长，不改数值）。
 * 层数下限按 1 取 —— 实例上的 `stacks` 理论恒 ≥1，但旧档/夹具可能给 0。
 */
function multiplierOf(
  statuses: StatusInstance[],
  key: "damageDealt" | "damageTaken" | "hitChance",
  lookup: TemplateLookup,
  gear?: EquipmentCombat,
): number {
  // 装备词条与状态走**同一批乘区**：两条来源相加后由调用方统一夹/取整。
  let total = gear?.[key] ?? 0;
  for (const inst of statuses) {
    const facet = lookup.status(inst.statusId)?.combat;
    const value = facet?.[key];
    if (typeof value !== "number") continue;
    total += facet?.stacksPerLayer ? value * Math.max(1, inst.stacks) : value;
  }
  return total;
}

/** 某资源的消耗修正明细：投影层用它解释「为什么面板写 2、模板写 18」。 */
export function costMultiplierOf(
  statuses: StatusInstance[],
  lookup: TemplateLookup,
  resource: string,
): { total: number; sources: Array<{ id: string; name: string; value: number }> } {
  let total = 0;
  const sources: Array<{ id: string; name: string; value: number }> = [];
  for (const inst of statuses) {
    const def = lookup.status(inst.statusId);
    const value = def?.combat?.costMultiplier?.[resource];
    if (typeof value !== "number") continue;
    const applied = def?.combat?.stacksPerLayer ? value * Math.max(1, inst.stacks) : value;
    total += applied;
    sources.push({ id: inst.statusId, name: def?.name ?? inst.statusId, value: applied });
  }
  return { total, sources };
}

/**
 * 闪避率（ADR-008 D1）：命中判定通过之后再掷的一道门。
 *
 * 多来源按「至少闪掉一个」合成 `1 - Π(1 - x)`——两个 50% 的闪避叠起来是 75%，不是 100%。
 * 单一来源 `1` ⇒ 必定落空（「到不了」）。返回 `source` 只为写日志：玩家要知道是谁挡的，
 * 否则「明明打中了却没伤害」读起来像 bug。
 *
 * 对外导出是给战斗木桩用的（ADR-012）：挑招要算**期望**伤害，不折闪避的话
 * 「无下限 100%」会被当成 0 收益的反面——仪器会一直选那招打不进去的技能。
 */
export function evadeOf(
  statuses: StatusInstance[],
  lookup: TemplateLookup,
  gear?: EquipmentCombat,
): { chance: number; source: string } {
  let miss = 1;
  let best = 0;
  let source = "";
  for (const inst of statuses) {
    const def = lookup.status(inst.statusId);
    const value = def?.combat?.evade;
    if (typeof value !== "number" || value <= 0) continue;
    /**
     * 每层独立成门（ADR-012 D6）：`1-(1-v)^stacks`。三层 10% 是 27.1%，不是 30%
     * —— 三层「各躲一次」本就不是同一个概率相加。
     */
    const stacks = def?.combat?.stacksPerLayer ? Math.max(1, inst.stacks) : 1;
    const effective = 1 - Math.pow(1 - value, stacks);
    miss *= 1 - effective;
    if (effective > best) {
      best = effective;
      source = def?.name ?? inst.statusId;
    }
  }
  /**
   * 装备闪避也是**一道独立门**（同一公式）：40% 的状态 + 25% 的护具 = 55%，不是 65%。
   * 它排在状态之后算，`source` 取更高的那一个 —— 日志要能说清是谁挡的。
   */
  if (gear !== undefined && gear.evade > 0) {
    const effective = 1 - Math.pow(1 - Math.min(1, gear.evade), 1);
    miss *= 1 - effective;
    if (effective > best) {
      best = effective;
      source = "装备";
    }
  }
  return { chance: 1 - miss, source };
}

function effectiveAttrsOf(c: Combatant, lookup: TemplateLookup, state?: WorldStateV2): Record<string, number> {
  if (!c.isPlayer || !state) return effectiveAttributes(c.attributes, c.statuses, c.mood, lookup);
  // 玩家侧接入装备动态状态（协议 §19 求值链）；attribute 条件用不含装备的基础值，避免递归
  const equipment = state.player.equipment ?? [];
  const base = effectiveAttributes(c.attributes, c.statuses, c.mood, lookup);
  if (equipment.length === 0) return base;
  const gate: ModifierConditionGate = (cond) =>
    checkCondition(cond, { state, lookup, rng: zeroRng, effAttrsOverride: base });
  return effectiveAttributes(c.attributes, c.statuses, c.mood, lookup, equipment, gate);
}

// ---------- 参战 ref 判活（ADR-0021 决策 1） ----------

/** 参战引用（与模板 `settle.combat.enemies/allies` 同形） */
export interface CombatRef {
  ref: string;
  levelScale?: number;
}

/** 判活后的参战列表（纯读结果，不落盘；`inactiveNpcIds` 仅供诊断/测试断言） */
export interface ResolvedCombatRefs {
  enemies: CombatRef[];
  allies: CombatRef[];
  /** ADR-012 D5：中立单位（第三方）。 */
  neutrals: CombatRef[];
  /** 过滤后敌人为空 ⇒ 战斗不成立（空 enemies 会被 checkBattleEnd 判即胜，白送 onVictory） */
  enemiesExhausted: boolean;
  /** 被移出参战列表的 NPC 实例 id（非持久化诊断信息） */
  inactiveNpcIds: string[];
}

/**
 * 参战 ref 判活的**单一入口**（ADR-0021 决策 1.1；与 `controlOf` 的 D-08 同型：
 * 多消费点共用一个函数，规则只写一处）。
 *
 * 判据：在 `state.npcs` 找到**同 id 实例**且 `lifecycle.state !== "alive"` ⇒ 确知非在世，
 * 移出参战列表；**找不到实例 ⇒ 视为可用**（模板角色未实例化，如纯敌人定义 `enemy-*`
 * 永不建实例，若按死亡处理会把全部战斗清空）。同口径先例：ADR-0020 关系冻结
 * 「只拦确知非在世，找不到端点按可写处理」。
 *
 * **不报错**：死者重新出现在 ref 里不视为模板错误，只是「该单位不在场」（ADR-0012 决策 2 修订）。
 * `lookup.character(ref)` 缺失仍抛 `character_not_found`（引用完整性错误，与判活无关，
 * 故校验先于过滤：改成过滤优先会让「死引用 + 未知 id」静默通过）。
 *
 * 纯函数：只读 state / lookup，不调 rng、不写状态 ⇒ 同 seed 结果不受影响。
 */
export function resolveCombatRefs(
  refs: Pick<CombatSettle, "enemies" | "allies" | "neutrals">,
  state: WorldStateV2,
  lookup: TemplateLookup,
): ResolvedCombatRefs {
  const inactiveNpcIds: string[] = [];
  const keepAlive = (list: readonly CombatRef[] | undefined): CombatRef[] =>
    (list ?? []).filter((r) => {
      const def = lookup.character(r.ref);
      if (!def) throw new Error(`character_not_found: ${r.ref}`);
      const instance = state.npcs.find((n) => n.id === r.ref);
      if (instance && instance.lifecycle.state !== "alive") {
        inactiveNpcIds.push(r.ref);
        return false;
      }
      return true;
    });
  const enemies = keepAlive(refs.enemies);
  const allies = keepAlive(refs.allies);
  const neutrals = keepAlive(refs.neutrals);
  return { enemies, allies, neutrals, enemiesExhausted: enemies.length === 0, inactiveNpcIds };
}

// ---------- 建场 ----------

export function createBattle(
  eventId: string,
  settle: CombatSettle,
  state: WorldStateV2,
  lookup: TemplateLookup,
): BattleState {
  // 判活一次，敌人/友军/中立共用同一份解析结果（规则只写一处）
  const resolved = resolveCombatRefs(settle, state, lookup);
  const enemies = buildUnits(resolved.enemies, state, lookup, "enemy");
  const allies = buildUnits(resolved.allies, state, lookup, "ally");
  const neutrals = buildUnits(resolved.neutrals, state, lookup, "neutral");

  return {
    eventId,
    settle,
    round: 1,
    player: {
      hp: state.player.hp,
      mp: state.player.mp,
      // ADR-003 D8：自定义资源镜像进战斗；结束时由 finishBattle 回写。
      resources: { ...state.player.resources },
      statuses: state.player.statuses.map((s) => ({ ...s })),
      skillCooldowns: {},
    },
    enemies,
    allies,
    neutrals,
    // ADR-013 D4：收回的召唤物停在这里，战斗一结束随 `battle` 一起丢弃（下一场满状态）。
    bench: [],
    // ADR-012 D3：中途加入的进度表（旧档缺省空表 ⇒ 不会重放）。
    reinforcementFires: {},
    log: [],
    over: null,
  };
}

/** 构建战斗单位的可选参数（ADR-012）：开场单位不传，召唤 / 中途加入才带。 */
interface BuildUnitOptions {
  instanceId?: string;
  levelScale?: number;
  tier?: "minion" | "hero";
  summonedBy?: string;
  enteredRound?: number;
  /** 召它的角色 id（ADR-013）：召回后重新召唤靠它对上号。 */
  summonRef?: string;
  dismissOnSummonerDown?: boolean;
  /** 阵营（2026-11-20）：已退场名册是混合列表，靠它上色。 */
  side?: BattleSide;
}

/** 装备授予的技能（ADR-012 D7）：`items.yaml` 的 `grantsSkill`，持有即拥有。 */
function grantedSkills(equipment: readonly EquipmentInstance[] | undefined, lookup: TemplateLookup): string[] {
  const out: string[] = [];
  for (const inst of equipment ?? []) {
    const skill = lookup.item(inst.itemId)?.grantsSkill;
    if (typeof skill === "string" && !out.includes(skill)) out.push(skill);
  }
  return out;
}

/**
 * 玩家的可用技能 = 自身技能 ∪ 装备授予（ADR-012 D7）。
 *
 * 单一入口：`skill_not_owned` 判定、战斗面板技能列表都从这里取。两处各自
 * `state.player.skills.includes(...)` 就是「天逆鉾拿在手上，界面上却没有那一招」的来源。
 */
export function playerSkills(state: WorldStateV2, lookup: TemplateLookup): string[] {
  const grants = grantedSkills(state.player.equipment, lookup);
  if (grants.length === 0) return [...state.player.skills];
  const owned = new Set([...state.player.skills, ...grants]);
  return [...owned];
}

/**
 * 从**角色定义**构建一个战斗单位（ADR-012 D1：`buildUnits` 的单件版本，召唤与中途加入共用）。
 *
 * 资源池只建**角色声明过的**专属键（ADR-012 D9）：`world.resources` 是全局池，
 * 一写在模板上就是「人人都有」——「咒灵数量」挂在夏术师身上成立，挂在别人身上就是 bug。
 */
export function buildUnit(
  def: Character,
  state: WorldStateV2,
  lookup: TemplateLookup,
  opts: BuildUnitOptions = {},
): BattleEnemy {
  const scale = opts.levelScale ?? 1;
  const statusInstances: StatusInstance[] = (def.statuses ?? []).map((id) => ({
    statusId: id,
    stacks: 1,
    appliedTurn: state.turnIndex,
    appliedAt: state.worldTime,
  }));
  // ADR-010 D3：模板声明的装备在构建战斗单位时实例化，词条走与玩家同一条链路。
  const equipment: EquipmentInstance[] | undefined = def.equipment?.length
    ? def.equipment.map((itemId, idx) => ({
        instanceId: `${def.id}#eq${idx + 1}`,
        itemId,
        ownerId: def.id,
        slot: lookup.item(itemId)?.slot ?? "weapon",
      }))
    : undefined;
  /**
   * 有效属性（含 simulation 状态 + 装备词条 + 心情档位）。
   * **这是行为变化**：以前这里直接读模板 `attributes`，NPC 身上的体质类状态与
   * 装备词条在战斗里整个被跳过（ADR-010 审计发现的「NPC 三等公民」之一）。
   */
  const eff = effectiveAttributesOfActor(state, lookup, {
    attributes: def.attributes,
    statuses: statusInstances,
    mood: def.mood.value,
    equipment,
  });
  const attributes: Record<string, AttributeValue> = {};
  for (const [k, v] of Object.entries(def.attributes)) {
    // ADR-003：只有数值属性随 levelScale 缩放；文本属性原样复制。
    attributes[k] = typeof v === "number" ? Math.round((eff[k] ?? v) * scale) : v;
  }
  // ADR-012 D9：专属资源池（自带上限，只有声明过的角色才有）。
  const resources: Record<string, number> = {};
  const resourceMax: Record<string, number> = {};
  for (const [key, pool] of Object.entries(def.resources ?? {})) {
    const max = Math.max(0, Math.round(pool.max * scale));
    resourceMax[key] = max;
    resources[key] = Math.max(0, Math.min(max, Math.round(pool.value)));
  }
  const skills = [...new Set([...(def.skills ?? []), ...grantedSkills(equipment, lookup)])];
  /**
   * 装备的战斗轴词条（2026-11-20）：与有效属性同一时机烘进单位 ——
   * 战斗中不能换装，所以整场不变；存进单位是为了让存档重载后仍然一致。
   */
  const gear = equipmentCombatOf(equipment, lookup, (cond) =>
    checkCondition(cond, { state, lookup, rng: zeroRng }),
  );
  const weights = (def.private.combatHints?.skillWeights as Record<string, number> | undefined) ?? {};
  const maxHpValue = Math.round(computeMax(lookup.template.resources.hp, 0, eff, 1) * scale);
  const maxMpValue = Math.round(computeMax(lookup.template.resources.mp, 0, eff, 0) * scale);
  return {
    instanceId: opts.instanceId ?? `${def.id}#1`,
    characterId: def.id,
    name: def.identity.name,
    hp: maxHpValue,
    maxHp: maxHpValue,
    mp: maxMpValue,
    maxMp: maxMpValue,
    attributes,
    resources,
    ...(Object.keys(resourceMax).length > 0 ? { resourceMax } : {}),
    /** ADR-010 D3：心情进战斗（以前 unitCombatant 写死 50，NPC 的心情从不影响判定）。 */
    mood: def.mood.value,
    ...(def.combatRegen !== undefined ? { combatRegen: { ...def.combatRegen } } : {}),
    statuses: statusInstances,
    skillCooldowns: {},
    skills,
    skillWeights: weights,
    alive: true,
    ...(opts.tier !== undefined ? { tier: opts.tier } : {}),
    ...(opts.summonedBy !== undefined ? { summonedBy: opts.summonedBy } : {}),
    ...(opts.enteredRound !== undefined ? { enteredRound: opts.enteredRound } : {}),
    ...(opts.summonRef !== undefined ? { summonRef: opts.summonRef } : {}),
    ...(opts.dismissOnSummonerDown !== undefined ? { dismissOnSummonerDown: opts.dismissOnSummonerDown } : {}),
    ...(opts.side !== undefined ? { side: opts.side } : {}),
    ...(gear.hitChance !== 0 ||
    gear.evade !== 0 ||
    gear.damageDealt !== 0 ||
    gear.damageTaken !== 0 ||
    gear.guaranteedHit
      ? { gear }
      : {}),
  };
}

/**
 * 从**已判活**的角色引用构建战斗单位（敌人/友军/中立共用）。
 * 入参必须是 `resolveCombatRefs` 的输出——本函数不做生命周期判断，避免判定散落两处。
 */
function buildUnits(
  refs: readonly CombatRef[],
  state: WorldStateV2,
  lookup: TemplateLookup,
  side: BattleSide,
): BattleEnemy[] {
  return refs.map((ref, i) => {
    const def = lookup.character(ref.ref);
    if (!def) throw new Error(`character_not_found: ${ref.ref}`);
    return buildUnit(def, state, lookup, {
      instanceId: `${def.id}#${i + 1}`,
      side,
      ...(ref.levelScale !== undefined ? { levelScale: ref.levelScale } : {}),
    });
  });
}

// ---------- 结算：命中判定 ----------

function hitChance(caster: Combatant, target: Combatant, skill: CombatSkill, lookup: TemplateLookup, state?: WorldStateV2): number {
  if (!skill.hitCheck) return 1;
  const effA = effectiveAttrsOf(caster, lookup, state);
  const effD = effectiveAttrsOf(target, lookup, state);
  const raw =
    skill.hitCheck.baseChance +
    ((effA[skill.hitCheck.attacker] ?? 0) - (effD[skill.hitCheck.defender] ?? 0)) * 0.05 +
    multiplierOf(caster.statuses, "hitChance", lookup, caster.gear);
  return Math.max(0.05, Math.min(0.95, raw));
}

// ---------- 施放消耗（ADR-003 D9：mp 与自定义资源同一套检查/扣除） ----------

/** 返回第一个不足的资源 key；全部足够返回 undefined。 */
function missingCost(c: Combatant, cost: Record<string, number>): string | undefined {
  for (const [key, amount] of Object.entries(cost)) {
    if (amount <= 0) continue;
    const value = key === "hp" ? c.hp : key === "mp" ? c.mp : (c.resources[key] ?? 0);
    if (value < amount) return key;
  }
  return undefined;
}

/** 扣除全部消耗（调用前必须先 `missingCost`；这里只做夹 0，不做二次判定）。 */
function payCost(c: Combatant, cost: Record<string, number>): void {
  for (const [key, amount] of Object.entries(cost)) {
    if (amount <= 0) continue;
    if (key === "hp") c.hp = Math.max(0, c.hp - amount);
    else if (key === "mp") c.mp = Math.max(0, c.mp - amount);
    else c.resources[key] = Math.max(0, (c.resources[key] ?? 0) - amount);
  }
}

/**
 * 施放消耗的**实际价格**（ADR-018 D3）：`cost[key] = ceil(base[key] × max(0, 1 + Σ[key]))`。
 *
 * 每个资源各算各的 —— 旧实现只给 `mp` 打折，而技能的 `cost` 早就是「mp + 任意资源」，
 * 于是「召唤消耗 -20%」这种写法在协议里根本表达不出来。
 * 向上取整是显式的：`18 × 0.1 = 1.8 → 2`，用 round 会让 -90% 漂成 -96%。
 */
function effectiveCost(cost: Record<string, number>, statuses: StatusInstance[], lookup: TemplateLookup): Record<string, number> {
  let changed = false;
  const out: Record<string, number> = {};
  for (const [key, amount] of Object.entries(cost)) {
    if (amount <= 0) {
      out[key] = amount;
      continue;
    }
    const factor = Math.max(0, 1 + costMultiplierOf(statuses, lookup, key).total);
    if (factor === 1) {
      out[key] = amount;
      continue;
    }
    out[key] = Math.max(0, Math.ceil(amount * factor));
    changed = true;
  }
  return changed ? out : cost;
}

/** 单位的资源当前值（hp/mp 在字段上，其余在 `resources`）。 */
function poolOf(c: Combatant, key: string): number {
  if (key === "hp") return c.hp;
  if (key === "mp") return c.mp;
  return c.resources[key] ?? 0;
}

/**
 * 召唤名额（ADR-012 D2 修订）：**世界维度、按档共享**——实现与缺省表都在
 * `@life-sim/shared` 的 `summonLimitOfTier` / `SUMMON_TIER_LIMITS`。
 * 这里只做转出，保证「引擎 / 投影 / 木桩」拿的是同一份。
 */
export { SUMMON_TIER_LIMITS, summonLimitOfTier } from "@life-sim/shared";

/**
 * 某召唤者当前存活的某档召唤物（上限按档统计，不按 ref）。
 *
 * **按阵营取，不按 `summonedBy` 全局取**（ADR-016 D3 修正，用户 2026-11-20：
 * 「替换的时候别把中立单位替换掉，只能替换友方单位」）：
 *  - 中立的召唤物（未调伏的魔虚罗）不在你的战力里，它既不占你的名额，也不会被顶掉 ——
 *    放出去的东西收不回来，也同样挤不下去；
 *  - 替换池因此天然等于「你的同阵营召唤物」，不需要在替换处再判一次阵营。
 */
function summonsOf(
  battle: BattleState,
  ownerId: string,
  tier: "minion" | "hero",
  team: "ally" | "enemy" | "neutral",
): BattleEnemy[] {
  return unitsOf(battle, team).filter(
    (u) => u.alive && u.summonedBy === ownerId && (u.tier ?? "minion") === tier,
  );
}

/**
 * 英雄档召唤物是否已经永久失去（ADR-013 D3）。
 *
 * 单一判定：`canUseSkill` 拒绝、战斗面板隐藏技能、模拟器挑招，都走这里 ——
 * 三处各写一遍 `lostSummons.includes(ref)` 就会出现「界面上没了、AI 还在挑」。
 */
export function summonLost(state: WorldStateV2, spec: SummonSpec | undefined): boolean {
  if (spec === undefined || spec.tier !== "hero") return false;
  return (state.lostSummons ?? []).includes(spec.ref);
}

function combatantOf(
  battle: BattleState,
  state: WorldStateV2,
  id: string,
  lookup: TemplateLookup,
): Combatant | undefined {
  if (id === selfIdOf(state)) return playerCombatant(state, battle, lookup);
  const unit = allUnits(battle).find((u) => u.instanceId === id);
  if (!unit) return undefined;
  const team: Combatant["team"] = battle.enemies.includes(unit)
    ? "enemy"
    : battle.allies.includes(unit)
      ? "ally"
      : "neutral";
  return unitCombatant(unit, team);
}

/**
 * 目标合法性（`LegalTargetSchema`）：返回拒绝码，合法返回 null。
 *
 * **唯一入口**：`canUseSkill`（面板置灰）与 `performBattleAction`（服务端兜底）都走这里，
 * 免得出现「面板说能放、引擎拒」或反过来。`target_required` 只对**需要点选**的目标类型
 * （`ally`）成立 —— 召唤 / 全体技能本来就没有单目标。
 */
export function legalTargetIdsOf(
  battle: BattleState,
  state: WorldStateV2,
  caster: Combatant,
  skill: CombatSkill,
): string[] {
  if (skill.target !== "enemy" && skill.target !== "ally") return [];
  const { hostile, friendly } = campsOf(battle, state, caster);
  const pool = skill.target === "ally" ? friendly : hostile;
  const rule = skill.legalTarget;
  return pool
    .filter((u) => rule?.summonedBy !== "self" || u.summonedBy === caster.id)
    .map((u) => u.id);
}

/**
 * 投影用：把**玩家**当施放者时的合法目标 id。
 *
 * 前端只做 `legalTargets.includes(选中id)`，不再重算规则 —— 否则「面板说能选、引擎拒」
 * 这类双份真相迟早出现（`legalTarget` 新增谓词时前端必须同步改，等于把协议抄两遍）。
 */
export function legalTargetsForPlayer(
  battle: BattleState,
  state: WorldStateV2,
  skill: CombatSkill,
): string[] {
  // 目标合法性不看装备词条（只判阵营与召唤归属），所以不穿 lookup。
  return legalTargetIdsOf(battle, state, playerCombatant(state, battle), skill);
}

export function legalTargetIssue(
  battle: BattleState,
  state: WorldStateV2,
  caster: Combatant,
  skill: CombatSkill,
  targetInstanceId: string | undefined,
): "target_not_legal" | null {
  if (skill.target !== "enemy" && skill.target !== "ally") return null;
  const legal = legalTargetIdsOf(battle, state, caster, skill);
  if (targetInstanceId === undefined) {
    /**
     * 没点选 = 引擎缺省（AI、旧调用）：无规则的技能照旧走各自缺省目标，
     * 有规则的要求「至少存在一个合法目标」——否则这一发放出来必然空手。
     */
    return skill.legalTarget !== undefined && legal.length === 0 ? "target_not_legal" : null;
  }
  return legal.includes(targetInstanceId) ? null : "target_not_legal";
}

/**
 * 这一招对这个人**实际要花多少**（ADR-012 D8）。投影层显示价格用，
 * 与 `canUseSkill` / `payCost` 同一个函数，所以面板上写 2 就真的扣 2。
 */
export function effectiveCostOf(
  state: WorldStateV2,
  battle: BattleState,
  casterId: string,
  skillId: string,
  lookup: TemplateLookup,
): Record<string, number> {
  const caster = combatantOf(battle, state, casterId, lookup);
  const skill = lookup.skill(skillId);
  if (!caster || skill === undefined || skill.kind !== "combat") return {};
  return effectiveCost(skill.cost, caster.statuses, lookup);
}

/**
 * 能不能用这一招 —— **唯一判定入口**（ADR-012 D1）。
 *
 * 以前「够不够钱 / 冷却 / cannot_attack」在 `performBattleAction`、`aiTurn`、投影置灰、
 * 仪器挑招四处各写一遍。加了召唤弹药与上限之后会变第五处，所以收成一条：
 * 引擎把 `reason` 翻成错误码，其余三处直接用结论（AI 不再浪费回合放不出来的招，
 * 面板也能说出「为什么灰」）。
 *
 * `casterId`：玩家用 `selfIdOf(state)`，单位用 `instanceId`。
 */
export function canUseSkill(
  state: WorldStateV2,
  battle: BattleState,
  casterId: string,
  skillId: string,
  lookup: TemplateLookup,
  /** 已选中的目标（可选）：给了就检查合法性；不给则只判「技能本身能不能放」。 */
  targetInstanceId?: string,
): { ok: true } | { ok: false; reason: string } {
  const skill = lookup.skill(skillId);
  if (!skill || skill.kind !== "combat") return { ok: false, reason: "skill_not_found" };
  const caster = combatantOf(battle, state, casterId, lookup);
  if (!caster) return { ok: false, reason: "caster_not_found" };
  const owned = caster.isPlayer
    ? playerSkills(state, lookup)
    : (allUnits(battle).find((u) => u.instanceId === casterId)?.skills ?? []);
  if (!owned.includes(skillId)) return { ok: false, reason: "skill_not_owned" };
  if (controlOf(caster.statuses, "cannot_use_skills", lookup)) return { ok: false, reason: "cannot_use_skills" };
  if (isAttackSkill(skill) && controlOf(caster.statuses, "cannot_attack", lookup)) {
    return { ok: false, reason: "cannot_attack" };
  }
  const cooldowns = caster.isPlayer
    ? battle.player.skillCooldowns
    : (allUnits(battle).find((u) => u.instanceId === casterId)?.skillCooldowns ?? {});
  if ((cooldowns[skill.id] ?? 0) > 0) return { ok: false, reason: "skill_on_cooldown" };
  const missing = missingCost(caster, effectiveCost(skill.cost, caster.statuses, lookup));
  if (missing !== undefined) {
    return { ok: false, reason: missing === "mp" ? "not_enough_mp" : `not_enough_resource:${missing}` };
  }
  if (skill.summon !== undefined) {
    /** ADR-013 D3：英雄档没了就是没了，本局再也召不出来。 */
    if (skill.summon.tier === "hero" && caster.id === selfIdOf(state) && summonLost(state, skill.summon)) {
      return { ok: false, reason: "summon_lost" };
    }
    /**
     * ADR-016 D3：**满员不再是拒绝理由**。
     *
     * 从前这里有一条 `summonsOf(...).length >= limit ⇒ summon_limit`，于是换一只式神要先
     * 「收」再「召」，白扔两三个回合；而玩家看到的是「我明明有名额，为什么不行」。
     * 现在的口径是「后面的替换前面的」—— 满员时 `performSummon` 把最早上场的挪进回收架，
     * 所以没有需要拦的情况。
     */
  }
  if (skill.recall !== undefined) {
    /**
     * 只看**场上**：已经在回收架里的那只不必再收一次（它本来就不在场上）。
     *
     * ADR-014 D5：只看**同阵营**。中立的召唤物收不回来 —— 暴走的式神没有「收回」这个动作，
     * 而「收得回来」正是调伏与否的分界线。闸门与 `performRecall` 同口径，否则面板上会留一个
     * 按下去什么也不发生的技能。
     */
    const recallable = unitsOf(battle, caster.team).some((u) => u.alive && u.summonedBy === caster.id);
    if (!recallable) return { ok: false, reason: "recall_empty" };
  }
  {
    const issue = legalTargetIssue(battle, state, caster, skill, targetInstanceId);
    if (issue !== null) return { ok: false, reason: issue };
  }
  if (skill.sacrifice !== undefined) {
    /**
     * 至少要有一支可烧的（ADR-013 D5）。旋涡没有祭品就只是 25 点 MP 换个基础伤害 ——
     * 那不是技能坏了，是没有条件，所以按「放不出」处理并说清理由。
     *
     * 只数同阵营（ADR-016 D3 补）：中立的魔虚罗不受指挥，不可能是祭品。
     */
    if (!unitsOf(battle, caster.team).some((u) => u.alive && u.summonedBy === caster.id)) {
      return { ok: false, reason: "sacrifice_empty" };
    }
  }
  return { ok: true };
}

// ---------- 结算：技能 ----------

interface SkillTargets {
  caster: Combatant;
  targets: Combatant[];
}

/** 施放者视角的两大阵营（`all_enemies` / `all_allies` 施加点用；与技能目标解析共用一份）。 */
interface Camps {
  hostile: Combatant[];
  friendly: Combatant[];
}

function campsOf(
  battle: BattleState,
  state: WorldStateV2,
  caster: Combatant,
  /**
   * 已在结算中的单位（本技能的目标 / 施放者）。**必须复用**这些快照：
   * `Combatant` 是值拷贝，重造一份会拿到「这一轮伤害还没写回」的旧血量，
   * 阵营状态收尾时再 `writeBack` 一次就把刚打出的伤害擦掉了
   * （范围技能＝全体伤害＋全体压制，正是这个形状，旧实现里伤害永远不落地）。
   */
  known?: ReadonlyMap<string, Combatant>,
): Camps {
  const take = (unit: Combatant): Combatant => known?.get(unit.id) ?? unit;
  const allyUnits: Combatant[] = [
    take(playerCombatant(state, battle)),
    ...battle.allies.filter((a) => a.alive).map((a) => take(allyCombatant(a))),
  ];
  const enemyUnits: Combatant[] = battle.enemies.filter((e) => e.alive).map((e) => take(enemyCombatant(e)));
  /**
   * ADR-012 D5：中立对**所有人**敌对，所以它同时出现在双方的 `hostile` 里；
   * 它自己的 `hostile` 是全场其余人。这样「暴走的东西站在中间抽两边」不需要任何特判，
   * 而它又不在 `enemies` 数组里 ⇒ 不会因为被打死而白送一场胜利。
   */
  // 旧夹具 / 旧档可能没有这一段：按空数组处理，别让投影在「没中立」的战场上崩。
  const neutralUnits: Combatant[] = (battle.neutrals ?? [])
    .filter((n) => n.alive)
    .map((n) => take(neutralCombatant(n)));
  if (caster.team === "neutral") {
    return { hostile: [...allyUnits, ...enemyUnits], friendly: neutralUnits };
  }
  return caster.team === "ally"
    ? { hostile: [...enemyUnits, ...neutralUnits], friendly: allyUnits }
    : { hostile: [...allyUnits, ...neutralUnits], friendly: enemyUnits };
}

function resolveTargets(
  battle: BattleState,
  state: WorldStateV2,
  caster: Combatant,
  skill: CombatSkill,
  targetInstanceId: string | undefined,
  lookup: TemplateLookup,
): SkillTargets {
  // forced_target_self（协议 §6.3）：行动目标强制为自身，覆盖技能的声明目标
  if (controlOf(caster.statuses, "forced_target_self", lookup)) {
    return { caster, targets: [caster] };
  }
  const { hostile, friendly } = campsOf(battle, state, caster);
  switch (skill.target) {
    case "self":
      return { caster, targets: [caster] };
    case "enemy": {
      /**
       * 敌对阵营里的单体，按目标实例挑，缺省敌方首位（主角）。
       * `hostile` 已含中立单位（ADR-012 D5），所以点中立怪也能选中它；
       * 对手是敌方阵营时 `hostile[0]` 就是玩家，与旧行为一致。
       */
      const def = targetInstanceId ? hostile.find((h) => h.id === targetInstanceId) : hostile[0];
      return { caster, targets: def ? [def] : [] };
    }
    case "all_enemies":
      return { caster, targets: hostile };
    case "all_allies":
      /**
       * 友军**全体**：与 `all_enemies` 对称，一次结算给整支友军（含自己）。
       * 和 `ally`（单体）分开：旧实现把两者混成一个 `friendly` 数组，
       * 于是「治疗一个队友」和「治疗全队」在数据上无法区分。
       */
      return { caster, targets: friendly };
    case "none":
      /**
       * 无目标（召唤 / 收灵 / 自我强化）：不进目标循环，只跑循环外的部分
       * （`summon` / `recall` / `applyStatus.target: self`）。写 `self` 会让面板显示
       * 「目标：自身」，读起来像「对自己施法」——召唤并不指定任何人。
       */
      return { caster, targets: [] };
    case "ally": {
      /**
       * 友军**单体**（ADR-012 D6 补）。旧实现直接返回整个 `friendly`，于是「治疗一个队友」
       * 变成了群体治疗；而前端也从来没传过友军目标 —— `targetInstanceId` 原本只对 `enemy` 生效。
       *
       * 缺省取 `friendly[0]`：友军阵营的第一位就是玩家，所以「不指定 = 治疗自己」与直觉一致。
       * 传入的 id 不在这边时同样回落到缺省，不返回空目标（那会让技能白扣钱白进冷却）。
       */
      const def = targetInstanceId ? friendly.find((f) => f.id === targetInstanceId) : undefined;
      return { caster, targets: [def ?? friendly[0] ?? caster] };
    }
  }
}

/**
 * 施加点收件人（ADR-006 D1）。`onSelf` 是旧写法，等价 `self`。
 *
 * 单一入口：引擎结算、模板校验、展示层「施加 … （自身）」都从这里取口径，
 * 免得三处各写一遍 `onSelf ?? false` 的推断。
 */
function applyTargetOf(app: StatusApplication): "self" | "skill" | "all_enemies" | "all_allies" {
  if (app.target !== undefined) return app.target;
  return app.onSelf === true ? "self" : "skill";
}

/** 资源表（含 hp/mp），给 `rollFormula` 的 `resource-scaled` 用。 */
function resourceSheet(c: Combatant): Record<string, number> {
  return { hp: c.hp, mp: c.mp, ...c.resources };
}

function setPool(c: Combatant, key: string, value: number): void {
  if (key === "hp") c.hp = value;
  else if (key === "mp") c.mp = value;
  else c.resources[key] = value;
}

/**
 * 往池子里加（召回返还用）：夹到 [0, 上限]。
 * 上限走 `maxResourceOf`，与扣费/回复同一条公式，免得「退还之后比上限还多」。
 */
function addPool(
  c: Combatant,
  key: string,
  amount: number,
  state: WorldStateV2,
  battle: BattleState,
  lookup: TemplateLookup,
): void {
  const max = maxResourceOf(c, key, state, battle, lookup);
  setPool(c, key, Math.max(0, Math.min(max, poolOf(c, key) + amount)));
}

/**
 * 召来的单位「叫什么」（ADR-013 D1）：`ref` + 召唤者。回收再召靠这对键认亲，
 * 不靠实例 id —— 实例 id 是运行时编号，玩家看不见，也不该被当成身份。
 */
function isSameSummon(unit: BattleEnemy, ref: string, ownerId: string): boolean {
  return unit.summonRef === ref && unit.summonedBy === ownerId;
}

/**
 * 从场上拿掉一个单位（不进回收架、不判定阵亡）—— 召回与替换共用。
 *
 * 按 `instanceId` 在三支阵营里找，而不是按 `caster.team`：召唤物未必和召唤者同阵营
 * （ADR-014 的中立式神就站在中立项里），替换时被挤下场的还可能是上一手留下的另一族。
 */
/** 退场单位留一份带原因的快照，供战斗面板解释「那只怎么没的」。 */
function rememberFallen(battle: BattleState, unit: BattleEnemy): void {
  battle.fallen = [...(battle.fallen ?? []), unit];
}

function removeFromField(battle: BattleState, unit: BattleEnemy): void {
  for (const team of ["ally", "enemy", "neutral"] as const) {
    const list = unitsOf(battle, team);
    const idx = list.findIndex((u) => u.instanceId === unit.instanceId);
    if (idx >= 0) {
      list.splice(idx, 1);
      return;
    }
  }
}

/**
 * 召唤（ADR-012 D1 / ADR-013 D1）：把角色定义实例化后塞进施放者同阵营。
 *
 * **先看回收架**：同一场战斗里收回过的那一只，状态原样搬回来（血量、状态、冷却、
 * 入场回合），只补一个「又上场了」的日志。没有才现场造新的 —— 所以
 * 「收回再召」是**同一只**，不是新的一只，这正是用户要的「状态继承」。
 *
 * 召唤不扣任何资源（ADR-013 D2）：稀缺性由 `limit`（场上限）与英雄的永久损失表达。
 */
function performSummon(
  battle: BattleState,
  state: WorldStateV2,
  caster: Combatant,
  spec: SummonSpec,
  lookup: TemplateLookup,
  log: (text: string) => void,
): void {
  const def = lookup.character(spec.ref);
  if (!def) return;
  const tier = spec.tier ?? "minion";
  const limit = summonLimitOfTier(spec.tier, lookup.template);
  /** 一次最多摆 `limit` 只：`count` 写得比 `limit` 大没有意义，多出来的直接不要。 */
  const want = Math.min(spec.count ?? 1, limit);
  /**
   * **落点阵营先定，名额与替换池都按它算**（ADR-016 D3）。
   *
   * 早先这里写的是 `caster.team`，于是召中立魔虚罗时，它把自己算进「我的英雄档」里 ——
   * 玉犬正占着那唯一的名额，于是玉犬被顶进回收架，中间站出一只不受控的魔虚罗。
   * 用户 02:26 实测：「召唤魔虚罗的时候把玉犬替了」。
   * 落点在中立项，就该按中立项数名额：不占你的档，也挤不掉你的式神（中立之间才互相替换）。
   */
  const team = spec.faction === "neutral" ? "neutral" : caster.team;
  const own = summonsOf(battle, caster.id, tier, team);
  /** 补满而非硬塞（ADR-013）：站着两只时 `count: 3` 只补第三只。 */
  const room = Math.max(0, limit - own.length);
  const bench = battle.bench ?? [];
  /**
   * ADR-016 D3：**名额满了不是拒绝，是替换**（用户 2026-11-20：「召唤超出限制时，
   * 后面的替换前面的」）。
   *
   * 从前满员直接 `summon_limit`，于是十影只能先「收」（花掉一个回合）再「召」——
   * 换一只式神要空转两三个回合，比不带这一手还难受。现在满员就把**最早上场**的那批
   * 挪进回收架（与主动收回同一个去处，不阵亡、不进 `lostSummons`），新的一批顶上去。
   *
   * 只在**一只都塞不下**时替换：还有空位就照旧补满，`count: 3` 站着两只补第三只这件事
   * 不变（ADR-013 D2 的承诺没被推翻，只是补不进去时不再报错）。
   */
  const evictedIds = new Set<string>();
  let count = Math.min(want, room);
  if (count === 0) {
    // 后浪推前浪：`own` 的顺序就是上场顺序（数组追加），所以 slice 出来的就是最早那批。
    for (const unit of own.slice(0, want)) {
      removeFromField(battle, unit);
      bench.push(unit);
      evictedIds.add(unit.instanceId);
      log(`${unit.name}被替换下场。`);
    }
    count = want;
  }
  /**
   * ADR-014 D1：`faction: neutral` ⇒ 进中立项。之后的敌我不分**不用任何新代码** ——
   * `campsOf` 早就规定中立对所有人敌对，`aiTurn` 也从两边挑目标。
   */
  const list = unitsOf(battle, team);
  for (let i = 0; i < count; i += 1) {
    /**
     * 回收架优先：同一只回来了，带着它离开时的伤。
     *
     * 但**刚被这次召唤挤下场的不算**：否则满员重召就是「把三只挪进回收架，再把同一批
     * 原样搬回来」——花掉 MP，场上一个像素都没变。
     */
    const back = bench.findIndex((u) => isSameSummon(u, spec.ref, caster.id) && !evictedIds.has(u.instanceId));
    if (back >= 0) {
      const [unit] = bench.splice(back, 1);
      unit.alive = true;
      delete unit.deathReason;
      list.push(unit);
      log(`${unit.name}应召而回。`);
      continue;
    }
    const unit = buildUnit(def, state, lookup, {
      instanceId: nextSummonId(battle, def.id),
      tier,
      side: team,
      summonedBy: caster.id,
      enteredRound: battle.round,
      summonRef: spec.ref,
      dismissOnSummonerDown: spec.onSummonerDown !== "stay",
      ...(spec.levelScale !== undefined ? { levelScale: spec.levelScale } : {}),
    });
    list.push(unit);
    log(`${unit.name}应召而来。`);
  }
  battle.bench = bench;
}

/**
 * 实例 id 取**单调序号**（ADR-013 修正）：原先用 `allUnits(battle).length` 起算，
 * 一旦有单位阵亡 / 被收回，长度会变短，下一只召出来的就与在场的撞名 ——
 * 而 `writeBack` 是按实例 id 找人的，撞名等于把伤害写到别人身上。
 * 序列号挂在 `battle` 上只增不减，长度变化影响不到它。
 */
function nextSummonId(battle: BattleState, base: string): string {
  const used = new Set(allUnits(battle).map((u) => u.instanceId));
  let seq = battle.summonSeq ?? 0;
  let id = "";
  do {
    seq += 1;
    id = `${base}#s${seq}`;
  } while (used.has(id));
  battle.summonSeq = seq;
  return id;
}

/**
 * 召回（ADR-012 D1 / ADR-013 D4）：把自己召唤的单位收回**回收架**，不返还任何东西。
 *
 * 收回 ≠ 阵亡：它还活着，只是不在场上。状态（含 `enteredRound`）原样留着，
 * 同一场里再召就原位回来；战斗结束 `battle` 整个丢掉，于是下一场自动满状态。
 */
function performRecall(
  battle: BattleState,
  caster: Combatant,
  spec: RecallSpec,
  /** 玩家点选的那只（`target: ally` 传上来的实例 id）；缺省 = 按入场顺序收最早的。 */
  targetInstanceId: string | undefined,
  log: (text: string) => void,
): void {
  const count = spec.count ?? 1;
  const list = unitsOf(battle, caster.team);
  const bench = battle.bench ?? [];
  const ownedAll = list.filter((u) => u.alive && u.summonedBy === caster.id);
  /**
   * 指定了谁就收谁（用户 2026-11-20：收灵要能让玩家选）。
   * 传进来的 id 不属于自己的召唤物（比如误点到自己）⇒ 回落到「按入场顺序收最早的」，
   * 不返回空手：这一步已经扣过 MP、进过冷却，静默变成「什么也没发生」才是最差的结果。
   */
  const picked =
    targetInstanceId !== undefined ? ownedAll.filter((u) => u.instanceId === targetInstanceId) : [];
  const owned = (picked.length > 0 ? picked : ownedAll).slice(0, count);
  for (const unit of owned) {
    const idx = list.findIndex((u) => u.instanceId === unit.instanceId);
    if (idx >= 0) list.splice(idx, 1);
    bench.push(unit);
    log(`${unit.name}被收了回去。`);
  }
  battle.bench = bench;
}

/**
 * 这一发献祭会烧掉谁（ADR-013 D5）。
 *
 * 挑法写死在这里而不是抛给调用方：**先杂兵、后英雄**，同档内按入场顺序（先召的先烧）。
 * 理由——「倾尽」通常指的是杂兵；一只英雄的代价远大于三只杂兵，不指定目标时不该先烧最贵的。
 * 顺序只由状态决定，所以玩家、AI 与模拟器算出的是同一批。
 *
 * 只数**施放者同阵营**的单位（ADR-016 D3 补）：中立的魔虚罗不受任何人指挥，
 * 既不能拿来当祭品，也不该因为在场就被算成「有货可烧」——
 * 否则闸门放行、旋涡烧出加成、而场上那只一个像素没动，等于每次点都白赚一段伤害。
 */
function sacrificeTargets(
  battle: BattleState,
  ownerId: string,
  spec: SacrificeSpec,
  team: "ally" | "enemy" | "neutral",
): BattleEnemy[] {
  const own = unitsOf(battle, team).filter((u) => u.alive && u.summonedBy === ownerId);
  const ordered = [
    ...own.filter((u) => (u.tier ?? "minion") === "minion"),
    ...own.filter((u) => u.tier === "hero"),
  ];
  const want = spec.count ?? "all";
  return want === "all" ? ordered : ordered.slice(0, want);
}

/**
 * 这一发献祭能换来多少伤害（不加任何随机）。与 `performSacrifice` 同源，
 * 所以模拟器算出的期望值与实战打出的一致 —— 仪器不另立一套规则。
 */
export function sacrificeValueOf(
  battle: BattleState,
  ownerId: string,
  spec: SacrificeSpec,
  team: "ally" | "enemy" | "neutral",
): number {
  return sacrificeTargets(battle, ownerId, spec, team).reduce(
    (sum, unit) => sum + ((unit.tier === "hero" ? spec.perTier?.hero : spec.perTier?.minion) ?? 0),
    0,
  );
}

/**
 * 献祭（ADR-013 D5）：把场上自己召来的单位烧掉，返回这一击该多打多少。
 *
 * 单位被**移除**而不是收进回收架 —— 献祭与召回的唯一区别就在这里：
 * 召回的那只还能回来，献祭的那只回不来了。英雄档还会进 `state.lostSummons`（D3）。
 */
function performSacrifice(
  battle: BattleState,
  state: WorldStateV2,
  caster: Combatant,
  spec: SacrificeSpec,
  log: (text: string) => void,
): number {
  let bonus = 0;
  for (const unit of sacrificeTargets(battle, caster.id, spec, caster.team)) {
    removeFromField(battle, unit);
    unit.deathReason = "被献祭";
    rememberFallen(battle, unit);
    bonus += (unit.tier === "hero" ? spec.perTier?.hero : spec.perTier?.minion) ?? 0;
    if (unit.tier === "hero") markSummonLost(battle, state, unit);
    log(`${unit.name}被献祭了。`);
  }
  return bonus;
}

/**
 * 英雄档召唤物永久失去（ADR-013 D3）：记在**世界状态**上，因为「这一只没了」要跨战斗。
 *
 * 只记玩家自己的（`summonedBy === selfId`）。NPC 的召唤物死在场上就是本场没了，
 * 不需要跨战斗的账本 —— 而 `lostSummons` 存的是角色 id，全局记会误伤同名的另一只。
 *
 * ADR-014 D4：**中立的召唤物不记**。未调伏的魔虚罗本来就不在名册里（调伏是名册机制），
 * 记进去等于让惠用一次「同归于尽」就永远少一张底牌 —— 而原作里这一手每次都是再赌一次。
 */
function markSummonLost(battle: BattleState, state: WorldStateV2, unit: BattleEnemy): void {
  if (unit.summonRef === undefined || unit.summonedBy !== selfIdOf(state)) return;
  if (battle.neutrals.includes(unit)) return;
  const lost = state.lostSummons ?? [];
  if (!lost.includes(unit.summonRef)) state.lostSummons = [...lost, unit.summonRef];
}


function executeSkill(
  battle: BattleState,
  state: WorldStateV2,
  caster: Combatant,
  skill: CombatSkill,
  targetInstanceId: string | undefined,
  lookup: TemplateLookup,
  rng: Rng,
): void {
  const log = (text: string) => battle.log.push(text);
  const effC = effectiveAttrsOf(caster, lookup, state);
  const dealtBonus = multiplierOf(caster.statuses, "damageDealt", lookup, caster.gear);

  // 消耗（mp + 自定义资源；调用方已检查，这里仍按 max(0) 兜底）。
  // ADR-012 D8：价格走修正后的值（六眼 -90%），否则「AI 觉得放得出、结算却扣不起」。
  payCost(caster, effectiveCost(skill.cost, caster.statuses, lookup));
  caster.skillCooldowns[skill.id] = skill.cooldownTurns;

  /**
   * 献祭（ADR-013 D5）必须在**伤害之前**：烧掉的那几支就是这一击威力的来源。
   * 返回值是加成，不是替换值 —— 技能自己的 `damage` 照常算，两者相加。
   */
  const sacrificeBonus =
    skill.sacrifice !== undefined ? performSacrifice(battle, state, caster, skill.sacrifice, log) : 0;

  const sheet = resourceSheet(caster);

  const { targets } = resolveTargets(battle, state, caster, skill, targetInstanceId, lookup);

  /**
   * 施加点按收件人分流（ADR-006 D1）。三份互斥：跟技能的（逐个结算、走命中）、
   * 只给自己的（一次）、点到全场某一阵营的（各一次，不重复跑命中）。
   *
   * 旧实现在目标循环里判 `onSelf` ⇒ 打三个敌人就把自己的增幅叠三层；目标全闪开时
   * 自己那一层还挂不上。分到循环外才说得通：挂在谁身上跟「打没打中谁」无关。
   */
  const apps = skill.applyStatus ?? [];
  const perTargetApps = apps.filter((a) => applyTargetOf(a) === "skill");
  const selfApps = apps.filter((a) => applyTargetOf(a) === "self");
  const campApps = apps.filter((a) => {
    const t = applyTargetOf(a);
    return t === "all_enemies" || t === "all_allies";
  });
  /** 循环外施加过的单位：写回时一并处理（`writeBack` 是合并式，重复调用无害但仍去重）。 */
  const extraReceivers = new Set<Combatant>();

  for (const target of targets) {
    const who = target.isPlayer ? "你" : target.name;
    /**
     * 命中判定（ADR-008 D1）：
     * - `hit: guaranteed` ⇒ 整段跳过（必中不掷骰、也不吃闪避）；
     * - 否则先掷命中骰（省略 `hitCheck` 时只掷满值，但仍然**可被闪避**）；
     * - 最后一道是闪避。闪避只对**攻击性技能**生效：给自己回血/加状态时，
     *   闪避率 100% 的单位不该连自己的治疗都躲开。
     */
    // 必中有两条来源：技能自己声明（`hit: guaranteed`），或**装备词条**给的
    // （`combat.guaranteedHit`，「强制解除术式」那类东西本来就长在刀上）。
    if (skill.hit !== "guaranteed" && caster.gear.guaranteedHit !== true) {
      const chance = hitChance(caster, target, skill, lookup, state);
      if (rng() >= chance) {
        log(`${caster.name}的「${skill.name}」被${who}闪开了。`);
        continue;
      }
      if (isAttackSkill(skill)) {
        const evade = evadeOf(target.statuses, lookup, target.gear);
        if (evade.chance > 0 && rng() < evade.chance) {
          log(`${caster.name}的「${skill.name}」没能触及${who}——「${evade.source}」把它隔在了外面。`);
          continue;
        }
      }
    }

    // 伤害
    if (skill.damage?.length) {
      const raw = rollFormula(skill.damage, effC, caster.statuses, sheet) + sacrificeBonus;
      const takenBonus = multiplierOf(target.statuses, "damageTaken", lookup, target.gear);
      const final = Math.max(0, Math.round(raw * (1 + dealtBonus) * (1 + takenBonus)));
      target.hp -= final;
      log(`${caster.name}的「${skill.name}」命中${target.isPlayer ? "你" : target.name}，造成 ${final} 点伤害。`);
    }

    // 治疗：不得超过目标 HP 上限（物品治疗同样 clamp，避免 overheal 被持久化）
    if (skill.heal?.length) {
      const amount = Math.max(0, Math.round(rollFormula(skill.heal, effC, caster.statuses, sheet)));
      const cap = maxHpOf(target, state, battle, lookup);
      const before = target.hp;
      target.hp = Math.min(cap, target.hp + amount);
      const healed = target.hp - before;
      log(`${caster.name}的「${skill.name}」为${target.isPlayer ? "你" : target.name}回复 ${healed} 点${lookup.resourceLabel("hp")}。`);
    }

    // 施加状态：只处理「跟技能目标」的那些
    for (const app of perTargetApps) {
      if (rng() >= (app.chance ?? 1)) continue;
      applyStatusCombat(target, app.status, app.stacks ?? 1, state, lookup, log, app.duration);
    }
  }

  // 挂在自己身上的一次性施加：与命中无关，因此放在目标循环之外
  for (const app of selfApps) {
    if (rng() >= (app.chance ?? 1)) continue;
    applyStatusCombat(caster, app.status, app.stacks ?? 1, state, lookup, log, app.duration);
    extraReceivers.add(caster);
  }

  // 施放者视角的全场阵营（范围技能：给全体敌人挂压制）
  if (campApps.length > 0) {
    // 复用本轮已改过的快照（伤害/治疗还没写回 battle）——见 `campsOf` 的 `known` 说明。
    const known = new Map<string, Combatant>([[caster.id, caster]]);
    for (const t of targets) known.set(t.id, t);
    const camps = campsOf(battle, state, caster, known);
    for (const app of campApps) {
      const receivers = applyTargetOf(app) === "all_enemies" ? camps.hostile : camps.friendly;
      for (const receiver of receivers) {
        if (rng() >= (app.chance ?? 1)) continue;
        applyStatusCombat(receiver, app.status, app.stacks ?? 1, state, lookup, log, app.duration);
        extraReceivers.add(receiver);
      }
    }
  }

  // 献祭：结算后移除施放者自身该状态（漩涡）
  const consume = skill.consumeStatus;
  if (consume) {
    const stacks = caster.statuses.find((s) => s.statusId === consume.status)?.stacks ?? 0;
    caster.statuses = caster.statuses.filter((s) => s.statusId !== consume.status);
    if (stacks > 0) {
      // 文案只引用模板里的状态名，不写死具体召唤物/世界观名词
      const statusName = lookup.status(consume.status)?.name ?? consume.status;
      log(`${caster.name}消耗了 ${stacks} 层「${statusName}」。`);
    }
  }

  /**
   * ADR-012 D10：回复资源池（收集类技能）。夹到上限走 `addPool`，与召回返还同一套。
   */
  if (skill.gainResource !== undefined) {
    const key = skill.gainResource.resource;
    const before = poolOf(caster, key);
    addPool(caster, key, skill.gainResource.amount, state, battle, lookup);
    const gained = poolOf(caster, key) - before;
    if (gained > 0) log(`${caster.name}的${lookup.resourceLabel(key)}增加了 ${gained} 点。`);
  }

  if (skill.summon !== undefined) performSummon(battle, state, caster, skill.summon, lookup, log);
  if (skill.recall !== undefined) performRecall(battle, caster, skill.recall, targetInstanceId, log);

  writeBack(battle, caster);
  for (const t of targets) writeBack(battle, t);
  for (const r of extraReceivers) writeBack(battle, r);
  markDeaths(battle, state);
}

/**
 * 标记 hp≤0 的单位阵亡（敌人 / 友军 / 中立），并写日志。
 *
 * 召唤物的「死」按档分两种（ADR-013）：
 * - 杂兵：本场没了，下一场照常召（它们是兵力，不是资产）；
 * - 英雄：进 `state.lostSummons`，**本局再也召不出来**（个体，死了就死了）。
 * 没有回补 —— 召唤本来就不花资源，也就没有东西可退。
 *
 * `state` 只为记英雄损失；不传就只标记阵亡（旧调用点 / 纯推演），不猜。
 */
function markDeaths(battle: BattleState, state?: WorldStateV2): void {
  const dead: BattleEnemy[] = [];
  for (const enemy of battle.enemies) {
    if (enemy.alive && enemy.hp <= 0) {
      enemy.alive = false;
      enemy.deathReason = "生命耗尽";
      battle.log.push(`${enemy.name}失去了战斗能力。`);
      dead.push(enemy);
    }
  }
  for (const ally of battle.allies) {
    if (ally.alive && ally.hp <= 0) {
      ally.alive = false;
      ally.deathReason = "生命耗尽";
      battle.log.push(`${ally.name}倒下了。`);
      dead.push(ally);
    }
  }
  for (const neutral of battle.neutrals ?? []) {
    if (neutral.alive && neutral.hp <= 0) {
      neutral.alive = false;
      neutral.deathReason = "生命耗尽";
      battle.log.push(`${neutral.name}倒下了。`);
      dead.push(neutral);
    }
  }
  if (state === undefined) return;
  for (const unit of dead) {
    if (unit.tier === "hero") markSummonLost(battle, state, unit);
  }
}

/**
 * 战斗域施加状态（ADR-018 D5）。
 *
 * 只剩一种时长：`{ rounds: n }` ⇒ `roundsLeft`；省略 ⇒ 撑到战斗结束。
 * 实例上没有「战后留存」标记 —— **所有**战斗态都会在收场时被丢掉，
 * 想留下痕迹就写状态定义上的 `toModifier`，由战后结算按 `roundsHeld` 折算。
 */
function applyStatusCombat(
  receiver: Combatant,
  statusId: string,
  stacks: number,
  state: WorldStateV2,
  lookup: TemplateLookup,
  log: (text: string) => void,
  duration?: CombatDuration,
): void {
  const def = lookup.status(statusId);
  if (!def) return;
  /**
   * 运行期兜底：加载期已经拒过「战斗施加非 battle 档」，但扩展可以注入模板，
   * 而这里放过去一条世界状态就会让它在收场时被静默丢掉 —— 宁可什么都不做。
   */
  if (def.kind !== "battle") return;
  /**
   * 这一次施加的时长（ADR-011 D1/D2）：**时钟的形态听这一次，数值只往后推**。
   *
   * 迟到的一击必须能把「还剩 1 回合」推回「还剩 3 回合」（延长的方向），
   * 但反过来，剩 3 回合的眩晕不该被一发只剩 1 回合的续上而变短。
   * 省略时长的（撑到战斗结束）不会被有期施加降级。
   */
  const roundsLeft = duration?.rounds;
  const existing = receiver.statuses.find((s) => s.statusId === statusId);
  if (existing) {
    const permanent = existing.roundsLeft === undefined;
    existing.appliedTurn = state.turnIndex;
    existing.appliedAt = state.worldTime;
    if (roundsLeft === undefined) delete existing.roundsLeft;
    else if (!permanent) existing.roundsLeft = Math.max(existing.roundsLeft ?? 0, roundsLeft);
    if (def.stacking === "stack") existing.stacks += stacks;
    else existing.stacks = Math.max(1, existing.stacks);
  } else {
    receiver.statuses.push({
      statusId,
      stacks: Math.max(1, stacks),
      appliedTurn: state.turnIndex,
      appliedAt: state.worldTime,
      ...(roundsLeft === undefined ? {} : { roundsLeft }),
    });
  }
  /**
   * 施加文案读**正负**（2026-11-20）：增益写「获得」、异常写「陷入」、中性写「生效」。
   *
   * 旧文案一律「陷入」，所以「你陷入了「天赐」」这种句子在实战里真会出现。
   * `hidden` 的状态**不写名字** —— 名字本身就是情报；名字都不给，也不编「某种力量」。
   */
  if (def.visibility === "known") {
    const subject = receiver.isPlayer ? "你" : receiver.name;
    if (def.polarity === "positive") log(`${subject}获得了「${def.name}」。`);
    else if (def.polarity === "negative") log(`${subject}陷入了「${def.name}」。`);
    else log(`「${def.name}」在${subject}身上生效。`);
  }
}

// ---------- 敌人 AI ----------

/**
 * AI 的攻击目标（ADR-016 D1）：**只有中立单位需要它**。
 *
 * 不传目标时 `resolveTargets` 取 `hostile[0]`，而敌对表的第一位恒是玩家 —— 中立的
 * `hostile` 是「友军 + 敌军」两段拼起来的，于是暴走的魔虚罗只会追着玩家打，
 * 「站在中间抽两边」实际只剩一边（用户 2026-11-20 实测：「中立单位貌似只会打玩家」）。
 *
 * 挑法：血量**比例**最低的那个，同比例取先手序。刻意不掷骰子 —— `rng` 是整场战斗共用的
 * 一条流，为选目标多掷一次会让后面所有判定跟着变，旧战斗的可复现性当场碎掉。
 */
function aiHostileTarget(
  battle: BattleState,
  state: WorldStateV2,
  caster: Combatant,
  skill: CombatSkill,
  lookup: TemplateLookup,
  policy: AiTargetPolicy,
  rng: Rng,
): string | undefined {
  if (skill.target !== "enemy") return undefined;
  // legacy：敌方攻击仍打首位（玩家），只有中立会挑血最少的。随机策略对所有阵营开放。
  if (policy === "lowest" && caster.team !== "neutral") return undefined;
  const { hostile } = campsOf(battle, state, caster); // campsOf 已剔除死者
  if (policy === "random") return pickWeighted(hostile, () => 1, rng)?.id;
  let best: { id: string; ratio: number } | undefined;
  for (const unit of hostile) {
    const ratio = unit.hp / Math.max(1, maxHpOf(unit, state, battle, lookup));
    if (best === undefined || ratio < best.ratio) best = { id: unit.id, ratio };
  }
  return best?.id;
}

/**
 * AI 的友军目标（ADR-012 D6 补）：挑**血量比例最低**的那个，没人擦破皮就把决定权交回缺省。
 *
 * 从前两个分支都传 `undefined`，而 `ally` 的分支缺省取 `friendly[0]` —— 于是队医会一直对着
 * 满血的自己读治疗。挑「最惨的那个」不需要任何战术天才，但足以让治疗看起来是有意义的。
 */
function aiAllyTarget(
  battle: BattleState,
  state: WorldStateV2,
  caster: Combatant,
  skill: CombatSkill,
  lookup: TemplateLookup,
  policy: AiTargetPolicy,
  rng: Rng,
): string | undefined {
  if (skill.target !== "ally") return undefined;
  const { friendly } = campsOf(battle, state, caster); // campsOf 已剔除死者
  if (policy === "random") return pickWeighted(friendly, () => 1, rng)?.id;
  let best: { id: string; ratio: number } | undefined;
  for (const unit of friendly) {
    const ratio = unit.hp / Math.max(1, maxHpOf(unit, state, battle, lookup));
    if (best === undefined || ratio < best.ratio) best = { id: unit.id, ratio };
  }
  return best !== undefined && best.ratio < 1 ? best.id : undefined;
}

/**
 * 这一次施放要不要点名（友军单体 / 中立的攻击）。两者都不适用时交回缺省目标，
 * 与旧行为逐字一致 —— 敌方 AI 仍然打「敌人表第一位」，也就是玩家。
 */
function aiTargetOf(
  battle: BattleState,
  state: WorldStateV2,
  caster: Combatant,
  skill: CombatSkill,
  lookup: TemplateLookup,
  policy: AiTargetPolicy,
  rng: Rng,
): string | undefined {
  return (
    aiAllyTarget(battle, state, caster, skill, lookup, policy, rng) ??
    aiHostileTarget(battle, state, caster, skill, lookup, policy, rng)
  );
}

function aiTurn(
  battle: BattleState,
  state: WorldStateV2,
  unit: BattleEnemy,
  team: "ally" | "enemy" | "neutral",
  lookup: TemplateLookup,
  rng: Rng,
  targetRoot: Rng,
): void {
  /**
   * ADR-016 D2：**召唤物在登场那一回合就行动**（`summonRef !== undefined`）。
   *
   * 原判据是「入场当回合不行动」（ADR-012 D1），理由是不想让召唤物借玩家的回合白打一轮。
   * 但站在玩家的位置上，这条规则是这么读的：召一只 → 它发呆一回合 → 下一回合才动。
   * 换式神时更糟：收（一个回合）+ 召（再一个回合）+ 它发呆（第三个回合）。
   * 「十影」六只式神共享一个名额，换手本来就该是这套术式的看家本领，结果被规则罚成最贵的一种操作。
   *
   * 保留给**中途加入**：援军从剧本里来，不是谁花了一个回合召来的，到场即出手会读成两次行动。
   * 判据不是「谁加的」而是「有没有被点名」（`summonRef`）—— 技能召唤一定带它。
   */
  if (unit.enteredRound !== undefined && unit.enteredRound === battle.round && unit.summonRef === undefined) {
    return;
  }
  const c = unitCombatant(unit, team);
  if (controlOf(c.statuses, "cannot_act", lookup)) {
    battle.log.push(`${unit.name}无法行动。`);
    return;
  }
  const cannotAttack = controlOf(c.statuses, "cannot_attack", lookup);
  const usable = unit.skills
    .map((id) => lookup.skill(id))
    .filter((s): s is CombatSkill => s?.kind === "combat")
    // ADR-012 D1：可用性走唯一判定（含消耗修正、召唤弹药与上限），AI 不再自己数钱。
    .filter((s) => canUseSkill(state, battle, unit.instanceId, s.id, lookup).ok)
    // cannot_attack（协议 §6.3）：攻击性技能不可用，增益/治疗类仍可施放
    .filter((s) => !cannotAttack || !isAttackSkill(s));
  if (usable.length === 0) {
    battle.log.push(cannotAttack ? `${unit.name}无法攻击，跳过了回合。` : `${unit.name}蓄势待发。`);
    return;
  }

  // 风格映射（协议 §20）：combatAi.assignments[characterId] → 风格画像。
  // 未提供 combat-ai.yaml 或该角色未映射时，保持既有 skillWeights 加权路径（逐字段兼容）。
  const combatAi = lookup.template.combatAi;
  const profile = combatAi ? combatAi.styles.find((s) => s.styleId === combatAi.assignments[unit.characterId]) : undefined;
  if (profile) {
    const foes = team === "neutral"
      ? [...battle.allies.filter((a) => a.alive), ...battle.enemies.filter((e) => e.alive)]
      : team === "enemy"
        ? battle.allies.filter((a) => a.alive)
        : battle.enemies.filter((e) => e.alive);
    const friends = team === "neutral"
      ? battle.neutrals.filter((n) => n.alive && n !== unit)
      : team === "enemy"
        ? battle.enemies.filter((e) => e.alive && e !== unit)
        : battle.allies.filter((a) => a.alive);
    const pub = buildPublicConditionContext({
      actor: {
        hp: Math.max(0, c.hp),
        maxHp: unit.maxHp,
        mp: Math.max(0, c.mp),
        maxMp: unit.maxMp ?? Math.max(1, c.mp),
      },
      player: {
        hp: Math.max(0, battle.player.hp),
        maxHp: maxHp(state.player, lookup.template),
        mp: Math.max(0, battle.player.mp),
        maxMp: maxMp(state.player, lookup.template),
      },
      round: battle.round,
      // 玩家恒在友军侧：敌方 / 中立看到的是「友军 + 玩家」，友军看到的是「敌军」。
      aliveAllies: team === "enemy" ? friends.length + 1 : friends.length + (team === "ally" ? 1 : 0),
      aliveFoes: team === "enemy" ? foes.length + 1 : foes.length,
    });
    // 决策只依赖战斗镜像与公有字段；结果交回既有 executeSkill 结算（AI 不写状态）
    const decision = decide({ candidates: usable.map((s) => ({ actionId: s.id, skill: s })), profile, pub });
    const chosen = decision.actionId ? usable.find((s) => s.id === decision.actionId) : undefined;
    if (chosen) {
      const targetRng = forkRng(targetRoot, `ai.target:${battle.round}:${unit.instanceId}:${chosen.id}`);
      executeSkill(
        battle,
        state,
        c,
        chosen,
        aiTargetOf(battle, state, c, chosen, lookup, profile.targetPolicy, targetRng),
        lookup,
        rng,
      );
      return;
    }
    battle.log.push(`${unit.name}蓄势待发。`);
    return;
  }

  const chosen = pickWeighted(usable, (s) => unit.skillWeights[s.id] ?? 1, rng);
  if (!chosen) return;
  executeSkill(
    battle,
    state,
    c,
    chosen,
    aiTargetOf(battle, state, c, chosen, lookup, "lowest", rng),
    lookup,
    rng,
  );
}

// ---------- 回合结束（结算持续伤害/治疗、状态到期、冷却递减） ----------

/** 战斗单位的资源上限：玩家走成长公式，敌人/友军走 `combatUnitResourceMax`。 */
function maxResourceOf(
  c: Combatant,
  key: string,
  state: WorldStateV2,
  battle: BattleState,
  lookup: TemplateLookup,
): number {
  /**
   * ADR-012 D9：专属池的上限来自角色声明，不在 `template.resources` 里 ——
   * 先查单位自己带的那一份，查不到才回到模板公式。
   */
  const exclusive = c.isPlayer
    ? state.player.resourceMax?.[key]
    : allUnits(battle).find((u) => u.instanceId === c.id)?.resourceMax?.[key];
  if (exclusive !== undefined) return exclusive;
  if (c.isPlayer) {
    if (key === "hp") return maxHp(state.player, lookup.template);
    if (key === "mp") return maxMp(state.player, lookup.template);
    return resourceMax(state.player, lookup.template, key);
  }
  if (key === "hp") return maxHpOf(c, state, battle, lookup);
  if (key === "mp") {
    const unit = allUnits(battle).find((u) => u.instanceId === c.id);
    return unit?.maxMp ?? unit?.mp ?? c.mp;
  }
  return combatUnitResourceMax(lookup.template, c.attributes, key);
}

/**
 * 战斗内每回合回复（ADR-003 D12）。
 *
 * 只写**战斗镜像**（结束由 `finishBattle` 统一回写），只处理正值，按各自上限夹取；
 * 实际回复量为 0 时不写日志（避免「每回合刷一条 +0」）。
 */
function applyCombatRegen(
  c: Combatant,
  regen: Record<string, RegenAmount> | undefined,
  battle: BattleState,
  state: WorldStateV2,
  lookup: TemplateLookup,
): void {
  if (regen === undefined) return;
  for (const [key, spec] of Object.entries(regen)) {
    // ADR-003 D12：支持「基础值 + 属性加权」；加权用该单位的基础属性。
    const amount = resolveRegenAmount(spec, c.attributes);
    if (amount <= 0) continue;
    if (lookup.template.resources[key] === undefined) continue; // 加载期已拒，防御性跳过
    const before = key === "hp" ? c.hp : key === "mp" ? c.mp : (c.resources[key] ?? 0);
    const next = Math.min(maxResourceOf(c, key, state, battle, lookup), before + amount);
    if (next <= before) continue;
    if (key === "hp") c.hp = next;
    else if (key === "mp") c.mp = next;
    else c.resources[key] = next;
    battle.log.push(`R${battle.round} ${c.isPlayer ? "你" : c.name}回复 ${next - before} 点${lookup.resourceLabel(key)}。`);
  }
}

function roundEnd(battle: BattleState, state: WorldStateV2, lookup: TemplateLookup, rng: Rng): void {
  const combatants: Combatant[] = [
    playerCombatant(state, battle, lookup),
    ...battle.allies.filter((a) => a.alive).map(allyCombatant),
    ...battle.neutrals.filter((n) => n.alive).map(neutralCombatant),
    ...battle.enemies.filter((e) => e.alive).map(enemyCombatant),
  ];
  for (const c of combatants) {
    for (const inst of [...c.statuses]) {
      const facet = lookup.status(inst.statusId)?.combat;
      for (const effect of facet?.onRoundEnd ?? []) {
        const eff = effectiveAttrsOf(c, lookup, state);
        if (effect.damage) {
          const dmg = Math.max(0, Math.round(rollFormula([effect.damage], eff, c.statuses)));
          c.hp -= dmg;
          // hidden 的状态不点名（名字就是情报）；只报数字，不编名字。
          const statusName = lookup.status(inst.statusId)?.visibility === "known" ? `「${lookup.status(inst.statusId)?.name}」的 ` : "";
          battle.log.push(`${c.isPlayer ? "你" : c.name}受到${statusName}${dmg} 点持续伤害。`);
        }
        if (effect.heal) {
          const heal = Math.max(0, Math.round(rollFormula([effect.heal], eff, c.statuses)));
          c.hp = Math.min(maxHpOf(c, state, battle, lookup), c.hp + heal);
        }
        for (const app of effect.applyStatus ?? []) {
          // 收件人恒为携带者本人（加载期已拒掉全阵营目标，见 world.ts 的 statuses 校验）；
          // `chance` 照样要掷——声明了却被静默忽略，是比「没写」更糟的一种谎。
          if (rng() >= (app.chance ?? 1)) continue;
          applyStatusCombat(c, app.status, app.stacks ?? 1, state, lookup, (t) => battle.log.push(t), app.duration);
        }
      }
      /**
       * ADR-018 D4：带 `toModifier` 的战斗态累计「已经待了几回合」，战后换算成世界时间。
       * 放在移除判定**之前** —— 这一回合它确实在场上，就该算进去。
       */
      if (lookup.status(inst.statusId)?.toModifier !== undefined) {
        inst.roundsHeld = (inst.roundsHeld ?? 0) + 1;
      }
      // 战斗域寿命（ADR-018 D5）：只数 `{ rounds }` 施加的状态；省略时长的撑到战斗结束。
      if (inst.roundsLeft !== undefined) {
        inst.roundsLeft -= 1;
        if (inst.roundsLeft <= 0) {
          c.statuses = c.statuses.filter((s) => s !== inst);
          continue;
        }
      }
    }
    for (const key of Object.keys(c.skillCooldowns)) {
      c.skillCooldowns[key] = Math.max(0, c.skillCooldowns[key] - 1);
    }
    // ADR-003 D12：战斗内每回合回复（玩家 = 模板 regen.combat；敌人/友军 = 角色 combatRegen）。
    const unitRegen = c.isPlayer
      ? lookup.template.regen.combat
      : allUnits(battle).find((u) => u.instanceId === c.id)?.combatRegen;
    applyCombatRegen(c, unitRegen, battle, state, lookup);
    writeBack(battle, c);
  }

  // 死亡复查
  markDeaths(battle, state);
  dismissOrphanSummons(battle, selfIdOf(state));
  battle.round += 1;
  /**
   * ADR-012 D3：中途加入在**新回合开始时**判定（`battle.round` 已 +1）。
   * 放在这里而不是 `performBattleAction` 开头，是因为援军属于「回合之间发生的事」，
   * 与谁先动、谁后动无关。
   */
  applyReinforcements(battle, state, lookup, rng);
}

/**
 * 召唤者倒下后收回其召唤物（ADR-012 D1，`onSummonerDown: stay` 的除外）。
 *
 * 判据是「召唤者不在了」而不是「召唤者这一轮被打死」：中途加入的单位没有 `summonedBy`，
 * 天然不受影响。
 */
function dismissOrphanSummons(battle: BattleState, selfId: string): void {
  for (const team of ["enemy", "ally", "neutral"] as const) {
    const list = unitsOf(battle, team);
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const unit = list[i];
      if (unit.summonedBy === undefined || unit.dismissOnSummonerDown === false) continue;
      // 玩家不是 `allUnits` 里的一员：他的 instanceId 是 `selfIdOf(state)`，必须单独认，
      // 否则「一开始召唤就被当成孤儿清掉」—— 第一次跑用例就是这么炸的。
      const ownerAlive = unit.summonedBy === selfId
        ? true
        : (allUnits(battle).find((u) => u.instanceId === unit.summonedBy)?.alive ?? false);
      if (ownerAlive) continue;
      list.splice(i, 1);
      unit.deathReason = "召唤者倒下，随之消散";
      rememberFallen(battle, unit);
      battle.log.push(`${unit.name}随着召唤者一同消失了。`);
    }
  }
}

/**
 * 中途加入（ADR-012 D3）：按「回合 / 间隔 / 概率 / 条件」投放单位。
 *
 * 与技能召唤的分工写在这里：这条**不看资源**，只看剧本 —— 作者说第 3 回合可能来人，
 * 就有 50% 来一个人。进度表进存档，所以读档不会把同一支援军再放一遍。
 */
function applyReinforcements(
  battle: BattleState,
  state: WorldStateV2,
  lookup: TemplateLookup,
  rng: Rng,
): void {
  const specs: readonly Reinforcement[] = battle.settle.reinforcements ?? [];
  if (specs.length === 0) return;
  const fires = battle.reinforcementFires ?? (battle.reinforcementFires = {});
  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i];
    const key = spec.id ?? `#${i}`;
    const fired = fires[key] ?? 0;
    const atRound = spec.atRound ?? 1;
    if (battle.round < atRound) continue;
    if (spec.everyRounds === undefined) {
      // 只来一次：触发过就不再判，否则「50% 概率」会变成「每回合 50%」。
      if (fired > 0) continue;
    } else if ((battle.round - atRound) % spec.everyRounds !== 0) {
      continue;
    }
    const side = spec.side ?? "enemy";
    const list = unitsOf(battle, side);
    const maxAlive = spec.maxAlive ?? 1;
    if (list.filter((u) => u.alive && u.characterId === spec.ref).length >= maxAlive) continue;
    if (spec.when !== undefined && spec.when.length > 0) {
      const ok = spec.when.every((cond) => checkCondition(cond, { state, lookup, rng }));
      if (!ok) continue;
    }
    if (spec.chance !== undefined && rng() >= spec.chance) continue;
    const def = lookup.character(spec.ref);
    if (!def) continue;
    const unit = buildUnit(def, state, lookup, {
      instanceId: `${def.id}#r${fires[key] === undefined ? i + 1 : fired + 1}`,
      side,
      enteredRound: battle.round,
      ...(spec.tier !== undefined ? { tier: spec.tier } : {}),
      ...(spec.levelScale !== undefined ? { levelScale: spec.levelScale } : {}),
    });
    list.push(unit);
    fires[key] = fired + 1;
    battle.log.push(`${unit.name}加入了战斗。`);
  }
}

// ---------- 胜负判定 ----------

/** 单条胜负条件求值（ADR-012 D4）。 */
function conditionMet(cond: BattleCondition, battle: BattleState): boolean {
  switch (cond.kind) {
    case "all_enemies":
      return battle.enemies.every((e) => !e.alive);
    case "unit_down": {
      /**
       * 指定角色的**全部实例**倒下。必须至少存在过一个实例：否则「击杀一个从未到场的人」
       * 会被判成已完成 —— 那是模板写错，不是战斗结果。
       */
      const units = allUnits(battle).filter((u) => u.characterId === cond.ref);
      return units.length > 0 && units.every((u) => !u.alive);
    }
    case "survive_rounds":
      return battle.round > cond.rounds;
    case "all_allies_down":
      // 没带友军的战斗不该因为「友军全灭」立刻判负（空集合的 every 恒真）。
      return battle.allies.length > 0 && battle.allies.every((a) => !a.alive);
    case "player_down":
      return battle.player.hp <= 1;
    default:
      return false;
  }
}

/**
 * 胜负判定。
 *
 * 没有声明 `victory` / `defeat` ⇒ 完全走旧的两条 if（ADR-012 D4 的零漂移承诺）；
 * 声明了就把判据换成条件表，仍然是「先判胜、后判负」——顺序保持不动，是因为旧实现
 * 就是这个顺序，改动会让「同回合同时满足」的边界行为静默翻转。
 */
export function checkBattleEnd(battle: BattleState, state: WorldStateV2): void {
  if (battle.over) return;
  const victory = battle.settle.victory;
  const won = victory !== undefined && victory.length > 0
    ? victory.some((c) => conditionMet(c, battle))
    : battle.enemies.every((e) => !e.alive);
  if (won) {
    battle.over = "victory";
    battle.log.push("战斗胜利！");
    return;
  }
  const defeat = battle.settle.defeat;
  const lost = defeat !== undefined && defeat.length > 0
    ? defeat.some((c) => conditionMet(c, battle))
    : battle.player.hp <= 1;
  if (lost) {
    battle.player.hp = 1;
    battle.over = "defeat";
    battle.log.push("你已无力再战……");
  }
}

// ---------- 玩家战斗行动入口 ----------

export function performBattleAction(
  state: WorldStateV2,
  command: BattleCommand,
  lookup: TemplateLookup,
  rng: Rng | BattleRng,
): void {
  const streams = battleRngOf(rng);
  const battle = state.battle;
  if (!battle || battle.over) throw new Error("battle_not_active");
  const pc = playerCombatant(state, battle, lookup);
  const prefix = `R${battle.round}`;

  if (controlOf(pc.statuses, "cannot_act", lookup)) {
    battle.log.push(`${prefix} 你无法行动。`);
  } else if (command.type === "skill") {
    if (controlOf(pc.statuses, "cannot_use_skills", lookup)) throw new Error("sealed_skills");
    const skill = lookup.skill(command.skillId);
    if (!skill || skill.kind !== "combat") throw new Error("skill_not_found");
    // ADR-012 D7：技能集含装备授予（天逆鉾拿着就能用那一招）。
    if (!playerSkills(state, lookup).includes(skill.id)) throw new Error("skill_not_owned");
    // cannot_attack（协议 §6.3）：只拦攻击性技能，增益/治疗仍可施放
    if (isAttackSkill(skill) && controlOf(pc.statuses, "cannot_attack", lookup)) throw new Error("cannot_attack");
    const missing = missingCost(pc, effectiveCost(skill.cost, pc.statuses, lookup));
    if (missing !== undefined) {
      // mp 保留旧错误码（既有前端 / 测试依赖）；其余资源带 id，便于诊断。
      throw new Error(missing === "mp" ? "not_enough_mp" : `not_enough_resource:${missing}`);
    }
    if ((pc.skillCooldowns[skill.id] ?? 0) > 0) throw new Error("skill_on_cooldown");
    /**
     * 目标合法性（2026-11-20）：先选目标、再放技能；非法目标直接拒，**不扣钱、不进冷却**。
     * 与 `canUseSkill` 同一份判定（`legalTargetIssue`），面板置灰只是它的展示面。
     */
    {
      const issue = legalTargetIssue(battle, state, pc, skill, command.targetInstanceId);
      if (issue !== null) throw new Error(issue);
    }
    battle.log.push(`${prefix} 你施放「${skill.name}」。`);
    executeSkill(battle, state, pc, skill, command.targetInstanceId, lookup, streams.resolve);
  } else if (command.type === "item") {
    if (controlOf(pc.statuses, "cannot_use_items", lookup)) throw new Error("bound_items");
    const item = lookup.item(command.itemId);
    if (!item || !item.usableInBattle) throw new Error("item_not_usable_in_battle");
    if ((state.player.inventory[item.id] ?? 0) <= 0) throw new Error("item_not_owned");
    // 先校验效果可结算再扣库存：避免「物品已消耗但效果被静默丢弃」
    for (const effect of item.use ?? []) {
      // 扩展效果在战斗内没有结算通道（`applyEffectsV2` 只在战斗外跑）⇒ 同样拒用，
      // 不静默跳过（「吃了没反应」比「用不了」难查得多）。
      if (!isCoreEffect(effect) || !BATTLE_ITEM_EFFECTS.has(effect.type)) {
        throw new Error(`item_effect_unsupported_in_battle: ${item.id}/${effect.type}`);
      }
    }
    state.player.inventory[item.id] -= 1;
    if (state.player.inventory[item.id] <= 0) delete state.player.inventory[item.id];
    // 战斗内物品效果仅结算资源/状态（作用于玩家镜像）
    for (const effect of item.use ?? []) {
      if (!isCoreEffect(effect)) continue;
      if (effect.type === "adjustResource") {
        // ADR-003 D8：hp/mp 与自定义资源在战斗道具里同一套语义（正=恢复 / 负=损失）。
        const key = effect.resource;
        const label = lookup.resourceLabel(key);
        if (key === "hp") {
          pc.hp = Math.max(1, Math.min(maxHp(state.player, lookup.template), pc.hp + effect.value));
        } else if (key === "mp") {
          pc.mp = Math.max(0, Math.min(maxMp(state.player, lookup.template), pc.mp + effect.value));
        } else {
          // ADR-012 D9：专属池（`curses` 这类）不在 `template.resources` 里，
          // 上限得先问玩家自己带的那一份，否则「道具补咒灵」会被夹成 0。
          const max = state.player.resourceMax?.[key] ?? resourceMax(state.player, lookup.template, key);
          pc.resources[key] = Math.max(0, Math.min(max, (pc.resources[key] ?? 0) + effect.value));
        }
        battle.log.push(
          `${prefix} 你使用了「${item.name}」，${effect.value >= 0 ? "恢复" : "损失"} ${Math.abs(effect.value)} 点${label}。`,
        );
      } else if (effect.type === "cureStatus") {
        // 道具属于世界：镜像与世界两份都要掉。只清镜像的话，收场丢镜像 ⇒ 白用一次解药。
        pc.statuses = pc.statuses.filter((s) => s.statusId !== effect.status);
        state.player.statuses = state.player.statuses.filter((s) => s.statusId !== effect.status);
        battle.log.push(`${prefix} 「${lookup.status(effect.status)?.name ?? effect.status}」被清除了。`);
      } else if (effect.type === "adjustMood") {
        state.player.mood = Math.max(lookup.template.mood.min, Math.min(lookup.template.mood.max, state.player.mood + effect.value));
      } else if (effect.type === "applyStatus") {
        /**
         * ADR-018 D6：道具是**世界**的东西，它施加的只能是 talent / modifier。
         * 落在世界上（收场不会丢），同时抄一份进镜像，让这一场立刻生效。
         */
        applyStatusTo(state, state.player, effect.status, effect.stacks ?? 1, lookup, effect.duration);
        const applied = state.player.statuses.find((s) => s.statusId === effect.status);
        if (applied !== undefined) {
          pc.statuses = pc.statuses.filter((s) => s.statusId !== effect.status);
          pc.statuses.push({ ...applied });
        }
      }
    }
    writeBack(battle, pc);
  } else if (command.type === "flee") {
    if (!battle.settle.canFlee) throw new Error("flee_not_allowed");
    if (controlOf(pc.statuses, "cannot_flee", lookup)) throw new Error("cannot_flee");
    const fleeCheck = battle.settle.fleeCheck;
    const eff = effectiveAttrsOf(pc, lookup, state);
    const blocker = battle.enemies.find((e) => e.alive);
    const defEff = blocker ? effectiveAttrsOf(enemyCombatant(blocker), lookup) : {};
    const chance = fleeCheck
      ? Math.max(0.05, Math.min(0.95, fleeCheck.baseChance + ((eff[fleeCheck.attacker] ?? 0) - (defEff[fleeCheck.defender] ?? 0)) * 0.05))
      : 0.5;
    if (streams.resolve() < chance) {
      battle.over = "flee";
      battle.log.push(`${prefix} 你趁隙脱离了战斗！`);
      return;
    }
    battle.log.push(`${prefix} 逃跑失败！`);
  } else if (command.type === "pass") {
    // D-14「空过」：不消耗 MP / 道具 / 冷却，不掷逃跑判定，只留一行可见日志；
    // 之后的友军/敌人行动与 roundEnd 照常执行 ⇒ 回合确实被消耗（与眩晕态的语义一致）。
    battle.log.push(`${prefix} 你按兵不动。`);
  }

  if (!battle.over) {
    // 友军行动（先于敌人，与主角同阵营）
    for (const ally of battle.allies.filter((a) => a.alive)) {
      aiTurn(battle, state, ally, "ally", lookup, streams.ai, streams.target);
    }
  }
  if (!battle.over) {
    for (const enemy of battle.enemies.filter((e) => e.alive)) {
      aiTurn(battle, state, enemy, "enemy", lookup, streams.ai, streams.target);
    }
  }
  // ADR-012 D5：中立单位最后行动（站在中间抽两边，谁近打谁没有差别，顺序只影响确定性）。
  if (!battle.over) {
    for (const neutral of battle.neutrals.filter((n) => n.alive)) {
      aiTurn(battle, state, neutral, "neutral", lookup, streams.ai, streams.target);
    }
  }
  if (!battle.over) {
    roundEnd(battle, state, lookup, streams.resolve);
  }
  checkBattleEnd(battle, state);
}

// ---------- 战斗收尾：折算 + 资源回写 ----------

/**
 * 战后折算（ADR-018 D4）：`toModifier` 是**单向**兑换。
 *
 * 战斗态每存在一回合，离场时兑换 `timePerRound` 的世界时间；最少按 1 回合算
 * （挨了一下就该留点印子）。`roundsLeft` 到期的战斗态已经不在数组里，自然不折算。
 */
function carryOverStatuses(
  instances: readonly StatusInstance[],
  actor: V2Player | V2Npc,
  state: WorldStateV2,
  lookup: TemplateLookup,
): void {
  for (const inst of instances) {
    const to = lookup.status(inst.statusId)?.toModifier;
    if (to === undefined) continue;
    const held = Math.max(1, inst.roundsHeld ?? 0);
    applyStatusTo(state, actor, to.id, inst.stacks, lookup, {
      value: to.timePerRound.value * held,
      unit: to.timePerRound.unit,
    });
  }
}

/**
 * 参战 NPC 的战后回写（ADR-018 D7）：血 / 资源交回去，状态按折算追加。
 *
 * 三道筛：召唤物不是世界演员（`summonedBy`）、纯敌人定义永不实例化（`state.npcs` 里找不到）、
 * 死者不复活。**死活不在这里写** —— `setNpcLifecycle` 是唯一入口：打到 0 血 ≠ 剧本要他死
 * （留活口 / 抓活的 / 打成重伤都是合法剧情），两处写同一件事必然打架。
 *
 * 同一 `characterId` 出现多个实例时按第一个匹配 —— 模板里一个角色一般只有一个实例。
 */
function writeBackNpc(unit: BattleEnemy, state: WorldStateV2): V2Npc | undefined {
  if (unit.summonedBy !== undefined) return undefined;
  const npc = state.npcs.find((n) => n.id === unit.characterId);
  if (npc === undefined || npc.lifecycle.state !== "alive") return undefined;
  if (!unit.alive || unit.hp <= 0) return undefined;
  npc.hp = Math.max(1, unit.hp);
  npc.mp = Math.max(0, unit.mp);
  if (npc.resources !== undefined) {
    for (const key of Object.keys(npc.resources)) {
      if (!(key in unit.resources)) continue;
      npc.resources[key] = Math.max(0, unit.resources[key]!);
    }
  }
  return npc;
}

/**
 * 战斗结束（over 非空）后调用：把战斗镜像回写世界状态。
 *
 * 状态转换规则（规格 6.2，2026-11-19 补一处）：**临时增益只带 combat 面的清除，
 * 永久特质即便只带 combat 面也要留下**。
 *
 * 为什么需要后半句：一条状态「是不是战斗里的临时效果」看的是 `duration`，不是看它
 * 有没有 simulation 面。`duration.turns` = 打出来的、会到期的东西（眩晕、压制、
 * 下一击的余韵）；`duration.untilCured` = 这个人**本来就有**的东西（天生的术、
 * 天生的眼、天生的体质）。旧实现只认 `simulation` 面，于是「只有战斗面、但是永久」
 * 的状态——典型如「到不了」这种闪避率 100% 的护身——打完一场就被当成战斗 buff
 * 清掉了，之后这个人连一次都没躲过。这不是某个模板的写法问题：它要么靠给那条护身
 * 硬塞一条假 simulation 绕过，要么就丢了身份。
 */
export function finishBattle(state: WorldStateV2, lookup: TemplateLookup): void {
  const battle = state.battle;
  if (!battle || !battle.over) return;

  /**
   * ADR-013 D4：召唤物**不需要**在收场时返还什么。
   *
   * 原先这里要把活着的那几只折回库存（存量 = 池 + 场上）。池子取消之后，
   * 「打完一场，咒灵数量对不上」这一整类 bug 就没有了 —— 没有账本，就没有账本对不上。
   * 回收架里的单位也随 `battle` 一起丢，所以下一场是新的一批（满血满状态）。
   */

  // 回写资源（失败保底 1 点生命）
  state.player.hp = battle.over === "defeat" ? 1 : Math.max(1, battle.player.hp);
  state.player.mp = Math.max(0, battle.player.mp);
  /**
   * ADR-003 D8：自定义资源回写。夹到 [0, 当前上限]——战斗中可能因上限变化
   * （升级/装备在战斗内不改，但模板初始值可能超过上限）出现越界值。
   */
  for (const key of Object.keys(state.player.resources)) {
    if (!(key in battle.player.resources)) continue;
    /**
     * ADR-012 D9 补三：**专属池（`curses` 这类）不在 `template.resources` 里**，
     * `resourceMax` 对它们返回 0 ⇒ 收场时会被夹成 0。这是「打一场，咒灵就凭空没了」
     * 的真正来源（比「没退还」更致命）。上限先问玩家自己带的那一份。
     */
    const max = state.player.resourceMax?.[key] ?? resourceMax(state.player, lookup.template, key);
    state.player.resources[key] = Math.max(0, Math.min(max, battle.player.resources[key]));
  }

  /**
   * 状态：**镜像整体丢弃**，世界那份从来没被动过（ADR-018 D4）。
   *
   * 战斗只操作 `battle.player.statuses` 这份镜像，世界状态的实例不会被战斗改写，
   * 所以这里不再需要「哪些要留、哪些要清」的启发式 —— 旧 `battleOnly` 判据是靠
   * `duration` 形态代理出来的，`exhausted` 那种两不像的就卡在缝里。
   *
   * 唯一从战斗带出去的东西写在状态定义上：`toModifier`。
   */
  carryOverStatuses(battle.player.statuses, state.player, state, lookup);
  for (const unit of [...battle.enemies, ...battle.allies, ...(battle.neutrals ?? [])]) {
    const npc = writeBackNpc(unit, state);
    if (npc !== undefined) carryOverStatuses(unit.statuses, npc, state, lookup);
  }

  state.history.push({
    id: `t${state.turnIndex}-battle-${battle.eventId}`,
    turnIndex: state.turnIndex,
    worldTime: state.worldTime,
    formattedTime: createTimeAdapter(lookup.template).format(state.worldTime),
    type: "battle",
    summary: `${battle.eventId} 的战斗以${battle.over === "victory" ? "胜利" : battle.over === "defeat" ? "败北" : "撤离"}告终。`,
    detail: battle.log.join("\n"),
    visibility: "public",
  });
}
