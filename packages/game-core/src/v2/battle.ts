import type {
  BattleCommand,
  BattleEnemy,
  BattleState,
  CombatSkill,
  CombatSettle,
  Effect,
  Formula,
  StatusInstance,
  V2Player,
  WorldStateV2,
} from "@life-sim/shared";
import { pickWeighted, type Rng } from "../rng.js";
import { computeMax, effectiveAttributes, maxHp, maxMp, moodBand, rollFormula, applyStatusToPlayer } from "./engine.js";
import { createTimeAdapter } from "./time.js";
import type { TemplateLookup } from "./lookup.js";

// ---------- 战斗内施法者抽象（玩家镜像与敌人统一结算） ----------

/**
 * 战斗内可结算的物品效果白名单（协议 §12 的子集）。
 * 未列出的效果类型必须可诊断地拒绝——不允许静默忽略（AGENTS.md §2）。
 */
const BATTLE_ITEM_EFFECTS = new Set<Effect["type"]>(["adjustResource", "cureStatus", "adjustMood", "applyStatus"]);

interface Combatant {
  /** 玩家为 "player"，敌人/友军为其 instanceId */
  id: string;
  name: string;
  isPlayer: boolean;
  team: "ally" | "enemy";
  hp: number;
  mp: number;
  attributes: Record<string, number>;
  statuses: StatusInstance[];
  skillCooldowns: Record<string, number>;
  mood: number;
}

function playerCombatant(state: WorldStateV2, battle: BattleState): Combatant {
  return {
    id: "player",
    name: state.player.name,
    isPlayer: true,
    team: "ally",
    hp: battle.player.hp,
    mp: battle.player.mp,
    attributes: state.player.attributes,
    statuses: battle.player.statuses,
    skillCooldowns: battle.player.skillCooldowns,
    mood: state.player.mood,
  };
}

function unitCombatant(unit: BattleEnemy, team: "ally" | "enemy"): Combatant {
  return {
    id: unit.instanceId,
    name: unit.name,
    isPlayer: false,
    team,
    hp: unit.hp,
    mp: unit.mp,
    attributes: unit.attributes,
    statuses: unit.statuses,
    skillCooldowns: unit.skillCooldowns,
    mood: 50,
  };
}

function enemyCombatant(enemy: BattleEnemy): Combatant {
  return unitCombatant(enemy, "enemy");
}

function allyCombatant(ally: BattleEnemy): Combatant {
  return unitCombatant(ally, "ally");
}

function writeBack(battle: BattleState, c: Combatant): void {
  if (c.isPlayer) {
    battle.player.hp = c.hp;
    battle.player.mp = c.mp;
    battle.player.statuses = c.statuses;
  } else {
    const list = c.team === "enemy" ? battle.enemies : battle.allies;
    const unit = list.find((u) => u.instanceId === c.id);
    if (unit) {
      unit.hp = c.hp;
      unit.mp = c.mp;
      unit.statuses = c.statuses;
    }
  }
}

// ---------- 控制/补正辅助 ----------

function controlOf(statuses: StatusInstance[], semantic: string, lookup: TemplateLookup): boolean {
  return statuses.some((inst) => {
    const control = lookup.status(inst.statusId)?.combat?.control;
    return control?.includes(semantic as never) ?? false;
  });
}

/** 攻击性技能：以敌方为目标或带伤害公式；cannot_attack 只拦这一类，不拦增益/治疗。 */
function isAttackSkill(skill: CombatSkill): boolean {
  return skill.target === "enemy" || skill.target === "all_enemies" || (skill.damage?.length ?? 0) > 0;
}

function multiplierOf(statuses: StatusInstance[], key: "damageDealt" | "damageTaken" | "hitChance", lookup: TemplateLookup): number {
  let total = 0;
  for (const inst of statuses) {
    const facet = lookup.status(inst.statusId)?.combat;
    const value = facet?.[key];
    if (typeof value === "number") total += value;
  }
  return total;
}

function effectiveAttrsOf(c: Combatant, lookup: TemplateLookup): Record<string, number> {
  return effectiveAttributes(c.attributes, c.statuses, c.mood, lookup);
}

// ---------- 建场 ----------

export function createBattle(
  eventId: string,
  settle: CombatSettle,
  state: WorldStateV2,
  lookup: TemplateLookup,
): BattleState {
  const enemies = buildUnits(settle.enemies, state, lookup);
  const allies = buildUnits(settle.allies ?? [], state, lookup);

  return {
    eventId,
    settle,
    round: 1,
    player: {
      hp: state.player.hp,
      mp: state.player.mp,
      statuses: state.player.statuses.map((s) => ({ ...s })),
      skillCooldowns: {},
    },
    enemies,
    allies,
    log: [],
    over: null,
  };
}

/** 从角色引用构建战斗单位（敌人/友军共用；资源池 = 公式上限按原始属性 × levelScale） */
function buildUnits(
  refs: Array<{ ref: string; levelScale?: number }>,
  state: WorldStateV2,
  lookup: TemplateLookup,
): BattleEnemy[] {
  return refs.map((ref, i) => {
    const def = lookup.character(ref.ref);
    if (!def) throw new Error(`character_not_found: ${ref.ref}`);
    const scale = ref.levelScale ?? 1;
    const attributes: Record<string, number> = {};
    for (const [k, v] of Object.entries(def.attributes)) attributes[k] = Math.round(v * scale);
    const skills = def.skills ?? [];
    const weights = (def.private.combatHints?.skillWeights as Record<string, number> | undefined) ?? {};
    const maxHpValue = Math.round(computeMax(lookup.template.resources.hp, 0, def.attributes, 1) * scale);
    const maxMpValue = Math.round(computeMax(lookup.template.resources.mp, 0, def.attributes, 0) * scale);
    return {
      instanceId: `${def.id}#${i + 1}`,
      characterId: def.id,
      name: def.identity.name,
      hp: maxHpValue,
      maxHp: maxHpValue,
      mp: maxMpValue,
      attributes,
      statuses: (def.statuses ?? []).map((id) => ({ statusId: id, stacks: 1, appliedTurn: state.turnIndex })),
      skillCooldowns: {},
      skills,
      skillWeights: weights,
      alive: true,
    };
  });
}

// ---------- 结算：命中判定 ----------

function hitChance(caster: Combatant, target: Combatant, skill: CombatSkill, lookup: TemplateLookup): number {
  if (!skill.hitCheck) return 1;
  const effA = effectiveAttrsOf(caster, lookup);
  const effD = effectiveAttrsOf(target, lookup);
  const raw =
    skill.hitCheck.baseChance +
    ((effA[skill.hitCheck.attacker] ?? 0) - (effD[skill.hitCheck.defender] ?? 0)) * 0.05 +
    multiplierOf(caster.statuses, "hitChance", lookup);
  return Math.max(0.05, Math.min(0.95, raw));
}

// ---------- 结算：技能 ----------

interface SkillTargets {
  caster: Combatant;
  targets: Combatant[];
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
  const allyUnits: Combatant[] = [
    playerCombatant(state, battle),
    ...battle.allies.filter((a) => a.alive).map(allyCombatant),
  ];
  const enemyUnits: Combatant[] = battle.enemies.filter((e) => e.alive).map(enemyCombatant);
  const hostile = caster.team === "ally" ? enemyUnits : allyUnits;
  const friendly = caster.team === "ally" ? allyUnits : enemyUnits;
  switch (skill.target) {
    case "self":
      return { caster, targets: [caster] };
    case "enemy": {
      // 敌方单体默认打己方首位（主角）；主角按目标实例或默认首位敌人
      if (caster.team === "enemy") return { caster, targets: hostile.length ? [hostile[0]] : [] };
      const def = targetInstanceId ? enemyUnits.find((e) => e.id === targetInstanceId) : enemyUnits[0];
      return { caster, targets: def ? [def] : [] };
    }
    case "all_enemies":
      return { caster, targets: hostile };
    case "ally":
      return { caster, targets: friendly };
  }
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
  const effC = effectiveAttrsOf(caster, lookup);
  const dealtBonus = multiplierOf(caster.statuses, "damageDealt", lookup);

  // 消耗
  caster.mp = Math.max(0, caster.mp - skill.cost.mp);
  caster.skillCooldowns[skill.id] = skill.cooldownTurns;

  const { targets } = resolveTargets(battle, state, caster, skill, targetInstanceId, lookup);

  for (const target of targets) {
    // 命中判定（省略 hitCheck = 必中）
    const chance = hitChance(caster, target, skill, lookup);
    if (rng() >= chance) {
      log(`${caster.name}的「${skill.name}」被${target.isPlayer ? "你" : target.name}闪开了。`);
      continue;
    }

    // 伤害
    if (skill.damage?.length) {
      const raw = rollFormula(skill.damage, effC, caster.statuses, rng);
      const takenBonus = multiplierOf(target.statuses, "damageTaken", lookup);
      const final = Math.max(0, Math.round(raw * (1 + dealtBonus) * (1 + takenBonus)));
      target.hp -= final;
      log(`${caster.name}的「${skill.name}」命中${target.isPlayer ? "你" : target.name}，造成 ${final} 点伤害。`);
    }

    // 治疗
    if (skill.heal?.length) {
      const amount = Math.max(0, Math.round(rollFormula(skill.heal, effC, caster.statuses, rng)));
      target.hp += amount;
      log(`${caster.name}的「${skill.name}」为${target.isPlayer ? "你" : target.name}回复 ${amount} 点${lookup.resourceLabel("hp")}。`);
    }

    // 施加补正（onSelf → 施放者）
    for (const app of skill.applyStatus ?? []) {
      const chance2 = app.chance ?? 1;
      if (rng() >= chance2) continue;
      const receiver = app.onSelf ? caster : target;
      applyStatusCombat(receiver, app.status, app.stacks ?? 1, state, lookup, log);
    }
  }

  // 献祭：结算后移除施放者自身该补正（漩涡）
  const consume = skill.consumeStatus;
  if (consume) {
    const stacks = caster.statuses.find((s) => s.statusId === consume.status)?.stacks ?? 0;
    caster.statuses = caster.statuses.filter((s) => s.statusId !== consume.status);
    if (stacks > 0) {
      // 文案只引用模板里的补正名，不写死具体召唤物/世界观名词
      const statusName = lookup.status(consume.status)?.name ?? consume.status;
      log(`${caster.name}消耗了 ${stacks} 层「${statusName}」。`);
    }
  }

  writeBack(battle, caster);
  for (const t of targets) writeBack(battle, t);
  markDeaths(battle);
}

/** 标记 hp≤0 的单位阵亡（敌人 / 友军），并写日志。 */
function markDeaths(battle: BattleState): void {
  for (const enemy of battle.enemies) {
    if (enemy.alive && enemy.hp <= 0) {
      enemy.alive = false;
      battle.log.push(`${enemy.name}失去了战斗能力。`);
    }
  }
  for (const ally of battle.allies) {
    if (ally.alive && ally.hp <= 0) {
      ally.alive = false;
      battle.log.push(`${ally.name}倒下了。`);
    }
  }
}

function applyStatusCombat(
  receiver: Combatant,
  statusId: string,
  stacks: number,
  state: WorldStateV2,
  lookup: TemplateLookup,
  log: (text: string) => void,
): void {
  const def = lookup.status(statusId);
  if (!def) return;
  const existing = receiver.statuses.find((s) => s.statusId === statusId);
  if (existing) {
    if (def.stacking === "stack") existing.stacks += stacks;
    else existing.stacks = Math.max(existing.stacks, stacks);
  } else {
    receiver.statuses.push({ statusId, stacks, appliedTurn: state.turnIndex, battleRoundsElapsed: 0 });
  }
  if (def.visibility === "known" || receiver.isPlayer) {
    log(`${receiver.isPlayer ? "你" : receiver.name}陷入了「${def.name}」。`);
  }
}

// ---------- 敌人 AI ----------

function aiTurn(
  battle: BattleState,
  state: WorldStateV2,
  unit: BattleEnemy,
  team: "ally" | "enemy",
  lookup: TemplateLookup,
  rng: Rng,
): void {
  const c = team === "enemy" ? enemyCombatant(unit) : allyCombatant(unit);
  if (controlOf(c.statuses, "cannot_act", lookup)) {
    battle.log.push(`${unit.name}无法行动。`);
    return;
  }
  const cannotAttack = controlOf(c.statuses, "cannot_attack", lookup);
  const usable = unit.skills
    .map((id) => lookup.skill(id))
    .filter((s): s is CombatSkill => s?.kind === "combat")
    .filter((s) => c.mp >= s.cost.mp && (c.skillCooldowns[s.id] ?? 0) <= 0)
    // cannot_attack（协议 §6.3）：攻击性技能不可用，增益/治疗类仍可施放
    .filter((s) => !cannotAttack || !isAttackSkill(s));
  if (usable.length === 0) {
    battle.log.push(cannotAttack ? `${unit.name}无法攻击，跳过了回合。` : `${unit.name}蓄势待发。`);
    return;
  }
  const chosen = pickWeighted(usable, (s) => unit.skillWeights[s.id] ?? 1, rng);
  if (!chosen) return;
  executeSkill(battle, state, c, chosen, undefined, lookup, rng);
}

// ---------- 回合结束（结算持续伤害/治疗、补正到期、冷却递减） ----------

function roundEnd(battle: BattleState, state: WorldStateV2, lookup: TemplateLookup, rng: Rng): void {
  const combatants: Combatant[] = [
    playerCombatant(state, battle),
    ...battle.allies.filter((a) => a.alive).map(allyCombatant),
    ...battle.enemies.filter((e) => e.alive).map(enemyCombatant),
  ];
  for (const c of combatants) {
    for (const inst of [...c.statuses]) {
      const facet = lookup.status(inst.statusId)?.combat;
      for (const effect of facet?.onRoundEnd ?? []) {
        const eff = effectiveAttrsOf(c, lookup);
        if (effect.damage) {
          const dmg = Math.max(0, Math.round(rollFormula([effect.damage], eff, c.statuses, rng)));
          c.hp -= dmg;
          battle.log.push(`${c.isPlayer ? "你" : c.name}受到「${lookup.status(inst.statusId)?.name}」的 ${dmg} 点持续伤害。`);
        }
        if (effect.heal) {
          const heal = Math.max(0, Math.round(rollFormula([effect.heal], eff, c.statuses, rng)));
          c.hp += heal;
        }
        for (const app of effect.applyStatus ?? []) {
          applyStatusCombat(c, app.status, app.stacks ?? 1, state, lookup, (t) => battle.log.push(t));
        }
      }
      // 战斗域寿命
      inst.battleRoundsElapsed = (inst.battleRoundsElapsed ?? 0) + 1;
      const rounds = facet?.battleRounds;
      if (rounds !== undefined && inst.battleRoundsElapsed >= rounds) {
        c.statuses = c.statuses.filter((s) => s !== inst);
      }
    }
    for (const key of Object.keys(c.skillCooldowns)) {
      c.skillCooldowns[key] = Math.max(0, c.skillCooldowns[key] - 1);
    }
    writeBack(battle, c);
  }

  // 死亡复查
  markDeaths(battle);
  battle.round += 1;
}

// ---------- 胜负判定 ----------

export function checkBattleEnd(battle: BattleState, state: WorldStateV2): void {
  if (battle.over) return;
  if (battle.enemies.every((e) => !e.alive)) {
    battle.over = "victory";
    battle.log.push("战斗胜利！");
    return;
  }
  if (battle.player.hp <= 1) {
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
  rng: Rng,
): void {
  const battle = state.battle;
  if (!battle || battle.over) throw new Error("battle_not_active");
  const pc = playerCombatant(state, battle);
  const prefix = `R${battle.round}`;

  if (controlOf(pc.statuses, "cannot_act", lookup)) {
    battle.log.push(`${prefix} 你无法行动。`);
  } else if (command.type === "skill") {
    if (controlOf(pc.statuses, "cannot_use_skills", lookup)) throw new Error("sealed_skills");
    const skill = lookup.skill(command.skillId);
    if (!skill || skill.kind !== "combat") throw new Error("skill_not_found");
    if (!state.player.skills.includes(skill.id)) throw new Error("skill_not_owned");
    // cannot_attack（协议 §6.3）：只拦攻击性技能，增益/治疗仍可施放
    if (isAttackSkill(skill) && controlOf(pc.statuses, "cannot_attack", lookup)) throw new Error("cannot_attack");
    if (pc.mp < skill.cost.mp) throw new Error("not_enough_mp");
    if ((pc.skillCooldowns[skill.id] ?? 0) > 0) throw new Error("skill_on_cooldown");
    battle.log.push(`${prefix} 你施放「${skill.name}」。`);
    executeSkill(battle, state, pc, skill, command.targetInstanceId, lookup, rng);
  } else if (command.type === "item") {
    if (controlOf(pc.statuses, "cannot_use_items", lookup)) throw new Error("bound_items");
    const item = lookup.item(command.itemId);
    if (!item || !item.usableInBattle) throw new Error("item_not_usable_in_battle");
    if ((state.player.inventory[item.id] ?? 0) <= 0) throw new Error("item_not_owned");
    // 先校验效果可结算再扣库存：避免「物品已消耗但效果被静默丢弃」
    for (const effect of item.use ?? []) {
      if (!BATTLE_ITEM_EFFECTS.has(effect.type)) {
        throw new Error(`item_effect_unsupported_in_battle: ${item.id}/${effect.type}`);
      }
    }
    state.player.inventory[item.id] -= 1;
    if (state.player.inventory[item.id] <= 0) delete state.player.inventory[item.id];
    // 战斗内物品效果仅结算资源/补正（作用于玩家镜像）
    for (const effect of item.use ?? []) {
      if (effect.type === "adjustResource") {
        if (effect.resource === "hp") {
          pc.hp = Math.min(maxHp(state.player, lookup.template), pc.hp + effect.value);
          battle.log.push(`${prefix} 你使用了「${item.name}」，回复 ${effect.value} 点${lookup.resourceLabel("hp")}。`);
        } else {
          pc.mp = Math.min(maxMp(state.player, lookup.template), pc.mp + effect.value);
          battle.log.push(`${prefix} 你使用了「${item.name}」，回复 ${effect.value} 点${lookup.resourceLabel("mp")}。`);
        }
      } else if (effect.type === "cureStatus") {
        pc.statuses = pc.statuses.filter((s) => s.statusId !== effect.status);
        battle.log.push(`${prefix} 「${lookup.status(effect.status)?.name ?? effect.status}」被清除了。`);
      } else if (effect.type === "adjustMood") {
        state.player.mood = Math.max(lookup.template.mood.min, Math.min(lookup.template.mood.max, state.player.mood + effect.value));
      } else if (effect.type === "applyStatus") {
        applyStatusCombat(pc, effect.status, effect.stacks ?? 1, state, lookup, (t) => battle.log.push(t));
      }
    }
    writeBack(battle, pc);
  } else if (command.type === "flee") {
    if (!battle.settle.canFlee) throw new Error("flee_not_allowed");
    if (controlOf(pc.statuses, "cannot_flee", lookup)) throw new Error("cannot_flee");
    const fleeCheck = battle.settle.fleeCheck;
    const eff = effectiveAttrsOf(pc, lookup);
    const blocker = battle.enemies.find((e) => e.alive);
    const defEff = blocker ? effectiveAttrsOf(enemyCombatant(blocker), lookup) : {};
    const chance = fleeCheck
      ? Math.max(0.05, Math.min(0.95, fleeCheck.baseChance + ((eff[fleeCheck.attacker] ?? 0) - (defEff[fleeCheck.defender] ?? 0)) * 0.05))
      : 0.5;
    if (rng() < chance) {
      battle.over = "flee";
      battle.log.push(`${prefix} 你趁隙脱离了战斗！`);
      return;
    }
    battle.log.push(`${prefix} 逃跑失败！`);
  }

  if (!battle.over) {
    // 友军行动（先于敌人，与主角同阵营）
    for (const ally of battle.allies.filter((a) => a.alive)) {
      aiTurn(battle, state, ally, "ally", lookup, rng);
    }
  }
  if (!battle.over) {
    for (const enemy of battle.enemies.filter((e) => e.alive)) {
      aiTurn(battle, state, enemy, "enemy", lookup, rng);
    }
  }
  if (!battle.over) {
    roundEnd(battle, state, lookup, rng);
  }
  checkBattleEnd(battle, state);
}

// ---------- 战斗收尾：补正转换 + 资源回写 ----------

/**
 * 战斗结束（over 非空）后调用：把战斗镜像回写世界状态。
 * 补正转换规则（规格 6.2）：存续 simulation 面，仅 combat 面清除；duration.turns 战斗中不递减。
 */
export function finishBattle(state: WorldStateV2, lookup: TemplateLookup): void {
  const battle = state.battle;
  if (!battle || !battle.over) return;

  // 回写资源（失败保底 1 点生命）
  state.player.hp = battle.over === "defeat" ? 1 : Math.max(1, battle.player.hp);
  state.player.mp = Math.max(0, battle.player.mp);

  // 补正转换
  const kept: StatusInstance[] = [];
  for (const inst of battle.player.statuses) {
    const def = lookup.status(inst.statusId);
    if (def?.simulation) {
      kept.push({ statusId: inst.statusId, stacks: inst.stacks, appliedTurn: state.turnIndex });
    }
  }
  state.player.statuses = kept;

  state.history.push({
    id: `t${state.turnIndex}-battle-${battle.eventId}`,
    turnIndex: state.turnIndex,
    worldTime: state.worldTime,
    formattedTime: createTimeAdapter(lookup.template).format(state.worldTime),
    type: "battle",
    summary: `${battle.eventId} 的战斗以${battle.over === "victory" ? "胜利" : battle.over === "defeat" ? "败北" : "撤离"}告终。`,
    detail: battle.log.join("\n"),
  });
}
