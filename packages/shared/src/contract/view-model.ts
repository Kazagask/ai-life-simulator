import { z } from "zod";

/**
 * 视图模型（P0 → Wave 3 扩写）：自定义前端与 `@life-sim/rpg-ui` 之间**唯一**的展示契约。
 *
 * 设计红线（ADR-0034 / 解耦目标）：
 *  - 本文件只描述「屏幕上要显示什么」，**不 import 引擎快照类型**（`V2Snapshot` / `BattleView` …）；
 *    任何 `V2Snapshot → ViewModel` 的搬运只允许发生在纯适配器
 *    `packages/rpg-ui/src/adapter.ts` 里（自定义前端可复用）。
 *  - 所有 schema 一律 `.strict()`：前端组件只消费这里声明的字段，多出来的键视为契约破坏。
 *  - 字段扩写遵循**追加**原则：既有字段名与语义不变，新字段只增不改。
 */

/** 角色身上的一条状态 / 补正（玩家卡、NPC 卡、战斗面板共用同一形状，避免两处漂移）。 */
export const StatusVMSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    stacks: z.number(),
  })
  .strict();
export type StatusVM = z.infer<typeof StatusVMSchema>;

/** 玩家卡上的一条属性（`label` 来自模板 `labels.attributes`，数组顺序即展示顺序）。 */
export const PlayerAttributeVMSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    value: z.number(),
  })
  .strict();
export type PlayerAttributeVM = z.infer<typeof PlayerAttributeVMSchema>;

export const PlayerVMSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** 追加：岁数（卡头「19 岁 · 女」）。 */
    age: z.number(),
    /** 追加：性别显示名（模板给出，展示层不映射 gender 枚举）。 */
    genderLabel: z.string(),
    /** 追加：资源与心情（卡头三条资源条）。 */
    hp: z.number(),
    maxHp: z.number(),
    mp: z.number(),
    maxMp: z.number(),
    mood: z.number(),
    /** 追加：心情档位显示名（与数值一起显示成「心境 · 平和」）。 */
    moodBandLabel: z.string(),
    /**
     * 追加：属性条。**顺序已在适配器按模板 `labels.attributes` 排好**，
     * 且 `proficiency*` 这类派生键已剔除 —— 排序与过滤是投影口径，不该散落到每个前端。
     */
    attributes: z.array(PlayerAttributeVMSchema),
    /** 追加：资源与心情的显示名（模板 `labels`；`hp` / `mp` 的缺省回填已在适配器完成）。 */
    labels: z
      .object({
        hp: z.string(),
        mp: z.string(),
        mood: z.string(),
      })
      .strict(),
    /** 追加：当前状态（名字与层数来自模板）。 */
    statuses: z.array(StatusVMSchema),
  })
  .strict();
export type PlayerVM = z.infer<typeof PlayerVMSchema>;

export const SlotSceneVMSchema = z
  .object({
    eventId: z.string(),
    title: z.string(),
    /** 场景正文；稀疏参与时缺省，消费侧用 `narrative ?? ""` 兜底（不要回填 title）。 */
    narrative: z.string().optional(),
  })
  .strict();
export type SlotSceneVM = z.infer<typeof SlotSceneVMSchema>;

/** 五维评价的单个分项（分数与等级都是服务端原值，展示层不重算）。 */
export const EvaluationDimensionVMSchema = z
  .object({
    id: z.string(),
    /** 维度中文名（模板 label）；缺省时展示层回退 id。（注意与 line 一致：`label` 可选） */
    label: z.string().optional(),
    level: z.string(),
    score: z.number(),
    explanation: z.string().optional(),
  })
  .strict();
export type EvaluationDimensionVM = z.infer<typeof EvaluationDimensionVMSchema>;

export const EvaluationVMSchema = z
  .object({
    summary: z.string(),
    /** 追加：五维分项；评价尚未生成时缺省（此时整块不渲染）。 */
    dimensions: z.array(EvaluationDimensionVMSchema).optional(),
    /** 追加：加权总分（与分项同时给出，不取代分项）。 */
    overall: z.number().optional(),
    /**
     * 追加：这一局是否已「盖棺」（`terminated` / `archived`）。
     * 评价是盖棺定论 —— 跑动中整块不渲染，判据由适配器算好，展示层不读状态枚举。
     */
    ended: z.boolean().optional(),
  })
  .strict();
export type EvaluationVM = z.infer<typeof EvaluationVMSchema>;

export const MediaVMSchema = z
  .object({
    slot: z.string(),
    assetId: z.string(),
    url: z.string(),
    alt: z.string(),
  })
  .strict();
export type MediaVM = z.infer<typeof MediaVMSchema>;

export const ContentBlockVMSchema = z
  .object({
    blockId: z.string(),
    /** 内容块类型（narrative / option / flavor / asset / …）。展示层按已知值分支，未知值按正文处理。 */
    kind: z.string(),
    text: z.string().optional(),
    /**
     * `kind === "asset"` 时的资源引用（追加字段）：展示层据此在叙事流里内联一张媒体资源。
     * 服务端读投影已透传本字段与 `slot`（`apps/server/src/narrative/read.ts`）；缺省时
     * 内联渲染为空，展示层不得回退猜图。
     */
    assetId: z.string().optional(),
    /** 资源槽位名（追加字段），与 `MediaVM.slot` 同一套命名。 */
    slot: z.string().optional(),
  })
  .strict();
export type ContentBlockVM = z.infer<typeof ContentBlockVMSchema>;

/**
 * NPC 的一条关系（只含**出边**：这个人怎么看别人）。
 *
 * `kindLabel` / `visibilityLabel` 由适配器翻译好 —— 关系词表与可见性词表是内核词汇，
 * 不该让每个前端各抄一份；`withName` 也已解析（含把玩家解析成「你」）。
 */
export const NpcRelationVMSchema = z
  .object({
    withId: z.string(),
    /** 对方显示名（已解析；缺省时展示层回退 id）。 */
    withName: z.string().optional(),
    kind: z.string(),
    kindLabel: z.string(),
    visibility: z.string(),
    visibilityLabel: z.string(),
    value: z.number().optional(),
    /** 亲缘称谓（「女儿」「孙女」…）；缺省表示这条边不是亲缘。 */
    kinshipTerm: z.string().optional(),
    /** 同一段亲缘的其它读法（模板打开 showAllRoles 时才有）。 */
    kinshipTerms: z.array(z.string()).optional(),
    /** 对方是否有可打开的档案（false ⇒ 标「无档案」，不假装能点开一个人）。 */
    counterpartVisible: z.boolean().optional(),
  })
  .strict();
export type NpcRelationVM = z.infer<typeof NpcRelationVMSchema>;

export const NpcVMSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** 追加：岁数 / 性别 / 人生阶段显示名（卡头与标签用）。 */
    age: z.number(),
    genderLabel: z.string(),
    lifeStageLabel: z.string(),
    /** 追加：对玩家的关系值（-100..100，条长只是视觉辅助）。 */
    relationship: z.number(),
    /** 追加：性格一句话。 */
    personality: z.string(),
    /** 追加：已知目标（玩家可见的那部分）。 */
    knownGoals: z.array(z.string()),
    /** 追加：状态（与玩家卡同形状）。 */
    statuses: z.array(StatusVMSchema),
    /** 追加：属性（顺序即模板 `attributes.order`，标签已回填）。 */
    attributes: z.array(PlayerAttributeVMSchema),
    /** 追加：是否在世（非在世时卡片整体弱化）。 */
    alive: z.boolean(),
    /** 追加：生命周期原始态（`alive` / `inactive` / `unspawned`，作样式钩子）。 */
    lifeState: z.string(),
    /** 追加：生命周期文案（原因码优先，缺省回退状态词；已 trim）。 */
    lifeText: z.string(),
    /** 追加：关系出边（投影仍下发双向，出边过滤属投影口径）。 */
    relations: z.array(NpcRelationVMSchema),
  })
  .strict();
export type NpcVM = z.infer<typeof NpcVMSchema>;

/** 可执行动作（自由行动阶段由模板下发；战斗 / 待决事件时为空）。 */
export const ActionVMSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string(),
  })
  .strict();
export type ActionVM = z.infer<typeof ActionVMSchema>;

/**
 * 资源条（HP / MP …）。`label` 一律来自模板 `labels.resources`，展示层不得硬编码世界观用词；
 * `key` 是稳定标识（React key / 样式钩子），`max` 由适配器保证 ≥1。
 *
 * `tone` 由**适配器**按阈值算好（数值告警属于投影口径，不是配色偏好）：
 * 展示层只照 `tone` 上色，不再自己写 `value <= 25 ? …` 这类规则。
 */
export const StatusBarVMSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    value: z.number(),
    max: z.number(),
    tone: z.enum(["normal", "danger"]),
  })
  .strict();
export type StatusBarVM = z.infer<typeof StatusBarVMSchema>;

/**
 * 战斗中的一条补正 —— 与玩家 / NPC 卡上的状态是**同一形状**，直接复用 `StatusVMSchema`。
 * 保留这个名字只为不打断既有引用（`BattleCombatantVMSchema` / `BattlePlayerVMSchema` 在用）。
 * 名字一律来自模板，展示层不自己造「眩晕」这类词；`stacks > 1` 时显示 ×N。
 */
export const BattleStatusVMSchema = StatusVMSchema;
export type BattleStatusVM = StatusVM;

/** 战斗中的一名参战者（只含展示字段：血量条 + 是否倒下 + 补正）。 */
export const BattleCombatantVMSchema = z
  .object({
    /** 战斗实例 id（同一模板角色换一场战斗就是另一个 id；UI 的目标选择键）。 */
    id: z.string(),
    name: z.string(),
    hp: z.number(),
    maxHp: z.number(),
    alive: z.boolean(),
    /** 追加：当前补正（与玩家一致，名字来自模板）。 */
    statuses: z.array(BattleStatusVMSchema),
  })
  .strict();
export type BattleCombatantVM = z.infer<typeof BattleCombatantVMSchema>;

/** 战斗内可用技能（只下发展示与禁用判定要用的字段，不含效果数值）。 */
export const BattleSkillVMSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    costMp: z.number(),
    cooldownLeft: z.number(),
  })
  .strict();
export type BattleSkillVM = z.infer<typeof BattleSkillVMSchema>;

/** 战斗内可用道具。 */
export const BattleItemVMSchema = z
  .object({
    itemId: z.string(),
    name: z.string(),
    count: z.number(),
  })
  .strict();
export type BattleItemVM = z.infer<typeof BattleItemVMSchema>;

/** 战斗中的玩家资源镜像（以战斗态为准，不是存档态）。 */
export const BattlePlayerVMSchema = z
  .object({
    hp: z.number(),
    maxHp: z.number(),
    mp: z.number(),
    maxMp: z.number(),
    /** 追加：当前补正（控制类补正的名字就是「无法行动」提示的来源）。 */
    statuses: z.array(BattleStatusVMSchema),
    /** 追加：本场可用技能（`cooldownLeft > 0` ⇒ 前端置灰，引擎也会拒）。 */
    skills: z.array(BattleSkillVMSchema),
    /** 追加：本场可用道具（`count` 是剩余数量）。 */
    items: z.array(BattleItemVMSchema),
    /** 追加：本回合能否正常行动（`cannot_act` 压制时 false，引擎不报错只跳过）。 */
    canAct: z.boolean(),
    /** 追加：本回合能否使用道具（false ⇒ 引擎以 `bound_items` 拒绝）。 */
    canUseItems: z.boolean(),
    /** 追加：本回合能否逃跑（false ⇒ 引擎以 `flee_not_allowed` / `cannot_flee` 拒绝）。 */
    canFlee: z.boolean(),
  })
  .strict();
export type BattlePlayerVM = z.infer<typeof BattlePlayerVMSchema>;

/**
 * 战斗展示模型：只镜像默认 UI 需要的展示字段（参战者血量 / 回合 / 战报行），
 * **不复用** `V2Snapshot["battle"]` 的引擎类型（那里含技能、道具、控制判定等规则细节）。
 */
export const BattleVMSchema = z
  .object({
    round: z.number(),
    /** 战斗结束原因；进行中为 null。 */
    over: z.enum(["victory", "defeat", "flee"]).nullable(),
    player: BattlePlayerVMSchema,
    enemies: z.array(BattleCombatantVMSchema),
    allies: z.array(BattleCombatantVMSchema),
    /** 战报行（按发生顺序，已经是玩家可见文案）。 */
    log: z.array(z.string()),
  })
  .strict();
export type BattleVM = z.infer<typeof BattleVMSchema>;

/** 转盘的一个扇区（权重用于切分面积：玩家看到的概率就是真实概率）。 */
export const WheelSegmentVMSchema = z
  .object({
    label: z.string(),
    weight: z.number(),
  })
  .strict();
export type WheelSegmentVM = z.infer<typeof WheelSegmentVMSchema>;

/**
 * 随机转盘的结算结果（展示用）：服务端已经抽完，前端只负责把它转出来。
 * `label` 是命中扇区，`segments` 是全部扇区（含权重）。
 */
export const WheelVMSchema = z
  .object({
    eventId: z.string(),
    label: z.string(),
    segments: z.array(WheelSegmentVMSchema),
  })
  .strict();
export type WheelVM = z.infer<typeof WheelVMSchema>;

/** 结局摘要：隐藏结局的掩码文案由服务端给出，展示层只照抄，不反推原文。 */
export const EndingVMSchema = z
  .object({
    title: z.string(),
    summary: z.string(),
  })
  .strict();
export type EndingVM = z.infer<typeof EndingVMSchema>;

export const ViewModelSchema = z
  .object({
    player: PlayerVMSchema,
    npcs: z.array(NpcVMSchema),
    slot: SlotSceneVMSchema.nullable(),
    evaluation: EvaluationVMSchema,
    media: z.array(MediaVMSchema),
    content: z.array(ContentBlockVMSchema),
    /** 自由行动阶段的可选动作；战斗 / 待决事件 / 终局时为空数组。 */
    availableActions: z.array(ActionVMSchema),
    /** 历法显示文本（模板时间适配器生成，原样展示）。 */
    formattedTime: z.string(),
    /** 人生阶段 id（样式钩子 / 逻辑判断用）。 */
    lifeStage: z.string(),
    /** 人生阶段显示名（展示用，模板缺 label 时回退 id）。 */
    lifeStageLabel: z.string(),
    /** 章节进度：仅当模板使用章节机时存在，缺省表示不显示章节指示。 */
    storyChapter: z.number().optional(),
    /** 资源条（HP / MP，标签来自模板）。 */
    statusBar: z.array(StatusBarVMSchema),
    battle: BattleVMSchema.nullable(),
    ending: EndingVMSchema.nullable(),
    /** 是否存在待回程的 LLM 调用（稀疏参与标志，展示层可用于「叙事生成中」提示）。 */
    llmPending: z.boolean().optional(),
    /** 当前轮次（0 起的回合序号，原样来自快照）。 */
    turnIndex: z.number(),
  })
  .strict();
export type ViewModel = z.infer<typeof ViewModelSchema>;

/**
 * 玩家一次「行动提交」的文本上限（单一真源）。
 *
 * 服务端 `turnSchema.action.description` 与前端 `MAX_ACT_TEXT` 必须同源：此前服务端写 200、
 * dock 输入写 100、选项块不设限 ⇒ LLM 写出的长选项被点击后整轮 400（`invalid_body`）。
 * 前端只能 import `@life-sim/shared`（rpg-ui 源码守卫），所以常量必须住在这里 ——
 * 放在 `apps/server` 会逼前端复制一份，复制就必然漂移。
 */
export const TURN_ACTION_DESCRIPTION_MAX = 200;

/** 行动 id（`action.type`）长度上限，同为单一真源。 */
export const TURN_ACTION_TYPE_MAX = 40;
