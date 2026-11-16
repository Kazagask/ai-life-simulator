import { z } from "zod";
import { CombatSettleSchema, EventV2Schema } from "./schema/event.js";
import { CharacterSchema } from "./schema/character.js";
import { EndingConfigSchema } from "./schema/ending.js";
import { EquipmentInstanceSchema } from "./schema/equipment.js";
import { ScheduledEventInstanceSchema } from "./schema/event-instance.js";
import { TerminationRecordSchema } from "./schema/ending.js";
import { RelationEdgeSchema } from "./schema/relation.js";
import { ObservationLedgerSchema } from "./contract/perspective.js";
import { TaskDagSchema } from "./contract/task-dag.js";
import { LlmInvocationSchema } from "./contract/llm-invocation.js";
import type { BattleState, HistoryEntryV2, WorldStateV2 } from "./v2.js";

/**
 * WorldStateV2 的 Zod 校验（R-PS-02 / ADR-0007）。
 * 加载磁盘存档本质是处理不可信输入：schemaVersion 校验之后必须过这里。
 * 双维护风险用文件末尾的双向类型断言收口——schema 与 TS 接口漂移即编译错误。
 *
 * 兼容策略：HistoryEntryV2.visibility / player.equipment / lastWheels 可缺省
 * （R2.x 旧档视为 public / [] / []），其余字段为存档必需——缺任一字段即拒绝该档（协议 §21.2）。
 */

const StatusInstanceSchema = z
  .object({
    statusId: z.string().min(1),
    stacks: z.number().int(),
    appliedTurn: z.number().int().nonnegative(),
    battleRoundsElapsed: z.number().int().nonnegative().optional(),
    restProgress: z.number().int().nonnegative().optional(),
    turnsLeft: z.number().int().nonnegative().optional(),
  })
  .strict();

const CombatantBaseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    gender: z.string(),
    age: z.number(),
    attributes: z.record(z.string(), z.number()),
    hp: z.number(),
    mp: z.number(),
    mood: z.number(),
    statuses: z.array(StatusInstanceSchema),
    skillCooldowns: z.record(z.string(), z.number()),
  })
  .strict();

const V2PlayerSchema = CombatantBaseSchema.extend({
  inventory: z.record(z.string(), z.number().int().nonnegative()),
  skills: z.array(z.string().min(1)),
  growthLevel: z.number().int().nonnegative(),
  equipment: z.array(EquipmentInstanceSchema).optional(),
}).strict();

const V2NpcSchema = CombatantBaseSchema.extend({
  relationship: z.number(),
  personality: z.string(),
  knownGoals: z.array(z.string()),
  skills: z.array(z.string().min(1)),
  /** 模板 `characters[].isEnemy` 的副本。实例表里**只会**出现 `false` —— 敌人不实例化。 */
  isEnemy: z.boolean(),
  inventory: z.record(z.string(), z.number().int().nonnegative()),
  goals: z.array(z.string()),
  traits: z.array(z.string()),
  knowledge: z.array(z.string()),
  secrets: z.array(z.string()),
  lastActedAtTurn: z.number().int().nonnegative(),
  /** ADR-0022：由哪条刷新规则生出；缺省 = 世界初始即存在 */
  spawnRuleId: z.string().min(1).optional(),
  /**
   * 生命周期（ADR-0012 决策 1 / ADR-0020）。**可选 + 默认存活**：
   * 该字段引入前落盘的存档没有它，加载时补成 alive，不升 `schemaVersion`
   * （沿用 `lastWheels` 的兼容先例，避免为一个新增字段废掉全部在跑存档）。
   */
  lifecycle: z
    .object({
      state: z.enum(["alive", "inactive", "unspawned"]),
      reasonCode: z.string().min(1).optional(),
      sinceTurn: z.number().int().nonnegative(),
      sinceWorldTime: z.number(),
    })
    .strict()
    .default({ state: "alive", sinceTurn: 0, sinceWorldTime: 0 }),
  /**
   * 出生时刻（世界分钟，**可为负** = 世界起点之前出生；ADR-0021 决策 4.1）。
   * 可选 + 读侧反推：缺字段的旧档不拒载，投影按 `birthTimeFromAge(age, adapter)` 兜底
   * （与 lifecycle 同一兼容策略 ⇒ **不升 schemaVersion**）。
   */
  birthTime: z.number().optional(),
}).strict();

const BattleEnemySchema = z
  .object({
    instanceId: z.string().min(1),
    characterId: z.string().min(1),
    name: z.string().min(1),
    hp: z.number(),
    maxHp: z.number(),
    mp: z.number(),
    maxMp: z.number().optional(),
    attributes: z.record(z.string(), z.number()),
    statuses: z.array(StatusInstanceSchema),
    skillCooldowns: z.record(z.string(), z.number()),
    skills: z.array(z.string().min(1)),
    skillWeights: z.record(z.string(), z.number()),
    alive: z.boolean(),
  })
  .strict();

const BattleStateSchema = z
  .object({
    eventId: z.string().min(1),
    /** 结算配置副本：复用模板协议的 combat settle 定义 */
    settle: CombatSettleSchema.shape.combat,
    round: z.number().int().nonnegative(),
    player: z
      .object({
        hp: z.number(),
        mp: z.number(),
        statuses: z.array(StatusInstanceSchema),
        skillCooldowns: z.record(z.string(), z.number()),
      })
      .strict(),
    enemies: z.array(BattleEnemySchema),
    allies: z.array(BattleEnemySchema),
    log: z.array(z.string()),
    over: z.enum(["victory", "defeat", "flee"]).nullable(),
  })
  .strict();

const HistoryEntryV2Schema = z
  .object({
    id: z.string().min(1),
    turnIndex: z.number().int().nonnegative(),
    worldTime: z.number(),
    formattedTime: z.string(),
    type: z.enum(["player_action", "npc_action", "event", "battle", "milestone"]),
    summary: z.string(),
    detail: z.string().optional(),
    /** 可选：R2.2 及以前旧档缺字段，读取侧视为 public（协议 §21.1 兼容策略） */
    visibility: z.enum(["public", "hidden", "unknown"]).optional(),
  })
  .strict();

/**
 * 呈现槽（ADR-0034 §1）：标量、进存档。`from` 是封闭枚举 —— 新增来源必须改协议。
 * 刻意**不**在这里存"已呈现过"之类的进度位：呈现是每请求现取的派生行为。
 */
const SlotSceneSchema = z
  .object({
    eventId: z.string().min(1),
    from: z.enum(["successor", "opening", "death", "hook", "queueTake"]),
    fromEventId: z.string().min(1).optional(),
    /** 仅 `from === "queueTake"` 写入（ADR-0034 §8-⑪）；不得进投影 */
    instanceId: z.string().min(1).optional(),
  })
  .strict();

const WheelResultViewSchema = z
  .object({
    eventId: z.string().min(1),
    /** D-16：所属事件标题；可缺省以兼容无该字段的旧档（读侧由前端兜底文案） */
    title: z.string().min(1).optional(),
    label: z.string(),
    segments: z.array(z.object({ label: z.string(), weight: z.number() }).strict()),
  })
  .strict();

const FlagsValueSchema = z.union([z.boolean(), z.number(), z.string()]);

/** 错失原因封闭枚举（design §3.4.1）；模板不能自由书写 reason 文本。 */
export const MissReasonSchema = z.enum(["window_expired", "miss_when"]);

const MissedEventRecordSchema = z
  .object({
    eventId: z.string().min(1),
    instanceId: z.string().min(1),
    turnIndex: z.number().int().nonnegative(),
    worldTime: z.number().int(),
    reason: MissReasonSchema,
    label: z.string().min(1).optional(),
  })
  .strict();

const EventFireRecordSchema = z
  .object({
    eventId: z.string().min(1),
    turnIndex: z.number().int().nonnegative(),
    worldTime: z.number().int(),
  })
  .strict();

const LastFiredIndexEntrySchema = z
  .object({
    turnIndex: z.number().int().nonnegative(),
    worldTime: z.number().int(),
  })
  .strict();

export const WorldStateV2Schema = z
  .object({
    id: z.string().min(1),
    templateId: z.string().min(1),
    seed: z.number().int(),
    turnIndex: z.number().int().nonnegative(),
    /** 整数分钟（R-LM-05）；#45 裁决本轮不加数值上界校验 */
    worldTime: z.number().int(),
    playerAgeAtStart: z.number(),
    player: V2PlayerSchema,
    /**
     * 玩家在演员表 / 关系图里的节点 id（A 期 seam）。
     * **可选**：引入前落盘的存档没有它，读取时回落 `PLAYER_ID`（"player"），行为逐字段不变。
     */
    selfId: z.string().min(1).optional(),
    npcs: z.array(V2NpcSchema),
    /** R2.6 / ADR-0014：关系图边（实例层，NPC↔NPC 与 NPC↔玩家同构；配置域不复制） */
    relations: z.array(RelationEdgeSchema),
    /**
     * ADR-0022：刷新规则实例队列。**可选 + 默认 []**（旧档加载补空数组，不升 schemaVersion）。
     */
    spawnRules: z
      .array(
        z
          .object({
            ruleId: z.string().min(1),
            characterRef: z.string().min(1),
            status: z.enum(["pending", "spawned"]),
            spawnedTurn: z.number().int().nonnegative(),
            spawnedWorldTime: z.number(),
          })
          .strict(),
      )
      .default([]),
    /** ADR-0022：事实层出生记录（append-only）。可选 + 默认 []。 */
    spawnLog: z
      .array(
        z
          .object({
            npcId: z.string().min(1),
            ruleId: z.string().min(1),
            turnIndex: z.number().int().nonnegative(),
            worldTime: z.number(),
          })
          .strict(),
      )
      .default([]),
    flags: z.record(z.string(), FlagsValueSchema),
    /** 过渡兼容索引：与 lastFiredIndex / eventFires 由 recordFire 一处写入 */
    firedEvents: z.record(z.string(), z.number().int().nonnegative()),
    /** 唯一队列（ADR-0034 §1）：延时事件队列。改名自 `scheduledEvents`（形状不变）。 */
    delayQueue: z.array(ScheduledEventInstanceSchema),
    /**
     * 运行时生成的分支事件定义（AGENTIC-GM 重构）：**追加式**，与模板事件同 schema。
     * 由 `story.submitBranch` 写入；`TemplateLookup` 查表时优先命中它（overlay）。
     * 可选 + 缺省 `[]` ⇒ 旧档可直载、无生成内容的世界逐字段不变。
     */
    generatedEvents: z.array(EventV2Schema).optional(),
    /** 运行时生成的角色定义（模板里没有的人）；与模板角色共用实例表与生命周期。 */
    generatedCharacters: z.array(CharacterSchema).optional(),
    enqueueSeqCounter: z.number().int().nonnegative(),
    missedEvents: z.array(MissedEventRecordSchema),
    eventFires: z.array(EventFireRecordSchema),
    lastFiredIndex: z.record(z.string(), LastFiredIndexEntrySchema),
    /** 呈现槽：`null` = 空槽。写入口只有「队列取出」与「后继占槽」两个（ADR-0034 §4 S4）。 */
    slot: SlotSceneSchema.nullable(),
    battle: BattleStateSchema.nullable(),
    lastWheel: WheelResultViewSchema.nullable(),
    /**
     * 当轮全部转盘结果（D-03）。可缺省：R2.x 旧档无此字段，读侧按 `[]` 处理
     * （与 history.visibility / player.equipment 同一兼容策略 ⇒ 不升 schemaVersion、不拒载旧档）。
     */
    lastWheels: z.array(WheelResultViewSchema).optional(),
    history: z.array(HistoryEntryV2Schema),
    openingCompleted: z.boolean(),
    termination: TerminationRecordSchema.nullable(),
    archived: z.boolean(),
    // ---------- F3 / F4 新契约状态（schemaVersion 4 预留；本波旧档不兼容） ----------
    observationLedger: ObservationLedgerSchema,
    taskDag: TaskDagSchema,
    pendingInvocation: LlmInvocationSchema.optional(),
    media: z
      .array(z.object({ slot: z.string().min(1), assetId: z.string().min(1) }).strict())
      .optional(),
    traceRef: z.string().min(1).optional(),
    /**
     * ADR-0036：触发器边沿历史（key = `${reason}#${llmTriggers 下标}`）。
     * 可选 ⇒ 旧档缺该字段时视作"无历史"（首轮把当前真值当刚刚变真，至多多发一次）。
     * **不升 schemaVersion**：与 `spawnRules` / `lastWheels` 同一兼容策略。
     */
    triggerFireLedger: z
      .record(
        z.string(),
        z
          .object({
            turnIndex: z.number().int().nonnegative(),
            hit: z.boolean(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type WorldStateV2Parsed = z.infer<typeof WorldStateV2Schema>;

// ---------- 双向类型断言（R-PS-02 完成定义） ----------
// schema 与 TS 接口任何一侧漂移，下面的赋值即编译错误。
const _forward: WorldStateV2 = {} as WorldStateV2Parsed;
const _backward: WorldStateV2Parsed = {} as WorldStateV2;
void _forward;
void _backward;

// EndingConfigSchema 引用保持（存档信封的 templateFingerprint 语义依赖模板整体，含 endings；
// 显式引用以防未来 schema 拆分时遗漏）。运行时无用，编译期存在即可。
const _endingConfigRef: typeof EndingConfigSchema = EndingConfigSchema;
void _endingConfigRef;

// HistoryEntryV2 类型与 schema 的显式关联（drift guard）
const _historyRef: HistoryEntryV2 = {} as z.infer<typeof HistoryEntryV2Schema>;
const _historyBack: z.infer<typeof HistoryEntryV2Schema> = {} as HistoryEntryV2;
void _historyRef;
void _historyBack;

const _battleRef: BattleState = {} as z.infer<typeof BattleStateSchema>;
void _battleRef;
