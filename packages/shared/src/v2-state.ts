import { z } from "zod";
import { CombatSettleSchema } from "./schema/event.js";
import { EndingConfigSchema } from "./schema/ending.js";
import { EquipmentInstanceSchema } from "./schema/equipment.js";
import { ScheduledEventInstanceSchema } from "./schema/event-instance.js";
import { TerminationRecordSchema } from "./schema/ending.js";
import { RelationEdgeSchema } from "./schema/relation.js";
import type { BattleState, HistoryEntryV2, WorldStateV2 } from "./v2.js";

/**
 * WorldStateV2 的 Zod 校验（R-PS-02 / ADR-0007）。
 * 加载磁盘存档本质是处理不可信输入：schemaVersion 校验之后必须过这里。
 * 双维护风险用文件末尾的双向类型断言收口——schema 与 TS 接口漂移即编译错误。
 *
 * 兼容策略：HistoryEntryV2.visibility / player.equipment 可缺省（R2.2 旧档视为 public / []），
 * 其余字段为存档必需——缺任一字段即拒绝该档（协议 §21.2）。
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
  isEnemy: z.boolean(),
  inventory: z.record(z.string(), z.number().int().nonnegative()),
  goals: z.array(z.string()),
  traits: z.array(z.string()),
  knowledge: z.array(z.string()),
  secrets: z.array(z.string()),
  lastActedAtTurn: z.number().int().nonnegative(),
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

const ChainStateV2Schema = z
  .object({
    id: z.string().min(1),
    stepIndex: z.number().int(),
    status: z.enum(["active", "completed"]),
    startedTurn: z.number().int().nonnegative(),
  })
  .strict();

const PendingEventSchema = z
  .object({
    eventId: z.string().min(1),
    chainId: z.string().min(1).optional(),
  })
  .strict();

const WheelResultViewSchema = z
  .object({
    eventId: z.string().min(1),
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
    npcs: z.array(V2NpcSchema),
    /** R2.6 / ADR-0014：关系图边（实例层，NPC↔NPC 与 NPC↔玩家同构；配置域不复制） */
    relations: z.array(RelationEdgeSchema),
    flags: z.record(z.string(), FlagsValueSchema),
    /** 过渡兼容索引：与 lastFiredIndex / eventFires 由 recordFire 一处写入 */
    firedEvents: z.record(z.string(), z.number().int().nonnegative()),
    scheduledEvents: z.array(ScheduledEventInstanceSchema),
    enqueueSeqCounter: z.number().int().nonnegative(),
    missedEvents: z.array(MissedEventRecordSchema),
    eventFires: z.array(EventFireRecordSchema),
    lastFiredIndex: z.record(z.string(), LastFiredIndexEntrySchema),
    chains: z.array(ChainStateV2Schema),
    pendingEvents: z.array(PendingEventSchema),
    battle: BattleStateSchema.nullable(),
    lastWheel: WheelResultViewSchema.nullable(),
    history: z.array(HistoryEntryV2Schema),
    openingCompleted: z.boolean(),
    termination: TerminationRecordSchema.nullable(),
    archived: z.boolean(),
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
