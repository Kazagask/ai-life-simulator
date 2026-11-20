import { z } from "zod";
import { TimeSpecSchema } from "../schema/common.js";
import { RelationKindSchema, RelationScopeSchema, RelationVisibilitySchema } from "../schema/relation.js";

/**
 * 提交分支的形状上限（2026-11-21）。
 *
 * **一份定义、三处引用**：schema 校验、工具描述里的「1..12 个事件块」、工具表的
 * `maxItems`。以前这三处各写各的数字，改一处就漂：模型按描述写 12 个、schema 只收 8 个
 * 时，整轮作废且没人知道为什么。
 */
export const BRANCH_MAX_NODES = 12;
/** 单个选项最多几条效果（`effects` 也用它做 `maxItems`）。 */
export const BRANCH_MAX_EFFECTS_PER_OPTION = 4;
/** 单个节点最多几个选项。 */
export const BRANCH_MAX_OPTIONS_PER_NODE = 4;
/** 一次提交最多新造几个 NPC。 */
export const BRANCH_MAX_GENERATED_NPCS = 4;
/**
 * 生成 NPC 的初始属性上限（引擎按此钳位）。
 *
 * 与模板的 `attributes.caps` 不同：这是**协议级**的可信边界（模型给的数字不可信），
 * 工具描述里的「钳到 [0,20]」也从这里取。
 */
export const GENERATED_NPC_ATTRIBUTE_MAX = 20;

/**
 * `story.submitBranch` 的入参（AGENTIC-GM 重构 · 设计 §4.2）。
 *
 * LLM 只表达三件事：**怎么触发、事件是什么、整条编排是什么**。
 * 槽 / 队列 / 候选池 / DAG / 权重这些是引擎规则，**不出现在这里**。
 *
 * 关键约束（引擎侧校验，不靠模型自觉）：
 * - `goto` 只能指向**本次提交内**的 `node`；跨提交一律拒。
 * - `node` 是本次提交内的**局部别名**，全局 id 由引擎分配（`gen:<invocationId>:<node>`），
 *   防止模型伪造引用。
 * - 选项 id 也由引擎分配。
 */
/**
 * 分支选项能带的效果：**三种扁平形状**，没有 `type`、没有嵌套。
 *
 * 为什么不用引擎那套 `EffectSchema`（24 变体判别联合、每个变体字段名都不同）：
 * 真实模型每写一次都要回忆一次字段表，实测反复写错（`{op,args}` / `{factRef,op,value}`
 * / `{type,id,value}` 三种混用），每次都让整轮作废。
 * 这里只暴露"作者真正会用的三个动作"，引擎编译时再映射回规范 Effect。
 */
/**
 * 分支内**新造**的 NPC（模板里没有定义的人）。
 *
 * 与模板 `spawnNpc {ruleId}` 的区别：那个是"把模板已定义、但还没登场的人拉出来"；
 * 这个是"现场造一个人"。两者**同一实例表、同一生命周期**，但来源不同：
 * - 模板源：定义在 `characters.yaml`，出生受 `npcSpawnRules` 管辖（幂等、可刷新）；
 * - 生成源：定义随分支一起提交，引擎校验后写入 `state.generatedCharacters`，
 *   实例以 `unspawned` 落表，由选项效果 `{spawn: alias}` 激活。
 *
 * 引擎只接受**展示所需的最小集**，其余字段按模板缺省填充 ——
 * 不让模型凭空指定 isEnemy / combatHints / knowledge 这类会影响规则判定的东西。
 */
export const GeneratedNpcSchema = z
  .object({
    /** 本次提交内的局部别名（引用它用，全局 id 由引擎分配） */
    alias: z.string().min(1).max(20),
    name: z.string().min(1).max(20),
    age: z.number().int().min(0).max(120).optional(),
    gender: z.string().min(1).max(20).optional(),
    /** 公开可见的性格描述 */
    personality: z.string().max(60).optional(),
    /** 玩家可见的目标 */
    knownGoals: z.array(z.string().max(40)).max(4).optional(),
    /** 引擎内部用的长期目标标签（不进投影） */
    goals: z.array(z.string().max(40)).max(4).optional(),
    /** 初始属性（只会采纳模板声明的属性键，值被钳到 [0, 20]） */
    attributes: z.record(z.string(), z.number()).optional(),
    /** 初始关系值（NPC→玩家，-100..100） */
    relationship: z.number().min(-100).max(100).optional(),
  })
  .strict();

export type GeneratedNpc = z.infer<typeof GeneratedNpcSchema>;

export const BranchEffectSchema = z.union([
  /** 置旗标（最常用：给分支留一个可观测痕迹） */
  z.object({ flag: z.string().min(1), value: z.union([z.boolean(), z.string(), z.number()]) }).strict(),
  /** 调心情 */
  z.object({ mood: z.number() }).strict(),
  /** 调资源（hp / mp） */
  z.object({ hp: z.number() }).strict(),
  z.object({ mp: z.number() }).strict(),
  /**
   * 让一个人**登场**。取值二选一：
   * - 本次提交里的 NPC 别名（`npcs[].alias`）⇒ 激活生成角色；
   * - 模板刷新规则 id（`npcSpawnRules[].id`）⇒ 走 `spawnNpc`，幂等、受规则管辖。
   * 引擎先查本次提交的别名，再查模板规则；都没有 ⇒ 拒绝（unknown_reference）。
   */
  z.object({ spawn: z.string().min(1) }).strict(),
  /** 调整某个角色与玩家的关系值 */
  z.object({ relation: z.object({ with: z.string().min(1), to: z.number().min(-100).max(100) }).strict() }).strict(),
  /** 改某个角色的生命周期（登场 / 离场） */
  z
    .object({
      lifecycle: z
        .object({
          npc: z.string().min(1),
          state: z.enum(["alive", "inactive", "unspawned"]),
        })
        .strict(),
    })
    .strict(),
  /**
   * 建立一条**关系边**（npc↔npc 或 npc↔player）。`from`/`to` 支持本次提交别名 /
   * `player` / 模板角色 id。
   *
   * **知情人范围用 `scope`**（ADR-007 D3）：`public` 大家都知道 / `limited` 名单内知道
   * （必须给 `knownBy`）/ `private` 仅当事人知道（缺省）。旧的四档 `visibility`
   * 仍接受但已废弃 —— 它和 `scope` 是同一件事的两套写法，模型只应该见到一套
   * （ADR-017 D1：写入口不再教一个新词）。
   *
   * 与 `{relation:{with,to}}` 的区别：那个只调 NPC→玩家**标量**，这个能建带 kind、
   * 带知情人范围的**有向边**，是关系图的主通道。
   */
  z
    .object({
      relationEdge: z
        .object({
          from: z.string().min(1),
          to: z.string().min(1),
          kind: RelationKindSchema,
          scope: RelationScopeSchema.optional(),
          /** `scope: limited` 的知情人名单（当事人不必列，判定时自动算在内）。 */
          knownBy: z.array(z.string().min(1)).optional(),
          /** @deprecated 用 `scope`；旧调用方仍可发，引擎按 `relationScopeOf` 折算。 */
          visibility: RelationVisibilitySchema.optional(),
        })
        .strict()
        .superRefine((edge, ctx) => {
          if (edge.scope === "limited" && (edge.knownBy ?? []).length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["knownBy"],
              message: "scope: limited 必须给 knownBy（否则没人看得到这条关系）",
            });
          }
        }),
    })
    .strict(),
  /** 往某个 NPC 的 `secrets` 追加一条隐秘（引擎按文本去重）。 */
  z
    .object({
      secret: z
        .object({
          npc: z.string().min(1),
          text: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
]);

export type BranchEffect = z.infer<typeof BranchEffectSchema>;

/**
 * `goto` 目标：字符串是「立刻切到该节点」的简写；对象形态可声明 `after`——
 * 即「这一幕结算之后再过 N 时间」才把后继放进队列（不占槽，中间可演别的）。
 */
export const BranchGotoSchema = z.union([
  z.string().min(1),
  z
    .object({
      node: z.string().min(1),
      /** 相对**上一幕结算时刻**的延迟（缺省 = 立刻）。 */
      after: TimeSpecSchema.optional(),
    })
    .strict(),
]);

export type BranchGoto = z.infer<typeof BranchGotoSchema>;

export const SubmitBranchOptionSchema = z
  .object({
    /** 选项文案（第二人称、动词开头） */
    text: z.string().min(1).max(120),
    /**
     * 该选项的效果（走模板同一套 effect 白名单校验）。
     *
     * 2026-11-21：空数组**不再是合法值**。实测模型会写 `effects: []`，玩家点下去什么
     * 都不发生 —— 看起来就是坏事件。省略仍然允许（旧存档 / 纯叙事选项的兼容路径），
     * 但一旦写了就必须至少一条：整条分支会被拒、模型在本轮内重试。
     */
    effects: z.array(BranchEffectSchema).min(1).max(BRANCH_MAX_EFFECTS_PER_OPTION).optional(),
    /** 指向**本次提交内**的另一个 node；缺省 = 到此为止 */
    goto: BranchGotoSchema.optional(),
  })
  .strict();

export const SubmitBranchNodeSchema = z
  .object({
    /** 局部别名，仅在本次提交内有效 */
    node: z.string().min(1).max(40),
    title: z.string().min(1).max(40),
    /** 事件正文（玩家在事件区看到的那段） */
    text: z.string().min(1).max(600),
    /**
     * **必须在场**的角色 id：引擎在呈现前复核存活/在场（防诈尸）。
     * 写进来的人如果已经死了 ⇒ 这一幕判错失，不会以"他还活着"的样子演出来。
     */
    actors: z.array(z.string().min(1)).max(6).optional(),
    /**
     * 仅**在正文里提到**、不要求在場的角色 id（可以是已故的人）。
     * 用于纪念 / 缅怀 / 遗物 / 墓前一类的戏 —— 逝者不该在场，但你确实要提他。
     */
    mentions: z.array(z.string().min(1)).max(6).optional(),
    /**
     * 这一幕要**拉上场**的人（SP1 的 LLM 源）：本次提交 alias / 模板角色 id /
     * 刷新规则 id 三选一。引擎在节点占槽呈现时执行（`alive` 幂等），与 `actors`
     * 的"必须在场"语义正交 —— 只拉上场，不额外判活。
     */
    npcs: z.array(z.string().min(1)).max(6).optional(),
    options: z.array(SubmitBranchOptionSchema).min(1).max(BRANCH_MAX_OPTIONS_PER_NODE),
  })
  .strict();

export const SubmitBranchArgsSchema = z
  .object({
    trigger: z
      .object({
        /**
         * **v1 不解释条件**：接受但忽略（`z.array(z.unknown())`）。
         *
         * 实测（glm-5.3）模型反复写错 condition DSL 形状 —— 这不该成为"整轮作废"的理由：
         * 分支什么时候触发，v1 由「触发器" + `mode` 决定就够了（`certain` = 尽快、
         * `random` = 进候选池）。条件触发等这一版跑顺再以**结构化**方式加回来，
         * 届时同步改工具描述与校验，而不是让模型猜。
         */
        conditions: z.array(z.unknown()).max(6).optional(),
        /**
         * `certain` = 条件满足即发生；`random` = 进候选池、按引擎节奏抽取。
         * 语义只到这一层——"池 / 权重 / 到期"是引擎内部实现，模型不感知。
         */
        mode: z.enum(["random", "certain"]),
        /**
         * 入口延迟（相对量）：提交后过多久这一幕才开演。缺省 = 尽快。
         * 声明后入口事件进延时队列、**不占槽**，中间可以继续演别的内容。
         */
        after: TimeSpecSchema.optional(),
      })
      .strict(),
    /** 本次提交**新造**的 NPC（模板里没有的人）；上限 4 个，避免一次灌一堆。 */
    npcs: z.array(GeneratedNpcSchema).max(BRANCH_MAX_GENERATED_NPCS).optional(),
    /** 整条编排：1..12 个事件块。单事件是 N=1 的退化形态。 */
    branch: z.array(SubmitBranchNodeSchema).min(1).max(BRANCH_MAX_NODES),
  })
  .strict();

export type SubmitBranchArgs = z.infer<typeof SubmitBranchArgsSchema>;
