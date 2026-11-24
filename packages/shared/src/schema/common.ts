import { AllocationTargetSchema } from "./allocation.js";
import { z } from "zod";
import { RelationKindSchema, RelationScopeSchema, RelationVisibilitySchema } from "./relation.js";

/**
 * 协议 V2 公共 Schema：时间量、数值公式 preset、条件与效果 DSL。
 * 所有对象 strict —— 未知字段在加载期即报错（拼写保护）。
 */

// ---------- 时间 ----------

export const TimeUnitSchema = z.enum(["minute", "hour", "day", "week", "month", "year"]);

export const TimeAmountSchema = z
  .object({
    /** 整数分钟标量：value × UNIT_MINUTES[unit] 必须为整数（R-LM-05） */
    value: z.number().int().positive(),
    unit: TimeUnitSchema,
  })
  .strict();

/**
 * TimeSpec（R2.5 / ADR-0011 / ADR-0013）：所有延时字段（window.start/end、delay、cooldown、
 * timeCost、ChainStep.delay、enqueueEvent.delay）共用的单一时间写法，**默认相对入队时刻**（OQ-#37 裁决）。
 * R2.6 起开放字符串字面量（#44/#39/#43）：
 * - 复合时长：`3d` / `2h30m` / `1y2mo`（y=年 mo=月 w=周 d=日 h=时 m=分，可串联，依次累加）；
 * - 历法日期字面量：`2006-12-24`（**绝对世界分钟**，语义与「相对入队」不同，适合 window.start）。
 * 字符串字面量由 CalendarAdapter.parseTimeSpec 在**入队时**解析并固化成绝对分钟（R-CAL-04）；
 * approx 历法只支持复合时长（日期字面量在运行期抛错——加载期无法校验历法语义）。
 */
export const TimeSpecSchema = z.union([TimeAmountSchema, z.string().min(1).max(64)]);

// ---------- 人生阶段（模板可配置，替代引擎硬编码阈值） ----------

export const LifeStageSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1).optional(),
    /** 年龄上界（含）；缺省表示该档为最后一档、无上界 */
    maxAge: z.number().int().nonnegative().optional(),
  })
  .strict();

// ---------- 数值公式（preset 白名单，见规格 10.4） ----------

export const FixedFormulaSchema = z
  .object({ preset: z.literal("fixed"), value: z.number() })
  .strict();

export const ScaledFormulaSchema = z
  .object({
    preset: z.literal("scaled"),
    base: z.number(),
    scaleBy: z.string().min(1),
    multiplier: z.number(),
  })
  .strict();

/** 按施放者指定状态的层数缩放：base + stacks(status) * perStack（如按消耗掉的层数） */
export const StackScaledFormulaSchema = z
  .object({
    preset: z.literal("stack-scaled"),
    base: z.number(),
    perStack: z.number(),
    status: z.string().min(1),
  })
  .strict();

/**
 * 按施放者**资源池当前值**缩放（ADR-012 D10）：`base + value(resource) × perPoint`。
 *
 * 存在的理由：咒灵操术的旋涡「献祭多少储备就有多响」，而那个储备是资源而不是状态层数
 * （ADR-012 D9 把「咒灵数量」从状态挪成了专属资源条）。副作用是式子必须读**消耗前**的值 ——
 * 结算顺序因此固定：先算伤害，再扣资源。
 */
export const ResourceScaledFormulaSchema = z
  .object({
    preset: z.literal("resource-scaled"),
    base: z.number(),
    perPoint: z.number(),
    resource: z.string().min(1),
  })
  .strict();

export const FormulaSchema = z.discriminatedUnion("preset", [
  FixedFormulaSchema,
  ScaledFormulaSchema,
  StackScaledFormulaSchema,
  ResourceScaledFormulaSchema,
]);

// ---------- 对比操作（条件用） ----------

const hasNumOp = (data: Record<string, unknown>): boolean =>
  ["eq", "ne", "gte", "lte", "gt", "lt"].some((k) => data[k] !== undefined);

// ---------- 条件 DSL（数组内 AND） ----------

export const FlagConditionSchema = z
  .object({
    flag: z.string().min(1),
    eq: z.union([z.string(), z.number(), z.boolean()]).optional(),
    ne: z.union([z.string(), z.number(), z.boolean()]).optional(),
    gte: z.number().optional(),
    lte: z.number().optional(),
    gt: z.number().optional(),
    lt: z.number().optional(),
  })
  .strict()
  .refine(hasNumOp, { message: "flag 条件需要至少一个比较操作" });

/**
 * 属性条件（ADR-003）。
 *
 * - 数值属性：`eq/ne/gte/lte/gt/lt` 全部可用；
 * - 文本属性（enum）：只有 `eq/ne`，值是选项 id；
 * - 阶梯属性：额外支持 `tier`（当前档位 id）；数值比较同样可用（按累计/本档数值）。
 *
 * 组合是 AND；至少一个操作。
 */
export const AttributeConditionSchema = z
  .object({
    attribute: z.string().min(1),
    eq: z.union([z.number(), z.string().min(1)]).optional(),
    ne: z.union([z.number(), z.string().min(1)]).optional(),
    gte: z.number().optional(),
    lte: z.number().optional(),
    gt: z.number().optional(),
    lt: z.number().optional(),
    /** 阶梯属性的当前档位 id（只在 kind=ladder 上合法，加载期校验）。 */
    tier: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (c) =>
      c.eq !== undefined ||
      c.ne !== undefined ||
      c.gte !== undefined ||
      c.lte !== undefined ||
      c.gt !== undefined ||
      c.lt !== undefined ||
      c.tier !== undefined,
    { message: "attribute 条件需要至少一个比较操作" },
  );

export const StatusConditionSchema = z
  .object({
    status: z.string().min(1),
    present: z.boolean().optional(),
    stacksGte: z.number().int().positive().optional(),
  })
  .strict();

export const InventoryConditionSchema = z
  .object({ inventory: z.string().min(1), gte: z.number().int().nonnegative() })
  .strict();

export const MoodConditionSchema = z
  .object({ mood: z.object({ gte: z.number().optional(), lte: z.number().optional() }).strict() })
  .strict();

/**
 * 关系条件（R2.6 / ADR-0014 扩展）。
 * ① 旧形态：`{ relation: npcId, gte, lte }` —— 读 NPC→玩家 标量 `npc.relationship`。
 * ② 关系边形态：声明 `kind` 时改读边 `(relation → to ?? 当前 self, kind)` 的 `value`
 *    （缺省 0）；`to` 缺省为**当前 self**（不是字面量玩家 id —— 扮演模板角色时
 *    那个节点叫角色 id）。`to` 只用来指向别人，例如「A 对 B 的敌意」。
 *
 * ⚠ 只匹配**事实边**：判定读的是权威 `state.relations`（`RelationEdgeSchema`，strict）。
 * 派生行（投影里 `derived: true` 的多跳亲缘，如「爷爷」那条 `kind: "relative"`）只随
 * `V2Snapshot` 下发，从不写进 `state.relations` —— 它是展示层的解释，不是事实。
 * 因此「他是我亲戚」不会满足「他是我的父亲」，哪怕两个称谓指的是同一个人；这里不需要
 * 任何额外判断，将来若要防回灌，应在**写入侧**拒绝，而不是在读取侧挂守卫。
 */
export const RelationConditionSchema = z
  .object({
    relation: z.string().min(1),
    gte: z.number().optional(),
    lte: z.number().optional(),
    kind: RelationKindSchema.optional(),
    to: z.string().min(1).optional(),
  })
  .strict();

export const RequiresSkillConditionSchema = z
  .object({ requiresSkill: z.string().min(1) })
  .strict();

/**
 * 当前 self（玩家正在扮演的演员）判定（2026-11-18 · 模板 branch 角色分派）。
 * self 永远是单值 ⇒ 同一节点的多个 `as` 变体天然互斥，不可能同时命中。
 * 服务模板侧 branch 的 node 级 `as` 语法：变体事件带 selfIs 条件，goto 到多变体节点时
 * 加载期展开成同形选项的 visibleWhen 门控（玩家只看到一条，不额外占轮次）。
 * `selfIsNot` 是对称的排除式判定：给**无 as 的兜底变体**用，表达「self 不是上述任何角色」，
 * 否则兜底会与 as 变体同时通过 trigger.conditions 而串戏。两者都只读 `selfIdOf(state)`。
 */
export const SelfIsConditionSchema = z.object({ selfIs: z.string().min(1) }).strict();
export const SelfIsNotConditionSchema = z.object({ selfIsNot: z.string().min(1) }).strict();

export const RandomConditionSchema = z
  .object({ random: z.number().min(0).max(1) })
  .strict();

/** 时间比较条件：以世界起始为 0 点，按 TimeAmount 偏移量比较当前世界时间。 */
export const TimeConditionSchema = z
  .object({
    time: z
      .object({
        gte: TimeAmountSchema.optional(),
        lte: TimeAmountSchema.optional(),
        gt: TimeAmountSchema.optional(),
        lt: TimeAmountSchema.optional(),
      })
      .strict()
      .refine((t) => [t.gte, t.lte, t.gt, t.lt].some((v) => v !== undefined), {
        message: "time 条件需要至少一个比较操作",
      }),
  })
  .strict();

/**
 * NPC 生命周期条件（ADR-0012 决策 1 / ADR-0020 落地）。
 * 只匹配**状态**，不匹配 `reasonCode`——「死人才能…」这类业务语义由模板用本条件组合表达，
 * 引擎不得对 reasonCode 分支。
 */
export const NpcStateConditionSchema = z
  .object({
    npcState: z
      .object({
        npcId: z.string().min(1),
        state: z.enum(["alive", "inactive", "unspawned"]),
      })
      .strict(),
  })
  .strict();

// ---------- anyMatch（ADR-075 §6） ----------

export const ANY_MATCH_COLLECTIONS = [
  "battle.enemies",
  "battle.allies",
  "battle.neutrals",
  "player.statuses",
  "player.inventory",
  "npcs",
  "relations",
] as const;
export type AnyMatchCollection = (typeof ANY_MATCH_COLLECTIONS)[number];

type AnyMatchFieldKind = "number" | "string" | "boolean";
const ANY_MATCH_FIELDS: Readonly<Record<AnyMatchCollection, Readonly<Record<string, AnyMatchFieldKind>>>> = {
  "battle.enemies": {
    ref: "string",
    name: "string",
    tier: "string",
    alive: "boolean",
    damageByPlayer: "number",
    damageToPlayer: "number",
    defeated: "boolean",
    killer: "boolean",
    summonedByPlayer: "boolean",
  },
  "battle.allies": {
    ref: "string",
    name: "string",
    tier: "string",
    alive: "boolean",
    damageByPlayer: "number",
    damageToPlayer: "number",
    defeated: "boolean",
    killer: "boolean",
    summonedByPlayer: "boolean",
  },
  "battle.neutrals": {
    ref: "string",
    name: "string",
    tier: "string",
    alive: "boolean",
    damageByPlayer: "number",
    damageToPlayer: "number",
    defeated: "boolean",
    killer: "boolean",
    summonedByPlayer: "boolean",
  },
  "player.statuses": {
    statusId: "string",
    kind: "string",
    stacks: "number",
    progress: "number",
  },
  "player.inventory": { itemId: "string", count: "number" },
  npcs: { id: "string", name: "string", lifecycle: "string", isEnemy: "boolean", visibility: "string" },
  relations: { from: "string", to: "string", kind: "string", value: "number", scope: "string", frozen: "boolean" },
};

const AnyMatchLiteralSchema = z.union([z.string(), z.number(), z.boolean()]);

export const AnyMatchPredicateSchema = z
  .object({
    field: z.string().min(1),
    eq: AnyMatchLiteralSchema.optional(),
    ne: AnyMatchLiteralSchema.optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    in: z.array(AnyMatchLiteralSchema).min(1).optional(),
  })
  .strict()
  .refine(
    (p) =>
      p.eq !== undefined ||
      p.ne !== undefined ||
      p.gt !== undefined ||
      p.gte !== undefined ||
      p.lt !== undefined ||
      p.lte !== undefined ||
      p.in !== undefined,
    { message: "anyMatch 谓词需要至少一个比较操作" },
  );
export type AnyMatchPredicate = z.infer<typeof AnyMatchPredicateSchema>;

export const AnyMatchSchema = z
  .object({
    over: z.enum(ANY_MATCH_COLLECTIONS),
    /** 全部谓词 AND；集合里任意一项满足即 true（按集合顺序短路，无随机）。 */
    where: z.array(AnyMatchPredicateSchema).min(1),
  })
  .strict()
  .superRefine((m, ctx) => {
    const fields = ANY_MATCH_FIELDS[m.over];
    m.where.forEach((pred, i) => {
      const kind = fields[pred.field];
      if (kind === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["where", i, "field"],
          message: `${m.over} 没有字段 ${pred.field}（白名单：${Object.keys(fields).join(" / ")}）`,
        });
        return;
      }
      const numericOps = (["gt", "gte", "lt", "lte"] as const).filter((k) => pred[k] !== undefined);
      if (kind !== "number" && numericOps.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["where", i, numericOps[0]!],
          message: `${pred.field} 是 ${kind}，不能用 ${numericOps.join("/")}`,
        });
      }
      if (pred.in !== undefined && kind === "boolean" && pred.in.some((v) => typeof v !== "boolean")) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["where", i, "in"], message: "布尔字段的 in 只接受 true/false" });
      }
      if (pred.in !== undefined && kind === "string" && pred.in.some((v) => typeof v !== "string")) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["where", i, "in"], message: "文本字段的 in 只接受字符串" });
      }
    });
  });
export type AnyMatch = z.infer<typeof AnyMatchSchema>;

export const ConditionSchema = z.union([
  FlagConditionSchema,
  AttributeConditionSchema,
  StatusConditionSchema,
  InventoryConditionSchema,
  MoodConditionSchema,
  RelationConditionSchema,
  RequiresSkillConditionSchema,
  SelfIsConditionSchema,
  SelfIsNotConditionSchema,
  RandomConditionSchema,
  TimeConditionSchema,
  NpcStateConditionSchema,
  AnyMatchSchema,
]);

/** 开放形条件（前向 seam）：引擎不解释，只做结构校验。 */
export const OpenConditionSchema = z
  .object({
    op: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();
export type OpenCondition = z.infer<typeof OpenConditionSchema>;

/**
 * 触发器 / 知识授予共用的条件联合：声明式扁平 DSL ∪ `{ op, args }` 开放形。
 * （原先的 guards / completion 条件已随 DAG 子系统一起删除。）
 */
/**
 * **模拟域**状态时长（ADR-018 D5）：世界时间的跨度。
 *
 * 单位复用 `TimeAmount`（与 `advanceBy` 完全同一套词表），不新造。
 * 为什么不是「回合数」：`turnIndex` 数的是**指针推进了几次**，与世界观时间流逝脱钩——
 * 一次事件结算可以 `advanceTo 4752 day` 而不推进一格状态。时长必须挂在世界时间上，
 * 到期判定才不需要任何地方补 tick（见 `StatusInstance.expiresAt`）。
 *
 * `{ untilCured: true }` 已退役：在「省略即语义」的口径下它是噪音——
 * 不写时长就是「直到被移除」，不需要一个令牌把这件事说第二遍。
 */
export const SimulationDurationSchema = TimeAmountSchema;
export type SimulationDuration = z.infer<typeof SimulationDurationSchema>;

/**
 * **战斗域**状态时长（ADR-018 D5）：只剩战斗回合一种，省略 = 整场。
 *
 * 不能复用模拟域那一支：战斗是槽内过程，`worldTime` 全程不动 ⇒ 按世界时间算永远不到期。
 * `{ untilBattleEnd }` 与 `{ value, unit }` 已退役：前者等于省略，后者是「战后还持续」的
 * 双时钟补丁 —— 那件事现在由状态定义上的 `toModifier` 单向折算承担。
 */
export const CombatDurationSchema = z
  .object({ rounds: z.number().int().positive() })
  .strict();
export type CombatDuration = z.infer<typeof CombatDurationSchema>;

export const TaskConditionSchema = z.union([ConditionSchema, OpenConditionSchema]);
export type TaskCondition = z.infer<typeof TaskConditionSchema>;

// ---------- 效果 DSL（声明式，引擎白名单实现） ----------

/**
 * 效果的作用对象（ADR-010 D2）。缺省 = 当前 self；给了 id 则作用于该演员。
 *
 * 这是「能力流转」的统一词：物品、状态、资源、技能、成长、属性调整全走它。
 * 目标必须是 `state.npcs` 里**存活**的人（加载期校验 id 已声明，运行期校验存活）；
 * 指向不存在或已离场的人时**静默无效** —— 不造人、不改别人、不抛错。
 */
const ActorTargetSchema = z.string().min(1).optional();

/**
 * `advanceTalent` 的增量（ADR-075 §7）。
 *
 * - 数字：模板直接给（事件奖励 / 阶奖励）；
 * - `statusStacks`：读战果里的战斗态层数（例如"每次觉醒最多算 3 层"），**只允许出现在战评 hooks**——
 *   世界效果没有战果上下文，写了就是静默 0。
 */
export const TalentAdvanceAmountSchema = z.union([
  z.number().int().positive(),
  z
    .object({
      metric: z.literal("statusStacks"),
      status: z.string().min(1),
      max: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type TalentAdvanceAmount = z.infer<typeof TalentAdvanceAmountSchema>;

export const EffectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setFlag"), id: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean()]) }).strict(),
  z.object({ type: z.literal("adjustFlag"), id: z.string().min(1), value: z.number() }).strict(),
  z.object({ type: z.literal("clearFlag"), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal("adjustAttribute"), attribute: z.string().min(1), value: z.number(), who: ActorTargetSchema }).strict(),
  /**
   * 绝对赋值（ADR-003）：数值属性写 number，文本属性写选项 id（如 `"fire"`）。
   * 文本值是否在 `defs[id].values` 内由加载期交叉校验；运行期再兜一次（可诊断）。
   */
  z
    .object({
      type: z.literal("setAttribute"),
      attribute: z.string().min(1),
      value: z.union([z.number(), z.string().min(1)]),
    })
    .strict(),
  /**
   * 资源增减：`hp` / `mp` 走同名字段，其余已在 `resources` 声明的自定义资源
   * 走 `state.player.resources`（ADR-003 D8）。
   */
  z.object({ type: z.literal("adjustResource"), resource: z.string().min(1), value: z.number(), who: ActorTargetSchema }).strict(),
  z.object({ type: z.literal("adjustMood"), value: z.number(), who: ActorTargetSchema }).strict(),
  /**
   * 改写玩家身份（性别 / 起始年龄 / 父母指针）。供「开局角色创建」在事件里定下性别与年龄——
   * 二者原本只能由 world.yaml 的 playerTemplate 静态声明，无法由玩家选择。
   * 改年龄时同步重置 playerAgeAtStart，保证之后按公历推进的年龄仍然正确。
   *
   * `fatherId` / `motherId` 是 ADR「开局父母指针」的可选扩展：同一个模板有多个开局、
   * 玩家可能扮演不同的人时，静态 playerTemplate 不能给每人写一套父母。缺省 = 不写，
   * 原样保留（不传就当"不详"，绝不把已有指针清空）。
   */
  z
    .object({
      type: z.literal("setIdentity"),
      /**
       * 名字（R-NAME-02 / ADR-001）：开局后改名 / 固定身份开局写权威名。
       * 只写传入字段；不传 = 保留原名（不清空）。空串拒载——空名统一由引擎写"无名氏"。
       */
      name: z.string().min(1).optional(),
      gender: z.string().min(1).optional(),
      age: z.number().int().nonnegative().optional(),
      fatherId: z.string().min(1).optional(),
      motherId: z.string().min(1).optional(),
    })
    .strict(),
  /**
   * **世界内加点**（ADR-019，2026-11-20）：挂一条待完成的分配请求。
   *
   * 它**不改任何属性** —— 只是把「你有 3 点可以分」这件事写进世界，等玩家在
   * 个人页面板里点确定（`POST /api/worlds/:id/allocation`，轮外，不推进回合）。
   * 为什么不直接 `adjustAttribute`：加点要玩家自己选，选完还要过一遍
   * 与开局同一套边界（预算 / 单项上下限 / 整数）。直接写属性等于替玩家做了选择。
   *
   * 同一时刻最多一条：再来一条会被拒（两笔一起挂，「点确定」只能靠猜）。
   */
  z
    .object({
      type: z.literal("grantAllocation"),
      id: z.string().min(1),
      budget: z.number().int().positive(),
      targets: z.array(AllocationTargetSchema).min(1),
      reason: z.string().min(1).optional(),
    })
    .strict(),
  /**
   * **推进成长型天赋**（ADR-075 §7）：唯一写入口，单调递增、夹 `progress.max`、不碰 RNG。
   *
   * `create: true` 表示"还没有就给一个"（成长型天赋第一次获得）；从 0 起算再加 `amount`，
   * 不会把 `progress.initial` 重复计一次。跨阶时按顺序结算各阶 `grant`（每阶一次）。
   */
  z
    .object({
      type: z.literal("advanceTalent"),
      talent: z.string().min(1),
      amount: TalentAdvanceAmountSchema,
      create: z.boolean().optional(),
    })
    .strict(),
  /**
   * **死亡信号**（ADR-075 §5.3）：把 hp 置 0 并落 `deathSignal`，由死亡路由决定
   * "直接结局"还是"再演一段事件"。它不直接终止 —— 终止是路由的事。
   *
   * 只该出现在事件 / 行动 / 世界效果里；战斗里判死归 `stake`，钩子效果是另一套闭集。
   */
  z.object({ type: z.literal("playerDeath"), reason: z.string().min(1).optional() }).strict(),
  /**
   * **观察者切换**（ADR-010 D4，2026-11-20 模板入口）。
   *
   * 只改「以谁的眼睛看」：关系可见性按它判、快照 `viewerId` 跟着变；
   * **不换人**（self 段、能力、数值一概不动）。换人控制走 `inheritActor` + 改 selfId。
   *
   * `actorId: null` = 回到自己。写非在场演员由加载期拒（`checkEffectRefs`）。
   */
  z.object({ type: z.literal("observeActor"), actorId: z.string().min(1).nullable() }).strict(),
  /**
   * **继承 / 夺舍 / 换身**（ADR-010 D7 的模板入口，2026-11-20）。
   *
   * `transplantActor` 一直是「切换角色的唯一通道」，但只作为纯函数存在 —— 模板里
   * 没有任何办法触发它。这条效果把它接上：`from` 的指定分组搬到 `to` 上，
   * **覆盖不是合并**（源没有的字段会被删掉，不留残影），`age` 不在任何分组里。
   *
   * 分组语义见 `ACTOR_FIELD_GROUPS`：
   * - `body`     体魄 / 属性 / 资源 / 状态 / 装备
   * - `mind`     技能 / 成长 / 知识 / 秘密
   * - `identity` 姓名 / 性别 / 出身
   * - `standing` 关系 / 声望 / 敌友 / 可见性
   *
   * 典型用法：老爵爷身故后，把 `identity + standing` 交给私生子（身体与本事留在原主身上）；
   * 夺舍则四组全搬。**不动 `selfId`** —— 换人控制仍要另改 `state.selfId`，
   * 这条效果只负责搬字段。
   */
  z
    .object({
      type: z.literal("inheritActor"),
      from: z.string().min(1),
      to: z.string().min(1),
      groups: z.array(z.enum(["body", "mind", "identity", "standing"])).min(1),
    })
    .strict(),
  /**
   * 换皮肤（2026-11-24 · 迭代 character-media）。
   *
   * - `who` 缺省 self；只能指向**已存在的、可写的人物实例**（`writableActorOf`），
   *   不存在 / 敌人等战斗临时单位 ⇒ 静默跳过（与 `inheritActor` 同策略）。
   * - `skinId: null` = 清除显式覆盖，回到 `skinRules` / `defaultSkin`。
   * - 只写 `skinId`，**不碰数值与身份**；皮肤必须属于该角色（加载期 `checkEffectRefs` 校验）。
   */
  z
    .object({
      type: z.literal("setSkin"),
      who: ActorTargetSchema,
      skinId: z.string().min(1).nullable(),
    })
    .strict(),
  /**
   * 关系调整（R2.6 / ADR-0014）。两种形态互斥，引擎侧校验：
   * ① 旧形态（兼容）：`{ npcId, value }` —— 调整 NPC→玩家 标量 `npc.relationship`。
   * ② 关系边形态：`{ fromId, toId, kind, value }` —— 对边值做增量调整；
   *    边不存在时按 `value` 建边（`scope` 缺省 `private`：当事人知道，外人不知道）。
   * 冻结边（一端已死亡）忽略调整。
   */
  z
    .object({
      type: z.literal("adjustRelation"),
      npcId: z.string().min(1).optional(),
      /** 边起点；`__self__` = 当前行动的 NPC */
      fromId: z.string().min(1).optional(),
      toId: z.string().min(1).optional(),
      kind: RelationKindSchema.optional(),
      /** 知情人范围（ADR-007 D3）；建新边时缺省 `private`。 */
      scope: RelationScopeSchema.optional(),
      /** `scope: limited` 的知情人名单。 */
      knownBy: z.array(z.string().min(1)).optional(),
      /** @deprecated 旧写法（R-OP-05）：`known`/`inferred` 视作 public，其余 private。 */
      visibility: RelationVisibilitySchema.optional(),
      value: z.number(),
    })
    .strict(),
  /** 显式建立关系边（已存在则合并，不重复；`frozen` 为单向棘轮）。 */
  z
    .object({
      type: z.literal("addRelationEdge"),
      fromId: z.string().min(1),
      toId: z.string().min(1),
      kind: RelationKindSchema,
      /** 知情人范围（ADR-007 D3）；缺省 `private`。 */
      scope: RelationScopeSchema.optional(),
      knownBy: z.array(z.string().min(1)).optional(),
      /** @deprecated 见 `adjustRelation`。 */
      visibility: RelationVisibilitySchema.optional(),
      value: z.number().min(-100).max(100).optional(),
      gap: z.boolean().optional(),
    })
    .strict(),
  /**
   * 往某个 NPC 的 `secrets` 追加一条隐秘（append-only）。
   * `npcId` 支持 `__self__`（当前行动的 NPC）；引擎按**文本**去重，重复追加静默跳过
   * （同一效果可能被模板多处命中，不该堆出重复隐秘）。
   */
  z
    .object({
      type: z.literal("addSecret"),
      npcId: z.string().min(1),
      text: z.string().min(1),
    })
    .strict(),
  /** 角色死亡时冻结与之相连的关系边（仍参与称谓推导，但不再被改动）。 */
  z.object({ type: z.literal("freezeRelationsOnDeath"), npcId: z.string().min(1) }).strict(),
  /**
   * 设置 NPC 生命周期状态（ADR-0012 决策 1/2，ADR-0020 落地）。
   * 复活 / 死亡 / 失联走同一入口，无特权通道。`reasonCode` 是模板自由字符串
   * （阵亡 / 叛逃 / 下落不明…），**引擎不对它分支**，只原样存下来供模板条件与投影展示。
   */
  /**
   * 依刷新规则实例建出 NPC（ADR-0010 决策 4 / R-LM-04 / ADR-0022）。
   * 只接受**规则 id**，不接受角色 id —— 触发权归模板事件效果，配置域定义不在运行时被拼装。
   * 重复调用同一 ruleId 幂等：已 spawned 则不做任何事（不重复建实例、不追加事实）。
   */
  z.object({ type: z.literal("spawnNpc"), ruleId: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal("setNpcLifecycle"),
      npcId: z.string().min(1),
      state: z.enum(["alive", "inactive", "unspawned"]),
      reasonCode: z.string().min(1).optional(),
    })
    .strict(),
  /**
   * 切换 NPC 在玩家人物列表里的可见性（2026-11-20）。
   * 与生命周期正交：`hidden` 的人照样活着、照样参与关系与自主行动，只是不上列表。
   * 用于叛逃线——此时夏油不再是「可拜访的 NPC」。
   */
  z
    .object({
      type: z.literal("setNpcVisibility"),
      npcId: z.string().min(1),
      visibility: z.enum(["public", "hidden"]),
    })
    .strict(),
  z.object({ type: z.literal("grantItem"), itemId: z.string().min(1), count: z.number().int().positive(), who: ActorTargetSchema }).strict(),
  z.object({ type: z.literal("removeItem"), itemId: z.string().min(1), count: z.number().int().positive(), who: ActorTargetSchema }).strict(),
  /**
   * 施加状态（模拟域）。**按 kind 必填时长**（ADR-018 D5）：
   *
   * - `modifier` ⇒ 必须写 `duration`（世界域没有「战斗结束」这个天然边界，
   *   静默给个默认值我们已经付过学费——`veil` 的 2 vs 3）；
   * - `talent` ⇒ **必须不写**（天赋没有时钟）；
   * - `battle` ⇒ 拒载（战斗态只能在战斗里产生）。
   *
   * schema 层只能是 optional（解析期看不到被引用状态的 kind），硬约束由加载期
   * 交叉校验承担，见 `world.ts` 的 `expectDurationFor`。
   */
  z
    .object({
      type: z.literal("applyStatus"),
      status: z.string().min(1),
      who: ActorTargetSchema,
      stacks: z.number().int().positive().optional(),
      duration: SimulationDurationSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("cureStatus"), status: z.string().min(1), who: ActorTargetSchema }).strict(),
  z.object({ type: z.literal("unlockSkill"), skillId: z.string().min(1), who: ActorTargetSchema }).strict(),
  z.object({ type: z.literal("adjustProficiency"), skillId: z.string().min(1), value: z.number(), who: ActorTargetSchema }).strict(),
  z.object({ type: z.literal("adjustGrowth"), value: z.number(), who: ActorTargetSchema }).strict(),
  /** 绝对推进目标（剧情节点），相对世界起始的偏移量；不倒退 */
  z.object({ type: z.literal("advanceTo"), value: TimeAmountSchema }).strict(),
  /** 相对推进量 */
  z.object({ type: z.literal("advanceBy"), value: TimeAmountSchema }).strict(),
  z.object({ type: z.literal("startChain"), chainId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("advanceChain"), chainId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("cancelChain"), chainId: z.string().min(1) }).strict(),
  /** 延时入队的唯一声明式通道（R-EV-08）；delay 缺省 = 相对入队时刻 0 分钟 */
  z
    .object({
      type: z.literal("enqueueEvent"),
      eventId: z.string().min(1),
      delay: TimeSpecSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("log"), text: z.string().min(1), visibility: z.enum(["public", "hidden"]) }).strict(),
]);

/** 内核效果 type 集合（从 `EffectSchema` 派生，不手抄名单）。 */
const KERNEL_EFFECT_TYPES: ReadonlySet<string> = new Set(
  EffectSchema.options.map((option) => option.shape.type.value),
);

/**
 * 开放形效果（模板边界专用）：`{ type }` + 任意其它字段，**由扩展自己解释**。
 *
 * 引擎不会解释它 —— `applyEffectsV2` 对白名单外的 type 走扩展分发，没命中就
 * `unknown_effect` 抛错。「这个 type 到底有没有人实现」由模板加载期扫描裁定
 * （`apps/server/src/templates.ts` 的 `unknown_effect_type`），不是 schema 的事。
 */
export const OpenEffectSchema = z.object({ type: z.string().min(1) }).catchall(z.unknown());
export type OpenEffect = z.infer<typeof OpenEffectSchema>;

/**
 * 模板侧效果联合：内核 27 种（闭合，strict）∪ 开放形（交给扩展）。
 *
 * 判别顺序有讲究：`OpenEffectSchema` 的 catchall 会吞下**任何**带 `type` 的对象，
 * 包括写错字段的内核效果（`{ type: "setFlag", id: "x" }` 少了 `value`）。所以命中
 * 开放形后还要按内核 type 复核一遍：type 属于内核白名单却过不了 `EffectSchema` ⇒
 * 仍然报错。否则一条漏字段的内核效果会被静默当扩展效果，运行期把 `undefined` 写进存档。
 */
export const TemplateEffectSchema = z
  .union([EffectSchema, OpenEffectSchema])
  .superRefine((effect, ctx) => {
    if (!KERNEL_EFFECT_TYPES.has(effect.type)) return;
    const strict = EffectSchema.safeParse(effect);
    if (strict.success) return;
    for (const issue of strict.error.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: issue.path,
        message: issue.message,
      });
    }
  });
export type TemplateEffect = z.infer<typeof TemplateEffectSchema>;

/**
 * 内核效果守卫：能过 `EffectSchema` 的才是**内核闭合形** `Effect`，开放形（扩展效果）
 * 一律 false。
 *
 * 用途只有一个：模板侧的类型是 `Effect ∪ 开放形`，而内核的加载期交叉引用校验
 * （`spawnNpc.ruleId` / `adjustRelation.with` 这类 id 是否存在、战斗内物品效果是否可结算…）
 * **只读得懂 27 种内核效果**。校验点第一行 `if (!isCoreEffect(e)) continue;` 跳过开放形，
 * 之后 `e` 已被窄化成 `Effect`，原来的 `switch` / 字段访问全部照旧可用。
 *
 * 别用 `as Effect` 代替：那会让写错字段的内核效果在校验层也静默通过，等于把 fail-fast
 * 拆了。扩展效果的合法性由**加载期词表扫描**（`apps/server/src/templates.ts` 的
 * `unknown_effect_type`）与扩展自己的 `schema` 负责，两处分工不重叠。
 */
export function isCoreEffect(effect: unknown): effect is Effect {
  return EffectSchema.safeParse(effect).success;
}

/**
 * T-00 开放注册位（前向 seam）：仅预留 Effect 类型扩展点，
 * 不改现有 24 个判别联合分支的语义、不为它重构。
 * 后续若要扩展 Effect 类型，把新分支的 `type` / 解析器登记进此表即可；
 * 当前引擎仍只消费 EffectSchema 的 z.discriminatedUnion（P0 零回归）。
 */
export interface EffectRegistration {
  readonly type: string;
  readonly parse: (raw: unknown) => unknown;
}
/** 可追加的 Effect 扩展注册表（P0 保持为空，供后续波次登记新分支）。 */
export const EFFECT_REGISTRY: EffectRegistration[] = [];

export type Condition = z.infer<typeof ConditionSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type Formula = z.infer<typeof FormulaSchema>;
export type TimeAmount = z.infer<typeof TimeAmountSchema>;
/** R2.6 起 TimeSpec = TimeAmount 对象 | 字符串字面量（复合时长 / 历法日期，ADR-0013） */
export type TimeSpec = z.infer<typeof TimeSpecSchema>;

/**
 * 战斗内每回合回复（ADR-003 D12）。
 *
 * 与 `regen.perTurn` 的区别：`perTurn` 是**自由行动轮**的结算，且在 schema 上强制
 * hp/mp 两项（引擎对它们有硬语义）；战斗内回复不强制任何键 —— 缺键就是 0，
 * 模板写 `{ beans: 1 }` 表示「每回合回 1 颗决意」，不写 hp 就是不回血。
 *
 * 值必须是非负数：战斗内没有「每回合掉血」的写法（持续伤害走状态的 `onRoundEnd`，
 * 那里能吃到攻击方属性与公式，语义不同，不能混）。
 */
/**
 * 单个资源的回复量（ADR-003 D12 追加）：`1` 或 `{ base: 1, perAttribute: { strength: 0.2 } }`。
 *
 * 加权用**基础属性**（与资源上限 `perAttribute` 同一口径）：回复量若随状态波动，
 * 「这回合回多少」会变成不可预期的数，玩家也无从校验。
 * 结果四舍五入到整数（资源本身就是整数）。
 */
export const RegenAmountSchema = z.union([
  z.number().nonnegative(),
  z
    .object({
      base: z.number().nonnegative(),
      perAttribute: z.record(z.string(), z.number()).optional(),
    })
    .strict(),
]);
export type RegenAmount = z.infer<typeof RegenAmountSchema>;

/**
 * 战斗内每回合回复（ADR-003 D12）：任意已声明资源 → 回复量，缺键 = 0。
 *
 * 与 `regen.perTurn` 的区别：`perTurn` 是**自由行动轮**的结算，且在 schema 上强制
 * hp/mp 两项（引擎对它们有硬语义）；战斗内回复不强制任何键。
 * 值必须非负：战斗内没有「每回合掉血」的写法（持续伤害走状态的 `onRoundEnd`）。
 */
export const CombatRegenSchema = z.record(z.string(), RegenAmountSchema);
