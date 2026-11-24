import type {
  BattleEnemy,
  BattleEvalCondition,
  BattleEvalHook,
  BattleGrade,
  BattleResult,
  BattleState,
  HpOnDefeat,
  ResourceSnapshot,
  StakeDef,
  StakeDefeatState,
  WorldStateV2,
  WorldTemplateV2,
} from "@life-sim/shared";
import { applyEffectsV2, effectiveAttributesOfActor, maxHp, maxMp, type EffectContextV2 } from "./engine.js";
import { anyMatchMet } from "./any-match.js";
import { resourceMax } from "./resources.js";
import type { TemplateLookup } from "./lookup.js";
import { selfIdOf } from "./actors.js";

/**
 * 战评：赌注（stake）、战斗力（power）、战果快照（BattleResult）（ADR-075）。
 *
 * 本文件是**纯函数 + 只读取数**：判死/结算仍然由 `battle.ts` 的 `checkBattleEnd` /
 * `finishBattle` 写。之所以拆出来，是因为这三件事都不该长在 2700 行的战斗循环里，
 * 而且死亡路由、`anyMatch`、叙事都要读同一份战果。
 */

// ---------- Stake ----------

/**
 * 内置三档。模板可以在 `world.combat.stakes` 里按 key 覆盖；
 * `dead` 是死亡路由的唯一入口，`down / yielded` 永不判死。
 */
export const BUILTIN_STAKES: Readonly<Record<string, StakeDef>> = Object.freeze({
  spar: { label: "切磋", defeatState: "yielded", hpOnDefeat: { mode: "floor", value: 1 } },
  hard: { label: "恶战", defeatState: "down", hpOnDefeat: { mode: "set", value: 1 } },
  deaths: { label: "死斗", defeatState: "dead", hpOnDefeat: { mode: "set", value: 0 } },
});

/** 战斗实际使用的 stake id。旧档没有 `battle.stake` ⇒ 按 `hard` 读（当时的全部战斗都是力竭）。 */
export function stakeIdOf(battle: BattleState, template: WorldTemplateV2): string {
  return battle.stake ?? battle.settle.stake ?? template.combat?.defaultStake ?? "deaths";
}

export function stakeOf(battle: BattleState, template: WorldTemplateV2): StakeDef {
  const id = stakeIdOf(battle, template);
  const def = template.combat?.stakes?.[id] ?? BUILTIN_STAKES[id];
  if (def === undefined) {
    // 加载期已经拒过未知 stake；运行期再抛一次，避免扩展注入的模板绕过校验。
    throw new Error(`unknown_stake: ${id}`);
  }
  return def;
}

/** 判负阈值：`dead → 0`，其余 `1`（ADR-075 §1.1）。 */
export function defeatThresholdOf(defeatState: StakeDefeatState): number {
  return defeatState === "dead" ? 0 : 1;
}

/** 缺省战败落点由 `defeatState` 推；显式声明优先。 */
export function hpOnDefeatOf(stake: StakeDef): HpOnDefeat {
  if (stake.hpOnDefeat !== undefined) return stake.hpOnDefeat;
  return stake.defeatState === "dead"
    ? { mode: "set", value: 0 }
    : { mode: "floor", value: 1 };
}

/** 战败时的 HP：`floor` 不往下掉，`set` 直接写。 */
export function applyHpOnDefeat(stake: StakeDef, hp: number): number {
  const spec = hpOnDefeatOf(stake);
  return spec.mode === "floor" ? Math.max(spec.value, hp) : spec.value;
}

// ---------- 战斗力 ----------

export type PowerWeights = Readonly<Record<string, number>>;

const weightCache = new WeakMap<WorldTemplateV2, PowerWeights>();

/**
 * 战斗力权重（ADR-075 §4.2）：模板显式声明优先；否则按"战斗面引用到的属性"推并集，
 * **每模板算一次**（`WeakMap` 缓存，不往只读模板上挂字段）。
 *
 * 推导来源：资源公式 / 技能的伤害与命中 / 三处钩子的概率属性 / 属性角色。
 * 每个 id 都递归折算回基础属性（派生键不重复计入），再剔除 signed / hidden。
 */
export function powerWeightsOf(template: WorldTemplateV2): PowerWeights {
  const explicit = template.combat?.evaluation?.power?.weights;
  if (explicit !== undefined) return explicit;
  const cached = weightCache.get(template);
  if (cached !== undefined) return cached;
  const derived = derivePowerWeights(template);
  weightCache.set(template, derived);
  return derived;
}

function derivePowerWeights(template: WorldTemplateV2): PowerWeights {
  const order = new Set(template.attributes.order);
  const defs = template.attributes.defs ?? {};
  const base = new Set<string>();
  const addBase = (id: string, seen: Set<string> = new Set()): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const def = defs[id];
    if (def === undefined) {
      // 没有 defs 的属性一律 number（ADR-003 零迁移），只要求它在 order 里。
      if (order.has(id)) base.add(id);
      return;
    }
    if (def.kind === "enum" || def.kind === "composite") return;
    if (def.kind === "number" && def.derived !== undefined) {
      for (const dep of def.derived.from) addBase(dep.attribute, seen);
      return;
    }
    if (def.hidden === true) return;
    if (def.kind === "number" && def.signed === true) return;
    if (order.has(id)) base.add(id);
  };
  const addHookAttrs = (hooks: readonly { when?: readonly unknown[] }[] | undefined): void => {
    for (const hook of hooks ?? []) {
      for (const cond of hook.when ?? []) {
        const chance = (cond as { chance?: unknown }).chance;
        if (chance === null || typeof chance !== "object") continue;
        const attr = (chance as { attribute?: unknown }).attribute;
        if (typeof attr === "string") addBase(attr);
      }
    }
  };

  for (const resource of Object.values(template.resources)) {
    for (const id of Object.keys(resource.perAttribute ?? {})) addBase(id);
  }
  for (const skill of template.skills) {
    if (skill.kind !== "combat") continue;
    for (const formula of skill.damage ?? []) {
      if (formula.preset === "scaled") addBase(formula.scaleBy);
    }
    if (skill.hitCheck !== undefined) {
      addBase(skill.hitCheck.attacker);
      addBase(skill.hitCheck.defender);
    }
    addHookAttrs(skill.hooks);
  }
  addHookAttrs(template.combat?.hooks);
  for (const status of template.statuses) addHookAttrs(status.combat?.hooks);
  for (const [id, def] of Object.entries(defs)) {
    if (def.kind === "number" && def.role !== undefined) addBase(id);
  }

  // 推导为空 ⇒ 退回"全部可见基础数值属性"。还空就真的是没有可加的了（战力 0）。
  if (base.size === 0) for (const id of template.attributes.order) addBase(id);

  const weights: Record<string, number> = {};
  for (const id of [...base].sort()) weights[id] = 1;
  return weights;
}

/** 按权重求和。缺键按 0；不取整（比值条件自己抵消量纲）。 */
export function powerOfAttributes(
  attributes: Readonly<Record<string, number>>,
  weights: PowerWeights,
): number {
  let sum = 0;
  for (const [id, weight] of Object.entries(weights)) sum += (attributes[id] ?? 0) * weight;
  return sum;
}

/** 单位战力：读 `attributes`（建场时已烘进 levelScale 与模板状态），不含战斗内临时态。 */
export function powerOfUnit(unit: BattleEnemy, weights: PowerWeights): number {
  const attrs: Record<string, number> = {};
  for (const [key, value] of Object.entries(unit.attributes)) {
    if (typeof value === "number") attrs[key] = value;
  }
  return powerOfAttributes(attrs, weights);
}

/** 单位有效属性（含战斗内状态）——只有"当前战力"需要它，开场快照不用。 */
export function powerOfUnitNow(
  unit: BattleEnemy,
  state: WorldStateV2,
  lookup: TemplateLookup,
  weights: PowerWeights,
): number {
  const attrs = effectiveAttributesOfActor(state, lookup, {
    attributes: unit.attributes,
    statuses: unit.statuses,
    mood: unit.mood ?? 50,
  });
  return powerOfAttributes(attrs, weights);
}

// ---------- 收场资源 ----------

export interface SettledResources {
  hp: number;
  mp: number;
  /** 自定义资源（只含"世界状态里有、战斗镜像里也有"的键，与旧行为一致）。 */
  resources: Record<string, number>;
}

/**
 * 收场资源表：战败走 `hpOnDefeat`，胜利保底 1；自定义资源夹到当前上限。
 *
 * `report` 与 `finishBattle` 共用它 —— 战果里写的数必须和写回世界的数一致，
 * 两处各算一遍迟早漂。
 */
export function settleResources(
  state: WorldStateV2,
  battle: BattleState,
  lookup: TemplateLookup,
): SettledResources {
  const stake = stakeOf(battle, lookup.template);
  const hp =
    battle.over === "defeat"
      ? applyHpOnDefeat(stake, battle.player.hp)
      : Math.max(1, battle.player.hp);
  const resources: Record<string, number> = {};
  for (const key of Object.keys(state.player.resources)) {
    if (!(key in battle.player.resources)) continue;
    const max = state.player.resourceMax?.[key] ?? resourceMax(state.player, lookup.template, key);
    resources[key] = Math.max(0, Math.min(max, battle.player.resources[key]!));
  }
  return { hp, mp: Math.max(0, battle.player.mp), resources };
}

// ---------- 战果快照 ----------

function allFieldUnits(battle: BattleState): BattleEnemy[] {
  return [
    ...battle.enemies,
    ...battle.allies,
    ...(battle.neutrals ?? []),
    ...(battle.fallen ?? []),
  ];
}

function sideOf(unit: BattleEnemy, fallback: "enemy" | "ally" | "neutral"): "enemy" | "ally" | "neutral" {
  return unit.side ?? fallback;
}

function resourceSnapshots(
  state: WorldStateV2,
  battle: BattleState,
  lookup: TemplateLookup,
  settled: SettledResources,
  worldAttrs: Record<string, number>,
): ResourceSnapshot[] {
  const ids = new Set<string>([
    "hp",
    "mp",
    ...Object.keys(lookup.template.resources),
    ...Object.keys(state.player.resources),
  ]);
  const out: ResourceSnapshot[] = [];
  for (const id of ids) {
    const current =
      id === "hp"
        ? settled.hp
        : id === "mp"
          ? settled.mp
          : (settled.resources[id] ?? state.player.resources[id] ?? 0);
    const max =
      id === "hp"
        ? (battle.player.maxHp ?? maxHp(state.player, lookup.template, worldAttrs))
        : id === "mp"
          ? maxMp(state.player, lookup.template, worldAttrs)
          : (state.player.resourceMax?.[id] ?? resourceMax(state.player, lookup.template, id));
    out.push({
      id,
      label: lookup.resourceLabel(id),
      current,
      max,
      ratio: max > 0 ? current / max : 0,
      preset: id === "hp" || id === "mp",
    });
  }
  return out;
}

/**
 * 产战果快照。**必须在 `finishBattle` 丢弃战斗镜像之前调用** ——
 * `statusStacks`、逐单位伤害、killer 都只活在镜像里。
 */
export function buildBattleResult(
  state: WorldStateV2,
  battle: BattleState,
  lookup: TemplateLookup,
  settled: SettledResources = settleResources(state, battle, lookup),
): BattleResult {
  const outcome = battle.over;
  if (outcome === null) throw new Error("battle_not_over");
  const stake = stakeOf(battle, lookup.template);
  const weights = powerWeightsOf(lookup.template);
  const selfId = selfIdOf(state);
  const worldAttrs = effectiveAttributesOfActor(state, lookup, state.player);
  const playerDied = settled.hp <= 0;

  const fallbackSides = {
    player: powerOfAttributes(worldAttrs, weights),
    ally: battle.allies.reduce((sum, u) => sum + powerOfUnit(u, weights), 0),
    enemy: battle.enemies.reduce((sum, u) => sum + powerOfUnit(u, weights), 0),
    neutral: (battle.neutrals ?? []).reduce((sum, u) => sum + powerOfUnit(u, weights), 0),
  };
  const sides = battle.powerStart ?? fallbackSides;

  const statusStacks: Record<string, number> = {};
  for (const inst of battle.player.statuses) {
    if (lookup.status(inst.statusId)?.visibility !== "known") continue;
    statusStacks[inst.statusId] = inst.stacks;
  }

  const enemyResults = [
    ...battle.enemies.map((u) => ({ unit: u })),
    ...(battle.fallen ?? [])
      .filter((u) => sideOf(u, "enemy") === "enemy" && !battle.enemies.some((e) => e.instanceId === u.instanceId))
      .map((u) => ({ unit: u })),
  ].map(({ unit }) => ({
    ref: unit.characterId,
    name: unit.name,
    tier: unit.tier ?? ("minion" as const),
    power: powerOfUnit(unit, weights),
    damageByPlayer: unit.damageByPlayer ?? 0,
    damageToPlayer: unit.damageToPlayer ?? 0,
    defeated: !unit.alive,
    killer: playerDied && unit.instanceId === battle.player.lastHitBy,
    summonedByPlayer: unit.summonedBy === selfId,
  }));

  const killerUnit =
    playerDied && battle.player.lastHitBy !== undefined && battle.player.lastHitBy !== selfId
      ? allFieldUnits(battle).find((u) => u.instanceId === battle.player.lastHitBy)
      : undefined;

  const deaths: BattleResult["deaths"] = [];
  if (playerDied) deaths.push({ id: selfId, side: "player", name: state.player.name });
  const seen = new Set<string>();
  const deathGroups: Array<[BattleEnemy[], "enemy" | "ally" | "neutral"]> = [
    [battle.enemies, "enemy"],
    [battle.allies, "ally"],
    [battle.neutrals ?? [], "neutral"],
    [battle.fallen ?? [], "enemy"],
  ];
  for (const [list, fallback] of deathGroups) {
    for (const unit of list) {
      if (seen.has(unit.instanceId) || unit.alive) continue;
      seen.add(unit.instanceId);
      deaths.push({
        id: unit.instanceId,
        ref: unit.characterId,
        side: sideOf(unit, fallback),
        name: unit.name,
      });
    }
  }

  return {
    eventId: battle.eventId,
    outcome,
    stake: stakeIdOf(battle, lookup.template),
    defeatState: stake.defeatState,
    rounds: battle.round,
    player: {
      hp: settled.hp,
      maxHp: battle.player.maxHp ?? maxHp(state.player, lookup.template, worldAttrs),
      resources: resourceSnapshots(state, battle, lookup, settled, worldAttrs),
      attributes: worldAttrs,
      power: sides.player,
      powerEnd: powerOfAttributes(worldAttrs, weights),
      damageDealt: battle.player.damageDealt ?? 0,
      damageTaken: battle.player.damageTaken ?? 0,
      crits: battle.player.crits ?? 0,
      hits: battle.player.hits ?? 0,
      kills: allFieldUnits(battle).filter((u) => !u.alive && u.lastHitBy === selfId).length,
      statusStacks,
    },
    sides,
    enemies: enemyResults,
    ...(killerUnit !== undefined
      ? {
          killer: {
            ref: killerUnit.characterId,
            name: killerUnit.name,
            tier: killerUnit.tier ?? "minion",
            power: powerOfUnit(killerUnit, weights),
            summonedByPlayer: killerUnit.summonedBy === selfId,
          },
        }
      : {}),
    deaths,
  };
}

/**
 * 旧档 / 测试的兜底：没有 `powerStart` 时按当前面板算四侧。
 * 只给读侧用，不写回状态。
 */
export function sidesNow(
  state: WorldStateV2,
  battle: BattleState,
  lookup: TemplateLookup,
): { player: number; ally: number; enemy: number; neutral: number } {
  const weights = powerWeightsOf(lookup.template);
  const attrs = effectiveAttributesOfActor(state, lookup, state.player);
  return {
    player: powerOfAttributes(attrs, weights),
    ally: battle.allies.reduce((sum, u) => sum + powerOfUnitNow(u, state, lookup, weights), 0),
    enemy: battle.enemies.reduce((sum, u) => sum + powerOfUnitNow(u, state, lookup, weights), 0),
    neutral: (battle.neutrals ?? []).reduce((sum, u) => sum + powerOfUnitNow(u, state, lookup, weights), 0),
  };
}

// ---------- 战评：等级与钩子（ADR-075 §2） ----------

function withinRange(value: number, cond: { eq?: number; ne?: number; gt?: number; gte?: number; lt?: number; lte?: number }): boolean {
  if (cond.eq !== undefined && value !== cond.eq) return false;
  if (cond.ne !== undefined && value === cond.ne) return false;
  if (cond.gt !== undefined && !(value > cond.gt)) return false;
  if (cond.gte !== undefined && !(value >= cond.gte)) return false;
  if (cond.lt !== undefined && !(value < cond.lt)) return false;
  if (cond.lte !== undefined && !(value <= cond.lte)) return false;
  return true;
}

function metricOf(result: BattleResult, metric: string): number {
  switch (metric) {
    case "hpRatio":
      return result.player.maxHp > 0 ? result.player.hp / result.player.maxHp : 0;
    case "rounds":
      return result.rounds;
    case "damageDealt":
      return result.player.damageDealt;
    case "damageTaken":
      return result.player.damageTaken;
    case "crits":
      return result.player.crits;
    case "kills":
      return result.player.kills;
    case "powerRatio": {
      const left = result.sides.player + result.sides.ally;
      const right = result.sides.enemy + result.sides.neutral;
      if (right > 0) return left / right;
      return left > 0 ? Number.POSITIVE_INFINITY : 1;
    }
    default:
      return 0;
  }
}

function battleEvalConditionMet(
  cond: BattleEvalCondition,
  result: BattleResult,
  state: WorldStateV2,
  lookup: TemplateLookup,
): boolean {
  if ("outcome" in cond) return result.outcome === cond.outcome;
  if ("grade" in cond) return result.grade === cond.grade;
  if ("metric" in cond) return withinRange(metricOf(result, cond.metric), cond);
  if ("statusStacks" in cond) return withinRange(result.player.statusStacks[cond.statusStacks] ?? 0, cond);
  return anyMatchMet(cond.anyMatch, { state, battle: result, template: lookup.template });
}

/** 战评等级：声明顺序首个命中；没声明 / 没命中 ⇒ undefined。 */
export function gradeOf(
  result: BattleResult,
  grades: readonly BattleGrade[] | undefined,
  state: WorldStateV2,
  lookup: TemplateLookup,
): string | undefined {
  for (const grade of grades ?? []) {
    // grade 条件在决胜阶段没有意义（自己读自己）；加载期已拒，这里再兜一次。
    if (grade.when.some((cond) => "grade" in cond)) continue;
    if (grade.when.every((cond) => battleEvalConditionMet(cond, result, state, lookup))) {
      return grade.id;
    }
  }
  return undefined;
}

/**
 * 战评收尾：产战果 → grade → 默认 hooks → 事件引用的 sets（按顺序）。
 *
 * **必须在 `finishBattle` 之前调用**：`statusStacks` / crits / 逐单位伤害都只活在战斗镜像里。
 * 钩子只允许 `advanceTalent / setFlag / adjustFlag / clearFlag / log`（schema 闭集），
 * 不碰时间、槽、链。
 */
export function evaluateBattle(
  state: WorldStateV2,
  battle: BattleState,
  lookup: TemplateLookup,
  rng: EffectContextV2["rng"],
): BattleResult {
  const settled = settleResources(state, battle, lookup);
  const result = buildBattleResult(state, battle, lookup, settled);
  const evaluation = lookup.template.combat?.evaluation;
  result.grade = gradeOf(result, evaluation?.grades, state, lookup);

  const ctx: EffectContextV2 = { state, lookup, rng, logs: [], battleResult: result };
  const runHooks = (hooks: readonly BattleEvalHook[] | undefined): void => {
    for (const hook of hooks ?? []) {
      if (!hook.when.every((cond) => battleEvalConditionMet(cond, result, state, lookup))) continue;
      applyEffectsV2(ctx, hook.effects);
    }
  };
  runHooks(evaluation?.hooks);
  for (const setId of battle.settle.evaluation ?? []) {
    runHooks(evaluation?.sets?.[setId]);
  }
  for (const line of ctx.logs ?? []) battle.log.push(line);
  return result;
}

// 便于调用方按需判断"这一场会不会死"。
export function isLethal(stake: StakeDef): boolean {
  return stake.defeatState === "dead";
}
