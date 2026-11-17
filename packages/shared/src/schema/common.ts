import { z } from "zod";
import { RelationKindSchema, RelationVisibilitySchema } from "./relation.js";

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

/** 按施放者指定补正的层数缩放：base + stacks(status) * perStack（如漩涡按献祭咒灵数） */
export const StackScaledFormulaSchema = z
  .object({
    preset: z.literal("stack-scaled"),
    base: z.number(),
    perStack: z.number(),
    status: z.string().min(1),
  })
  .strict();

export const FormulaSchema = z.discriminatedUnion("preset", [
  FixedFormulaSchema,
  ScaledFormulaSchema,
  StackScaledFormulaSchema,
]);

// ---------- 对比操作（条件用） ----------

const numOps = {
  eq: z.number().optional(),
  ne: z.number().optional(),
  gte: z.number().optional(),
  lte: z.number().optional(),
  gt: z.number().optional(),
  lt: z.number().optional(),
};

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

export const AttributeConditionSchema = z
  .object({ attribute: z.string().min(1), ...numOps })
  .strict()
  .refine(hasNumOp, { message: "attribute 条件需要至少一个比较操作" });

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
 * ② 关系边形态：声明 `kind` 时改读边 `(relation → to ?? "player", kind)` 的 `value`
 *    （缺省 0）；`to` 缺省为玩家，便于表达「某 NPC 对玩家的师徒/敌意强度」。
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

export const ConditionSchema = z.union([
  FlagConditionSchema,
  AttributeConditionSchema,
  StatusConditionSchema,
  InventoryConditionSchema,
  MoodConditionSchema,
  RelationConditionSchema,
  RequiresSkillConditionSchema,
  RandomConditionSchema,
  TimeConditionSchema,
  NpcStateConditionSchema,
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
export const TaskConditionSchema = z.union([ConditionSchema, OpenConditionSchema]);
export type TaskCondition = z.infer<typeof TaskConditionSchema>;

// ---------- 效果 DSL（声明式，引擎白名单实现） ----------

export const EffectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setFlag"), id: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean()]) }).strict(),
  z.object({ type: z.literal("adjustFlag"), id: z.string().min(1), value: z.number() }).strict(),
  z.object({ type: z.literal("clearFlag"), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal("adjustAttribute"), attribute: z.string().min(1), value: z.number() }).strict(),
  z.object({ type: z.literal("adjustResource"), resource: z.enum(["hp", "mp"]), value: z.number() }).strict(),
  z.object({ type: z.literal("adjustMood"), value: z.number() }).strict(),
  /**
   * 改写玩家身份（性别 / 起始年龄）。供「开局角色创建」在事件里定下性别与年龄——
   * 二者原本只能由 world.yaml 的 playerTemplate 静态声明，无法由玩家选择。
   * 改年龄时同步重置 playerAgeAtStart，保证之后按公历推进的年龄仍然正确。
   */
  z
    .object({
      type: z.literal("setIdentity"),
      gender: z.string().min(1).optional(),
      age: z.number().int().nonnegative().optional(),
    })
    .strict(),
  /**
   * 关系调整（R2.6 / ADR-0014）。两种形态互斥，引擎侧校验：
   * ① 旧形态（兼容）：`{ npcId, value }` —— 调整 NPC→玩家 标量 `npc.relationship`。
   * ② 关系边形态：`{ fromId, toId, kind, value }` —— 对边值做增量调整；
   *    边不存在时按 `value` 建边（`visibility` 缺省 `unknown`，**不误建为 known**）。
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
  z.object({ type: z.literal("grantItem"), itemId: z.string().min(1), count: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("removeItem"), itemId: z.string().min(1), count: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("applyStatus"), status: z.string().min(1), stacks: z.number().int().positive().optional() }).strict(),
  z.object({ type: z.literal("cureStatus"), status: z.string().min(1) }).strict(),
  z.object({ type: z.literal("unlockSkill"), skillId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("adjustProficiency"), skillId: z.string().min(1), value: z.number() }).strict(),
  z.object({ type: z.literal("adjustGrowth"), value: z.number() }).strict(),
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
