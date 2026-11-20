import type {
  AttributeValue,
  BattleCommand,
  BattleEnemy,
  Character,
  CombatSkill,
  EquipmentInstance,
  StatusInstance,
  WorldStateV2,
  WorldTemplateV2,
} from "@life-sim/shared";
import {
  canUseSkill,
  createBattle,
  createBattleRng,
  createLookup,
  createRng,
  createWorldV2,
  effectiveAttributesOfActor,
  effectiveCostOf,
  evadeOf,
  initPlayerResources,
  maxHp,
  maxMp,
  performBattleAction,
  playerSkills,
  rollFormula,
  sacrificeValueOf,
  selfIdOf,
  isAttackSkill,
  summonLimitOfTier,
  type Rng,
  type TemplateLookup,
} from "@life-sim/game-core";

/**
 * 战斗数值模拟器（2026-11-19；2026-11-19 晚迁出 core，ADR-012）。
 *
 * **它是后台工具，不是引擎能力。** 之前放在 `packages/game-core/src/v2/sim.ts` 并从
 * 包出口导出，等于给任何扩展开了一条「不经过回合管线也能造一场战斗」的后门；
 * 现在搬到服务端的后台工具目录，只服务 `pnpm inspect sim` 与 `/api/admin/sim`。
 *
 * 为什么要有它：数值从来不是「写对了」的，是「量出来的」。技能的消耗/倍率、状态的
 * 增减益、装备词条、召唤上限、消耗修正全部汇进 `performBattleAction`，而这条链路只有在
 * 真打一场的时候才会暴露问题（MP 池够不够放两发苍、无下限会不会把命中率打到 5%、
 * 天逆鉾的必中能不能破掉 100% 闪避）。
 *
 * 所以这里**不复写任何战斗规则**：建世界 → 摆一个对手 → 每回合按期望伤害挑技能 →
 * 交给 `performBattleAction`。可用性判断也只调 `canUseSkill`，不自己数钱。
 *
 * 「木桩」是注入到模板克隆体里的一个合成角色（无技能、不还手），用来量输出；
 * `--vs <角色 id>` 则打真人对局，用来量胜负与节奏。
 */

/** 模拟里的一方。`ref` 与 `dummy` 二选一（都不给 ⇒ 裸属性木桩）。 */
export interface SimActorSpec {
  /** 模板角色 id（读它的属性 / 技能 / 状态 / 装备 / 专属资源）。 */
  ref?: string;
  /** 木桩：不给角色卡，数值直接给。 */
  dummy?: {
    name?: string;
    hp?: number;
    attributes?: Record<string, number>;
    statuses?: string[];
  };
  /** 覆盖项（叠在角色卡 / 木桩之上；`attributes` 逐键覆盖）。 */
  attributes?: Record<string, number>;
  skills?: string[];
  statuses?: string[];
  equipment?: string[];
}

export interface SimDuelSpec {
  left: SimActorSpec;
  right: SimActorSpec;
  /** 打几局（不同的 seed 派生），缺省 100。 */
  repeat?: number;
  seed?: number;
  /** 单局上限回合（默认 30）；到点未分胜负计入 `undecided`。 */
  maxRounds?: number;
  /**
   * 挑招姿态（缺省 `damage`）。
   *
   * `damage` 永远选期望伤害最高的那招 —— 量 DPR 要的是这个。
   * `coverage` 先把「召唤 → 满员 → 召回 → 再召唤」这条环走完再回来打：`damage`
   * 姿态下召唤永远输给伤害（夏油开局就一发旋涡把池清零），于是召唤链路一行都量不到。
   */
  stance?: SimStance;
}

export type SimStance = "damage" | "coverage";

/** 单局结果（聚合前的原始事实）。 */
export interface SimDuelRow {
  outcome: "victory" | "defeat" | "undecided";
  rounds: number;
  damageDealt: number;
  damageTaken: number;
  attacks: number;
  hits: number;
  mpSpent: number;
  endHp: number;
  maxHp: number;
  skillUse: Record<string, number>;
  /** ADR-012：曾同时在场的召唤物峰值（量「三只杂兵+一只英雄」到底挤不挤）。 */
  summons: number;
}

/** 聚合报告：所有字段都是「每局均值」（计数类除外）。 */
export interface SimDuelReport {
  leftName: string;
  rightName: string;
  duels: number;
  wins: number;
  losses: number;
  undecided: number;
  winRate: number;
  avgRounds: number;
  /** 每回合造成的伤害（对全部敌人求和）。 */
  dpr: number;
  /** 每回合承受的伤害。 */
  takenPerRound: number;
  /** 攻击性施放的成功率（有伤害落地 / 有伤害公式的施放）。 */
  hitRate: number;
  mpSpentPerDuel: number;
  endHpRatio: number;
  skillUse: Record<string, number>;
  /** ADR-012：每局召唤物峰值均值。 */
  summonsPerDuel: number;
  rows: SimDuelRow[];
}

const DUMMY_ID = "sim-dummy";

function statusInstances(ids: readonly string[] | undefined, state: { turnIndex: number; worldTime: number }): StatusInstance[] {
  return (ids ?? []).map((id) => ({
    statusId: id,
    stacks: 1,
    appliedTurn: state.turnIndex,
    appliedAt: state.worldTime,
  }));
}

/** `characters[].equipment` → 实例（与 `buildUnit` 同形；槽位取物品自身，缺省 weapon）。 */
function instantiate(
  ids: readonly string[] | undefined,
  ownerId: string,
  lookup: TemplateLookup,
  prefix: string,
): EquipmentInstance[] {
  return (ids ?? []).map((itemId, idx) => ({
    instanceId: `${prefix}#eq${idx + 1}`,
    itemId,
    ownerId,
    slot: lookup.item(itemId)?.slot ?? "weapon",
  }));
}

/** 把 `--vs` 的木桩塞进模板克隆体：敌人必须能按 ref 解析，所以它得先「存在」。 */
function withDummy(template: WorldTemplateV2, spec: SimActorSpec): WorldTemplateV2 {
  if (spec.dummy === undefined) return template;
  const dummy: Character = {
    id: DUMMY_ID,
    isEnemy: true,
    identity: { name: spec.dummy.name ?? "木桩", age: 20, gender: template.genders[0]?.id ?? "male" },
    visibility: "hidden",
    mood: { value: 50 },
    attributes: { ...template.attributes.defaults, ...(spec.dummy.attributes ?? {}), ...(spec.attributes ?? {}) },
    skills: spec.skills ?? [],
    statuses: spec.statuses ?? spec.dummy.statuses ?? [],
    relationship: -100,
    public: {},
    private: {},
  };
  return { ...template, characters: [...template.characters, dummy] };
}

/** 属性里只有数值能进战斗算式（enum 的 options 值如 `special` 不能当数字用）。 */
function numericOverrides(base: Record<string, AttributeValue>, overrides: Record<string, number> | undefined) {
  for (const [key, value] of Object.entries(overrides ?? {})) base[key] = value;
  return base;
}

function bonusOf(statuses: StatusInstance[], key: "damageDealt" | "damageTaken", lookup: TemplateLookup): number {
  let total = 0;
  for (const inst of statuses) {
    const value = lookup.status(inst.statusId)?.combat?.[key];
    if (typeof value === "number") total += value;
  }
  return total;
}

/** 场上所有非玩家单位（敌 / 友 / 中立）。 */
function allUnits(state: WorldStateV2): BattleEnemy[] {
  const b = state.battle!;
  return [...b.enemies, ...b.allies, ...b.neutrals];
}

/**
 * 每回合的决策：**按期望伤害挑**，血量过半以下才把治疗算进分数。
 *
 * 这是「仪器」不是「AI」——它只需要稳定、可解释、不随机。任何战术上的偏好都应该
 * 体现为模板数值的差异，而不是模拟器的聪明程度。
 *
 * ADR-012：可用性一律问 `canUseSkill`（含消耗修正、召唤弹药与上限），
 * 所以六眼 -90% 之后这里会真的多放几发，不用改仪器。
 */
export function chooseCommand(
  state: WorldStateV2,
  lookup: TemplateLookup,
  maxHpValue: number,
  stance: SimStance,
): BattleCommand {
  const battle = state.battle!;
  const pc = battle.player;
  const selfId = selfIdOf(state);
  const eff = effectiveAttributesOfActor(state, lookup, state.player);
  const dealt = 1 + bonusOf(pc.statuses, "damageDealt", lookup);
  const hpRatio = pc.hp / Math.max(1, maxHpValue);
  const sheet = { hp: pc.hp, mp: pc.mp, ...pc.resources };

  const usable: CombatSkill[] = [];
  // ADR-012 D7：技能集必须问 `playerSkills`（角色自带的 ∪ 装备授予的），
  // 不能直接读 `state.player.skills` —— 否则仪器看不见天逆鉾，量不到「必中破无下限」。
  for (const id of playerSkills(state, lookup)) {
    const skill = lookup.skill(id);
    if (!skill || skill.kind !== "combat") continue;
    if (!canUseSkill(state, battle, selfId, skill.id, lookup).ok) continue;
    usable.push(skill);
  }
  if (usable.length === 0) return { type: "pass" };

  // coverage 姿态：先把召唤槽塞满，塞满了就把场上的烧掉换成伤害。
  // 不这么做的话召唤永远输给伤害 —— 夏油第一发就是普通攻击，场上空着，献祭换不到任何东西。
  if (stance === "coverage") {
    /**
     * 「还有空位」要自己判（ADR-016 D3）：满员之后 `canUseSkill` 不再拒绝召唤，而是替换 ——
     * 不判这一下的话，coverage 会一直重召下去，`sacrifice` 那段永远走不到，旋涡就量不到。
     * 判据与引擎同一份 `summonLimitOfTier`，档位统计只看自己的友军（中立的式神不占名额）。
     */
    const hasRoom = (s: CombatSkill): boolean => {
      const spec = s.summon;
      if (spec === undefined) return false;
      const tier = spec.tier ?? "minion";
      const own = battle.allies.filter(
        (u) => u.alive && u.summonedBy === selfId && (u.tier ?? "minion") === tier,
      ).length;
      return own < summonLimitOfTier(tier, lookup.template);
    };
    const summon = usable.filter(hasRoom).sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (summon) return { type: "skill", skillId: summon.id };
    // 召不动了（场上满）⇒ 把这几只烧掉换成伤害，而不是收回一只再召回来 ——
    // 后者能一直转下去，等于永远量不到 ADR-013 D5 的那一发。
    //
    // 没有献祭的流派（十影）走到这里就该**停下来正常打**：它没有「先堆再炸」的解法，
    // 回收只是换手，不是战术。以前这里无条件召回，十影会被量成「召回→重召」的永动机。
    const sacrifice = usable.filter((s) => s.sacrifice !== undefined).sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (sacrifice) {
      // 只看友军（与引擎同口径）：中立召唤物不是祭品，把它算进来会让 sim 空放旋涡。
      const hasSummon = battle.allies.some((u) => u.alive && u.summonedBy === selfId);
      const recall = usable.find((s) => s.recall !== undefined);
      // 场上还站着东西就先烧；空了但回收架里还有，就收一只回来继续烧。
      if (hasSummon || recall === undefined) return { type: "skill", skillId: sacrifice.id };
      return { type: "skill", skillId: recall.id };
    }
  }

  let best: { skill: CombatSkill; score: number } | undefined;
  // 期望伤害要折闪避：无下限是 evade 1，不折的话「41 点但永远打不进去」会一直压过
  // 天逆鉾的 32 点必中，仪器就永远量不到「必中破无下限」这件事。
  const target = battle.enemies.find((e) => e.alive);
  const miss = target ? evadeOf(target.statuses, lookup).chance : 0;
  for (const skill of usable) {
    const damage = skill.damage?.length ? rollFormula(skill.damage, eff, pc.statuses, sheet) * dealt : 0;
    // ADR-013 D5：献祭加成也算进期望伤害，否则旋涡只剩 base 10，永远排在普通攻击后面。
    const bonus =
      skill.sacrifice !== undefined ? sacrificeValueOf(battle, selfId, skill.sacrifice, "ally") : 0;
    const heal = skill.heal?.length ? rollFormula(skill.heal, eff, pc.statuses, sheet) * (hpRatio < 0.5 ? 1 : 0) : 0;
    const reach = skill.hit === "guaranteed" ? 0 : miss;
    const score = (damage + bonus) * (1 - reach) + heal;
    if (best === undefined || score > best.score || (score === best.score && skill.id < best.skill.id)) {
      best = { skill, score };
    }
  }
  // 全是增益/治疗且血够 ⇒ 仍然会选中它们（score 0 也比干站着强），只有完全无解才空过。
  if (best === undefined) return { type: "pass" };
  return { type: "skill", skillId: best.skill.id };
}

/** 一场模拟的现场：模板（含木桩）、查询表、世界状态、RNG、玩家最大 HP。 */
export interface SimSetup {
  template: WorldTemplateV2;
  lookup: TemplateLookup;
  state: WorldStateV2;
  rng: Rng;
  maxHpValue: number;
}

/**
 * 摆好一场单局战斗，但不替你打。
 *
 * 批量木桩（`simulateDuel`）与后台实时演练共用这一个入口：
 * 两边看到的角色卡、覆盖项、装备、状态、专属资源必须逐字相同，
 * 否则「木桩量出来的数」和「演练场打出来的数」会各说各话。
 */
export function createSimSetup(baseTemplate: WorldTemplateV2, spec: SimDuelSpec, seed: number): SimSetup {
  const template = withDummy(baseTemplate, spec.right);
  const lookup = createLookup(template);
  const leftDef = spec.left.ref ? template.characters.find((c) => c.id === spec.left.ref) : undefined;
  if (spec.left.ref && !leftDef) throw new Error(`sim_actor_not_found: ${spec.left.ref}`);

  const state = createWorldV2(
    {
      templateId: template.meta.id,
      seed,
      self: {
        kind: "new",
        id: "sim-player",
        name: leftDef?.identity.name ?? "模拟玩家",
        gender: leftDef?.identity.gender ?? template.genders[0]?.id ?? "male",
        age: leftDef?.identity.age ?? 16,
        attributes: {},
      },
    },
    template,
    `sim-${seed}`,
  );

  // 玩家位：角色卡打底 → spec 覆盖。属性要重算资源上限，所以放在最前面。
  const baseAttrs: Record<string, AttributeValue> = {
    ...template.attributes.defaults,
    ...(leftDef?.attributes ?? {}),
  };
  state.player.attributes = numericOverrides(baseAttrs, spec.left.attributes);
  state.player.skills = [...(spec.left.skills ?? leftDef?.skills ?? [])];
  state.player.statuses = statusInstances(spec.left.statuses ?? leftDef?.statuses, state);
  state.player.equipment = instantiate(spec.left.equipment ?? leftDef?.equipment, state.player.id, lookup, "sim-p");
  state.player.mood = leftDef?.mood.value ?? template.mood.defaultValue;
  initPlayerResources(state.player, template);
  // ADR-012 D9：角色声明的专属池也带进玩家侧（夏油开局就有「咒灵数量」）。
  for (const [key, pool] of Object.entries(leftDef?.resources ?? {})) {
    state.player.resources[key] = Math.max(0, Math.min(pool.max, pool.value));
  }
  state.player.hp = maxHp(state.player, template);
  state.player.mp = maxMp(state.player, template);

  const rightRef = spec.right.dummy !== undefined ? DUMMY_ID : spec.right.ref;
  if (!rightRef) throw new Error("sim_right_actor_missing");
  const battle = createBattle("sim-duel", { enemies: [{ ref: rightRef }], canFlee: false }, state, lookup);
  state.battle = battle;
  // 木桩的血量直接写在单位上：它本来就是个「给你打的东西」，不该再受 (75 + 5×咒力) 约束。
  const dummyHp = spec.right.dummy?.hp;
  if (dummyHp !== undefined && battle.enemies[0]) {
    battle.enemies[0].hp = dummyHp;
    battle.enemies[0].maxHp = dummyHp;
  }

  return { template, lookup, state, rng: createRng(seed), maxHpValue: maxHp(state.player, template) };
}

/** 跑一局。返回原始事实，聚合在 `simulateDuel` 里做。 */
function runDuel(baseTemplate: WorldTemplateV2, spec: SimDuelSpec, seed: number): SimDuelRow {
  const setup = createSimSetup(baseTemplate, spec, seed);
  const { state, lookup, rng } = setup;
  const battle = state.battle!;
  const row: SimDuelRow = {
    outcome: "undecided",
    rounds: 0,
    damageDealt: 0,
    damageTaken: 0,
    attacks: 0,
    hits: 0,
    mpSpent: 0,
    endHp: 0,
    maxHp: setup.maxHpValue,
    skillUse: {},
    summons: 0,
  };
  const maxRounds = spec.maxRounds ?? 30;
  const stance = spec.stance ?? "damage";

  while (!battle.over && row.rounds < maxRounds) {
    row.rounds += 1;
    const enemiesBefore = battle.enemies.map((e) => e.hp);
    const playerBefore = battle.player.hp;
    const mpBefore = battle.player.mp;
    const command = chooseCommand(state, lookup, row.maxHp, stance);
    let attacked = false;
    if (command.type === "skill") {
      const skill = lookup.skill(command.skillId);
      if (skill?.kind === "combat" && isAttackSkill(skill)) {
        row.attacks += 1;
        attacked = true;
      }
      row.skillUse[command.skillId] = (row.skillUse[command.skillId] ?? 0) + 1;
    }
    performBattleAction(state, command, lookup, createBattleRng(rng));

    const dealt = battle.enemies.reduce(
      (sum, e, i) => sum + Math.max(0, (enemiesBefore[i] ?? 0) - Math.max(0, e.hp)),
      0,
    );
    row.damageDealt += dealt;
    // 只在这回合**自己**放的是攻击技能时才记命中。ADR-012 之后召唤物也会打掉敌人的血，
    // 光看 `dealt > 0` 会让命中率超过 100%。
    if (attacked && dealt > 0) row.hits += 1;
    row.damageTaken += Math.max(0, playerBefore - battle.player.hp);
    row.mpSpent += Math.max(0, mpBefore - battle.player.mp);
    row.summons = Math.max(row.summons, allUnits(state).filter((u) => u.summonedBy !== undefined).length);
  }

  row.outcome = battle.over === "victory" ? "victory" : battle.over === "defeat" ? "defeat" : "undecided";
  row.endHp = Math.max(0, battle.player.hp);
  return row;
}

/**
 * 跑 N 局并聚合成一份报告。同 seed + 同 spec ⇒ 同报告（每局 seed = seed + i）。
 */
export function simulateDuel(template: WorldTemplateV2, spec: SimDuelSpec): SimDuelReport {
  const repeat = Math.max(1, spec.repeat ?? 100);
  const baseSeed = spec.seed ?? 1;

  const rows: SimDuelRow[] = [];
  for (let i = 0; i < repeat; i += 1) rows.push(runDuel(template, spec, (baseSeed + i * 7919) >>> 0));

  const sum = (pick: (r: SimDuelRow) => number) => rows.reduce((acc, r) => acc + pick(r), 0);
  const rounds = sum((r) => r.rounds);
  const attacks = sum((r) => r.attacks);
  const skillUse: Record<string, number> = {};
  for (const r of rows) {
    for (const [id, n] of Object.entries(r.skillUse)) skillUse[id] = (skillUse[id] ?? 0) + n;
  }
  const wins = rows.filter((r) => r.outcome === "victory").length;
  const losses = rows.filter((r) => r.outcome === "defeat").length;

  const leftDef = spec.left.ref ? template.characters.find((c) => c.id === spec.left.ref) : undefined;
  const rightDef = spec.right.ref ? template.characters.find((c) => c.id === spec.right.ref) : undefined;

  return {
    leftName: leftDef?.identity.name ?? spec.left.dummy?.name ?? "模拟玩家",
    rightName: spec.right.dummy !== undefined
      ? (spec.right.dummy.name ?? "木桩")
      : (rightDef?.identity.name ?? spec.right.ref ?? "?"),
    duels: repeat,
    wins,
    losses,
    undecided: repeat - wins - losses,
    winRate: wins / repeat,
    avgRounds: rounds / repeat,
    dpr: rounds > 0 ? sum((r) => r.damageDealt) / rounds : 0,
    takenPerRound: rounds > 0 ? sum((r) => r.damageTaken) / rounds : 0,
    hitRate: attacks > 0 ? sum((r) => r.hits) / attacks : 0,
    mpSpentPerDuel: sum((r) => r.mpSpent) / repeat,
    endHpRatio: sum((r) => (r.maxHp > 0 ? r.endHp / r.maxHp : 0)) / repeat,
    skillUse,
    summonsPerDuel: sum((r) => r.summons) / repeat,
    rows,
  };
}

export type { Rng };
export { effectiveCostOf };
