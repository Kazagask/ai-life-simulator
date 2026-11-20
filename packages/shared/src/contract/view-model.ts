import { z } from "zod";
import { ResolvedStyleSchema, ResolvedTagSchema } from "../schema/style.js";
import { EffectSummarySchema, TurnGainSchema, type EffectSummary, type TurnGain } from "../schema/effects.js";

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

/**
 * 一条展示用效果（ADR-002 D3）。形状定义在 `schema/effects.ts`，这里只做前端契约别名，
 * 保证内核快照与前端视图**同一份**。
 */
export const EffectSummaryVMSchema = EffectSummarySchema;
export type EffectSummaryVM = EffectSummary;

/** 已装备的一件装备（只含展示字段；状态结果由内核每次结算现算，不下发）。 */
export const EquipmentVMSchema = z
  .object({
    instanceId: z.string(),
    itemId: z.string(),
    slot: z.string(),
    /** 槽位显示名（模板 `equipment.yaml`）；缺省时展示层回退 `slot` id。 */
    slotLabel: z.string().optional(),
    stacks: z.number().optional(),
    durability: z.number().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    category: z.string().optional(),
    /** 类别显示名（模板 `equipment.categories`）；缺省回退 `category` id。 */
    categoryLabel: z.string().optional(),
    quality: z.string().optional(),
    /** 解析后的样式（ADR-002 D2）；缺省 = 默认样式。 */
    style: ResolvedStyleSchema.optional(),
    /** 效果摘要（展示用）。 */
    effects: z.array(EffectSummaryVMSchema).optional(),
    /** 展示标签（ADR-002 D2b）：品级 / 增益减益等，带自己的样式。 */
    tags: z.array(ResolvedTagSchema).optional(),
  })
  .strict();
export type EquipmentVM = z.infer<typeof EquipmentVMSchema>;

/** 装备槽位定义：格子数 / 允许类别 / 摆位全部来自模板，前端不猜（R-EQ-15）。 */
export const EquipmentSlotVMSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    maxCount: z.number(),
    allowedCategories: z.array(z.string()),
    panelSide: z.enum(["left", "right", "bottom"]),
  })
  .strict();
export type EquipmentSlotVM = z.infer<typeof EquipmentSlotVMSchema>;

/** 背包里的一件物品。 */
export const InventoryItemVMSchema = z
  .object({
    itemId: z.string(),
    name: z.string(),
    description: z.string(),
    count: z.number(),
    usableOutsideBattle: z.boolean(),
    usableInBattle: z.boolean(),
    type: z.enum(["consumable", "material", "key", "equipment"]),
    slot: z.string().optional(),
    slotLabel: z.string().optional(),
    category: z.string().optional(),
    categoryLabel: z.string().optional(),
    quality: z.string().optional(),
    style: ResolvedStyleSchema.optional(),
    effects: z.array(EffectSummaryVMSchema).optional(),
    tags: z.array(ResolvedTagSchema).optional(),
  })
  .strict();
export type InventoryItemVM = z.infer<typeof InventoryItemVMSchema>;

/**
 * 技能封印（ADR-015）：技能**还在手**，但现在用不了，以及为什么。
 *
 * 与「技能不存在」是两件事，所以不能靠隐藏表达：式神死透了、祭品没了、场上站满了、
 * 咒力不够——这些都不是「你没学过这一招」。藏起来只会让玩家反复怀疑自己点错了，
 * 所以技能照常列出，靠 `seal` 说明原因。`code` 是机器可读的判据（引擎拒绝用的同一个），
 * `text` 是给玩家看的人话（由内核按模板取名，不在前端拼字符串）。
 */
export const SkillSealVMSchema = z
  .object({
    code: z.string(),
    text: z.string(),
  })
  .strict();
export type SkillSealVM = z.infer<typeof SkillSealVMSchema>;

/** 角色身上的一条状态 / 状态（玩家卡、NPC 卡、战斗面板共用同一形状，避免两处漂移）。 */
export const StatusVMSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    stacks: z.number(),
    /** 说明（状态详情浮层用）。 */
    description: z.string().optional(),
    quality: z.string().optional(),
    style: ResolvedStyleSchema.optional(),
    /** 效果摘要：属性状态 / 战斗面 / 控制语义。 */
    effects: z.array(EffectSummaryVMSchema).optional(),
    /** 展示标签（ADR-002 D2b）：品级 / 增益减益，带自己的样式。 */
    tags: z.array(ResolvedTagSchema).optional(),
    /** 正负（一等字段）：战斗面 / 技能描述的配色来源，不由 tags 推断。 */
    polarity: z.enum(["positive", "negative", "neutral"]),
    /**
     * 三类生命周期（ADR-018）：UI 按它分「天赋 / 状态」两栏。
     * `talent` 恒不叠层、无时长；`battle` 只在战斗面板出现，时长单位是回合。
     */
    kind: z.enum(["talent", "battle", "modifier"]),
    /** 持续时间的人话（「持续到被移除」/「剩余 3 回合」）。 */
    durationLabel: z.string().optional(),
  })
  .strict();
export type StatusVM = z.infer<typeof StatusVMSchema>;

/** 召唤物自带的一个技能（浮窗里一行一个）。 */
export const SummonSkillVMSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    style: ResolvedStyleSchema.optional(),
    effects: z.array(EffectSummaryVMSchema).optional(),
  })
  .strict();
export type SummonSkillVM = z.infer<typeof SummonSkillVMSchema>;

/**
 * 召唤物的**面板**（它是谁、带什么技能与状态）—— 不含技能参数。
 *
 * 单独一层是为了让「参数」和「面板」的归属在类型上就分开，
 * 但它们**必须一起下发**：只有一个的 `summon` 半残（链接没前缀 / 浮层打不开）。
 */
export const SummonUnitVMSchema = z
  .object({
    ref: z.string(),
    name: z.string(),
    tier: z.enum(["minion", "hero"]),
    description: z.string().optional(),
    // 不能退化成 `string[]`：浮窗要按技能展示各自的效果摘要。
    skills: z.array(SummonSkillVMSchema).default([]),
    /**
     * 召唤物身上**常驻的状态**（`characters[].statuses`，如魔虚罗的法轮）。
     * 被动不是技能：不列出来，玩家会以为「每回合回 25 点」是白送的。
     */
    statuses: z.array(StatusVMSchema).default([]),
  })
  .strict();
export type SummonUnitVM = z.infer<typeof SummonUnitVMSchema>;

/** 状态合计里的一笔来源（ADR-018 D8）：谁贡献了多少。 */
export const StatusTotalSourceSchema = z
  .object({
    name: z.string(),
    value: z.number(),
    /** 这一笔是几层叠出来的（>1 才下发）。 */
    stacks: z.number().optional(),
  })
  .strict();
export type StatusTotalSourceVM = z.infer<typeof StatusTotalSourceSchema>;

/**
 * 状态合计的一条通道（ADR-018 D8）。
 *
 * 属性通道的 `total` 是**真算出来的有效值减基础值**（含装备与心情），
 * 所以来源里可能出现一项「装备 / 心情」——那是残差，不是第二套算法。
 */
export const StatusTotalVMSchema = z
  .object({
    /** `attr:<属性>` / `combat:<键>` / `cost:<资源>` / `dot` / `control`。 */
    id: z.string(),
    label: z.string(),
    /** `attr` 数值 / `percent` 百分比 / `dot` 每回合伤害 / `control` 文本清单。 */
    format: z.enum(["attr", "percent", "dot", "control"]),
    total: z.number(),
    sources: z.array(StatusTotalSourceSchema).default([]),
  })
  .strict();
export type StatusTotalVM = z.infer<typeof StatusTotalVMSchema>;

/**
 * 一个召唤类技能的全部信息：**技能参数 + 召唤物面板一起下发**（2026-11-20 用户裁决）。
 *
 * 分成 `summonInfo` / `summonParams` 两个可选字段时，只给其一会让 UI 半残
 * （链接缺前缀、浮层打不开）。合成一个对象后，「有召唤」就只有一种形状。
 */
export const SummonVMSchema = z
  .object({
    /** 技能参数：一次召几只、这批多强。 */
    count: z.number(),
    levelScale: z.number().optional(),
    /** 召唤物面板。 */
    unit: SummonUnitVMSchema,
  })
  .strict();
export type SummonVM = z.infer<typeof SummonVMSchema>;

/** 已习得的技能（只有展示字段）。 */
export const SkillVMSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    kind: z.string(),
    quality: z.string().optional(),
    style: ResolvedStyleSchema.optional(),
    effects: z.array(EffectSummaryVMSchema).optional(),
    /** 召唤类技能：参数 + 召唤物面板一起给（描述里的加粗文字点开浮层）。 */
    summon: SummonVMSchema.optional(),
    /** 封印（ADR-015）：有值 ⇒ 这一招现在放不出来，`text` 就是原因。 */
    seal: SkillSealVMSchema.optional(),
  })
  .strict();
export type SkillVM = z.infer<typeof SkillVMSchema>;

/**
 * 一回合里的**一条**收获（ADR-002 D4）：由引擎「基线 + 差分」算出，只走响应、不落库。
 * 形状定义在 `schema/effects.ts`，这里只做前端契约别名。
 */
export const TurnGainVMSchema = TurnGainSchema;
export type TurnGainVM = TurnGain;

/**
 * 一条资源（ADR-003 D10）：战斗面板、玩家卡与状态栏共用。
 * `display` 决定条形 / 刻度；`dangerAt` 是告警阈值比例（0 = 永不告警）。
 */
export const ResourceVMSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    value: z.number(),
    max: z.number(),
    display: z.enum(["bar", "pips"]),
    dangerAt: z.number(),
  })
  .strict();
export type ResourceVM = z.infer<typeof ResourceVMSchema>;

/**
 * 玩家卡 / NPC 卡上的一条属性（ADR-003）。
 *
 * `kind` 决定渲染；`display` 是引擎解析好的展示文本（数字 / 选项 label / 档位 label / 称号），
 * 展示层不得自行查模板或把选项 id 印出来。
 */
export const AttributeSourceVMSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    display: z.string(),
    style: ResolvedStyleSchema.optional(),
  })
  .strict();
export type AttributeSourceVM = z.infer<typeof AttributeSourceVMSchema>;

export const PlayerAttributeVMSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    kind: z.enum(["number", "enum", "ladder", "composite"]),
    /** number/ladder 为数值；enum 为选项 id；composite 无。 */
    value: z.union([z.number(), z.string()]).optional(),
    /** 已解析的展示文本。 */
    display: z.string(),
    style: ResolvedStyleSchema.optional(),
    /** ladder：本档内进度（无下一档且无上限时缺省）。 */
    progress: z.object({ value: z.number(), max: z.number() }).strict().optional(),
    /** ladder：当前档位（label 已是玩家可见文案）。 */
    tier: z
      .object({ id: z.string(), label: z.string(), style: ResolvedStyleSchema.optional() })
      .strict()
      .optional(),
    /** composite：来源轴（如「恶名 ＋＋ · 善名 ＋＋」）。 */
    sources: z.array(AttributeSourceVMSchema).optional(),
  })
  .strict();
export type PlayerAttributeVM = z.infer<typeof PlayerAttributeVMSchema>;

export const NpcRelationVMSchema = z
  .object({
    withId: z.string(),
    /** 对方显示名（已解析；缺省时展示层回退 id）。 */
    withName: z.string().optional(),
    kind: z.string(),
    /** 这一行的称谓（「父亲」；扩展推导出来的行可能是「爷爷」「舅舅」这种具体叫法）。 */
    kindLabel: z.string(),
    /**
     * **边类型**的名字（`kind` 那一档的词，如「亲戚」），筛选与图例用。
     *
     * 与 `kindLabel` 分开的原因（2026-11-20）：扩展推导出的亲属行会把 `kindLabel`
     * 换成人话里的具体称谓（`relative` → 「爷爷」「舅舅」「叔公」各不同），
     * 拿它当类型标签会出现七个亲戚被压成一个「爷爷 7」。类型只有 `kind` 一档。
     */
    typeLabel: z.string().optional(),
    /**
     * 边的方向（2026-11-20）：`out` = 我视他为 X；`in` = 他视我为 X。
     *
     * NPC 卡只画出边（适配器已过滤）；**玩家关系图两个方向都画** ——
     * 「我认这个儿子」与「这个儿子认我」是两件事，图上的箭头就该分开。
     * 缺省按 `out` 兜底（旧数据里只有出边）。
     */
    direction: z.enum(["out", "in"]).optional(),
    /**
     * 知情人范围（ADR-007 D3）：`public` / `limited` / `private`。
     * 不是"玩家有多确信"，而是"这件事有多少人知道"——换视角时同一行照样成立。
     */
    scope: z.string(),
    /** 上面那一档的文案（「公开」「部分人知道」「仅当事人知道」），由适配器翻译。 */
    scopeLabel: z.string(),
    value: z.number().optional(),
    /** 亲缘称谓（「女儿」「孙女」…）；缺省表示这条边不是亲缘。 */
    kinshipTerm: z.string().optional(),
    /** 同一段亲缘的其它读法（模板打开 showAllRoles 时才有）。 */
    kinshipTerms: z.array(z.string()).optional(),
    /** 对方是否有可打开的档案（false ⇒ 不假装能点开一个人）。 */
    counterpartVisible: z.boolean().optional(),
    /**
     * 没有档案的**原因**（2026-11-19）：`unspawned` 尚未登场 / `hidden` 未现身 /
     * `enemy` 不在名册。缺省时展示层按 `unspawned` 兜底。
     *
     * 为什么不是一句「无档案」：玩家看到「惠的父亲 · 无档案」会以为系统缺数据，
     * 实际是「这个人在世上还没出场」。同一句「没有卡」，三种意思，得分开说。
     */
    counterpartState: z.enum(["unspawned", "hidden", "enemy"]).optional(),
    /** 上面那一档的文案（「尚未登场」「未现身」「不在名册」），由适配器翻译。 */
    counterpartStateLabel: z.string().optional(),
    /**
     * 关系档位文案（「亲近」「疏远」…），由适配器按 `value` 分档。
     *
     * 裸数值不上屏：`+32` 对玩家没有意义，还会让人以为在看一个可以刷的属性条。
     * `value` 仍下发（tooltip / 无障碍朗读 / 排序用），只是不再是主视觉。
     */
    valueLabel: z.string().optional(),
  })
  .strict();
export type NpcRelationVM = z.infer<typeof NpcRelationVMSchema>;
/**
 * 待完成的加点（ADR-019）：`label` / `style` 已在适配器按玩家属性视图补齐 ——
 * 面板只渲染，不再自己查模板。
 */
export const PendingAllocationVMSchema = z
  .object({
    id: z.string(),
    budget: z.number().int().nonnegative(),
    /** 为什么给这些点（「切磋之后」），展示用。 */
    reason: z.string().optional(),
    targets: z.array(
      z
        .object({
          attribute: z.string(),
          label: z.string(),
          min: z.number().optional(),
          max: z.number().optional(),
          style: ResolvedStyleSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type PendingAllocationVM = z.infer<typeof PendingAllocationVMSchema>;

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
     * 追加：资源条（ADR-003）。含 hp/mp 与自定义资源，顺序 = 模板 `statusBar` 的 resource 段。
     * 宿主用它渲染刻度 / 条形；hp/maxHp 等字段保留给只关心血蓝的老组件。
     */
    resources: z.array(ResourceVMSchema).default([]),
    /**
     * 追加：属性条。**顺序已在适配器按模板 `labels.attributes` 排好**，
     * 且 `proficiency*` 这类派生键已剔除 —— 排序与过滤是投影口径，不该散落到每个前端。
     */
    attributes: z.array(PlayerAttributeVMSchema),
    /**
     * 追加：**人生页人物卡**要展示的属性子集（2026-11-19）。
     *
     * 与 `attributes` 的关系：`attributes` 是全部可见属性（个人页用），这里是按
     * `ui.yaml playerCard.attributes` 过滤 + 排序后的子集；未声明该配置时两者相同。
     * 过滤放在适配器里做，自定义前端不必各自读 ui.yaml 再筛一遍。
     */
    cardAttributes: z.array(PlayerAttributeVMSchema).default([]),
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
    /**
     * 追加：状态合计（ADR-018 D8）。
     *
     * 「状态直接算总值、详情展示来源」：面板不再只列名字，玩家能看见
     * 「咒力 +3、伤害 +15%、咒力消耗 -90%」，点开是每一笔的来源。
     * 零值通道不下发。
     */
    statusTotals: z.array(StatusTotalVMSchema).default([]),
    /**
     * 玩家自己的关系（2026-11-20）：**两个方向都在**，`direction` 区分。
     *
     * 关系图（个人页「关系」）直接渲染这一份：节点 = 对端，边 = 这些行。
     * 以前玩家关系只能靠在 NPC 卡上反向看，本体缺这份投影。
     */
    relations: z.array(NpcRelationVMSchema).default([]),
    /** 待完成的加点（ADR-019）：有它 ⇒ 个人页挂出 `PointsAllocator`。 */
    pendingAllocation: PendingAllocationVMSchema.optional(),
    /**
     * 上面这份关系属于谁（`observeActor` 生效时才有；缺省 = 你）。
     * 展示层据此写「以 XX 的目光」——关系图换了主语，标题必须跟着换。
     */
    relationsOwner: z.object({ id: z.string(), name: z.string() }).strict().optional(),
    /** 追加：人生阶段 id / 显示名（显示名为空串表示模板没给文案，展示层不该印 id）。 */
    lifeStage: z.string(),
    lifeStageLabel: z.string(),
    /** 追加：已装备实例（与背包互斥：穿戴中的不在 inventory 里）。 */
    equipment: z.array(EquipmentVMSchema),
    /** 追加：背包（穿在身上的不在这里）。 */
    inventory: z.array(InventoryItemVMSchema),
    /** 追加：已习得技能。 */
    skills: z.array(SkillVMSchema),
  })
  .strict();
export type PlayerVM = z.infer<typeof PlayerVMSchema>;

/** 待决事件的一个选项（id 由引擎分配，提交时原样回传）。 */
export const EventOptionVMSchema = z
  .object({
    id: z.string(),
    text: z.string(),
  })
  .strict();
export type EventOptionVM = z.infer<typeof EventOptionVMSchema>;

export const SlotSceneVMSchema = z
  .object({
    eventId: z.string(),
    title: z.string(),
    /** 场景正文；稀疏参与时缺省，消费侧用 `narrative ?? ""` 兜底（不要回填 title）。 */
    narrative: z.string().optional(),
    /**
     * 追加：待决事件的可选项（服务端已按 `visibleWhen` 过滤，id 是引擎分配的真 optionId）。
     * 缺省表示这一格不是待决事件 / 没有选项；展示层按空数组处理，不要 `undefined.map`。
     */
    options: z.array(EventOptionVMSchema).optional(),
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
    /** 追加：命运偏离度（服务端原值，纯展示）。 */
    canonDeviation: z.number().optional(),
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
    /** 该块所属回合（ADR-002 D5）；展示层据此只给最新回合播打字机。 */
    turnIndex: z.number().optional(),
  })
  .strict();
export type ContentBlockVM = z.infer<typeof ContentBlockVMSchema>;

/**
 * 一条关系（NPC 卡与玩家关系图共用）。
 *
 * 方向由 `direction` 标明：NPC 卡在适配器里**滤出边**（这个人怎么看别人），
 * 玩家的关系图两个方向都要（`out` 实线朝外 / `in` 虚线朝内）。
 *
 * `kindLabel` / `typeLabel` / `scopeLabel` 由适配器翻译好 —— 关系词表与知情人范围词表
 * 是内核词汇，不该让每个前端各抄一份；`withName` 也已解析（含把玩家解析成「你」）。
 */


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
    /**
     * `relationship` 的档位文案（「深厚」「亲近」「平常」「疏远」「敌视」）。
     *
     * 裸数值不上屏（2026-11-19 用户裁决：「那个数值直接展示着，一点不明所以」）：
     * 玩家要判断的是"这个人跟我是哪一档"，不是"我有多少点"。原值仍在 `relationship`，
     * 进度条与 title 都用它。
     */
    relationshipLabel: z.string(),
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
    /** 渲染形态（ADR-003 D10）：条形 / 刻度；缺省按 bar 处理。 */
    display: z.enum(["bar", "pips"]).default("bar"),
  })
  .strict();
export type StatusBarVM = z.infer<typeof StatusBarVMSchema>;

/**
 * 战斗中的一条状态 —— 与玩家 / NPC 卡上的状态是**同一形状**，直接复用 `StatusVMSchema`。
 * 保留这个名字只为不打断既有引用（`BattleCombatantVMSchema` / `BattlePlayerVMSchema` 在用）。
 * 名字一律来自模板，展示层不自己造「眩晕」这类词；`stacks > 1` 时显示 ×N。
 */
export const BattleStatusVMSchema = StatusVMSchema;
export type BattleStatusVM = StatusVM;

/** 战斗中的一名参战者（只含展示字段：血量条 + 是否倒下 + 状态）。 */
export const BattleCombatantVMSchema = z
  .object({
    /** 战斗实例 id（同一模板角色换一场战斗就是另一个 id；UI 的目标选择键）。 */
    id: z.string(),
    name: z.string(),
    hp: z.number(),
    maxHp: z.number(),
    alive: z.boolean(),
    /** 追加：当前状态（与玩家一致，名字来自模板）。 */
    statuses: z.array(BattleStatusVMSchema),
    /**
     * 追加（ADR-012 D9）：专属资源池。只有声明过的角色才有条目
     * （术式储备这种「只有他会烧」的东西，不该在每个人头上画一条空槽）。
     */
    resources: z.array(ResourceVMSchema).default([]),
    /**
     * 追加：单位档位（ADR-012 D2）。`minion` 用三分之一宽的小框排版，`hero` 与真实战斗
     * 角色同版式。缺省 = `hero`（旧快照没有这个字段，而它们全是完整单位）。
     */
    tier: z.enum(["minion", "hero"]).optional(),
    /**
     * 阵营：**混合列表**（已退场名册）靠它决定边框色。
     * 普通列表按数组分阵营，前端不需要读它；缺省按友军兜底。
     */
    side: z.enum(["ally", "enemy", "neutral"]).optional(),
    /** 召唤者实例 id；有值说明这是召唤物，可以打开详情面板。 */
    summonedBy: z.string().optional(),
    /** 召它的角色 id（与召唤者实例 id 不是一回事）。 */
    summonRef: z.string().optional(),
    /** 退场原因（生命耗尽 / 被献祭 / 召唤者倒下）。 */
    deathReason: z.string().optional(),
    /** 召唤者名字（战斗卡只展示名字，不展示实例 id）。 */
    summonerName: z.string().optional(),
  })
  .strict();
export type BattleCombatantVM = z.infer<typeof BattleCombatantVMSchema>;

/** 战斗内可用技能（只下发展示与禁用判定要用的字段，不含效果数值）。 */
export const BattleSkillVMSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** 全量消耗（ADR-003 D9）：含自定义资源；缺省按空数组处理。 */
    costs: z
      .array(
        z.object({ resource: z.string(), label: z.string(), amount: z.number() }).strict(),
      )
      .default([]),
    cooldownLeft: z.number(),
    /**
     * 目标类型（ADR-012 D6 补）：前端据此决定「把哪个阵营的卡片当作可选目标」。
     * `ally` 是**单体**友军（旧实现在引擎里被当成全体，前端也从未传过友军 id）。
     */
    target: z.enum(["enemy", "self", "ally", "all_allies", "all_enemies", "none"]).default("enemy"),
    /**
     * 合法目标 id：只对需要点选的目标类型下发（缺省 = 这一招不接受单目标）。
     * 由引擎算出（`legalTargetsForPlayer`），前端只做 `includes`，不重算规则。
     */
    legalTargets: z.array(z.string()).optional(),
    /** 选中非法目标时的解释（DSL 的 `disableReason`），作悬停提示用。 */
    legalTargetNote: z.string().optional(),
    /**
     * 封印（ADR-015）：有值 ⇒ 按钮置灰并在按钮上写出原因（`text`）。
     * 面板**不再隐藏**用不了的技能——藏起来玩家只会以为自己点错了。
     */
    seal: SkillSealVMSchema.optional(),
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
    /** 玩家在战斗里的单位 id：前端「选自己」时把它当作友军单体目标传上去。 */
    id: z.string(),
    hp: z.number(),
    maxHp: z.number(),
    mp: z.number(),
    maxMp: z.number(),
    /** 战斗内资源条（含 hp/mp 与自定义资源；ADR-003 D10）。 */
    resources: z.array(ResourceVMSchema).default([]),
    /** 追加：当前状态（控制类状态的名字就是「无法行动」提示的来源）。 */
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
    /** 追加（ADR-012 D5）：第三方单位，对所有人敌对，不计入胜负。旧前端可忽略。 */
    neutrals: z.array(BattleCombatantVMSchema).default([]),
    /** 已退场单位（献祭 / 连带消失），点击可看原因。 */
    fallen: z.array(BattleCombatantVMSchema).default([]),
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
    /** 装备槽位定义（模板 projection）；未配置装备分域的世界为空数组 / 缺省。 */
    equipmentSlots: z.array(EquipmentSlotVMSchema).optional(),
    battle: BattleVMSchema.nullable(),
    ending: EndingVMSchema.nullable(),
    /** 是否存在待回程的 LLM 调用（稀疏参与标志，展示层可用于「叙事生成中」提示）。 */
    llmPending: z.boolean().optional(),
    /** 当前轮次（0 起的回合序号，原样来自快照）。 */
    turnIndex: z.number(),
    /**
     * 扩展命名空间（`docs/EXTENSIONS.md` §7）：宿主**原样搬运** `snapshot.extensions`
     * / 扩展快照片段，不解析、不映射、不校验（`unknown`）。各扩展自带的 UI 自己解释自己的切片。
     *
     * 缺省表示这个世界没有装任何带 UI 的扩展 ⇒ 宿主不渲染任何扩展页签。
     */
    extensions: z.record(z.string(), z.unknown()).optional(),
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
