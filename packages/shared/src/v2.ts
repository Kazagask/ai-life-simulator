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
  TemplateEffect,
  TimeAmount,
  WorldTemplateV2,
  TerminationRecord,
} from "./schema/index.js";
import type { ObservationLedger } from "./contract/perspective.js";
import type { LlmInvocation } from "./contract/llm-invocation.js";

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
  /**
   * 父/母指针（`docs/FAMILY-GRAPH.md` §3.1）：模板 `playerTemplate.fatherId/motherId` 的副本。
   * 玩家不是特例；可选 + 无默认值 ⇒ 旧档缺字段不拒载。
   */
  fatherId?: string;
  motherId?: string;
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
  /**
   * **大众认知的生父**（`docs/FAMILY-GRAPH.md` §3.1）：模板 `characters[].fatherId` 的副本，
   * 缺省 = 不详。可选 + 无默认值，旧档缺字段不拒载（沿用 `birthTime` 的先例）。
   *
   * ⚠ **本轮只是铺路**：亲缘推导仍走关系边，没有任何代码读这两个指针。
   */
  fatherId?: string;
  /** **大众认知的生母**。语义同 `fatherId`。 */
  motherId?: string;
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
  /**
   * 玩家在**演员表 / 关系图**里的节点 id（A 期 seam，2026-11-16）。
   *
   * 目标形态是「玩家也是一个 npc 实例，用一个 self 指针指向它」；本期只提前施工这一半：
   * 玩家仍存在 `state.player`（不切存储），但所有把玩家当图节点的代码
   * 一律走 `selfIdOf(state)` / `actorOf(state, id)`，不再写死字面量 `"player"`。
   * 可选 + 缺省 `"player"` ⇒ 旧档直载；切换存储那期只需让 `actorOf` 从 `npcs` 命中它。
   */
  selfId?: string;
  npcs: V2Npc[];
  /**
   * R2.6 / ADR-0014：关系图边（实例层）。kind 语义 = from→to（`{from:A,to:B,kind:"father"}` =
   * B 是 A 的父亲）；默认 visibility=unknown（R-OP-05），known/inferred 才进玩家投影。
   */
  relations: RelationEdge[];
  /** NPC 刷新规则实例队列（ADR-0022；配置域规则的实例化副本，可序列化、进存档） */
  spawnRules: SpawnRuleInstance[];
  /** 事实层：出生/登场记录（append-only，与 eventFires / missedEvents 同级） */
  spawnLog: SpawnFact[];
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
   * 扩展层的状态切片（`docs/EXTENSIONS.md` §2 / `docs/CLAN-DESIGN.md` §2.1）。
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
     * 属性面板（ADR-0021 决策 3）：**只含模板 `attributes.order` 内的键**，值为模板声明的
     * base 原值（`levelScale` 与状态补正一概不叠）；order 内但 NPC 未声明的键给 0
     * （与玩家面板同口径）。**必填**——空模板给 `{}`，前端可直接遍历，不必判 undefined。
     * 不下发 `attributeModifiers` / effective 派生值：补正只走 `statuses`（hidden 侧信道红线）。
     */
    attributes: Record<string, number>;
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
      /**
       * 对方是否有可见的 NPC 卡。`false` = 这条边指向未登场 / 不展示的角色
       * （敌人、尚未露面的亲属）。关系是独立事实，不因对方不可见而消失。
       */
      counterpartVisible?: boolean;
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
       * 只是来源标记，**不代表可信度更低**：它的 `visibility` 由路径上各边合成，
       * 全部 known 时它就是 known。
       */
      derived?: boolean;
    }>;
    /**
     * 当前补正（ADR-0019）。**只投影 visibility=known 的定义**，与玩家补正同一过滤口径；
     * unknown / hidden 补正不外泄，避免「状态列表」变成侧信道。
     */
    statuses: Array<{ id: string; name: string; stacks: number }>;
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
  /** F3：媒体资源投影（展示就绪，含 url / alt）；存档只留引用。 */
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
