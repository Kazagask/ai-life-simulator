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
  /**
   * 本局装备实例（R-EQ-02，协议 §19；可缺省，旧存档按 [] 处理）。
   * 只存实例状态，不存补正结果——补正值每次经 evaluateDynamicModifier 现算（P8）。
   */
  equipment?: EquipmentInstance[];
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
  /** MP 上限（战斗 AI 公有比例用；可选以兼容旧存档，缺省回退当前 mp） */
  maxMp?: number;
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

/** 历史条目可见性：只有 public 进玩家端；hidden/unknown 一律不进（R-VS-01）。 */
export type HistoryVisibility = "public" | "hidden" | "unknown";

export interface HistoryEntryV2 {
  id: string;
  turnIndex: number;
  worldTime: number;
  /** 由时间适配器生成的历法显示文本（替代前端公历硬编码） */
  formattedTime: string;
  type: "player_action" | "npc_action" | "event" | "battle" | "milestone";
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
    attributes: Record<string, number>;
    statuses: StatusView[];
    skills: Array<{ id: string; name: string; description: string; kind: string }>;
    inventory: Array<{ itemId: string; name: string; description: string; count: number; usableOutsideBattle: boolean; usableInBattle: boolean }>;
    /**
     * 已装备实例投影：只含展示字段（实例 id / 物品 id / 槽位 / 层数 / 耐久 / 显示名）。
     * 不含任何补正结果——补正由内核每次结算现算（R-EQ-04 / P8）。
     */
    equipment?: Array<{
      instanceId: string;
      itemId: string;
      slot: string;
      stacks?: number;
      durability?: number;
      name?: string;
      slotLabel?: string;
    }>;
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
  /** 运行状态；缺省视为 running（兼容未升级的调用方） */
  status?: WorldRunStatus;
  /** 已终止时的结局投影；未终止为 null */
  ending?: EndingView | null;
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
