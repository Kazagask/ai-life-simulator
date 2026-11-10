import type {
  Chain,
  Character,
  CombatSettle,
  Condition,
  Effect,
  EventOption,
  EventV2,
  Item,
  Skill,
  StatusEffect,
  TimeAmount,
  WorldTemplateV2,
  TerminationRecord,
} from "./schema/index.js";

/**
 * 协议 V2 运行时类型：世界状态、战斗会话、玩家可见投影与交互命令。
 * 与 Schema（协议定义）分离：Schema 校验模板，本文件描述引擎运行时。
 */

// ---------- 运行时补正实例 ----------

export interface StatusInstance {
  statusId: string;
  stacks: number;
  /** 模拟域：施加时的世界轮次 */
  appliedTurn: number;
  /** 战斗域：已存在的战斗回合数（用于 battleRounds 到期判定） */
  battleRoundsElapsed?: number;
  /** 模拟域：休息治疗进度（cureConditions.restTurns 用） */
  restProgress?: number;
  /** 模拟域：剩余持续轮次（duration.turns 的实例副本，模板不可变） */
  turnsLeft?: number;
}

// ---------- 运行时角色 ----------

export interface V2CombatantBase {
  id: string;
  name: string;
  gender: string;
  age: number;
  attributes: Record<string, number>;
  hp: number;
  mp: number;
  mood: number;
  statuses: StatusInstance[];
  /** 当前生效的技能冷却（skillId -> 剩余战斗回合） */
  skillCooldowns: Record<string, number>;
}

export interface V2Player extends V2CombatantBase {
  inventory: Record<string, number>;
  skills: string[];
  /** 成长等级（adjustGrowth 推进；HP/MP 上限公式 perLevel 引用） */
  growthLevel: number;
}

export interface V2Npc extends V2CombatantBase {
  /** 与玩家的关系值 */
  relationship: number;
  personality: string;
  knownGoals: string[];
  skills: string[];
  isEnemy: boolean;
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
}

// ---------- 战斗 ----------

export interface BattleEnemy {
  /** 战斗实例 id（同角色多实例区分） */
  instanceId: string;
  characterId: string;
  name: string;
  hp: number;
  maxHp: number;
  mp: number;
  attributes: Record<string, number>;
  statuses: StatusInstance[];
  skillCooldowns: Record<string, number>;
  skills: string[];
  skillWeights: Record<string, number>;
  alive: boolean;
}

export type BattleOutcome = "victory" | "defeat" | "flee";

export interface BattleState {
  /** 触发战斗的事件 id */
  eventId: string;
  /** 结算配置副本 */
  settle: CombatSettle;
  round: number;
  /** 玩家在战斗内的运行时镜像（伤害/治疗结算到镜像，结束后回写主状态） */
  player: {
    hp: number;
    mp: number;
    statuses: StatusInstance[];
    skillCooldowns: Record<string, number>;
  };
  enemies: BattleEnemy[];
  /** 友军单位（与主角同阵营，AI 自动行动；形状同敌人，战斗内临时，不持久化到世界） */
  allies: BattleEnemy[];
  /** 战斗日志（玩家可见） */
  log: string[];
  over: BattleOutcome | null;
}

// ---------- 待决事件 ----------

export interface PendingEvent {
  eventId: string;
  /** 归属链（chain 事件） */
  chainId?: string;
}

// ---------- 世界状态 ----------

export interface ChainStateV2 {
  id: string;
  /** 当前进行到的步骤下标（-1 表示尚未开始） */
  stepIndex: number;
  status: "active" | "completed";
  startedTurn: number;
}

export interface HistoryEntryV2 {
  id: string;
  turnIndex: number;
  worldTime: number;
  /** 由时间适配器生成的历法显示文本（替代前端公历硬编码） */
  formattedTime: string;
  type: "player_action" | "npc_action" | "event" | "battle" | "milestone";
  summary: string;
  detail?: string;
}

export interface WorldStateV2 {
  id: string;
  templateId: string;
  seed: number;
  turnIndex: number;
  worldTime: number;
  playerAgeAtStart: number;
  player: V2Player;
  npcs: V2Npc[];
  flags: Record<string, boolean | number | string>;
  /** eventId -> 最近触发轮次（once/冷却判定） */
  firedEvents: Record<string, number>;
  chains: ChainStateV2[];
  /** 待玩家决策的普通事件队列（FIFO） */
  pendingEvents: PendingEvent[];
  /** 进行中的战斗（同一时刻至多一场；over 后保留至下一次轮次推进时清除） */
  battle: BattleState | null;
  /** 最近一次转盘结果（持久化到状态，供刷新后回放） */
  lastWheel: WheelResultView | null;
  history: HistoryEntryV2[];
  /** 开局交接完成标记；false 时拒绝普通轮次推进 */
  openingCompleted: boolean;
  /** 唯一终止事实来源：null=运行，非 null=已终止（固化后只读） */
  termination: TerminationRecord | null;
  /** 归档只读标记；为真时拒绝任何状态写入 */
  archived: boolean;
}

// ---------- 投影与命令 ----------

export interface WheelResultView {
  eventId: string;
  /** 命中的扇区 */
  label: string;
  /** 全扇区（含权重，供前端播放转盘动画） */
  segments: Array<{ label: string; weight: number }>;
}

export interface EventOptionView {
  id: string;
  text: string;
}

export interface PendingEventView {
  eventId: string;
  title: string;
  narrative: string;
  options: EventOptionView[];
}

export interface BattleEnemyView {
  instanceId: string;
  name: string;
  hp: number;
  maxHp: number;
  alive: boolean;
  statuses: Array<{ id: string; name: string; stacks: number }>;
}

export interface BattleView {
  eventId: string;
  round: number;
  over: BattleOutcome | null;
  player: {
    hp: number;
    maxHp: number;
    mp: number;
    maxMp: number;
    statuses: Array<{ id: string; name: string; stacks: number }>;
    skills: Array<{ id: string; name: string; description: string; costMp: number; cooldownLeft: number }>;
    items: Array<{ itemId: string; name: string; count: number }>;
    canFlee: boolean;
  };
  enemies: BattleEnemyView[];
  allies: BattleEnemyView[];
  log: string[];
}

export interface StatusView {
  id: string;
  name: string;
  stacks: number;
}

export interface V2Snapshot {
  worldId: string;
  templateId: string;
  worldName: string;
  turnIndex: number;
  worldTime: number;
  /** 时间适配器生成的历法显示文本 */
  formattedTime: string;
  lifeStage: string;
  lifeStageLabel: string;
  startYear: number;
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
    attributes: Record<string, number>;
    statuses: StatusView[];
    skills: Array<{ id: string; name: string; description: string; kind: string }>;
    inventory: Array<{ itemId: string; name: string; description: string; count: number; usableOutsideBattle: boolean; usableInBattle: boolean }>;
  };
  npcs: Array<{
    id: string;
    name: string;
    age: number;
    genderLabel: string;
    personality: string;
    relationship: number;
    knownGoals: string[];
  }>;
  pendingEvent: PendingEventView | null;
  battle: BattleView | null;
  lastWheel: WheelResultView | null;
  activeChains: Array<{ id: string; status: string }>;
  availableActions: Array<{ id: string; label: string; description: string; duration?: TimeAmount }>;
  evaluation: { summary: string; canonDeviation: number };
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

export type BattleCommand =
  | { type: "skill"; skillId: string; targetInstanceId?: string }
  | { type: "item"; itemId: string }
  | { type: "flee" };

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
  action(id: string): { id: string; label: string; description?: string; duration?: TimeAmount; advanceTo?: TimeAmount; effects?: Effect[] } | undefined;
}

export type { Condition, Effect, EventV2, Skill, Item, StatusEffect, WorldTemplateV2, TimeAmount, Chain };
