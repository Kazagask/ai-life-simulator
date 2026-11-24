import { z } from "zod";
import { PendingAllocationSchema } from "./schema/allocation.js";
import { OpeningStepResultSchema } from "./schema/opening.js";
import { AttributeValueSchema } from "./schema/attribute.js";
import { CombatSettleSchema, EventV2Schema } from "./schema/event.js";
import { BattleResultSchema } from "./schema/battle-evaluation.js";
import { CharacterSchema } from "./schema/character.js";
import { EndingConfigSchema } from "./schema/ending.js";
import { EquipmentInstanceSchema } from "./schema/equipment.js";
import { ScheduledEventInstanceSchema } from "./schema/event-instance.js";
import { TerminationRecordSchema } from "./schema/ending.js";
import { RelationEdgeSchema } from "./schema/relation.js";
import { ObservationLedgerSchema } from "./contract/perspective.js";
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
    /** ADR-009：施加时的 worldTime（分钟）。到期判定与展示的基准点。 */
    appliedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().optional(),
    roundsLeft: z.number().int().nonnegative().optional(),
    /** ADR-018 D4：战斗态已经历的回合末次数（战后折算世界时间用）。 */
    roundsHeld: z.number().int().nonnegative().optional(),
    restProgress: z.number().int().nonnegative().optional(),
    /** ADR-075：成长型天赋的进度与已结算阶数（旧档缺省 0）。 */
    progress: z.number().optional(),
    tiersApplied: z.number().int().nonnegative().optional(),
  })
  .strict();

const CombatantBaseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    gender: z.string(),
    age: z.number(),
    /** ADR-003：数值属性为 number，enum 属性为选项 id。 */
    attributes: z.record(z.string(), AttributeValueSchema),
    /**
     * reset 阶梯的当前档位（ADR-003 D4）。可选：旧档与只用 cumulative 的世界没有该字段。
     */
    attributeTiers: z.record(z.string(), z.string().min(1)).optional(),
    hp: z.number(),
    mp: z.number(),
    mood: z.number(),
    statuses: z.array(StatusInstanceSchema),
    skillCooldowns: z.record(z.string(), z.number()),
  })
  .strict();

/**
 * 生命周期（ADR-0012 决策 1 / ADR-0020）。抽出来是为了 ADR-010 D1：玩家结构在
 * 接管一个 NPC 时也要能携带它（可选），而 NPC 上它必填且默认存活。
 */
const LifecycleSchema = z
  .object({
    state: z.enum(["alive", "inactive", "unspawned"]),
    reasonCode: z.string().min(1).optional(),
    sinceTurn: z.number().int().nonnegative(),
    sinceWorldTime: z.number(),
  })
  .strict();

const V2PlayerSchema = CombatantBaseSchema.extend({
  inventory: z.record(z.string(), z.number().int().nonnegative()),
  /**
   * 自定义资源（ADR-003 D8）：**不含 hp/mp**（它们是同名字段）。
   * 可选 + 默认 {} ⇒ 旧档直载。
   */
  resources: z.record(z.string(), z.number()).default({}),
  /** ADR-012 D9：专属资源池上限（以角色开局时才有）。 */
  resourceMax: z.record(z.string(), z.number()).optional(),
  skills: z.array(z.string().min(1)),
  growthLevel: z.number().int().nonnegative(),
  equipment: z.array(EquipmentInstanceSchema).optional(),
  /**
   * 父/母指针（`extensions/family/doc/FAMILY-GRAPH.md` §3.1）：模板 `playerTemplate.fatherId/motherId` 的副本。
   * 可选 + 无默认值 ⇒ 旧档缺字段不拒载。
   */
  fatherId: z.string().min(1).optional(),
  motherId: z.string().min(1).optional(),
  /**
   * ⚠ **ADR-010 D1 演员同构**：以下字段与 NPC 同名同义，只在「self 就是某个模板角色」
   * （扮演、夺舍、继承）时出现。全部可选 + 无默认 ⇒ 旧档与普通玩家档逐字段不变。
   */
  lifecycle: LifecycleSchema.optional(),
  personality: z.string().optional(),
  goals: z.array(z.string()).optional(),
  traits: z.array(z.string()).optional(),
  knowledge: z.array(z.string()).optional(),
  secrets: z.array(z.string()).optional(),
  visibility: z.enum(["public", "hidden"]).optional(),
  isEnemy: z.boolean().optional(),
  birthTime: z.number().optional(),
  lastActedAtTurn: z.number().int().nonnegative().optional(),
  /** ADR-010 D5：对**当前 self** 的单向好感标量，不参与判定。 */
  relationship: z.number().optional(),
}).strict();

const V2NpcSchema = CombatantBaseSchema.extend({
  relationship: z.number(),
  personality: z.string(),
  knownGoals: z.array(z.string()),
  skills: z.array(z.string().min(1)),
  /** 模板 `characters[].isEnemy` 的副本。实例表里**只会**出现 `false` —— 敌人不实例化。 */
  isEnemy: z.boolean(),
  /**
   * 展示门（由模板 `characters[].visibility` 复制而来）：`hidden` ⇒ 不进玩家视角的 NPC 列表。
   * **只影响列表**，不影响实例存在、关系端点、战斗解析与自主行动。
   * 可选 + 默认 `public`：该字段引入前落盘的存档没有它，加载时补成 public，不升 schemaVersion。
   */
  visibility: z.enum(["public", "hidden"]).default("public"),
  inventory: z.record(z.string(), z.number().int().nonnegative()),
  /**
   * ⚠ **ADR-010 D1 演员同构**：与玩家同名同义。全部可选 + 无默认 ⇒ 旧档逐字段不变，
   * 且「NPC 没有这个东西」仍可辨认（字段缺席，而不是 0）。
   */
  resources: z.record(z.string(), z.number()).optional(),
  equipment: z.array(EquipmentInstanceSchema).optional(),
  growthLevel: z.number().int().nonnegative().optional(),
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
  lifecycle: LifecycleSchema.default({ state: "alive", sinceTurn: 0, sinceWorldTime: 0 }),
  /**
   * 出生时刻（世界分钟，**可为负** = 世界起点之前出生；ADR-0021 决策 4.1）。
   * 可选 + 读侧反推：缺字段的旧档不拒载，投影按 `birthTimeFromAge(age, adapter)` 兜底
   * （与 lifecycle 同一兼容策略 ⇒ **不升 schemaVersion**）。
   */
  birthTime: z.number().optional(),
  /**
   * 父/母指针（`extensions/family/doc/FAMILY-GRAPH.md` §3.1）：模板 `characters[].fatherId/motherId` 的副本。
   * 可选 + 无默认值 ⇒ 旧档缺字段不拒载；本轮**不参与任何推导**，只为后续族谱轮次铺路。
   */
  fatherId: z.string().min(1).optional(),
  motherId: z.string().min(1).optional(),
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
    attributes: z.record(z.string(), AttributeValueSchema),
    /** 敌人 / 友军的自定义资源（ADR-003 D9：引擎对称，不做「只有玩家有」的特例）。 */
    resources: z.record(z.string(), z.number()).default({}),
    /** ADR-012 D9：专属资源池上限。旧档 / 无专属池 ⇒ 空表。 */
    resourceMax: z.record(z.string(), z.number()).optional(),
    statuses: z.array(StatusInstanceSchema),
    skillCooldowns: z.record(z.string(), z.number()),
    /** ADR-010 D3：心情进战斗。可选 ⇒ 旧档缺省按 50 处理。 */
    mood: z.number().optional(),
    skills: z.array(z.string().min(1)),
    skillWeights: z.record(z.string(), z.number()),
    alive: z.boolean(),
    /** ADR-075：战果计数（旧档缺省 0）。 */
    damageByPlayer: z.number().optional(),
    damageToPlayer: z.number().optional(),
    /** ADR-075：最后把 hp 打到 0 的来源实例 id。 */
    lastHitBy: z.string().min(1).optional(),
    /** ADR-012 D2：展示档位。旧档缺省 ⇒ 按 minion 处理（小框）。 */
    tier: z.enum(["minion", "hero"]).optional(),
    /** 装备战斗轴合计（2026-11-20）：建场时算一次，整场不变；旧档缺省 ⇒ 空。 */
    gear: z
      .object({
        hitChance: z.number(),
        evade: z.number(),
        damageDealt: z.number(),
        damageTaken: z.number(),
        guaranteedHit: z.boolean(),
      })
      .strict()
      .optional(),
    /** 阵营（2026-11-20）：已退场名册的混合列表靠它上色。旧档缺省 ⇒ 按友军兜底。 */
    side: z.enum(["ally", "enemy", "neutral"]).optional(),
    /** ADR-012 D1：召唤者实例 id（只对召唤物有值）。 */
    summonedBy: z.string().min(1).optional(),
    /** ADR-012 D1：入场回合号（= 当前回合 ⇒ 本回合不行动）。 */
    enteredRound: z.number().int().nonnegative().optional(),
    /** ADR-013 D1：召它的角色 id —— 收回后再召靠它认亲（不按实例 id）。 */
    summonRef: z.string().min(1).optional(),
    /** ADR-012 D1：召唤者倒下时是否连带消失。 */
    dismissOnSummonerDown: z.boolean().optional(),
    /** 死亡 / 献祭 / 连带消失的可展示原因。旧档缺省。 */
    deathReason: z.string().optional(),
  })
  .strict();

const BattleStateSchema = z
  .object({
    eventId: z.string().min(1),
    /** 结算配置副本：复用模板协议的 combat settle 定义 */
    settle: CombatSettleSchema.shape.combat,
    round: z.number().int().nonnegative(),
    /** ADR-075：本场赌注与判负口径（旧档缺省 ⇒ hard / down / 1）。 */
    stake: z.string().min(1).optional(),
    defeatState: z.enum(["yielded", "down", "dead"]).optional(),
    defeatThreshold: z.number().int().nonnegative().optional(),
    powerStart: z
      .object({
        player: z.number(),
        ally: z.number(),
        enemy: z.number(),
        neutral: z.number(),
      })
      .strict()
      .optional(),
    player: z
      .object({
        hp: z.number(),
        mp: z.number(),
        /** ADR-075：开场 HP 上限与战果计数（旧档缺省 ⇒ 现算 / 0）。 */
        maxHp: z.number().optional(),
        damageDealt: z.number().optional(),
        damageTaken: z.number().optional(),
        crits: z.number().int().nonnegative().optional(),
        hits: z.number().int().nonnegative().optional(),
        lastHitBy: z.string().min(1).optional(),
        /** 战斗镜像里的自定义资源（ADR-003 D8）；结束时回写权威状态。 */
        resources: z.record(z.string(), z.number()).default({}),
        statuses: z.array(StatusInstanceSchema),
        skillCooldowns: z.record(z.string(), z.number()),
      })
      .strict(),
    enemies: z.array(BattleEnemySchema),
    allies: z.array(BattleEnemySchema),
    /** ADR-012 D5：中立单位。旧档缺省空数组。 */
    neutrals: z.array(BattleEnemySchema).default([]),
    /** 已退场但保留原因的单位（献祭 / 连带消失）。旧档缺省空。 */
    fallen: z.array(BattleEnemySchema).optional(),
    /** ADR-013 D4：已收回的召唤物（战斗内保留状态，重召即原位回来）。旧档 ⇒ 空。 */
    bench: z.array(BattleEnemySchema).optional(),
    /** 本轮离场的灰卡（收回 / 献祭），下一回合清空。旧档 ⇒ 空。 */
    departed: z.array(BattleEnemySchema).optional(),
    /** 结束瞬间算好的战评（`leave` 时交给 finishBattle，不重算）。旧档 ⇒ 空。 */
    evaluation: BattleResultSchema.optional(),
    /** ADR-013：召唤实例编号的单调计数器（长度会变，不能用长度起算）。 */
    summonSeq: z.number().int().nonnegative().optional(),
    /** ADR-012 D3：中途加入触发进度（键 = id / `#下标`，值 = 次数）。 */
    reinforcementFires: z.record(z.string(), z.number()).optional(),
    /** ADR-073：钩子触发次数（键 = hook id）。 */
    hookFires: z.record(z.string(), z.number()).optional(),
    /** ADR-073：本回合钩子触发次数（`limit.per: round`），回合末清空。 */
    hookRoundFires: z.record(z.string(), z.number()).optional(),
    /** ADR-073 / ADR-076：结构化战斗事件（只写不读）。 */
    events: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("damage"),
              seq: z.number().int().positive().optional(),
              round: z.number().int().positive().optional(),
              actor: z.string(),
              target: z.string(),
              skillId: z.string().optional(),
              amount: z.number(),
              critical: z.boolean(),
              critTier: z.union([z.literal(1), z.literal(2)]).optional(),
              amplifiedBy: z.string().optional(),
              hookId: z.string().optional(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("heal"),
              seq: z.number().int().positive().optional(),
              round: z.number().int().positive().optional(),
              actor: z.string(),
              target: z.string(),
              skillId: z.string().optional(),
              amount: z.number(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("miss"),
              seq: z.number().int().positive().optional(),
              round: z.number().int().positive().optional(),
              actor: z.string(),
              target: z.string(),
              skillId: z.string().optional(),
              stage: z.enum(["beforeHit", "hit", "evade", "afterHit"]),
              reason: z.string().optional(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("summon"),
              seq: z.number().int().positive().optional(),
              round: z.number().int().positive().optional(),
              actor: z.string(),
              summonId: z.string(),
              name: z.string().optional(),
              skillId: z.string().optional(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("recall"),
              seq: z.number().int().positive().optional(),
              round: z.number().int().positive().optional(),
              actor: z.string(),
              target: z.string(),
              name: z.string().optional(),
              skillId: z.string().optional(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("sacrifice"),
              seq: z.number().int().positive().optional(),
              round: z.number().int().positive().optional(),
              actor: z.string(),
              target: z.string(),
              skillId: z.string().optional(),
              name: z.string().optional(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("buff"),
              seq: z.number().int().positive().optional(),
              round: z.number().int().positive().optional(),
              actor: z.string(),
              target: z.string(),
              skillId: z.string().optional(),
              statusId: z.string(),
              name: z.string().optional(),
              polarity: z.enum(["positive", "negative", "neutral"]).optional(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("cancel"),
              seq: z.number().int().positive().optional(),
              round: z.number().int().positive().optional(),
              actor: z.string(),
              target: z.string().optional(),
              skillId: z.string().optional(),
              hookId: z.string().optional(),
              reason: z.string(),
            })
            .strict(),
          z
            .object({ kind: z.literal("hook"), seq: z.number().int().positive().optional(),
              round: z.number().int().positive().optional(), hookId: z.string(), text: z.string().optional() })
            .strict(),
        ]),
      )
      .optional(),
    /** ADR-076 §10：事件序号计数器（events 只留 200 条，序号不能按数组下标推算）。 */
    eventSeq: z.number().int().nonnegative().optional(),
    log: z.array(z.string()),
    over: z.enum(["victory", "defeat", "flee"]).nullable(),
  })
  .strict();

/**
 * 历史条目的**人话**标签（2026-11-21）。
 *
 * `type` 是机器枚举（`npc_action` 这类），直接丢给模型会让它把枚举写进正文，
 * 或者读不懂"最近发生了什么"。凡是给模型看的窗口一律带 `kindLabel`。
 *
 * 与前端「行 / 人 / 事 / 战 / 碑 / 世」的单字标记**不是同一套**：那是版面宽度受限的缩写，
 * 这里是完整说法。两处都从这一个枚举派生，改枚举时一起看。
 */
export const HISTORY_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  player_action: "主角行动",
  npc_action: "他人动向",
  event: "事件",
  battle: "战斗",
  milestone: "里程碑",
  world: "世界动态",
});

const HistoryEntryV2Schema = z
  .object({
    id: z.string().min(1),
    turnIndex: z.number().int().nonnegative(),
    worldTime: z.number(),
    formattedTime: z.string(),
    type: z.enum(["player_action", "npc_action", "event", "battle", "milestone", "world"]),
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

// ---------- 扩展 state 切片校验接缝（`docs/EXTENSIONS.md` §2） ----------

/** 单条切片校验的结论。失败只带人话消息与相对路径，**不带错误码**（码由读档层给）。 */
export type ExtensionStateSliceValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly path?: readonly (string | number)[] };

export type ExtensionStateSliceValidator = (slice: unknown) => ExtensionStateSliceValidation;

/**
 * 扩展 id → 切片校验器。
 *
 * 为什么这份表在 `shared` 而不是 `game-core`：读档的唯一入口是 `WorldStateV2Schema`
 * （`apps/server/src/store.ts` 的 `worldStateV2Schema.safeParse` → 封闭码 `world_state_invalid`），
 * 而 `shared` 是读档层的依赖方向，**不能反向依赖 game-core 的注册表**。所以这里只留一个
 * 由装配层注入的钩子：`@life-sim/game-core` 的 `registerExtensionRuntime` 把每个扩展的
 * `stateSchema` 包成校验器塞进来，`resetExtensionRuntimes` 清空。
 *
 * 语义三条：
 * 1. **只校验已注册的 id**；未注册的 id 留在 `state.extensions` 里不报错（可能是已卸载扩展的
 *    遗留数据），**不丢**。
 * 2. **切片缺省 = 不校验**（不是失败）：模板 `extensions:` 声明了某个扩展、但存档是该扩展
 *    引入之前落盘的时候，`state.extensions` 整段都不存在 —— 这必须能直载，
 *    否则「加一个扩展」会废掉所有在跑存档（沿用 `spawnRules` / `lastWheels` 的兼容策略）。
 * 3. 校验失败由读档层归到既有封闭码 **`world_state_invalid`**（`apps/server/src/store.ts` 的
 *    `UnloadableReason`），本文件不新造码、不改拒载通道。
 */
const EXTENSION_STATE_VALIDATORS = new Map<string, ExtensionStateSliceValidator>();

/**
 * 装配期注入（只有 `@life-sim/game-core` 的 `registerExtensionRuntime` /
 * `resetExtensionRuntimes` 调；业务代码不要直接调）。整表替换，不累加。
 */
export function setExtensionStateSliceValidators(
  validators: Readonly<Record<string, ExtensionStateSliceValidator>>,
): void {
  EXTENSION_STATE_VALIDATORS.clear();
  for (const [id, validate] of Object.entries(validators)) {
    EXTENSION_STATE_VALIDATORS.set(id, validate);
  }
}

/**
 * `state.extensions` 的存档校验：每个**已注册**的 id 用它的 `stateSchema` 校验自己的切片，
 * 失败即读档失败（路径 `extensions.<id>.<…>`）。未注册的 id 原样放行。
 */
const ExtensionsBagSchema = z.record(z.string(), z.unknown()).superRefine((bag, ctx) => {
  for (const [id, slice] of Object.entries(bag)) {
    const validate = EXTENSION_STATE_VALIDATORS.get(id);
    if (validate === undefined) continue;
    const result = validate(slice);
    if (result.ok) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [id, ...(result.path ?? [])],
      message: result.message,
    });
  }
});

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
    /** 观察者（`observeActor` 写入）；缺省 = selfId。旧档直载。 */
    viewerId: z.string().min(1).optional(),
    /** ADR-001：前实例化开局落盘记录（只记结果）。schemaVersion 5 新档必写。 */
    opening: z
      .object({
        openingId: z.string().min(1),
        // 与 `OpeningStepResultSchema` 同源：以前这里手抄了一份，ADR-072 D7 加 `input`
        // 时立刻漂了一次（旧档没事，新档一提交就 `Unrecognized key`）。直接复用。
        results: z.array(OpeningStepResultSchema),
      })
      .strict()
      .optional(),
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
    /**
     * 待完成的加点请求（ADR-019，2026-11-20）。
     *
     * **可选** ⇒ 旧档直载、不升 `schemaVersion`（与 `spawnRules` / `facts` 同一策略）。
     * 提交后由轮外端点清空；不写回「剩余点数」，那会变成一个永远没人对账的字段。
     */
    pendingAllocation: PendingAllocationSchema.optional(),
    flags: z.record(z.string(), FlagsValueSchema),
    /**
     * 世界时间表的执行记录（ADR-007 D1）：`factId` 出现即「这条事实已经发生过」。
     *
     * append-only，只由引擎在 `scheduledFacts` 条件满足时追加一条；读侧只看「在不在」。
     * **可选 + 默认 []** ⇒ 旧档直载、不升 schemaVersion（与 `spawnRules` / `spawnLog`
     * 同一兼容策略）。
     */
    facts: z
      .array(
        z
          .object({
            factId: z.string().min(1),
            turnIndex: z.number().int().nonnegative(),
            worldTime: z.number(),
          })
          .strict(),
      )
      .default([]),
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
    /** ADR-075：最近一场战果快照。旧档缺省 ⇒ 没有最近战果。 */
    lastBattleResult: BattleResultSchema.optional(),
    /** ADR-075：死亡链状态。旧档缺省 ⇒ 不在死亡链里。 */
    deathPending: z
      .object({ routeId: z.string().min(1), eventId: z.string().min(1) })
      .strict()
      .optional(),
    deathSignal: z.object({ reason: z.string().min(1).optional() }).strict().optional(),
    deathDepth: z.number().int().nonnegative().optional(),
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
    /**
     * 扩展状态切片（`docs/EXTENSIONS.md` §2）：键 = 扩展 id，值由扩展自己的 `stateSchema` 解释。
     * 可选 ⇒ 旧档直载、不声明扩展的世界逐字段不变（**不升 `schemaVersion`**）。
     * 值形状**故意是 `unknown`**：`shared` 不依赖任何扩展；切片校验走上面的注入钩子。
     */
    extensions: ExtensionsBagSchema.optional(),
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
