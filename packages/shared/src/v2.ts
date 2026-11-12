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
  ScheduledEventInstance,
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
  /** NPC 背包（createWorldV2 初始化为空对象；本轮不做 NPC 物品逻辑） */
  inventory: Record<string, number>;
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

/**
 * 待玩家决策的即时普通事件（R2.5 起**只**承载槽位呈现队列，不再兼作调度队列）。
 * 延时事件一律进 `scheduledEvents`，到期出队后才可能产生这里的条目。
 */
export interface PendingEvent {
  eventId: string;
  /** 归属链（chain 事件） */
  chainId?: string;
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
  /** 世界时间 = **整数分钟**（R-LM-05；本轮按 #45 裁决不加数值上界校验） */
  worldTime: number;
  playerAgeAtStart: number;
  player: V2Player;
  npcs: V2Npc[];
  /**
   * R2.6 / ADR-0014：关系图边（实例层）。kind 语义 = from→to（`{from:A,to:B,kind:"father"}` =
   * B 是 A 的父亲）；默认 visibility=unknown（R-OP-05），known/inferred 才进玩家投影。
   */
  relations: RelationEdge[];
  /** 模板可读写的语义黑板；引擎内部记录不得写入（R-LM-02） */
  flags: Record<string, boolean | number | string>;
  /**
   * 【R2.5 过渡兼容】eventId -> 最近触发轮次，保留为 O(1) 「last fired turn」索引。
   * 与 `lastFiredIndex` / `eventFires` 三者**只由 scheduler.recordFire 一处写入**，不得散写。
   * 保留原因：ending.ts / turn.ts / 27 处既有消费与测试依赖该数值形态，本轮不冒险批量改写。
   * R2.6 可统一收敛到 `lastFiredIndex`（含 worldTime）后退役本字段。
   */
  firedEvents: Record<string, number>;
  /** 实例层：延时队列（有 id / status / 固化窗口，可审计，不复制配置域字段） */
  scheduledEvents: ScheduledEventInstance[];
  /** 全局单调入队序号，纯状态递增（不用 Date / 随机） */
  enqueueSeqCounter: number;
  /** 事实层：错失记录（append-only） */
  missedEvents: MissedEventRecord[];
  /** 事实层：触发日志（append-only） */
  eventFires: EventFireRecord[];
  /** 派生索引：可从 eventFires 重建；冷却读 worldTime */
  lastFiredIndex: Record<string, LastFiredIndexEntry>;
  chains: ChainStateV2[];
  /** 待玩家决策的普通事件队列（FIFO，只承载槽位呈现） */
  pendingEvents: PendingEvent[];
  /** 进行中的战斗（同一时刻至多一场；over 后保留至下一次轮次推进时清除） */
  battle: BattleState | null;
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
    /**
     * 本回合是否可逃跑（D-12）：settle 声明 `canFlee` **与**未被 `cannot_flee` 补正压制
     * 的合取，由投影层用与引擎同一判定算出。为 false 时引擎会以 `flee_not_allowed` /
     * `cannot_flee` 拒绝，前端据此禁用逃跑按钮，不要自己查 status id。
     */
    canFlee: boolean;
    /**
     * 本回合是否允许使用战斗道具（D-08）。由投影层用与引擎**同一**控制判定
     * （`controlOf(battle.player.statuses, "cannot_use_items")`）算出，
     * 前端据此禁用道具按钮，不要自己查 status id 或补正表。
     * 为 false 时引擎也会以 `bound_items` 拒绝，二者同源。
     */
    canUseItems: boolean;
    /**
     * 本回合能否正常行动（D-13）。为 false 表示玩家被 `cannot_act` 类补正（如眩晕）压制：
     * 引擎**不会报错**，而是跳过玩家动作、照常让友军/敌人行动并推进战斗回合
     * （眩晕的应有语义，不改），玩家点击只会白费一个回合 —— 故由投影如实告知。
     * 判定与引擎同一处 `controlOf(..., "cannot_act")`，输入取战斗镜像补正列表。
     *
     * 禁用原因**不单独下发**：`known` 可见性的补正本身已在 `statuses` 里（含名字），
     * 前端可直接展示；若某模板把控制类补正声明为 hidden，则会出现
     * 「canAct=false 但 statuses 里看不到原因」，这属于模板可见性声明问题。
     */
    canAct: boolean;
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
    attributes: Record<string, number>;
    statuses: StatusView[];
    skills: Array<{ id: string; name: string; description: string; kind: string }>;
    inventory: Array<{
      itemId: string;
      name: string;
      description: string;
      count: number;
      usableOutsideBattle: boolean;
      usableInBattle: boolean;
      /** 展示字段（T5-02 / R-EQ-09）：来自物品定义，不含补正结果 */
      type: "consumable" | "material" | "key" | "equipment";
      slot?: string;
      slotLabel?: string;
      category?: string;
      quality?: string;
    }>;
    /**
     * 已装备实例投影：只含展示字段（实例 id / 物品 id / 槽位 / 层数 / 耐久 / 显示名 / 说明）。
     * 不含任何补正结果——补正由内核每次结算现算（R-EQ-04 / P8）。
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
      quality?: string;
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
     * R2.6 / ADR-0014：与本体相关且玩家**已知**的关系边（仅 known / inferred）。
     * unknown / hidden 一律不投影（R-OP-05：默认不认识，hidden 来源不泄露）。
     */
    relations: Array<{
      /** 另一端节点 id（NPC 或 "player"） */
      withId: string;
      kind: string;
      visibility: string;
      /** 边的方向：out = 本体→withId；in = withId→本体 */
      direction: "out" | "in";
      value?: number;
      /** 多跳中文称谓（仅亲属链可推导时存在） */
      kinshipTerm?: string;
    }>;
  }>;
  pendingEvent: PendingEventView | null;
  battle: BattleView | null;
  /** 最近一次转盘结果（向后兼容的单槽视图，等价于 `lastWheels` 的末项） */
  lastWheel: WheelResultView | null;
  /**
   * 本轮全部转盘结果（D-03）：按触发顺序，供前端逐条呈现同轮多个转盘。
   * 空数组表示本轮没有转盘（前端据此不渲染转盘区）。
   */
  lastWheels: WheelResultView[];
  activeChains: Array<{ id: string; status: string }>;
  availableActions: Array<{ id: string; label: string; description: string; duration?: TimeAmount }>;
  evaluation: {
    summary: string;
    canonDeviation: number;
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
  action(id: string): { id: string; label: string; description?: string; duration?: TimeAmount; advanceTo?: TimeAmount; effects?: Effect[] } | undefined;
}

export type { Condition, Effect, EventV2, Skill, Item, StatusEffect, WorldTemplateV2, TimeAmount, Chain };
