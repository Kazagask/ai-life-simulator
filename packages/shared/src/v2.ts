import type {
  Chain,
  Character,
  CombatSettle,
  Condition,
  Effect,
  EquipmentInstance,
  EventOption,
  EventV2,
  Item,
  RelationEdge,
  RelationScope,
  ScheduledEventInstance,
  Skin,
  Skill,
  StatusEffect,
  TemplateEffect,
  TimeAmount,
  WorldTemplateV2,
  TerminationRecord,
} from "./schema/index.js";
import type { EffectSummary } from "./schema/effects.js";
import type { RegenAmount } from "./schema/common.js";
import type { AttributeValue } from "./schema/attribute.js";
import type { PendingAllocation } from "./schema/allocation.js";
import type { ResolvedStyle, ResolvedTag } from "./schema/style.js";
import type { FxEffect } from "./schema/ui.js";
import type { ObservationLedger } from "./contract/perspective.js";
import type { StatusTotalVM } from "./contract/view-model.js";
import type { LlmInvocation } from "./contract/llm-invocation.js";
import type { BattleResult } from "./schema/battle-evaluation.js";

/**
 * 事件叙事回退工具（F3）：narrative 缺省时回退到 title —— 不是空串。
 * LLM 叙事正文只进 trace，event view 的 narrative 允许缺省，消费侧统一用本函数取展示文本。
 */
export function eventNarrativeOrTitle(view: { narrative?: string; title: string }): string {
  return view.narrative ?? view.title;
}

/**
 * 协议 V2 运行时类型：世界状态、战斗会话、玩家可见投影与交互命令。
 * 与 Schema（协议定义）分离：Schema 校验模板，本文件描述引擎运行时。
 */

// ---------- 运行时状态实例 ----------

export interface StatusInstance {
  statusId: string;
  stacks: number;
  /** 施加时的世界轮次（仅日志 / 展示用——**不是**时长单位，ADR-009 D2） */
  appliedTurn: number;
  /** 施加时的 `worldTime`（分钟）。`expiresAt` 的基准点。 */
  appliedAt: number;
  /**
   * 模拟域到期点（`worldTime` 分钟）。到期 = `worldTime >= expiresAt`，纯比较、不递减。
   * `untilCured` 与「挂载的身份」没有这个字段 ⇒ 永不到期。
   */
  expiresAt?: number;
  /** 战斗域：剩余战斗回合（`{ rounds: n }` 施加时置位），归零即移除 */
  roundsLeft?: number;
  /**
   * 战斗域：这条战斗态**已经经历了多少个回合末**（ADR-018 D4）。
   *
   * 只给带 `toModifier` 的实例累加，战后按 `timePerRound × max(1, roundsHeld)` 折算世界时间。
   * 不用 `battle.round - appliedRound`：`battle.round` 在回合末会 +1（`atRound: 3` 指第 3 回合
   * **开始**），减法要先对齐这个偏移；而中途存档重载、战中补数值之后还得能重建起点。
   * 单调计数器没有这些解释成本。
   */
  roundsHeld?: number;
  /** 模拟域：休息治疗进度（**分钟**，`cureConditions.restDays` 用） */
  restProgress?: number;
  /**
   * 成长型天赋的进度（ADR-075 §7）。**不是层数**：天赋实例永远一份，`stacks` 恒 1。
   * 只有 `kind: talent` 且定义声明了 `progress` 时才有。
   */
  progress?: number;
  /**
   * 已经结算过 `grant` 的阶数（0..tiers.length）。跨阶时从这一格往后结算，
   * 保证"每阶一次性奖励"只发一次；旧档缺省 ⇒ 0（读侧会按当前进度补齐）。
   */
  tiersApplied?: number;
}

// ---------- 运行时角色 ----------

export interface V2CombatantBase {
  id: string;
  name: string;
  gender: string;
  age: number;
  /** ADR-003：数值属性为 number，enum 属性为选项 id（类型由模板 defs 决定）。 */
  attributes: Record<string, AttributeValue>;
  /** reset 阶梯的当前档位（缺省 = 未发生升档；cumulative 不用此字段）。 */
  attributeTiers?: Record<string, string>;
  hp: number;
  mp: number;
  mood: number;
  statuses: StatusInstance[];
  /** 当前生效的技能冷却（skillId -> 剩余战斗回合） */
  skillCooldowns: Record<string, number>;
  /**
   * 当前皮肤（2026-11-24 · 迭代 character-media）：**只影响展示**，不参与任何判定。
   *
   * 故意**不进 `ACTOR_FIELD_GROUPS`**（`game-core/v2/actors.ts`）：夺舍搬的是「谁」与「会什么」，
   * 长相跟着**身体**走 —— 否则羂索夺舍夏油后会顶着上一具身体的脸。
   */
  skinId?: string;
  /**
   * 实例独有皮肤（预留）：自定义角色的 AI 生成形象落在这里，V1 不产生、不读。
   * 同样不参与字段搬运。
   */
  customSkin?: Skin;
}

export interface V2Player extends V2CombatantBase {
  inventory: Record<string, number>;
  /**
   * 自定义资源（ADR-003 D8）：不含 hp/mp。旧档缺省为 {}。
   */
  resources: Record<string, number>;
  /**
   * 专属资源池上限（ADR-012 D9）：与 NPC 的 `BattleEnemy.resourceMax` 同义。
   * 只有「以某角色开局（`self.kind: reuse`）」时才会有内容，缺省空。
   */
  resourceMax?: Record<string, number>;
  skills: string[];
  /** 成长等级（adjustGrowth 推进；HP/MP 上限公式 perLevel 引用） */
  growthLevel: number;
  /**
   * 本局装备实例（R-EQ-02，协议 §19；可缺省，旧存档按 [] 处理）。
   * 只存实例状态，不存状态结果——状态值每次经 evaluateDynamicModifier 现算（P8）。
   */
  equipment?: EquipmentInstance[];
  /**
   * 父/母指针（`extensions/family/doc/FAMILY-GRAPH.md` §3.1）：模板 `playerTemplate.fatherId/motherId` 的副本。
   * 玩家不是特例；可选 + 无默认值 ⇒ 旧档缺字段不拒载。
   */
  fatherId?: string;
  motherId?: string;

  // ── ADR-010 D1：以下字段与 V2Npc 同名同义，只为「演员可逆搬运」而存在 ──
  //
  // 玩家默认不写这些（扮演的人不一定有生死状态、也不一定有 AI 驱动的人格标签）。
  // 一旦扮演的是模板角色、或发生夺舍/继承，`actorTransfer` 会把对方的这些字段搬过来，
  // 搬走时不留残影。**它们不是「玩家的新功能」，是同一个演员在不同位置上的同一份数据。**
  /** 生死/离场状态。玩家天然恒在世，故缺省。 */
  lifecycle?: NpcLifecycle;
  /** 对外人格描述（模板 `public.personality` 的副本）。 */
  personality?: string;
  /** 私有目标标签（AI 效用评分用）。 */
  goals?: string[];
  /** 私有性格标签（AI 效用评分用）。 */
  traits?: string[];
  /** 已知信息标签。 */
  knowledge?: string[];
  /** 隐秘信息（不进投影）。 */
  secrets?: string[];
  /** 人物列表可见性；玩家视角下自己恒可见，故缺省。 */
  visibility?: "public" | "hidden";
  /** 模板 `isEnemy` 的副本。玩家恒 false，故缺省。 */
  isEnemy?: boolean;
  /** 出生时刻（世界分钟）。缺省时由 `birthTimeFromAge` 反推。 */
  birthTime?: number;
  /** 上次自主行动的轮次。 */
  lastActedAtTurn?: number;
  /**
   * **该演员对当前 self 的单向好感标量**（ADR-010 D5）。
   *
   * 与关系边（`state.relations`，带 `kind`/`scope` 的图）是两种东西，不是双轨：
   * 边是「是什么关系」，这个是「总体态度」，只供 AI 效用评分与投影显示，**不参与任何判定**。
   * self 换人后该字段自动解释为新 self，不需要迁移。
   */
  relationship?: number;
}

/** NPC 生命周期三态（ADR-0012 决策 1）：不引入阶段枚举，只这三态 + 自由 reasonCode。 */
export type NpcLifecycleState = "alive" | "inactive" | "unspawned";

export interface NpcLifecycle {
  state: NpcLifecycleState;
  /** 模板自由字符串（阵亡 / 叛逃 / 下落不明…）；引擎不分支，只透传。 */
  reasonCode?: string;
  /** 置为当前状态的轮次（世界初始即如此时为 0）。 */
  sinceTurn: number;
  /** 置为当前状态的世界时间（分钟）。 */
  sinceWorldTime: number;
}

/**
 * NPC 刷新规则实例（ADR-0010 决策 4 / R-LM-04 / ADR-0022）。
 *
 * 配置层（`npcSpawnRules`，yaml）→ 实例层（本结构，进存档）→ 事实层（`spawnLog` 只追加）。
 * 它是**队列**：`pending` 表示角色尚未出生/登场，`spawned` 之后不再回退。
 */
export interface SpawnRuleInstance {
  ruleId: string;
  /** 指向的角色 id —— 实例只记引用，不复制配置域定义（ADR-0010 决策 4） */
  characterRef: string;
  status: "pending" | "spawned";
  /** spawned 时的轮次与世界时间；pending 恒为 0 */
  spawnedTurn: number;
  spawnedWorldTime: number;
}

/** 事实层：NPC 出生/登场记录（append-only，只由 spawnNpc 效果追加）。 */
export interface SpawnFact {
  npcId: string;
  ruleId: string;
  turnIndex: number;
  worldTime: number;
}

/**
 * 世界时间表的事实记录（ADR-007 D1）。与 `SpawnFact` 同构，但记的是「世界自己的
 * 一行时间表走到了」——NPC 登场只是它的一种效果，所以这里不再有角色字段。
 */
export interface FactFact {
  factId: string;
  turnIndex: number;
  worldTime: number;
}

export interface V2Npc extends V2CombatantBase {
  /**
   * 生命周期（ADR-0012 决策 1 / ADR-0020 落地）。
   * 引擎**只判 `state === "alive"`**（NPC 自主行动、关系写入）；`reasonCode` 是模板自由字符串
   * （阵亡 / 叛逃 / 下落不明…），引擎不对它分支，业务语义由模板 `npcState` 条件表达。
   */
  lifecycle: NpcLifecycle;
  /** 由哪条刷新规则生出（ADR-0022）；缺省 = 世界初始即存在的角色 */
  spawnRuleId?: string;
  /**
   * 出生时刻（**世界分钟，可为负**：负值 = 世界起点之前出生，ADR-0021 决策 4.1）。
   * 与 `age` 的关系：「当前年龄」= `ageAt(birthTime, worldTime)`。
   *
   * **可选 + 读侧反推、不升 schemaVersion**（沿用 `lifecycle` 先例）：旧档没有该字段时，
   * 读取侧按「从世界起点按整年回溯 age」兜底（`time.birthTimeFromAge`），
   * 从而保证 `ageAt(birthTime, 0) === age`。
   *
   * 写入点只有一处：建世界期（`createWorldV2`）。`spawnNpc` 仍缺，故本字段不新增写入点。
   */
  birthTime?: number;
  /**
   * ⚠ **语义收窄（ADR-0021 决策 4.1）**：`age` 继承自 `V2CombatantBase`，在 NPC 上它现在只是
   * 「**起始年龄快照**（世界起点时的年龄）」，唯一合法读者是 birthTime 的反推兜底；
   * **不再表示当前年龄**，也不被投影直接读取——投影的 `npcs[].age` 由
   * `ageAt(birthTime, worldTime)` 现算。保留为必填字段只是旧档字节兼容
   * （`CombatantBaseSchema.age` 是 strict 存档必填，删字段＝旧档全拒载）。
   */
  // age 在 V2CombatantBase 中声明，此处仅承接语义说明
  /** 与玩家的关系值 */
  relationship: number;
  personality: string;
  knownGoals: string[];
  skills: string[];
  /** 模板 `characters[].isEnemy` 的副本。实例表里只会出现 `false`（敌人不实例化）。 */
  isEnemy: boolean;
  /**
   * 模板 `characters[].visibility` 的副本：**玩家视角「人物列表里有没有他」的唯一门**
   * （2026-11-16 用户裁决）。`hidden` 的人照样活在世上、照样有卡片之外的一切
   * （关系端点、战斗解析、自主行动），只是不出现在 NPC 列表里。
   * 旧档缺字段 ⇒ 加载期补 `public`。
   */
  visibility: "public" | "hidden";
  /**
   * NPC 背包。`createWorldV2` 初始化为空对象；物品进出走 `grantItem`/`removeItem` 的 `who`
   * 参数（ADR-010 D2）。NPC 自主使用物品仍未实现（`npcActions` 不读它）。
   */
  inventory: Record<string, number>;

  // ── ADR-010 D1：与 V2Player 同名同义，只在 NPC 需要时才出现 ──
  /** 自定义资源（不含 hp/mp）。缺省 = 只有 hp/mp。战斗单位构建时若缺省按空处理。 */
  resources?: Record<string, number>;
  /** 装备实例（模板 `characters[].equipment` 实例化而来）。词条计算与玩家同一套函数。 */
  equipment?: EquipmentInstance[];
  /** 成长等级（`computeMax` 的 perLevel 公式引用）。缺省 = 0，与旧行为一致。 */
  growthLevel?: number;
  /** 私有目标标签（效用评分 goalMatch，不进投影） */
  goals: string[];
  /** 私有性格标签（效用评分 traitAffinity，不进投影） */
  traits: string[];
  /** 已知信息标签（信息差约束，不进投影） */
  knowledge: string[];
  /** 隐秘信息（不进投影） */
  secrets: string[];
  /** 上次自主行动的轮次 */
  lastActedAtTurn: number;
  /**
   * **大众认知的生父**（`extensions/family/doc/FAMILY-GRAPH.md` §3.1）：模板 `characters[].fatherId` 的副本，
   * 缺省 = 不详。可选 + 无默认值，旧档缺字段不拒载（沿用 `birthTime` 的先例）。
   *
   * ⚠ **本轮只是铺路**：亲缘推导仍走关系边，没有任何代码读这两个指针。
   */
  fatherId?: string;
  /** **大众认知的生母**。语义同 `fatherId`。 */
  motherId?: string;
}

// ---------- 战斗 ----------

/** 单位在战斗里的阵营。用于**混合列表**（已退场名册）的边框配色。 */
export type BattleSide = "ally" | "enemy" | "neutral";

/** 装备词条在战斗轴上的合计（`dynamicModifiers` 里 `combat:` 那一支的产物）。 */
export interface BattleGear {
  hitChance: number;
  evade: number;
  damageDealt: number;
  damageTaken: number;
  guaranteedHit: boolean;
}

export interface BattleEnemy {
  /** 战斗实例 id（同角色多实例区分） */
  instanceId: string;
  characterId: string;
  name: string;
  hp: number;
  maxHp: number;
  mp: number;
  /** MP 上限（战斗 AI 公有比例用；可选以兼容旧存档，缺省回退当前 mp） */
  maxMp?: number;
  attributes: Record<string, AttributeValue>;
  /** 自定义资源（ADR-003 D8）；敌人 / 友军同样携带。 */
  resources: Record<string, number>;  /**
   * 专属资源池的上限（ADR-012 D9）：`resources` 只存当前值，上限来自角色声明。
   * 缺省（旧档 / 无专属池）⇒ 空表，投影只显示有名有姓的池。
   */
  resourceMax?: Record<string, number>;
  /** ADR-003 D12：战斗内每回合结束的回复（来自角色声明的 `combatRegen`；值可为常数或加权式）。 */
  combatRegen?: Record<string, RegenAmount>;
  statuses: StatusInstance[];
  skillCooldowns: Record<string, number>;
  /**
   * 心情（ADR-010 D3）。以前战斗单位没有这个字段，`unitCombatant` 一律写 50，
   * 于是 NPC 的心情从不影响 `moodBand` 的属性修正。可选以兼容旧档（缺省按 50）。
   */
  mood?: number;
  skills: string[];
  skillWeights: Record<string, number>;
  alive: boolean;
  /**
   * 战果计数（ADR-075 §3）：只用于 `BattleResult` / `anyMatch`，不参与任何战斗判定。
   * 旧档缺省 0。
   */
  damageByPlayer?: number;
  damageToPlayer?: number;
  /** 最后一次把 hp 打到 0 的来源单位实例 id（无 → 不是被技能打死的）。 */
  lastHitBy?: string;

  // ── ADR-012：召唤与中途加入 ──
  /** 展示档位：minion = 小框（缺省）；hero = 与真实战斗角色同版式。 */
  tier?: "minion" | "hero";
  /**
   * 阵营（2026-11-20）：建场 / 召唤 / 援军时写入。
   *
   * 普通面板按数组分阵营（`enemies` / `allies` / `neutrals`），不需要它；
   * **已退场名册是混合列表** —— 少了这个字段，敌方献祭的单位会被渲染成友军蓝框
   * （用户 2026-11-20 实测：夏油献祭的咒灵是蓝的）。
   */
  side?: BattleSide;
  /**
   * 装备的战斗轴合计（2026-11-20）：命中 / 闪避 / 增减伤 / 必中。
   *
   * 建场时算一次、整场不变（战斗中不能换装），与有效属性同理烘进单位快照 ——
   * 引擎不存「装备实例」，只存它们在这一场结算出来的数。
   */
  gear?: BattleGear;
  /** 召唤者（战斗实例 id）。只对召唤物有值，用于上限统计、召回与连带清除。 */
  summonedBy?: string;
  /** 入场回合号。等于当前回合 ⇒ 本回合不行动（免得刚召唤就替玩家打一轮）。 */
  enteredRound?: number;
  /**
   * 召唤它的角色 id（ADR-013）：召回后重新召唤要靠它对上号 ——
   * 「同一只」是按 `summonRef` + `summonedBy` 认的，不按实例 id。
   */
  summonRef?: string;
  /** 召唤者倒下时是否一并消失（缺省 dismiss）。 */
    dismissOnSummonerDown?: boolean;
    /** 单位退场 / 死亡的可展示原因（英雄死亡、被献祭等）。缺省 = 没有可解释的原因。 */
    deathReason?: string;
}

/** 事件 + 统一戳：`seq` 由 pushBattleEvent 分配，`round` 用来切段（见 fx 分组）。 */
export type BattleEvent = BattleEventBody & { round?: number };

export type BattleOutcome = "victory" | "defeat" | "flee";

export interface BattleState {
  /** 触发战斗的事件 id */
  eventId: string;
  /** 结算配置副本 */
  settle: CombatSettle;
  round: number;
  /**
   * 本场赌注（ADR-075）：建场时从 `settle.stake ?? world.combat.defaultStake` 解析。
   * 旧档缺省 ⇒ 按 `hard` 读（当时的全部战斗都是"力竭"）。
   */
  stake?: string;
  /** 战败后的状态；`dead` 是死亡路由的唯一入口。旧档缺省 ⇒ `down`。 */
  defeatState?: "yielded" | "down" | "dead";
  /** 判负阈值：`dead → 0`，其余 `1`。旧档缺省 ⇒ 1。 */
  defeatThreshold?: number;
  /**
   * 开场战斗力快照（ADR-075 §4.4）：四侧都在建场时算一次。
   * 旧档缺省 ⇒ 读侧现算（只能用当前面板，可能已含中途增减益）。
   */
  powerStart?: { player: number; ally: number; enemy: number; neutral: number };
  /** 玩家在战斗内的运行时镜像（伤害/治疗结算到镜像，结束后回写主状态） */
  player: {
    hp: number;
    mp: number;
    /** 开场 HP 上限（hp_below 与战果快照用）。旧档缺省 ⇒ 现算。 */
    maxHp?: number;
    /** 战果计数（ADR-075 §3）：只记录，不参与判定。 */
    damageDealt?: number;
    damageTaken?: number;
    crits?: number;
    hits?: number;
    /** 最后一次把玩家打到 0 的来源单位实例 id。 */
    lastHitBy?: string;
    /** 自定义资源镜像（ADR-003 D8）；战斗结束回写 `state.player.resources`。 */
    resources: Record<string, number>;
    statuses: StatusInstance[];
    skillCooldowns: Record<string, number>;
    /** 装备的战斗轴合计（2026-11-20）：开场算一次，整场不变。 */
    gear?: BattleGear;
  };
  enemies: BattleEnemy[];
  /** 友军单位（与主角同阵营，AI 自动行动；形状同敌人，战斗内临时，不持久化到世界） */
  allies: BattleEnemy[];
  /**
   * 中立单位（ADR-012 D5）：第三方，对所有人敌对，**不参与胜负判定**。
   * 旧档没有这个字段 ⇒ 读取侧按空数组处理。
   */
  neutrals: BattleEnemy[];
  /**
   * 已从战场移除但仍需解释下场的单位（献祭 / 召唤者倒下连带消失）。
   * 留在场上倒下的单位仍在 allies/enemies/neutrals 里，不重复记到这里。
   */
  fallen?: BattleEnemy[];
  /**
   * 已收回的召唤物（ADR-013）。收回 ≠ 阵亡：单位连同伴随它走过的一切（血量、状态、
   * 冷却、入场回合）停在这里，同一场战斗里再喊一次就原样回去 ——
   * 这就是「战斗内收回再召唤，状态继承」。战斗结束即随 `battle` 一起丢弃，
   * 所以下一场照例满血（ADR-013 D4）。旧档没有这个字段 ⇒ 按空数组读。
   */
  bench?: BattleEnemy[];
  /**
   * 本轮刚离场、还要在面板上留一张灰卡的单位（收回 / 献祭）。
   * 不参与任何判定，**下一回合开始清空** —— 清太早会让轨迹指向空气。
   */
  departed?: BattleEnemy[];
  /**
   * 战斗结束时**当场算好**的战评（ADR-077）。
   *
   * 判定出 `over` 到玩家点「继续」之间世界是停住的 —— 战评必须在这段时间里可读，
   * 所以在 `over` 出现的那一刻就算好并落在这里；`leave` 时直接交给 `finishBattle`，不重算。
   */
  evaluation?: BattleResult;
  /**
   * 召唤物实例编号的**单调计数器**（ADR-013）。只增不减：数组长度会因阵亡 / 收回变短，
   * 拿它起算编号就会与在场的单位撞名，而 `writeBack` 是按实例 id 找人的。
   * 旧档没有 ⇒ 从 0 起算，编号仍由在场者去重兜底。
   */
  summonSeq?: number;
  /**
   * 中途加入的触发进度（ADR-012 D3）：键 = 声明的 `id`（缺省 `#<下标>`），值 = 已触发次数。
   * 进存档是为了读档不重放；缺省空表。
   */
  reinforcementFires?: Record<string, number>;
  /**
   * 钩子触发次数（ADR-073）：键 = `hook.id`，值 = 本场已触发次数（`limit.per: battle` 用它）。
   * 进存档是为了读档不复活「每场一次」的不屈。
   */
  hookFires?: Record<string, number>;
  /** 本回合的钩子触发次数（`limit.per: round`）；`roundEnd` 清空。 */
  hookRoundFires?: Record<string, number>;
  /**
   * 结构化战斗事件（ADR-073 §6）：只写不读，UI 之后按需消费。
   * 与 `log` 并行存在 —— `log` 是人读的句子，这里是机器读的事实，不从字符串反解。
   */
  events?: BattleEvent[];
  /**
   * 事件序号计数器（ADR-076 §10）：`events` 只留最近 200 条，
   * 序号不能靠数组下标推算。旧档缺省 0。
   */
  eventSeq?: number;
  /** 战斗日志（玩家可见） */
  log: string[];
  over: BattleOutcome | null;
}

/**
 * 结构化战斗事件（ADR-073 / ADR-076）：渲染层据此做轨迹、受击与数字。
 *
 * `seq` 由 `pushBattleEvent` 统一编号（单调递增、进存档）：UI 只播 `seq > 游标` 的段，
 * 读档时把游标推到最后一条，避免一进战斗就炸一屏数字。
 *
 * `miss` 的出现（ADR-076 §9）是因为「未命中」以前只有一行 log ——
 * 前端只能正则匹配中文，改文案就崩。
 */
type BattleEventBody =
  | {
      kind: "damage";
      seq?: number;
      actor: string;
      target: string;
      /** 技能 id（ADR-076 §3.3 的 P3 覆盖键）；DoT 之类的间接伤害没有它 */
      skillId?: string;
      amount: number;
      critical: boolean;
      /** 1 = 普通暴击；2 = 被钩子放大过的暴击（倍率指数 ≠ 1） */
      critTier?: 1 | 2;
      /** 把这次暴击的倍率再放大的钩子 id（`critExponent` 效果） */
      amplifiedBy?: string;
      hookId?: string;
    }
  | { kind: "heal"; seq?: number; actor: string; target: string; skillId?: string; amount: number }
  | {
      kind: "miss";
      seq?: number;
      actor: string;
      target: string;
      skillId?: string;
      /** 断在哪一道判定上：beforeHit 取消 / 命中骰 / 闪避 / afterHit 取消 */
      stage: "beforeHit" | "hit" | "evade" | "afterHit";
      /** 只用于浮层解释（如闪避来源的状态名），不参与判定 */
      reason?: string;
    }
  | {
      /**
       * 献祭（ADR-076 §3.12）：召唤物被消耗掉，没有伤害也没有治疗。
       * 不给这条，漩涡的第一段（群体献祭）在画面上就是空的。
       */
      kind: "sacrifice";
      seq?: number;
      actor: string;
      target: string;
      skillId?: string;
      name?: string;
    }
  | {
      /**
       * 状态施加（ADR-076 §3.8）：**纯状态技能既没有伤害也没有治疗**，
       * 不补这条事件，表现层就什么也演不出来（点了没反应）。极性只用于选色。
       */
      kind: "buff";
      seq?: number;
      actor: string;
      target: string;
      skillId?: string;
      statusId: string;
      /** 模板里的状态名；内核不写死文案，缺省时前端不显示浮层 */
      name?: string;
      polarity?: "positive" | "negative" | "neutral";
    }
  | {
      /**
       * 召唤 / 收回（ADR-076 §3.7）：目标为空的那类技能没有伤害事件，
       * 但表现层需要「谁登场了、谁退场了」这条事实，否则召唤就只能靠前端猜。
       */
      kind: "summon";
      seq?: number;
      actor: string;
      /** 新登场的召唤物实例 id（友军 / 中立的单位 id） */
      summonId: string;
      name?: string;
      skillId?: string;
    }
  | { kind: "recall"; seq?: number; actor: string; target: string; name?: string; skillId?: string }
  | { kind: "cancel"; seq?: number; actor: string; target?: string; skillId?: string; hookId?: string; reason: string }
  | { kind: "hook"; seq?: number; hookId: string; text?: string };

// ---------- 呈现槽（ADR-0034 §1） ----------

/**
 * 呈现槽：**下一次轮次必须立即处理的那一个事件**（ADR-0034 §1/§2）。
 *
 * 为什么是状态字段而不是队列：用户口述模型是「同一轮次只能发生、处理、结算**一个**事件」，
 * 而「下一个要处理哪个事件」本身是**一条事实**，必须进存档（否则刷新即丢）。
 * 它只存"是谁、从哪来"，**不存进度、不存玩家输入、不存选项**——呈现内容永远从模板现取。
 *
 * 写入口 = **5 个具名来源**（ADR-0034 §4 S4）：
 * 1. 队列取出：`from: "queueTake"`（扫描到期实例后取出即占槽）；
 * 2. 当前事件结算后的后继：`from: "successor"`（`nextEventId` 且**无时间账**时才占槽）；
 * 3. 开局交接：`from: "opening"`（`handoff.pendingEvents` 的第一条占槽，其余入队）；
 * 4. 行动钩子：`from: "hook"`（`action-hook` 命中后直接写槽，早于队列扫描）；
 * 5. 死亡结局事件：`from: "death"`（终止路径写入的收束事件）。
 * 另有 1 处**死亡路径的克隆回写**（`turn.ts` 的 `state.slot = res.state.slot`：判定与写回不在同一对象上，
 * 属"同一来源的二次落地"，不计为第 6 个来源）。
 *
 * ⚠ 这是**白名单纪律，不是类型层保证**：TS 拦不住直接给 `state.slot` 赋非 null 值。
 * 加固方向见 ADR-0034 §12-1（收敛到单一入口 `assignSlot()` + 「写点枚举」静态测试）。
 */
export interface SlotScene {
  eventId: string;
  from: "successor" | "opening" | "death" | "hook" | "queueTake";
  /** `from === "successor"` 时记录上一个事件 id（诊断用，不参与判定） */
  fromEventId?: string;
  /**
   * 该事件来自**队列实例**时带上实例 id（仅 `from === "queueTake"` 会写，ADR-0034 §8-⑪）。
   *
   * 为什么需要它：`MissedEventRecord.instanceId` 是「错失事实能回指到队列实例」的唯一凭据。
   * 槽路径（`revalidateSlot`）失效时若没有实例 id，就只能退化进非持久化的 `droppedPending`——
   * 那是**预期**，不是 bug：`successor` / `hook` / `opening` / `death` 四个来源根本没有队列实例，
   * **不得造 id**（造假 id 会污染 `missedEvents` 的回指）。
   *
   * 反作弊：它属于队列身份，**不得进投影**（§8-⑥）——`slotEvent` / history / 错误详情都不带。
   */
  instanceId?: string;
}

// ---------- R2.5 事实层 / 派生索引 ----------

/** 错失原因封闭枚举：新增原因须改协议（design §3.4.1）。 */
export type MissReason = "window_expired" | "miss_when";

/** 错失事实（append-only）：一条记录必然能在 scheduledEvents 找到对应 instanceId。 */
export interface MissedEventRecord {
  eventId: string;
  instanceId: string;
  turnIndex: number;
  /** 判定错失时的世界分钟（整数） */
  worldTime: number;
  reason: MissReason;
  /** 模板 missLabel 透传，仅 miss_when 有意义 */
  label?: string;
}

/** 触发事实（append-only）：同一 eventId 可多条，写入后逐字段不变（R-LM-03）。 */
export interface EventFireRecord {
  eventId: string;
  turnIndex: number;
  worldTime: number;
}

/** 派生索引/缓存（**不是事实**）：可从 eventFires 重建，承接 once/冷却/eventOccurred 的 O(1) 查询。 */
export interface LastFiredIndexEntry {
  turnIndex: number;
  worldTime: number;
}

// ---------- 世界状态 ----------

/** 历史条目可见性：只有 public 进玩家端；hidden/unknown 一律不进（R-VS-01）。 */
export type HistoryVisibility = "public" | "hidden" | "unknown";

export interface HistoryEntryV2 {
  id: string;
  turnIndex: number;
  worldTime: number;
  /** 由时间适配器生成的历法显示文本（替代前端公历硬编码） */
  formattedTime: string;
  type: "player_action" | "npc_action" | "event" | "battle" | "milestone" | "world";
  summary: string;
  detail?: string;
  /**
   * 可选是为了兼容 R2.2 及以前的存档（缺省视为 public——兼容策略而非语义主张）；
   * 写入侧由 pushHistory 签名强制提供，新数据一定带值。协议 §21.1。
   */
  visibility?: HistoryVisibility;
}

/**
 * 玩家可见性唯一判定入口（R-VS-01）：读取侧不得各自写 `=== "public"`。
 */
export function isPlayerVisible(entry: HistoryEntryV2): boolean {
  return (entry.visibility ?? "public") === "public";
}

/**
 * 世界状态协议版本（落盘信封的 `schemaVersion`）。
 *
 * 唯一出处：服务端拒载旧档、客户端上报 `world_saves.protocol_version` 都用它；
 * 两处各写一个字面量迟早漂。新增字段若是**可选 + 读侧兜底**，不升这个数。
 */
export const WORLD_SCHEMA_VERSION = 5;

export interface WorldStateV2 {
  id: string;
  templateId: string;
  seed: number;
  turnIndex: number;
  /** 世界时间 = **整数分钟**（R-LM-05；本轮按 #45 裁决不加数值上界校验） */
  worldTime: number;
  playerAgeAtStart: number;
  player: V2Player;
  /**
   * 玩家**永久失去**的召唤物（ADR-013 D3）：存的是 `summon.ref` 点过的角色 id。
   *
   * 英雄档召唤物是「个体」不是「耗材」—— 死了或献祭了就真的没了，本局再也召不出来
   * （十影那套宝可梦玩法靠的就是这一条：损失是真的）。杂兵不进这张表，它们只是
   * 一次性的兵力，下一场照常召（ADR-013 D2）。
   *
   * 纯新增 ⇒ 不升 `schemaVersion`、不拒旧档；旧档读作「什么都没失去」。
   */
  lostSummons?: string[];
  /**
   * 当前观察者（2026-11-20）：由 `observeActor` 效果写入，缺省 = `selfId`。
   *
   * 只影响**关系可见性**与快照上的 `viewerId` —— 不换人、不改数值。
   * 模板可以用「行动 / 事件」把镜头交给别人（看某人的关系行、看某个死者的过去）。
   */
  viewerId?: string;
  /**
   * 玩家在**演员表 / 关系图**里的节点 id（ADR-001 / R-SELF-01，2026-11-18 完整切换）。
   *
   * 权威 self 实体**就是 `state.player`**（唯一真源）：`selfId` 是它在图里的名字。
   * 默认 `"player"`；扮演剧本人物时为角色 id（如 `npc-xxx`），**该角色不再进 `npcs`**
   * （同一实体不建两份，杜绝属性双写补丁）。所有把玩家当图节点的代码一律走
   * `selfIdOf(state)` / `actorOf(state, id)`，不写死字面量 `"player"`。
   * 可选 + 缺省 `"player"` 仅为旧读法兜底；schemaVersion 5 的新档一律显式写入。
   */
  selfId?: string;
  /**
   * 前实例化开局的落盘记录（ADR-001）：openingId + 每一步的 results。
   * 可选（schemaVersion 5 的新档一定会写）；只记结果，不记 Draft / 中间世界。
   */
  opening?: {
    openingId: string;
    results: Array<{
      nodeId: string;
      optionId?: string;
      rollIndex?: number;
      allocation?: Record<string, Record<string, number>>;
      /** input 节点玩家填的原文（ADR-072 D7）。 */
      input?: string;
    }>;
  };
  npcs: V2Npc[];
  /**
   * R2.6 / ADR-0014：关系图边（实例层）。kind 语义 = from→to（`{from:A,to:B,kind:"father"}` =
   * B 是 A 的父亲）；知情人范围见 `scope`（ADR-007 D3，缺省由旧 `visibility` 推导）。
   */
  relations: RelationEdge[];
  /** NPC 刷新规则实例队列（ADR-0022；配置域规则的实例化副本，可序列化、进存档） */
  spawnRules: SpawnRuleInstance[];
  /** 事实层：出生/登场记录（append-only，与 eventFires / missedEvents 同级） */
  spawnLog: SpawnFact[];
  /**
   * 世界时间表执行记录（ADR-007 D1）：每条形如 `{ factId, turnIndex, worldTime }`，
   * append-only。`factId` 出现即「这条事实已经发生」，引擎不再重复执行。
   */
  facts: FactFact[];
  /**
   * 待完成的加点请求（ADR-019，2026-11-20）：由 `grantAllocation` 效果挂上，
   * 由轮外端点 `POST /api/worlds/:id/allocation` 提交后清空。
   *
   * 只存**请求**，不存「已分配点数」：提交即落基础属性（与开局一致，D3/D5），
   * 世界里不留一个会被遗忘的余额字段。同 id 的重复授予是幂等的（日常事件反复给同一笔）。
   */
  pendingAllocation?: PendingAllocation;
  /** 模板可读写的语义黑板；引擎内部记录不得写入（R-LM-02） */
  flags: Record<string, boolean | number | string>;
  /**
   * 【R2.5 过渡兼容】eventId -> 最近触发轮次，保留为 O(1) 「last fired turn」索引。
   * 与 `lastFiredIndex` / `eventFires` 三者**只由 scheduler.recordFire 一处写入**，不得散写。
   * 保留原因：ending.ts / turn.ts / 27 处既有消费与测试依赖该数值形态，本轮不冒险批量改写。
   * R2.6 可统一收敛到 `lastFiredIndex`（含 worldTime）后退役本字段。
   */
  firedEvents: Record<string, number>;
  /** 实例层：**唯一队列**——延时事件队列（有 id / status / 固化窗口，可审计） */
  delayQueue: ScheduledEventInstance[];
  /**
   * 运行时生成的分支事件定义（AGENTIC-GM 重构）：追加式，与模板事件同 schema。
   * 由 `story.submitBranch` 写入；`TemplateLookup.event()` 查表时优先命中它。
   * 可选 ⇒ 旧档可直载、没有生成内容的世界逐字段不变。
   */
  generatedEvents?: EventV2[];
  /**
   * 运行时生成的**角色定义**（模板里没有的人）：随分支提交写入，实例同时落 `npcs`
   * （`unspawned`），由选项效果 `{spawn: alias}` 激活。与模板角色共用同一实例表与生命周期。
   */
  generatedCharacters?: Character[];
  /** 全局单调入队序号，纯状态递增（不用 Date / 随机） */
  enqueueSeqCounter: number;
  /** 事实层：错失记录（append-only） */
  missedEvents: MissedEventRecord[];
  /** 事实层：触发日志（append-only） */
  eventFires: EventFireRecord[];
  /** 派生索引：可从 eventFires 重建；冷却读 worldTime */
  lastFiredIndex: Record<string, LastFiredIndexEntry>;
  /**
   * 呈现槽（ADR-0034 §1）：`null` = 空槽（可自由行动 / 可扫队列）；非 null = 必须立即处理它。
   * 这是「一轮只演一个事件」的**结构保证**（标量，构不出"两个事件同时在槽"）。
   */
  slot: SlotScene | null;
  /** 进行中的战斗（同一时刻至多一场；over 后保留至下一次轮次推进时清除） */
  battle: BattleState | null;
  /**
   * 最近一场战斗的战果快照（ADR-075 §3）。
   *
   * 死亡事件可能在这之后的轮次才结算，所以它跨轮存活；新战斗建场时清空。
   * 注意：它**不是权威状态**，只是"这一场发生了什么"的只读记录。
   */
  lastBattleResult?: BattleResult;
  /**
   * 死亡链待办（ADR-075 §5.3）：已命中 `then.kind: event` 的路由，等这条事件结算。
   * 期间禁止普通行动；事件结算后要么 hp1 收尾，要么被 `playerDeath` 再入路由。
   */
  deathPending?: { routeId: string; eventId: string };
  /** `playerDeath` 落下的信号；由死亡边界消费并清空。 */
  deathSignal?: { reason?: string };
  /** 当前死亡链深度（进入路由 +1，链结束归零）。引擎不设上限，模板自己收敛。 */
  deathDepth?: number;
  /** 最近一次转盘结果（持久化到状态，供刷新后回放） */
  lastWheel: WheelResultView | null;
  /**
   * 当轮全部转盘结果（D-03），按本轮**触发顺序**排列；每个轮次起点清空，不是累计历史。
   * 单槽 `lastWheel` 只保留「最后一个」，同轮多个 `kind: random` 事件会互相覆盖 ——
   * 本字段承接「同轮全部呈现」，`lastWheel` 保留以兼容既有消费者（投影 / D-09 回放）。
   * 可选：R2.x 旧存档无此字段，读侧一律按 `[]` 处理（与 history.visibility /
   * player.equipment 同一兼容策略，故不升 schemaVersion、不拒载旧档）。
   */
  lastWheels?: WheelResultView[];
  history: HistoryEntryV2[];
  /** 开局交接完成标记；false 时拒绝普通轮次推进 */
  openingCompleted: boolean;
  /** 唯一终止事实来源：null=运行，非 null=已终止（固化后只读） */
  termination: TerminationRecord | null;
  /** 归档只读标记；为真时拒绝任何状态写入 */
  archived: boolean;

  // ---------- F3 / F4 新契约状态（schemaVersion 4 预留；本波旧档不兼容） ----------
  /** 统一观察者知识台账（F4）：玩家与每个 npc:<id> 共用一套。 */
  observationLedger: ObservationLedger;
  /** 进行中的 LLM 调用；回程一律走引擎 API。 */
  pendingInvocation?: LlmInvocation;
  /** 当前占用的媒体资源绑定（存档只留引用，不放叙事正文）。 */
  media?: Array<{ slot: string; assetId: string }>;
  /** append-only *.trace.jsonl 的引用；叙事正文只进 trace（F3）。 */
  traceRef?: string;
  /**
   * ADR-0036：触发器**边沿判定**的跨轮历史（key = `${reason}#${llmTriggers 下标}`）。
   *
   * 为什么进 state：边沿判据是跨轮的，必须和它判定的世界同生共死 —— 读档后重新求值要得到
   * 同样的结果（确定性硬约束）。放内存 = 重启后重复触发。
   *
   * 为什么 optional 且不升 schemaVersion：旧档缺该字段 ⇒ 视作"无历史" ⇒ 首轮把当前真值
   * 当"刚刚变真"（至多多发一次，不会永久抑制），与 `spawnRules` / `lastWheels` 同一兼容策略。
   */
  triggerFireLedger?: Record<string, TriggerFireLedgerEntry>;
  /**
   * 扩展层的状态切片（`docs/EXTENSIONS.md` §2 / `extensions/family/doc/CLAN-DESIGN.md` §2.1）。
   *
   * 键 = 扩展 id（与模板 `extensions:` 的键对齐），值 = **该扩展自己的**可 JSON 序列化对象。
   * 内核**只做字节级 round-trip**：不读、不改、不解释内容，也不认识「宗族」「声望」这类词 ——
   * 这是「卸载全部扩展后内核照样跑完整一局」的落点。
   *
   * 可选 + 缺省 `undefined` ⇒ 旧档直载、模板不声明扩展时逐字段不变（沿用
   * `spawnRules` / `lastWheels` 的兼容策略，**不升 `schemaVersion`**）。
   * 读档时已注册扩展的 `stateSchema` 会被应用到对应切片；未注册的 id 原样保留
   * （可能是已卸载扩展的遗留数据），不丢、不报错。
   */
  extensions?: Record<string, unknown>;
}

/** ADR-0036：单条触发器的最近一次求值结果。 */
export interface TriggerFireLedgerEntry {
  turnIndex: number;
  hit: boolean;
}

// ---------- 投影与命令 ----------

export interface WheelResultView {
  eventId: string;
  /**
   * 转盘所属事件的标题（D-16），即 `EventV2.title`，如「日常占卜」「巡逻」。
   *
   * 为什么带在结果里而不是让前端用 `eventId` 去 `triggeredEvents` 查：
   * `triggeredEvents` 只存在于**当次**轮次响应里，刷新后为空 ⇒ 双转盘卡片标题会回落成
   * 「随机事件」（QA P2-2）。把标题随结果一起持久化，刷新/旧档重放都不再依赖响应上下文。
   *
   * 可选是为了兼容**旧档**：历史 `lastWheel` / `lastWheels` 没有该字段，读侧按缺省处理，
   * 前端用 `wheel.title ?? "随机事件"` 兜底（由前端决定显示文案，内核不编造默认标题）。
   */
  title?: string;
  /** 命中的扇区 */
  label: string;
  /** 全扇区（含权重，供前端播放转盘动画） */
  segments: Array<{ label: string; weight: number }>;
}

export interface EventOptionView {
  id: string;
  text: string;
}

/**
 * 呈现槽的事件视图（ADR-0034 §5）：投影**只给"当前在演什么"**，
 * 不下发队列内容、也不下发队列长度（反作弊，§8-⑥：否则"队列里有一条关于某人的事件"
 * 会泄露该人未死/将出现）。
 */
export interface SlotEventView {
  eventId: string;
  /** 场景来源（与 `SlotScene.from` 同枚举）：诊断与前端解释"这一格为什么在演" */
  from: "successor" | "opening" | "death" | "hook" | "queueTake";
  /**
   * **前端必须按它决定"继续"按钮的语义**（ADR-0034 §8-⑩）：
   * - `normal` ⇒ 呈现选项，玩家选择后走 `events/choose`；
   * - `random` ⇒ **已掷出**转盘结果由 `wheel` 给出，"继续" = **确认**（走 `turns`，不带行动语义）；
   * - `combat` ⇒ 战斗进行中，命令走 `battle`；
   * - 空槽不产出本字段（`slotEvent === null`）。
   */
  kind: "normal" | "random" | "combat";
  title: string;
  /** F3：叙事正文可缺省，消费侧用 eventNarrativeOrTitle(view) 回退到 title（不是空串）。 */
  narrative?: string;
  /** `kind === "normal"` 时按 `visibleWhen` 过滤后的可选项 */
  options?: EventOptionView[];
  /** `kind === "random"` 时已掷出的那一格（幂等：同一槽重复呈现同一结果） */
  wheel?: WheelResultView;
}

export interface BattleEnemyView {
  instanceId: string;
  name: string;
  /** 本轮离场但保留展示的灰卡（收回 / 献祭）；不参与判定 */
  departed?: boolean;
  /** 阵营：已退场名册用它决定边框颜色（普通列表按数组分，不依赖它）。 */
  side?: BattleSide;
  hp: number;
  maxHp: number;
  alive: boolean;
  statuses: StatusView[];
  /** ADR-012 D9：专属资源池（只有声明过的角色才有条目）。 */
  resources: ResourceView[];
  /** ADR-012 D2：`minion` 小框 / `hero` 整行。缺省按 hero。 */
  tier?: "minion" | "hero";
  /** ADR-012 D1：召唤者实例 id；有值说明这是召唤物。 */
  summonedBy?: string;
  /** ADR-013 D1：召它的角色 id（收回后再召靠它认亲）。 */
  summonRef?: string;
  /** 退场原因（战败 / 献祭 / 召唤者倒下等），前端详情面板直接展示。 */
  deathReason?: string;
  /** 召唤者**名字**（不是实例 id）：战斗卡片只展示这个，详情入口在个人技能页。 */
  summonerName?: string;
}

// ---------- 战斗表现层（ADR-076） ----------

/** 一个目标身上的「发生了什么」（受击层 + 结算层的结论）。 */
export interface BattleFxHit {
  seq: number;
  targetId: string;
  /** 语义：决定颜色与符号（`summon` / `depart` / `buff` 没有数字） */
  kind: "damage" | "heal" | "miss" | "immune" | "summon" | "depart" | "buff" | "sacrifice";
  /** 轨迹怎么收尾：命中 / 断线 / 撞盾 */
  outcome: "hit" | "miss" | "immune";
  /** 结算值（正数；符号由 kind 决定，表现层不可翻转） */
  amount?: number;
  /** 已拼好的数字文本（含符号与后缀）：`-225!!` / `+80`。没有数字时缺省 */
  text?: string;
  critical?: boolean;
  critTier?: 1 | 2;
  /** 数字色（语义色，不吃技能色） */
  color: string;
  size: number;
  stroke: number;
  labels: Array<{ id: string; text: string; latin?: string }>;
  /**
   * 这一击自己的轨迹（覆盖 cast 级默认）。
   * 「治疗全体」要一人一支：自己上行、友军扇形，靠 cast 级那一条表达不了。
   */
  trace?: { preset: string; color?: string; width?: number; def?: FxEffect };
  /** 受击预设 id；`null` = 这一段没有受击（未命中） */
  impact: string | null;
  /** 受击的模板定义（`presentation.effects[id]`）；缺省 = 走内置几何 */
  def?: FxEffect;
  /**
   * 轨迹方向反过来（目标 → 施法者）。
   *
   * 收灵 / 吸取这类「把东西拉回来」的动作，箭头必须指回自己；不改方向就只能
   * 画成「我又打了他一下」。
   */
  reverse?: boolean;
}

/** 一次施放（= 同一 actor + 同一技能 + 连续 seq 的一串事件）。 */
export interface BattleFxCast {
  /** 本段最后一条事件的 seq（客户端游标用） */
  seq: number;
  eventId: string;
  actorId: string;
  skillId?: string;
  cast: { preset: string | null; color: string; durationMs: number; def?: FxEffect };
  trace: { preset: string | null; color: string; width: number; durationMs: number; def?: FxEffect };
  hits: BattleFxHit[];
}

/** `V2Snapshot.battle.fx`：只带最近几段，旧前端忽略即可。 */
export interface BattleFxView {
  /** 当前最大 seq：读档时把游标推到这里，避免重放历史特效 */
  seq: number;
  casts: BattleFxCast[];
}

export interface BattleView {
  eventId: string;
  round: number;
  over: BattleOutcome | null;
  player: {
    /** 玩家在战斗里的单位 id（= `state.player.id`）：前端「选自己」要传这个值。 */
    id: string;
    hp: number;
    maxHp: number;
    mp: number;
    maxMp: number;
    /** 战斗内资源条（含 hp/mp 与自定义资源，ADR-003 D10）。 */
    resources: ResourceView[];
    statuses: StatusView[];
    skills: Array<{
      id: string;
      name: string;
      description: string;
      /** 全量消耗清单（含自定义资源）；前端据此展示与置灰。 */
      costs: Array<{ resource: string; label: string; amount: number }>;
      cooldownLeft: number;
      /** 目标类型（ADR-012 D6 补）：前端据此决定哪边的卡片是可选目标。 */
      target: "enemy" | "self" | "ally" | "all_allies" | "all_enemies" | "none";
      /**
       * 合法目标 id（只对 `enemy` / `ally` 下发）：UI 只做 `includes`，不重算规则。
       * 缺省表示「不需要点选」（`self` / 全体 / 无目标）。
       */
      legalTargets?: string[];
      /** 选中非法目标时的解释（DSL 的 `disableReason`），作悬停提示用。 */
      legalTargetNote?: string;
      /**
       * 封印（ADR-015）：有值 ⇒ 这一回合放不出来，`text` 是给玩家看的原因。
       * 用不了的技能**不再从列表里删掉**，否则玩家分不清「没学过」与「学过但用不了」。
       */
      seal?: { code: string; text: string };
    }>;
    items: Array<{ itemId: string; name: string; count: number }>;
    /**
     * 本回合是否可逃跑（D-12）：settle 声明 `canFlee` **与**未被 `cannot_flee` 状态压制
     * 的合取，由投影层用与引擎同一判定算出。为 false 时引擎会以 `flee_not_allowed` /
     * `cannot_flee` 拒绝，前端据此禁用逃跑按钮，不要自己查 status id。
     */
    canFlee: boolean;
    /**
     * 本回合是否允许使用战斗道具（D-08）。由投影层用与引擎**同一**控制判定
     * （`controlOf(battle.player.statuses, "cannot_use_items")`）算出，
     * 前端据此禁用道具按钮，不要自己查 status id 或状态表。
     * 为 false 时引擎也会以 `bound_items` 拒绝，二者同源。
     */
    canUseItems: boolean;
    /**
     * 本回合能否正常行动（D-13）。为 false 表示玩家被 `cannot_act` 类状态（如眩晕）压制：
     * 引擎**不会报错**，而是跳过玩家动作、照常让友军/敌人行动并推进战斗回合
     * （眩晕的应有语义，不改），玩家点击只会白费一个回合 —— 故由投影如实告知。
     * 判定与引擎同一处 `controlOf(..., "cannot_act")`，输入取战斗镜像状态列表。
     *
     * 禁用原因**不单独下发**：`known` 可见性的状态本身已在 `statuses` 里（含名字），
     * 前端可直接展示；若某模板把控制类状态声明为 hidden，则会出现
     * 「canAct=false 但 statuses 里看不到原因」，这属于模板可见性声明问题。
     */
    canAct: boolean;
  };
  enemies: BattleEnemyView[];
  allies: BattleEnemyView[];
  /** ADR-012 D5：第三方单位，对所有人敌对、不计入胜负。 */
  neutrals: BattleEnemyView[];
  /** 已退场但仍需解释原因的单位（献祭 / 召唤者倒下连带消失）。 */
  fallen: BattleEnemyView[];
  log: string[];
  /** 本场暴击次数（ADR-073）；旧快照缺省 0。 */
  crits?: number;
  /** ADR-076：最近几段施放的四层解析结果（只读投影）；旧快照缺省。 */
  fx?: BattleFxView;
  /** 战斗结束后的战评（`over` 之前缺省）：结束时技能区换成它。 */
  evaluation?: BattleResult;
}

export interface StatusView {
  id: string;
  name: string;
  stacks: number;
  /** 说明（状态详情浮层用）。 */
  description?: string;
  quality?: string;
  /** 解析后的样式（ADR-002 D2）；缺省 = 默认样式。 */
  style?: ResolvedStyle;
  /** 效果摘要（属性 / 战斗面 / 控制语义），由定义派生。 */
  effects?: EffectSummary[];
  /** 展示标签（ADR-002 D2b）：品级 / 增益减益。 */
  tags?: ResolvedTag[];
  /** 正负（一等字段）：战斗面与技能描述的配色来源；不再由 tags 推断，也不下发 battleStyle。 */
  polarity: "positive" | "negative" | "neutral";
  /** 三类生命周期（ADR-018）：UI 按它分「天赋 / 状态」两栏。 */
  kind: "talent" | "battle" | "modifier";
  /** 持续时间的人话（「持续到被移除」/「剩余 3 回合」）。 */
  durationLabel?: string;
  /**
   * 成长型天赋的进度（ADR-075 §7），**按阶梯**给（ADR-079）：
   * `current` = 当前进度（已到顶时夹到最后一阶），`target` = 下一阶门槛（到顶时等于 current），
   * `done` = 已经在最高阶。展示成 `current/target`，到顶再加「已完成」。
   */
  progress?: { label: string; value: number; current: number; target: number; done: boolean };
}

/**
 * 一条属性视图（ADR-003）：引擎在投影期按 `defs` 解析好，前端只展示。
 *
 * `kind` 决定渲染：number 数值 / enum 带样式文本 / ladder 档位+进度 / composite 派生称号。
 * hidden 属性不会出现在这里（但仍存在于 `player.attributes` 原始记录）。
 */
export interface AttributeSourceView {
  id: string;
  label: string;
  /** 来源属性自己的展示文本（数值 / 选项 label / 档位 label）。 */
  display: string;
  style?: ResolvedStyle;
}

export interface AttributeView {
  id: string;
  label: string;
  kind: "number" | "enum" | "ladder" | "composite";
  /** number/ladder：数值；enum：选项 id；composite：无。 */
  value?: number | string;
  /** 已解析的展示文本（number 为数值字符串；enum 为选项 label；composite 为称号）。 */
  display: string;
  style?: ResolvedStyle;
  /** ladder：本档内进度（无下一档且无 cap 时不出现）。 */
  progress?: { value: number; max: number };
  /** ladder：当前档位。 */
  tier?: { id: string; label: string; style?: ResolvedStyle };
  /** composite：来源轴（详情展示「恶名 ＋＋ · 善名 ＋＋」）。 */
  sources?: AttributeSourceView[];
}

/** 资源显示形态（ADR-003 D10）：条形 / 刻度。模板在 `ui.yaml.resources` 声明。 */
export type ResourceDisplay = "bar" | "pips";

/**
 * 一条资源视图：顺序 = 模板 `statusBar` 的 resource 段；hp/mp 与自定义资源同形。
 * `dangerAt` 是告警阈值比例（0 = 永不告警），由 `ui.yaml.resources` 提供。
 */
export interface ResourceView {
  key: string;
  label: string;
  value: number;
  max: number;
  display: ResourceDisplay;
  dangerAt: number;
}

/**
 * 结局投影（R-EN-05 / R-NFR-04）。
 * 只承载玩家可见的结局信息：隐藏结局（模板声明 narrativeConfig.masked，ADR-0006）不得泄漏其
 * name/description，由投影层替换为掩码文案并派生 visibility 标志，供前端提示「已达成隐藏结局」。
 */
export interface EndingView {
  endingId: string;
  title: string;
  summary: string;
  endingType: string;
  /** 派生显示标志（ADR-0006）：模板 narrativeConfig.masked 存在 ⇒ "hidden"，非模板配置字段 */
  visibility: "public" | "hidden";
  /** 终止来源：condition / player / battleDefeat / event */
  source: string;
  reason: string;
  worldTime: number;
  turnIndex: number;
  narrativeSource: "template" | "llm" | "fallback";
  /** 本局已确认证据 id（P6：可在 history 中解析） */
  evidenceIds: string[];
}

/** 本局运行状态：running=可继续；terminated=已终止；archived=已封存（只读） */
export type WorldRunStatus = "running" | "terminated" | "archived";

/**
 * 一条关系行：**关系的投影单位**（NPC 卡与玩家关系图共用同一份）。
 *
 * 同一条边两个方向是同一件事实的两种说法（A 视 B 为父 / B 视 A 为子），
 * 所以行里带 `direction`，由消费方决定画不画：
 * NPC 卡只画「这个人怎么看别人」（出边），玩家关系图两个方向都画（箭头方向不同）。
 */
export interface RelationRow {
  /** 另一端节点 id（NPC 或 "player"） */
  withId: string;
  kind: string;
  /**
   * 知情人范围（ADR-007 D3）：`public` 大家都知道 / `limited` 部分人知道 /
   * `private` 仅当事人知道。
   *
   * 不是「玩家看到了什么」——投影期由 `relationVisibleTo(edge, viewerId)` 判定
   * 要不要出这一行，本字段只描述事实本身属于哪一档。这样换成 NPC 视角时
   * 同一行数据仍然成立（将来切玩家不需要重写这张表）。
   */
  scope: RelationScope;
  /** 边的方向：out = 本体→withId；in = withId→本体 */
  direction: "out" | "in";
  /**
   * 对方是否有可见的 NPC 卡。`false` = 这条边指向未登场 / 不展示的角色
   * （敌人、尚未露面的亲属）。关系是独立事实，不因对方不可见而消失。
   */
  counterpartVisible?: boolean;
  /**
   * `counterpartVisible === false` 时**为什么**没有卡（2026-11-19 用户裁决：
   * 「不实例化但知道的关系」不该被说成「无档案」——那不是没有资料，是还没出场）。
   *
   * · `unspawned`：还没登场（将来会出场、现在还不在世上的人）
   * · `hidden`：已在世上，但不进玩家的人物列表（当面不认得 / 只闻其名）
   * · `enemy`：不实例化的野怪（永远不会有卡）
   *
   * 缺省（无此字段但 `counterpartVisible === false`）⇒ 展示层按 `unspawned` 兜底。
   */
  counterpartState?: "unspawned" | "hidden" | "enemy";
  /** 对方名字（隐藏 / 未登场者也有名字：关系是独立事实，不因无卡而丢名字）。 */
  withName?: string;
  value?: number;
  /** 多跳中文称谓（仅亲属链可推导时存在）。**按本行自己的关系推导**，不是整对端点的最短路径。 */
  kinshipTerm?: string;
  /**
   * 同一段亲缘的其他读法（不含 `kinshipTerm` 本身）。
   * 由扩展 `extensions.family` 产出（模板 `extensions.family.showAllRoles` 打开时才有），
   * 如某人同时是「女儿」与「孙女」。
   */
  kinshipTerms?: string[];
  /**
   * true = 这一行不是声明出来的边，而是由多跳路径推出的关系。
   * 只是来源标记，**不代表可信度更低**：它的 `scope` 由路径上各边合成
   * （任一段 `private` ⇒ 整条 `private`），合成结果就写在上面那个 `scope` 里。
   */
  derived?: boolean;
}

export interface V2Snapshot {
  worldId: string;
  /**
   * 当前视角（ADR-010 D4）。缺省 = self。
   *
   * **只影响「看到哪些关系」**，不改变 `self` 段与控制权：观察者是在看别人，
   * 不是变成别人。真要换人控制，走 `transplantActor` + `state.selfId`。
   */
  viewerId?: string;
  /**
   * 观察者的显示名（2026-11-20；仅 `viewerId !== selfId` 时下发）。
   *
   * 顶栏要写「以谁的目光」。只给 id 的话前端得去 `npcs` 里找，而观察者可能是
   * 不在人物列表里的人（隐藏 / 已离场），名字就丢了。
   */
  viewerName?: string;
  templateId: string;
  worldName: string;
  turnIndex: number;
  worldTime: number;
  /** 时间适配器生成的历法显示文本 */
  formattedTime: string;
  lifeStage: string;
  lifeStageLabel: string;
  startYear: number;
  /**
   * 章节进度（D-07）：主线章节机的**数字**进度，取自 `flags.chapter`（模板在
   * `opening.yaml#worldSetup.flags.chapter` 起 1，事件用 `setFlag` 推进）。
   * 仅当该 flag 是 number 时下发；未使用章节机的世界缺省该字段（不输出 null / 0），
   * 前端据此判断「是否显示章节指示」。
   *
   * 命名用 `storyChapter` 而非 `chapter`：`chapter` 是模板自有的 flag 键，
   * 快照字段名不应与模板键名混同；`story` 前缀表明这是**剧情进度展示位**。
   * 引擎不编造章节中文名（模板无章节名表），只给数字。
   */
  storyChapter?: number;
  /**
   * 模板驱动的展示名（statusBar 与 attributes.labels 的解析结果）。
   * 前端渲染资源条/属性名一律读这里，不得再硬编码世界观用词。
   */
  labels: {
    /** 资源键（hp/mp）→ 显示名 */
    resources: Record<string, string>;
    /** 属性 id → 显示名（顺序即 attributes.order） */
    attributes: Record<string, string>;
    /** 心情显示名 */
    mood: string;
  };
  player: {
    id: string;
    name: string;
    age: number;
    gender: string;
    genderLabel: string;
    hp: number;
    maxHp: number;
    mp: number;
    maxMp: number;
    mood: number;
    moodBandLabel: string;
    /** 原始属性记录（含 hidden；数值/文本混合）。展示请用 `attributeViews`。 */
    attributes: Record<string, AttributeValue>;
    /** 属性面板视图（已按 order 排序、已剔除 hidden、已解析样式/档位/进度）。 */
    attributeViews: AttributeView[];
    /** 资源条视图（含 hp/mp 与自定义资源；顺序 = statusBar 的 resource 段）。 */
    resources: ResourceView[];
    statuses: StatusView[];
    /**
     * 状态合计（ADR-018 D8）：面板上「资源 +3 / 伤害 +15%」直接读这里，
     * 明细（每一笔来自谁）也在同一个对象里，前端不自己求和。
     */
    statusTotals: StatusTotalVM[];
    /**
     * 玩家自己的关系（2026-11-20 补齐）：与 NPC 卡同一份 `buildRelationRows`，
     * **两个方向都在**（`direction` 区分）。
     *
     * 以前关系只挂得出 NPC 卡：玩家自己的父/母/妻/子只能靠在别人的卡上「反向」看见，
     * 或者干脆看不见 —— 这是本体能力的缺口，不是展示层没写。
     */
    relations: RelationRow[];
    /**
     * 这些关系是**谁的**（2026-11-20）：`observeActor` 把镜头交给别人时才有。
     * 缺省 = 你自己。展示层写「以 XX 的目光」，不让玩家误以为自己的关系变了。
     */
    relationsOwner?: { id: string; name: string };
    skills: Array<{
      id: string;
      name: string;
      description: string;
      kind: string;
      quality?: string;
      style?: ResolvedStyle;
      effects?: EffectSummary[];
      tags?: ResolvedTag[];
      /**
       * 召唤类技能：**参数与召唤物面板一起下发**（`projection.ts` 的 `summonInfoOf` 是唯一产地）。
       * 合成一个对象是为了消灭「只有一半」的中间态：有召唤就只有这一种形状。
       */
      summon?: {
        /** 技能参数：一次召几只、这批多强。 */
        count: number;
        levelScale?: number;
        /** 召唤物面板。 */
        unit: {
          ref: string;
          name: string;
          tier: "minion" | "hero";
          description?: string;
          /** 召唤物自带技能：名字之外还带效果摘要（浮窗里一行一个技能地展示）。 */
          skills: Array<{
            id: string;
            name: string;
            description?: string;
            style?: ResolvedStyle;
            effects?: EffectSummary[];
          }>;
          /** 召唤物身上常驻的状态（`characters[].statuses`，如魔虚罗的法轮）。 */
          statuses: StatusView[];
        };
      };
      /**
       * 封印（ADR-015）：技能页里照常列出，但这一招现在用不了，`text` 说明原因
       * （目前只有英雄召唤永久失去这一条持久判据）。
       */
      seal?: { code: string; text: string };
    }>;
    inventory: Array<{
      itemId: string;
      name: string;
      description: string;
      count: number;
      usableOutsideBattle: boolean;
      usableInBattle: boolean;
      /** 展示字段（T5-02 / R-EQ-09）：来自物品定义，不含状态结果 */
      type: "consumable" | "material" | "key" | "equipment";
      slot?: string;
      slotLabel?: string;
      category?: string;
      categoryLabel?: string;
      quality?: string;
      style?: ResolvedStyle;
      effects?: EffectSummary[];
      tags?: ResolvedTag[];
    }>;
    /**
     * 已装备实例投影：只含展示字段（实例 id / 物品 id / 槽位 / 层数 / 耐久 / 显示名 / 说明）。
     * 不含任何状态结果——状态由内核每次结算现算（R-EQ-04 / P8）。
     * 背包（inventory）与装备栏**互斥**：穿戴中的实例不出现在 inventory（ADR-0008）。
     */
    equipment?: Array<{
      instanceId: string;
      itemId: string;
      slot: string;
      stacks?: number;
      durability?: number;
      name?: string;
      slotLabel?: string;
      description?: string;
      category?: string;
      categoryLabel?: string;
      quality?: string;
      style?: ResolvedStyle;
      effects?: EffectSummary[];
      tags?: ResolvedTag[];
    }>;
  };
  /**
   * 装备栏槽位定义（模板 equipment.yaml 的 slots 投影）；未配置装备分域的世界为空数组。
   * 前端据 maxCount 渲染格子数量、据 allowedCategories 过滤可装备物品、
   * 据 panelSide 摆位（left/right 两列 + bottom 方块区），
   * **不得由前端猜槽位名、格子数或摆位**（ADR-0008 / ADR-0009 / R-EQ-11/15）。
   */
  equipmentSlots?: Array<{
    id: string;
    label: string;
    maxCount: number;
    allowedCategories: string[];
    /** 追加（2026-11-21）：`allowedCategories` 的显示名，同序一一对应。 */
    allowedCategoryLabels?: string[];
    panelSide: "left" | "right" | "bottom";
  }>;
  npcs: Array<{
    id: string;
    name: string;
    age: number;
    genderLabel: string;
    personality: string;
    relationship: number;
    knownGoals: string[];
    /**
     * 属性面板（ADR-0021 决策 3）：**只含模板 `attributes.order` 内的键**，值为模板声明的
     * base 原值（`levelScale` 与状态一概不叠）；order 内但 NPC 未声明的键给 0
     * （与玩家面板同口径）。**必填**——空模板给 `{}`，前端可直接遍历，不必判 undefined。
     * 不下发 `attributeModifiers` / effective 派生值：状态只走 `statuses`（hidden 侧信道红线）。
     */
    attributes: Record<string, AttributeValue>;
    /** 属性面板视图（ADR-003；与玩家同一份解析，hidden 已剔除）。 */
    attributeViews: AttributeView[];
    /**
     * R2.6 / ADR-0014：与本体相关、且**本体能看见**的关系边（ADR-007 D3 由
     * `relationVisibleTo(edge, viewerId)` 判定：他在这条事实的知情人范围内才出）。
     *
     * 旧口径（R-OP-05）是「known / inferred 才投影」，那把玩家写进了事实本身；
     * 现在边的属性是 `scope`（谁知道），投影只负责按观察者过滤。
     */
    relations: RelationRow[];
    /**
     * 当前状态（ADR-0019）。**只投影 visibility=known 的定义**，与玩家状态同一过滤口径；
     * unknown / hidden 状态不外泄，避免「状态列表」变成侧信道。
     */
    statuses: StatusView[];
    /** 人生阶段 id（按模板阶段表由 NPC 年龄推导，与玩家口径一致）。 */
    lifeStage: string;
    /** 人生阶段显示标签（模板未给 label 时回退 stage id）。 */
    lifeStageLabel: string;
    /**
     * 生命周期（ADR-0020）：与上屏解耦——`inactive` 的 NPC 照常上屏并标注状态，
     * 只是不再自主行动、关系写入冻结。「已故」由 `state + reasonCode` 表达。
     */
    lifecycle: {
      state: NpcLifecycleState;
      reasonCode?: string;
      sinceTurn: number;
      sinceWorldTime: number;
    };
  }>;
  /**
   * 呈现槽（ADR-0034 §5）：`null` = 空槽（可自由行动）。**唯一**的呈现真源。
   * 只描述"当前在演什么"，不含队列内容与长度。
   */
  /**
   * 待完成的加点（ADR-019，2026-11-20）：有它 ⇒ 个人页面板挂出加点组件。
   * 只下发请求；属性在玩家提交（轮外端点）后才变。
   *
   * `label` / `style` 已由投影解析好（与开局 `describeNode` 同一口径）。
   */
  pendingAllocation?: {
    id: string;
    budget: number;
    reason?: string;
    targets: Array<{
      attribute: string;
      label: string;
      min?: number;
      max?: number;
      style?: ResolvedStyle;
    }>;
    sinceTurn: number;
    sinceWorldTime: number;
  };
  slotEvent: SlotEventView | null;
  battle: BattleView | null;
  /** 最近一次转盘结果（向后兼容的单槽视图，等价于 `lastWheels` 的末项） */
  lastWheel: WheelResultView | null;
  /**
   * 本轮全部转盘结果（D-03）：按触发顺序，供前端逐条呈现同轮多个转盘。
   * 空数组表示本轮没有转盘（前端据此不渲染转盘区）。
   */
  lastWheels: WheelResultView[];
  availableActions: Array<{ id: string; label: string; description: string; duration?: TimeAmount }>;
  evaluation: {
    summary: string;
    canonDeviation: number;
    /**
     * 追加（2026-11-21）：这段总结的来源。`llm` 是响应层装饰后的结果（非权威），
     * `template` 是引擎拼的总结；缺省 = 旧快照 / 尚未生成。
     */
    summarySource?: "template" | "llm" | "fallback";
    /**
     * R2.6 / ADR-0016：五维分项评价（成长/羁绊/功绩/真相/自由等，取自模板
     * `evaluation.yaml`）。只读过程信号，不含结局类型 ⇒ 不泄露结局。
     * 可选以兼容尚未生成评价的局面（`summary` 为占位文案时为空）。
     */
    dimensions?: Array<{
      id: string;
      /** 维度中文名（模板 label）；缺省时前端回退显示 id */
      label?: string;
      score: number;
      level: string;
      explanation: string;
    }>;
    /** 加权总分（模板维度 weight 加权），与分项同时给出，不取代分项 */
    overall?: number;
  };
  /** 运行状态；缺省视为 running（兼容未升级的调用方） */
  status?: WorldRunStatus;
  /** 已终止时的结局投影；未终止为 null */
  ending?: EndingView | null;
  /**
   * 媒体资源投影（F3 + 2026-11-24 角色媒体）。
   *
   * 两份来源合并：`state.media`（内容块点名的槽）+ **派生**（在场人物按皮肤解析出的
   * `avatar.<id>` / `portrait.<id>`）。引擎只给 `assetId`，`url` 由下发层按路由拼 ——
   * 内核不认识 origin / 版本号，也不该认识。
   */
  media?: Array<{ slot: string; assetId: string; url: string; alt: string }>;
  /** 是否存在待回程的 LLM 调用（F3 稀疏参与标志）。 */
  llmPending?: boolean;
  /**
   * 扩展段：**不透明命名空间**，键 = 扩展 id（`docs/EXTENSIONS.md` §7）。与
   * `WorldStateV2.extensions` 完全同构。
   *
   * 宿主只做搬运：不解析、不映射、不校验，也不认识任何具体玩法（没有 `family` 这种字段）。
   * **可选且只在扩展产出段时出现** —— 不声明任何扩展的世界逐字段不变（零回归门槛）。
   * 段的内容由扩展的 `snapshotDerivation` 产出，解释权在扩展自带的 UI。
   */
  extensions?: Record<string, unknown>;
}

export interface V2TurnResult {
  state: WorldStateV2;
  snapshot: V2Snapshot;
  elapsed: TimeAmount;
  triggeredEvents: Array<{ id: string; title: string; narrative: string }>;
  wheelResult: WheelResultView | null;
  playerVisibleHistory: HistoryEntryV2[];
}

// ---------- 命令 ----------

export interface ChooseOptionCommand {
  optionId: string;
}

/**
 * 战斗命令的**类型与 schema 都在 `v2-command.ts`**（D-15 单一真源）：
 * 此处只做转发，保持既有 `import { BattleCommand } from "@life-sim/shared"` 的引用面不变。
 * 不要在 `v2.ts` 里恢复手写联合类型——那会立刻退回「同一契约两份真源」。
 */
export type { BattleCommand } from "./v2-command.js";
export { BattleCommandSchema } from "./v2-command.js";

export interface UseItemCommand {
  itemId: string;
}

// ---------- 模板辅助查找 ----------

export interface TemplateLookup {
  template: WorldTemplateV2;
  event(id: string): EventV2 | undefined;
  skill(id: string): Skill | undefined;
  item(id: string): Item | undefined;
  status(id: string): StatusEffect | undefined;
  character(id: string): Character | undefined;
  chain(id: string): Chain | undefined;
  action(id: string): { id: string; label: string; description?: string; duration?: TimeAmount; advanceTo?: TimeAmount; effects?: TemplateEffect[] } | undefined;
}

export type { Condition, Effect, EventV2, Skill, Item, StatusEffect, WorldTemplateV2, TimeAmount, Chain };
