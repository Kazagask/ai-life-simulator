import { z } from "zod";
import { QUALITY_TIER_IDS, isQualityTier } from "./style.js";
import {
  CombatRegenSchema,
  RegenAmountSchema,
  TaskConditionSchema,
  TemplateEffectSchema,
  LifeStageSchema,
  TimeAmountSchema,
  isCoreEffect,
} from "./common.js";
import { AttributeDefsSchema, AttributeValueSchema, isNumericAttributeKind, type AttributeKind } from "./attribute.js";
import { CharacterSchema, GenderDefSchema } from "./character.js";
import { PLAYER_ID, RelationDeclSchema } from "./relation.js";
import { SkillSchema } from "./skill.js";
import { ItemSchema } from "./item.js";
import { StatusEffectSchema } from "./status-effect.js";
import { NpcActionSchema } from "./npc-action.js";
import { ChainSchema, EventV2Schema } from "./event.js";
import { EquipmentConfigSchema, checkDynamicModifierSpec, type EquipmentSlot } from "./equipment.js";
import { CombatAiConfigSchema } from "./combat-ai.js";
import { BattleHookSchema, CritSpecSchema } from "./battle-hooks.js";
import { CombatEvaluationSchema, DeathRouteSchema, StakeSchema } from "./battle-evaluation.js";

/**
 * WorldTemplateV2 顶层聚合 Schema。
 * 除结构校验外，附带跨实体引用完整性校验（genders/attributes/statuses/events/enemies/skills）。
 */

/**
 * 资源上限公式：base + perLevel × growthLevel + Σ perAttribute[attr] × 基础属性值。
 * perAttribute 引用 attributes.order 中声明的**数值**属性（引用完整性见顶层 superRefine）。
 *
 * ADR-003 D8：`hp` / `mp` 之外可追加任意自定义资源；上限再受 `cap` 限制，
 * 初始值取 `initial`（缺省 = 上限）。显示形态（刻度/告警）在 `ui.yaml.resources`，不在这里。
 */
const ResourceDefSchema = z
  .object({
    base: z.number().nonnegative(),
    perLevel: z.number().nonnegative().default(0),
    perAttribute: z.record(z.string(), z.number()).optional(),
    /** 显示名（引擎日志与资源条缺省标签用；statusBar 段的 label 优先）。 */
    label: z.string().min(1).optional(),
    /** 上限硬顶（如「能量豆最多 5 个」）。 */
    cap: z.number().nonnegative().optional(),
    /** 初始值：缺省 = 上限；显式写 0 表示从空开始。 */
    initial: z.number().nonnegative().optional(),
  })
  .strict();

/** 回复量：hp/mp 仍必填（引擎有硬语义），其余资源可追加（catchall）；值可以是常数或按属性加权。 */
const RegenAmountsSchema = z
  .object({ hp: RegenAmountSchema, mp: RegenAmountSchema })
  .catchall(RegenAmountSchema);

const MoodBandSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    min: z.number(),
    max: z.number(),
    attributeModifiers: z.record(z.string(), z.number()),
  })
  .strict();

const MoodConfigSchema = z
  .object({
    min: z.number(),
    max: z.number(),
    defaultValue: z.number(),
    bands: z.array(MoodBandSchema).min(1),
  })
  .strict()
  .superRefine((m, ctx) => {
    const sorted = [...m.bands].sort((a, b) => a.min - b.min);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].min >= sorted[i].max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bands", i], message: "档位区间 min 必须小于 max" });
      }
      if (i > 0 && sorted[i].min <= sorted[i - 1].max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bands", i], message: "档位区间重叠" });
      }
    }
    if (sorted[0].min !== m.min || sorted[sorted.length - 1].max !== m.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bands"], message: "档位区间未覆盖 min..max 全域" });
    }
  });

const StatusBarSectionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    source: z.enum(["identity", "attribute", "resource", "mood", "status", "custom"]),
    key: z.string().min(1).optional(),
    keys: z.array(z.string().min(1)).optional(),
    visibleWhen: z.array(z.unknown()).optional(),
  })
  .strict();

const PlayerTemplateSchema = z
  .object({
    identity: z
      .object({
        gender: z.string().min(1),
        age: z.number().int().nonnegative(),
      })
      .strict(),
    mood: z.number().optional(),
    /** ADR-003：数值属性写 number，`enum` 属性写选项 id。 */
    attributes: z.record(z.string(), AttributeValueSchema),
    skills: z.array(z.string().min(1)).optional(),
    items: z
      .array(z.object({ itemId: z.string().min(1), count: z.number().int().positive() }).strict())
      .optional(),
    /**
     * 玩家也适用父/母指针（`extensions/family/doc/FAMILY-GRAPH.md` §3.1「玩家不是特例」）。
     * 指向 `characters[].id`，加载期校验引用完整性；缺省 = 不详（不编）。
     */
    fatherId: z.string().min(1).optional(),
    motherId: z.string().min(1).optional(),
    /**
     * 玩家**自己这边**的初始关系边（ADR-017 D2）。
     *
     * 从前只有 `characters[].relations`（from = 那个角色），玩家若不是复用某个角色，
     * 「你视他为何」就没有任何声明点 —— 关系图上只有指向你的边，没有从你出去的边。
     * 这里补齐：`from` 恒为 self，只写 `to` + `kind`（+ `scope` / `knownBy` / `gap`）。
     *
     * **不写 `value`**：强度是「A 视 B 多重」，你自己的观感由行为养成，开局不预设数字
     * （与 `to: player` 的边不许带 value 是同一条规则的两面，见 ADR-017 D1）。
     */
    relations: z.array(RelationDeclSchema).optional(),
  })
  .strict();

/**
 * R2.6 历法配置（ADR-0013）：三种时间模型切换。
 * - approx：固定分钟近似（1 月 = 30 天、1 年 = 365 天），= R2.5 现状，零迁移。
 * - gregorian：真实公历（月长 28–31、闰年）。
 * - custom：模板声明 months[]/leapRule/era（年号/纪元）。
 * 缺省视为 approx。
 */
export const CalendarConfigSchema = z
  .object({
    preset: z.enum(["approx", "gregorian", "custom"]),
    /** 自定义历/年号：显示用纪元名与纪元起点（世界分钟，可为负 = 世界开始前） */
    era: z.object({ name: z.string().min(1), epochStartMinute: z.number().int() }).optional(),
    /** 自定义历月定义（custom 必填） */
    months: z.array(z.object({ name: z.string().min(1), days: z.number().int().positive() })).optional(),
    leapRule: z.enum(["gregorian", "none"]).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.preset === "custom") {
      if (!c.months || c.months.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["months"], message: "custom 历法必须声明 months" });
      }
    }
    if (c.preset === "gregorian" && c.months && c.months.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["months"], message: "gregorian 不应声明 months（走真实公历）" });
    }
    if (c.months) {
      const total = c.months.reduce((s, m) => s + m.days, 0);
      if (total <= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["months"], message: "月份天数合计必须为正" });
    }
  });

/**
 * NPC 刷新规则（ADR-0010 决策 4 / R-LM-04 / ADR-0022 落地）。
 *
 * 配置层只声明「将来会有这个角色」；世界创建时把每条规则**实例化**为
 * `SpawnRuleInstance`（实例层、进存档），由 `spawnNpc(ruleId)` 效果真正把人拉上场。
 *
 * **登场时点不写在这里**（ADR-007 D1）：什么时候登场是「世界的时间表」，
 * 写在 `scheduledFacts` 里的一条 `{ type: spawnNpc, ruleId }` 效果上。
 * 本 schema 因此只剩「这个人是谁、登场时几岁」—— 规则对象不再自带触发条件，
 * 时间线只有一处真源（旧字段 `when` 已随 ADR-007 删除）。
 */
export const NpcSpawnRuleSchema = z
  .object({
    id: z.string().min(1),
    /** 目标角色 id（必须在 characters 中声明且非敌人） */
    characterRef: z.string().min(1),
    /** 出生/登场时的年龄；缺省沿用 `characterRef.identity.age`。0 = 新生儿 */
    age: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * 世界自己的时间表（ADR-007 D1）：到点就发生的事实，**不占事件槽、不等玩家点头**。
 *
 * 解决的问题：在这之前，「世界自己往前走」只有两条腿 ——
 * 要么写成事件（占槽、要玩家选、错过就永远不补），要么硬编码进引擎（`spawnNpc` 的
 * `when` 就是这种局部特例）。结果是同一件事（如「某人在某年收下一个弟子」）被塞进剧情链，
 * 玩家没走到那一步，世界就停在错的年份。
 *
 * 语义：
 * · `when` 每轮 tail 求值一次，全部满足 ⇒ 执行 `effects`，并在 `state.facts` 里记一条
 *   （append-only，一事实只发生一次）；此后永不重复。
 * · 时间只由世界时钟推进（`advanceTo` 跳年也照常补齐），与玩家有没有选择无关。
 * · `effects` 是**完整**的内核效果表：spawnNpc / addRelationEdge / setFlag /
 *   adjustAttribute / setNpcLifecycle …—— 同一套效果，不另立语法。
 * · 不进历史条目、不弹窗：玩家看到的是它的**后果**（人物卡上多了一个人、
 *   关系行上多了一条「某人视谁为弟子」），而不是一条"系统通知"。
 */
export const ScheduledFactSchema = z
  .object({
    id: z.string().min(1),
    /** 作者注：这条事实在讲什么（只出现在后台编排图，不进玩家端）。 */
    note: z.string().min(1).optional(),
    /**
     * **玩家可见**的一句话（2026-11-19 用户裁决）。
     *
     * 世界事实不经过玩家，所以它天然没有「本轮收获」——某个角色在后续年份学会新技能，
     * 玩家那回合可能只是在修炼。但「你看不到」不等于「不该告诉你」：这条消息写进
     * 编年史（`history` 的 `world` 类），读起来就是「远方传来的事」。
     *
     * 与 `note` 严格分开：`note` 是写给作者看的（含「为什么写在时间表而不是事件」这种
     * 设计注释，直接上屏会穿帮）；`tidings` 是写给玩家看的，会被原样当成正文。
     * 不写 ⇒ 这条事实是纯状态修改，不上屏（旧模板零改动）。
     */
    tidings: z.string().min(1).optional(),
    /** 生效条件；时间条件是常规写法（`{ time: { gte: … } }`），也允许叠剧情前提。 */
    when: z.array(TaskConditionSchema).min(1),
    effects: z.array(TemplateEffectSchema).min(1),
  })
  .strict();

export const WorldTemplateV2Schema = z
  .object({
    meta: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        description: z.string().min(1),
        startYear: z.number().int(),
        engineProtocol: z.literal("v2"),
        /**
         * 隐藏模板（2026-11-20）：不在 `GET /api/templates` 里出现，但**仍可用 id 建局**。
         *
         * 用途是测试田与半成品：玩家不该在选模板时看到它，
         * 但作者要能用 curl / 脚本起一个局。做成模板字段而不是服务端开关，
         * 是因为「哪个模板是测试田」属于模板自己的性质，不该由部署环境决定。
         *
         * 不进语义指纹：它只影响列表可见性，不改变任何投影或判定。
         */
        hidden: z.boolean().optional(),
      })
      .strict(),
    /**
     * 扩展声明（`docs/EXTENSIONS.md` §3）：键 = 扩展 id，出现即启用。
     *
     * · **值**：`true`（用扩展的默认配置）或一个对象（交给扩展自己的 schema 校验）。
     * · **不声明 ⇒ 扩展不跑**，哪怕它的包就装在那儿 —— 这是「卸载全部扩展后投影零回归」的落点。
     * · 某个 id 在已注册 runtime 里找不到 ⇒ 模板拒载（`unknown_extension`），由 `apps/server` 加载器判定。
     *
     * 语义指纹：整个 `extensions:` 段进指纹（`config` 会改变投影内容，如 `maxHops`）。
     */
    extensions: z
      .record(
        z.string().min(1),
        z.union([z.literal(true), z.record(z.string(), z.unknown())]),
      )
      .optional(),
    /**
     * 运行包版本声明（`docs/EXTENSIONS.md` §3.1）：这个世界是按哪版主包 / 哪版扩展写的。
     * `core` 省略 ⇒ 不校主包版本（老模板零回归）；`extensions` 的键必须都在
     * `extensions:` 里声明过，且已装 runtime 的版本必须满足给定区间，否则加载期拒载。
     * 版本号字符串格式见 `satisfiesVersion()`（精确 / ^ / >= / *）。
     *
     * 语义指纹：进指纹（换扩展版本会改变投影语义，旧档必须拒载）。
     */
    requires: z
      .object({
        core: z.string().min(1).optional(),
        extensions: z.record(z.string().min(1), z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    time: z
      .object({
        defaultStep: TimeAmountSchema,
        lifeStageSteps: z.record(z.string(), TimeAmountSchema).optional(),
        /** 人生阶段阈值（按 maxAge 升序；最后一档可省略 maxAge 表示无上界）。缺省时引擎回退到旧固定阈值。 */
        lifeStages: z.array(LifeStageSchema).optional(),
        /** R2.6 历法配置（ADR-0013）：缺省 approx（= 现状固定分钟近似），零迁移。 */
        calendar: CalendarConfigSchema.optional(),
      })
      .strict()
      .superRefine((t, ctx) => {
        const stages = t.lifeStages ?? [];
        for (let i = 1; i < stages.length; i++) {
          const prev = stages[i - 1].maxAge;
          const cur = stages[i].maxAge;
          if (prev !== undefined && cur !== undefined && cur <= prev) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["lifeStages", i, "maxAge"],
              message: "人生阶段 maxAge 必须严格递增",
            });
          }
        }
      }),
    genders: z.array(GenderDefSchema).min(1),
    mood: MoodConfigSchema,
    statusBar: z.array(StatusBarSectionSchema).min(1),
    attributes: z
      .object({
        order: z.array(z.string().min(1)).min(1),
        /** 值类型按 `defs[id].kind` 校验（enum 写选项 id；number/ladder 写数值）。 */
        defaults: z.record(z.string(), AttributeValueSchema),
        caps: z.record(z.string(), z.number()).optional(),
        /**
         * 属性显示名（玩家可见，如 strength → "力量"）。
         * 引擎与前端一律经此取显示名，不得在代码里硬编码世界观专名；缺省回退属性 id。
         */
        labels: z.record(z.string(), z.string().min(1)).optional(),
        /**
         * 属性类型声明（ADR-003）：缺省 = 全部 `number`（旧模板零迁移）。
         * 键必须是 `order` 的子集；各 kind 的结构校验由 `AttributeDefSchema` 完成，
         * 交叉引用（defaults / 角色初始值 / 数值面）在顶层 superRefine。
         */
        defs: AttributeDefsSchema.optional(),
      })
      .strict(),
    resources: z
      .object({ hp: ResourceDefSchema, mp: ResourceDefSchema })
      // ADR-003 D8：hp/mp 必填，之后可追加任意自定义资源（如 beans）。
      .catchall(ResourceDefSchema),
    /**
     * 召唤名额（ADR-012 D2 修订，2026-11-20 用户裁决）：**世界维度的规则，按档共享**。
     *
     * 所有英雄档召唤物共用 `hero` 个位置、所有杂兵共用 `minion` 个位置 ——
     * 不是「玉犬 1 个、円鹿 1 个」各算各的；技能只声明「一次几只」（`count`）
     * 与「这批多强」（`levelScale`），不声明名额。
     * 缺省 minion 3 / hero 1（唯一缺省表在 `SUMMON_TIER_LIMITS`）。
     */
    summonLimits: z
      .object({
        minion: z.number().int().positive().optional(),
        hero: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    /**
     * 战斗的**世界级**规则（ADR-073）。缺省 = 没有暴击、没有钩子 ——
     * 引擎不写死任何数值，旧模板零迁移。
     */
    combat: z
      .object({
        /** 全局暴击默认值（与状态/技能的 `crit` 同形累加）。 */
        crit: CritSpecSchema.optional(),
        /** 世界规则的钩子：对**所有**战斗生效（这是世界现象，不是某个人的特质）。 */
        hooks: z.array(BattleHookSchema).optional(),
        /**
         * 战败赌注（ADR-075 §1）。内置 `spar / hard / deaths`；模板按 key 覆盖，
         * `defaultStake` 决定没写 `stake` 的战斗按哪一档算。
         */
        stakes: z.record(z.string().min(1), StakeSchema).optional(),
        /** 缺省 `deaths`（ADR-075 用户裁决：默认硬核）。 */
        defaultStake: z.string().min(1).optional(),
        /** 战评（ADR-075 §2）；缺省 = 没有评价与钩子。 */
        evaluation: CombatEvaluationSchema.optional(),
      })
      .strict()
      .optional(),
    regen: z
      .object({
        perTurn: RegenAmountsSchema,
        actions: z.record(z.string(), RegenAmountsSchema).optional(),
        /**
         * ADR-003 D12：战斗内**每回合结束**的回复（任意已声明资源，缺键 = 0）。
         * 与 `perTurn` 分开：战斗轮不走自由行动管线，两套节奏不能共用一份配置。
         */
        combat: CombatRegenSchema.optional(),
      })
      .strict(),
    characters: z.array(CharacterSchema),
    playerTemplate: PlayerTemplateSchema.optional(),
    /** 玩家行动定义（action-hook 事件的 onActionId 引用此处） */
    actions: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().min(1),
            description: z.string().optional(),
            duration: TimeAmountSchema.optional(),
            /** 绝对推进目标（剧情节点）：相对世界起始的偏移量；存在时忽略 duration，将世界时间直接推进到该目标（不倒退）。 */
            advanceTo: TimeAmountSchema.optional(),
            effects: z.array(TemplateEffectSchema).optional(),
          })
          .strict(),
      )
      .optional(),
    skills: z.array(SkillSchema),
    items: z.array(ItemSchema),
    /** 装备分域（协议 V2.1 §19，可选；equipment.yaml，未提供时引擎行为不变） */
    equipment: EquipmentConfigSchema.optional(),
    /** 战斗 AI 分域（协议 V2.1 §20，可选；combat-ai.yaml，未映射的敌人保持既有简单权重路径） */
    combatAi: CombatAiConfigSchema.optional(),
    statuses: z.array(StatusEffectSchema),
    events: z.array(EventV2Schema),
    chains: z.array(ChainSchema).optional(),
    /** NPC 自主行动定义（A6：触发式 + 效用评分） */
    npcActions: z.array(NpcActionSchema).optional(),
    /** NPC 刷新规则（ADR-0022；世界创建时实例化为 SpawnRuleInstance，由 spawnNpc 效果触发） */
    npcSpawnRules: z.array(NpcSpawnRuleSchema).optional(),
    /**
     * 世界自己的时间表（ADR-007 D1）：到点就发生的事实。
     *
     * 与 `npcSpawnRules` 的分工：那里只声明「将来会有这个人」，这里声明「哪天发生什么」。
     * 可选 ⇒ 旧模板零改动可载（无 `scheduledFacts` = 世界没有自主时间表）。
     */
    scheduledFacts: z.array(ScheduledFactSchema).optional(),
    /**
     * 死亡路由（ADR-075 §5）：**死亡结局的唯一权威**。声明顺序即优先序，首个命中；
     * 必须有 `when: []` 兜底。`endings.triggerConditions` 不参与死亡选择。
     */
    deathRoutes: z.array(DeathRouteSchema).optional(),
    /**
     * 事件流阈值（ADR-0034 §3-6 / §8-⑨）：控制主循环 pool 抽取的触发条件。
     * 全部**可选 + 默认值** ⇒ 既有模板零改动即可跑（默认 `skipWhenSlotOccupied: true`、
     * `maxQueueLength: 3`）。语义：`slot !== null || delayQueue.length >= maxQueueLength` ⇒ 本轮不摇。
     *
     * 注意（ADR-0034 §10）：这里限制的是**「摇出事件这个判断」**，不是"pool 血统的事件链不占槽"——
     * 被摇出的事件进队列后与普通事件完全等价，它自己的 `nextEventId` 后继照常可以占槽。
     */
    eventFlow: z
      .object({
        poolDraw: z
          .object({
            skipWhenSlotOccupied: z.boolean().default(true),
            maxQueueLength: z.number().int().nonnegative().default(3),
          })
          .strict()
          .default({ skipWhenSlotOccupied: true, maxQueueLength: 3 }),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((w, ctx) => {
    // 全库 id 唯一（跨文件合并后仍成立）
    const idGroups: Array<[string, { id: string }[]]> = [
      ["characters", w.characters],
      ["skills", w.skills],
      ["items", w.items],
      ["statuses", w.statuses],
      ["events", w.events],
      ["chains", w.chains ?? []],
    ];
    for (const [group, list] of idGroups) {
      const seen = new Map<string, number>();
      list.forEach((entity, i) => {
        const first = seen.get(entity.id);
        if (first !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [group, i, "id"],
            message: `重复 id：${entity.id}（已用于 ${group}[${first}]）`,
          });
        } else {
          seen.set(entity.id, i);
        }
      });
    }

    const genderIds = new Set(w.genders.map((g) => g.id));
    const attributeIds = new Set(w.attributes.order);
    /**
     * ADR-003：属性类型。没有 defs 的属性一律 number（旧模板零迁移）。
     * 数值面（公式 / caps / 状态 / 资源公式）只接受 number / ladder。
     */
    const defs = w.attributes.defs ?? {};
    const kindOf = (id: string): AttributeKind => defs[id]?.kind ?? "number";
    const isNumericAttr = (id: string): boolean => isNumericAttributeKind(kindOf(id));
    const enumValuesOf = (id: string): ReadonlySet<string> | undefined => {
      const def = defs[id];
      return def?.kind === "enum" ? new Set(def.values.map((v) => v.id)) : undefined;
    };
    /**
     * 派生属性（ADR-074）：只读、按依赖顺序现算、不落存档。
     *
     * 加载期做三件事，缺一不可：
     * 1. 依赖必须存在且是数值属性（写 enum 会算出 NaN）；
     * 2. **拒绝循环依赖**（a←b←a）—— 运行期没有「先算谁」的答案；
     * 3. 派生属性不能出现在任何**写点**（defaults / 角色 / 开局 / setAttribute / adjustAttribute）。
     */
    interface DerivedSpecLocal {
      base?: number;
      from: { attribute: string; perPoint: number }[];
      min?: number;
      max?: number;
    }
    const derivedSpecs = new Map<string, DerivedSpecLocal>();
    for (const [id, def] of Object.entries(defs)) {
      if (def.kind === "number" && def.derived !== undefined) {
        derivedSpecs.set(id, def.derived);
      }
    }
    const derivedIds = new Set(derivedSpecs.keys());
    const isWritableAttr = (id: string): boolean => attributeIds.has(id) && !derivedIds.has(id);
    const resourceIds = new Set(Object.keys(w.resources));
    // ADR-012 D9：角色声明的专属池也算「已知资源」—— 召唤弹药与旋涡引用的就是它。
    // 但它**不进** `w.resources`，所以不会变成人人都有的一条槽。
    for (const c of w.characters) for (const key of Object.keys(c.resources ?? {})) resourceIds.add(key);
    const statusIds = new Set(w.statuses.map((s) => s.id));
    /** ADR-018：施加点与状态的 kind 必须属于同一个域，判据只有这一张表。 */
    const statusKindById = new Map(w.statuses.map((s) => [s.id, s.kind] as const));
    const isBattleStatus = (id: string): boolean => statusKindById.get(id) === "battle";
    const add = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    /**
     * 战斗钩子的引用完整性（ADR-073）。三处挂载点（世界 / 状态 / 技能）同一套判定：
     * - `applyStatus` 只能指向已声明的 `kind: battle`（和技能施加点同一条纪律）；
     * - `chance.attribute` 必须是已声明的**数值**属性（写 enum 会算出一个 NaN 概率）；
     * - 同一来源内 id 唯一（同名钩子挂两处是合法的，同数组里重复是笔误）。
     */
    const checkHooks = (
      hooks: readonly { id: string; when?: readonly unknown[]; effects: readonly unknown[] }[] | undefined,
      path: (string | number)[],
    ): void => {
      const seen = new Set<string>();
      (hooks ?? []).forEach((hook, i) => {
        const p = [...path, i];
        if (seen.has(hook.id)) add([...p, "id"], `重复的 hook id：${hook.id}`);
        seen.add(hook.id);
        (hook.when ?? []).forEach((cond, j) => {
          const chance = (cond as { chance?: unknown }).chance;
          if (chance === null || typeof chance !== "object") return;
          const attr = (chance as { attribute?: unknown }).attribute;
          if (typeof attr !== "string") return;
          if (!attributeIds.has(attr)) add([...p, "when", j, "chance", "attribute"], `未知属性：${attr}`);
          else if (!isNumericAttr(attr)) {
            add([...p, "when", j, "chance", "attribute"], `概率只接受数值属性：${attr}（${kindOf(attr)}）`);
          }
        });
        (hook.effects ?? []).forEach((raw, j) => {
          const eff = raw as { type?: string; status?: unknown };
          if (eff.type === "applyStatus") {
            const id = eff.status;
            if (typeof id !== "string") return;
            if (!statusIds.has(id)) add([...p, "effects", j, "status"], `未知状态：${id}`);
            else if (!isBattleStatus(id)) {
              add([...p, "effects", j, "status"], `钩子只能施加 kind: battle（${id} 不是）`);
            }
          }
          if (eff.type === "cureStatus" && typeof eff.status === "string" && !statusIds.has(eff.status)) {
            add([...p, "effects", j, "status"], `未知状态：${eff.status}`);
          }
        });
      });
    };
    checkHooks(w.combat?.hooks, ["combat", "hooks"]);
    /**
     * Stake（ADR-075 §1）。内置三档由引擎提供，模板可按 key 覆盖；
     * `defaultStake` 与每场战斗的 `stake` 都必须解析得到。
     */
    const BUILTIN_STAKES = ["spar", "hard", "deaths"] as const;
    const stakeIds = new Set<string>([...BUILTIN_STAKES, ...Object.keys(w.combat?.stakes ?? {})]);
    const defaultStake = w.combat?.defaultStake ?? "deaths";
    if (!stakeIds.has(defaultStake)) {
      add(["combat", "defaultStake"], `defaultStake 指向未声明的 stake：${defaultStake}`);
    }
    for (const [id, stake] of Object.entries(w.combat?.stakes ?? {})) {
      if (stake.defeatState !== "dead" || stake.hpOnDefeat === undefined) continue;
      if (stake.hpOnDefeat.mode !== "set" || stake.hpOnDefeat.value !== 0) {
        add(
          ["combat", "stakes", id, "hpOnDefeat"],
          `defeatState: dead 的战败落点必须是 { mode: set, value: 0 }（hp 0 是死亡信号）`,
        );
      }
    }
    w.events.forEach((e, i) => {
      if (e.kind !== "combat") return;
      const stake = e.settle.combat.stake;
      if (stake !== undefined && !stakeIds.has(stake)) {
        add(["events", i, "settle", "combat", "stake"], `未知 stake：${stake}`);
      }
    });
    /**
     * 死亡路由（ADR-075 §5）：id 唯一、必须有兜底、兜底之后不得再有路由；
     * 事件目标只能是 `kind: normal`（转盘/战斗都无法在 hp 0 上收敛）。
     * `endingId` 的引用在 `template-loader` 里跨文件校验（endings.yaml 不在本 schema）。
     */
    const deathRoutes = w.deathRoutes ?? [];
    const routeIds = new Set<string>();
    let fallbackAt = -1;
    deathRoutes.forEach((route, i) => {
      if (routeIds.has(route.id)) add(["deathRoutes", i, "id"], `重复的死亡路由 id：${route.id}`);
      routeIds.add(route.id);
      if (route.when.length === 0) fallbackAt = i;
      const action = route.then;
      if (action.kind === "event") {
        const event = w.events.find((e) => e.id === action.eventId);
        if (event === undefined) add(["deathRoutes", i, "then", "eventId"], `未知事件：${action.eventId}`);
        else if (event.kind !== "normal") {
          add(["deathRoutes", i, "then", "eventId"], `死亡事件只能是 kind: normal（${event.id} 是 ${event.kind}）`);
        }
      }
    });
    if (deathRoutes.length > 0) {
      if (fallbackAt < 0) add(["deathRoutes"], "死亡路由必须有一条 when: [] 兜底");
      else if (fallbackAt !== deathRoutes.length - 1) {
        add(["deathRoutes", fallbackAt], "兜底路由之后不得再有路由（永远不会命中）");
      }
    }
    /**
     * 战斗力权重（ADR-075 §4.3）：只接受**基础、非 signed、非 hidden 的数值属性**。
     * 派生键会与它的基属性重复计入；signed 键（mpCostRate）是负值，会把战力倒扣。
     */
    for (const key of Object.keys(w.combat?.evaluation?.power?.weights ?? {})) {
      const p = ["combat", "evaluation", "power", "weights", key];
      if (!attributeIds.has(key)) add(p, `未知属性：${key}`);
      else if (derivedIds.has(key)) add(p, `战斗力权重不能引用派生属性：${key}`);
      else if (!isNumericAttr(key)) add(p, `战斗力只接受数值属性：${key}（${kindOf(key)}）`);
      else if (defs[key]?.hidden === true) add(p, `战斗力权重不能引用隐藏属性：${key}`);
      else if (defs[key]?.kind === "number" && defs[key].signed === true) {
        add(p, `战斗力权重不能引用 signed 属性：${key}（负值会倒扣战力）`);
      }
    }
    /**
     * 战评（ADR-075 §2）：grade id 唯一、`when` 非空、不得自引用 grade；
     * hook id 全模板唯一；事件引用的 set 必须存在。
     */
    const evaluation = w.combat?.evaluation;
    const gradeIds = new Set<string>();
    evaluation?.grades?.forEach((grade, i) => {
      if (gradeIds.has(grade.id)) add(["combat", "evaluation", "grades", i, "id"], `重复的 grade id：${grade.id}`);
      gradeIds.add(grade.id);
      if (grade.when.length === 0) add(["combat", "evaluation", "grades", i, "when"], "grade 的 when 不能为空");
      if (grade.when.some((cond) => "grade" in cond)) {
        add(["combat", "evaluation", "grades", i, "when"], "grade 条件不能引用 grade（自己读自己）");
      }
    });
    const evalHookIds = new Set<string>();
    const checkEvalHookId = (hook: { id: string }, p: (string | number)[]): void => {
      if (evalHookIds.has(hook.id)) add([...p, "id"], `重复的战评 hook id：${hook.id}`);
      evalHookIds.add(hook.id);
    };
    evaluation?.hooks?.forEach((hook, i) => checkEvalHookId(hook, ["combat", "evaluation", "hooks", i]));
    for (const [setId, hooks] of Object.entries(evaluation?.sets ?? {})) {
      hooks.forEach((hook, i) => checkEvalHookId(hook, ["combat", "evaluation", "sets", setId, i]));
    }
    w.events.forEach((event, i) => {
      if (event.kind !== "combat") return;
      event.settle.combat.evaluation?.forEach((setId, j) => {
        if (evaluation?.sets?.[setId] === undefined) {
          add(["events", i, "settle", "combat", "evaluation", j], `未知战评组：${setId}`);
        }
      });
    });
    const isWorldStatus = (id: string): boolean => {
      const kind = statusKindById.get(id);
      return kind === "talent" || kind === "modifier";
    };
    const skillIds = new Set(w.skills.map((s) => s.id));
    const itemIds = new Set(w.items.map((i) => i.id));
    const characterIds = new Set(w.characters.map((c) => c.id));
    const eventIds = new Set(w.events.map((e) => e.id));
    const chainIds = new Set((w.chains ?? []).map((c) => c.id));

    for (const [id, spec] of derivedSpecs) {
      if (!attributeIds.has(id)) add(["attributes", "defs", id], `派生属性不在 attributes.order 中：${id}`);
      const seenDeps = new Set<string>();
      spec.from.forEach((dep, j) => {
        const p = ["attributes", "defs", id, "derived", "from", j, "attribute"];
        if (dep.attribute === id) add(p, `派生属性不能依赖自己：${id}`);
        else if (!attributeIds.has(dep.attribute)) add(p, `未知属性：${dep.attribute}`);
        else if (!isNumericAttr(dep.attribute)) add(p, `派生属性只能依赖数值属性：${dep.attribute}（${kindOf(dep.attribute)}）`);
        if (seenDeps.has(dep.attribute)) add(p, `重复的依赖项：${dep.attribute}`);
        seenDeps.add(dep.attribute);
      });
    }
    {
      const mark = new Map<string, 1 | 2>();
      const path: string[] = [];
      const visit = (id: string): void => {
        const state = mark.get(id);
        if (state === 2) return;
        if (state === 1) {
          add(["attributes", "defs", id, "derived"], `派生属性存在循环依赖：${[...path, id].join(" → ")}`);
          return;
        }
        mark.set(id, 1);
        path.push(id);
        for (const dep of derivedSpecs.get(id)?.from ?? []) {
          if (derivedSpecs.has(dep.attribute)) visit(dep.attribute);
        }
        path.pop();
        mark.set(id, 2);
      };
      for (const id of derivedSpecs.keys()) visit(id);
    }


    // ---- ADR-003：属性类型声明 ----
    /** 角色唯一（ADR-074）：两个属性都声明 `role: critRate`，引擎该读谁没有答案。 */
    const roleOwner = new Map<string, string>();
    for (const [id, def] of Object.entries(defs)) {
      if (def.kind !== "number" || def.role === undefined) continue;
      const prev = roleOwner.get(def.role);
      if (prev !== undefined) add(["attributes", "defs", id, "role"], `角色 ${def.role} 已被 ${prev} 占用`);
      else roleOwner.set(def.role, id);
    }
    Object.entries(defs).forEach(([id, def]) => {
      if (!attributeIds.has(id)) {
        add(["attributes", "defs", id], `未知属性：${id}（未在 attributes.order 中声明）`);
        return;
      }
      if (def.kind === "composite") {
        def.sources.forEach((src, i) => {
          if (!attributeIds.has(src)) {
            add(["attributes", "defs", id, "sources", i], `未知属性：${src}`);
          } else if (!isNumericAttr(src)) {
            add(["attributes", "defs", id, "sources", i], `复合属性的来源必须是数值属性：${src}（${kindOf(src)}）`);
          }
        });
      }
    });

    /** 属性值的类型校验：enum 必须是已声明选项；number/ladder 必须是数值；composite 不可写。 */
    const checkAttributeValue = (attr: string, value: unknown, path: (string | number)[]): void => {
      const def = defs[attr];
      if (def?.kind === "composite") {
        add(path, `composite 属性是只读派生，不能直接赋值：${attr}`);
        return;
      }
      if (def?.kind === "enum") {
        if (typeof value !== "string" || !enumValuesOf(attr)?.has(value)) {
          add(path, `未知选项：${String(value)}（属性 ${attr} 的 enum 取值必须是 values[].id）`);
        }
        return;
      }
      if (typeof value !== "number") {
        add(path, `属性 ${attr} 是数值属性，值必须是 number（收到 ${typeof value}）`);
      }
    };

    // 资源公式 perAttribute 引用（只接受数值属性）
    Object.entries(w.resources).forEach(([res, def]) => {
      Object.keys(def.perAttribute ?? {}).forEach((attr) => {
        if (!attributeIds.has(attr)) add(["resources", res, "perAttribute"], `未知属性：${attr}`);
        else if (!isNumericAttr(attr)) {
          add(["resources", res, "perAttribute"], `资源公式只接受数值属性：${attr}（${kindOf(attr)}）`);
        }
      });
    });

    // 属性显示名引用（键必须是 attributes.order 中声明的属性）
    Object.keys(w.attributes.labels ?? {}).forEach((attr) => {
      if (!attributeIds.has(attr)) add(["attributes", "labels"], `未知属性：${attr}`);
    });

    // 属性键必须在 attributes.order 中声明（D-17），值类型必须符合 defs 的 kind。
    const checkAttributeValues = (value: Record<string, unknown> | undefined, path: (string | number)[]): void => {
      Object.entries(value ?? {}).forEach(([attr, v]) => {
        if (!attributeIds.has(attr)) {
          add([...path, attr], `未知属性：${attr}（未在 attributes.order 中声明）`);
          return;
        }
        if (derivedIds.has(attr)) {
          add([...path, attr], `派生属性只读：${attr} 由公式计算，不能直接赋值`);
          return;
        }
        checkAttributeValue(attr, v, [...path, attr]);
      });
    };
    checkAttributeValues(w.attributes.defaults, ["attributes", "defaults"]);
    checkAttributeValues(w.playerTemplate?.attributes, ["playerTemplate", "attributes"]);

    // caps 只对数值属性有意义（文本 / 复合没有「上限」）。
    Object.keys(w.attributes.caps ?? {}).forEach((attr) => {
      if (!attributeIds.has(attr)) add(["attributes", "caps"], `未知属性：${attr}`);
      else if (!isNumericAttr(attr)) add(["attributes", "caps"], `caps 只接受数值属性：${attr}（${kindOf(attr)}）`);
    });

    // 心情档位的属性状态只接受数值属性
    w.mood.bands.forEach((band, i) => {
      Object.keys(band.attributeModifiers).forEach((attr) => {
        if (!attributeIds.has(attr)) add(["mood", "bands", i, "attributeModifiers"], `未知属性：${attr}`);
        else if (!isNumericAttr(attr)) {
          add(["mood", "bands", i, "attributeModifiers"], `属性状态只接受数值属性：${attr}（${kindOf(attr)}）`);
        }
      });
    });

    // 状态的属性状态（定义层，ADR-018 D2）只接受数值属性（hidden 数值属性可以）
    w.statuses.forEach((st, i) => {
      Object.keys(st.attributeModifiers ?? {}).forEach((attr) => {
        if (!attributeIds.has(attr)) add(["statuses", i, "attributeModifiers"], `未知属性：${attr}`);
        else if (!isNumericAttr(attr)) {
          add(["statuses", i, "attributeModifiers"], `属性状态只接受数值属性：${attr}（${kindOf(attr)}）`);
        }
      });
      /**
       * 消耗修正的 key 必须是已声明资源（ADR-018 D3）。
       * 写错一个 key 不会报错、也不会生效 —— 那正是最坏的一种：玩家花了钱没看到折扣。
       */
      Object.keys(st.combat?.costMultiplier ?? {}).forEach((key) => {
        if (!resourceIds.has(key)) add(["statuses", i, "combat", "costMultiplier"], `未知资源：${key}`);
      });
      checkHooks(st.combat?.hooks, ["statuses", i, "combat", "hooks"]);
      /**
       * 属性转化（ADR-074）：源与目标都要是已声明的数值属性，且都不能是派生属性 ——
       * 派生属性不落存档、按公式现算，把「搬走一个现算值」写进状态只会让顺序变得不可推理。
       */
      (st.conversion ?? []).forEach((conv, j) => {
        const p = ["statuses", i, "conversion", j];
        if (!attributeIds.has(conv.from)) add([...p, "from"], `未知属性：${conv.from}`);
        else if (derivedIds.has(conv.from)) add([...p, "from"], `派生属性不能被转化：${conv.from}`);
        else if (!isNumericAttr(conv.from)) {
          add([...p, "from"], `属性转化只接受数值属性：${conv.from}（${kindOf(conv.from)}）`);
        }
        for (const to of Object.keys(conv.to)) {
          if (!attributeIds.has(to)) add([...p, "to", to], `未知属性：${to}`);
          else if (derivedIds.has(to)) add([...p, "to", to], `派生属性不能被转化：${to}`);
          else if (!isNumericAttr(to)) add([...p, "to", to], `属性转化只接受数值属性：${to}（${kindOf(to)}）`);
          else if (to === conv.from) add([...p, "to", to], `转化目标不能是源属性本身：${to}`);
        }
      });
      /**
       * 战后折算只能指向 `modifier`（ADR-018 D4）：折算的意义就是「变成世界状态」，
       * 指回 `battle` 等于原地打转，指向 `talent` 等于凭空长出一个天赋。
       */
      if (st.toModifier !== undefined) {
        const target = statusKindById.get(st.toModifier.id);
        if (target === undefined) add(["statuses", i, "toModifier", "id"], `未知状态：${st.toModifier.id}`);
        else if (target !== "modifier") {
          add(["statuses", i, "toModifier", "id"], `toModifier 只能指向 kind: modifier（当前 ${target}）`);
        }
      }
      /**
       * 回合末施加点（ADR-006 D1 收尾）：`onRoundEnd.applyStatus` 的收件人只能是**携带者自己**。
       *
       * 回合末结算按「谁身上挂着这条状态」逐个跑（`roundEnd`），没有「施放者」这个概念——
       * 写 `all_enemies` 时既没有阵营可算，也会在同一条状态挂在三个人身上时重复施加三次。
       * 与其让引擎猜，不如在加载期拒掉：要往全场写状态，用技能的 `applyStatus`。
       */
      (st.combat?.onRoundEnd ?? []).forEach((re, j) => {
        (re.applyStatus ?? []).forEach((a, k) => {
          const target = a.target ?? (a.onSelf === true ? "self" : "skill");
          if (target === "all_enemies" || target === "all_allies") {
            add(
              ["statuses", i, "combat", "onRoundEnd", j, "applyStatus", k, "target"],
              `回合末施加只能指向携带者自己（self/skill），不能写 ${target}`,
            );
          }
        });
      });
    });

    // 状态栏数据源引用（resource 段必须是已声明资源；attribute 段只接受数值属性）
    w.statusBar.forEach((section, i) => {
      if (section.source === "resource") {
        if (!section.key) add(["statusBar", i, "key"], "source 为 resource 时必须声明 key");
        else if (!resourceIds.has(section.key)) add(["statusBar", i, "key"], `未知资源：${section.key}`);
      }
      if (section.source === "attribute") {
        const keys = section.keys ?? (section.key ? [section.key] : []);
        if (keys.length === 0) add(["statusBar", i, "keys"], "source 为 attribute 时必须声明 keys");
        keys.forEach((k) => {
          if (!attributeIds.has(k)) add(["statusBar", i, "keys"], `未知属性：${k}`);
          else if (!isNumericAttr(k)) add(["statusBar", i, "keys"], `状态栏属性段只接受数值属性：${k}（${kindOf(k)}）`);
        });
      }
    });

    // 技能消耗：hp/mp 之外的自定义资源键必须是已声明资源
    w.skills.forEach((s, i) => {
      if (s.kind !== "combat") return;
      Object.keys(s.cost).forEach((key) => {
        if (!resourceIds.has(key)) add(["skills", i, "cost", key], `未知资源：${key}`);
      });
    });

    // 回复配置：键必须是已声明资源；加权系数只能引用数值属性（ADR-003 D12）。
    const checkRegen = (amounts: Record<string, unknown> | undefined, path: (string | number)[]): void => {
      Object.entries(amounts ?? {}).forEach(([key, amount]) => {
        if (!resourceIds.has(key)) add([...path, key], `未知资源：${key}`);
        if (amount === null || typeof amount !== "object") return;
        Object.keys((amount as { perAttribute?: Record<string, number> }).perAttribute ?? {}).forEach((attr) => {
          if (!attributeIds.has(attr)) add([...path, key, "perAttribute", attr], `未知属性：${attr}`);
          else if (!isNumericAttr(attr)) {
            add([...path, key, "perAttribute", attr], `回复加权只接受数值属性：${attr}（${kindOf(attr)}）`);
          }
        });
      });
    };
    checkRegen(w.regen.perTurn, ["regen", "perTurn"]);
    Object.entries(w.regen.actions ?? {}).forEach(([id, amounts]) => checkRegen(amounts, ["regen", "actions", id]));
    // ADR-003 D12：战斗内每回合回复同样只能引用已声明资源。
    checkRegen(w.regen.combat, ["regen", "combat"]);
    w.characters.forEach((c, i) => checkRegen(c.combatRegen, ["characters", i, "combatRegen"]));

    // ---- ADR-003：效果里的属性 / 资源引用 ----
    /**
     * 状态引用 + 域归属（ADR-018 D6）。
     *
     * 世界效果只能碰 `talent` / `modifier`，且时长按 kind 必填：
     * `modifier` 必须写 `duration`（静默默认付过学费），`talent` 必须不写（天赋没有时钟）。
     * 这是整份协议里唯一一个「schema 层 optional + 加载期硬约束」的组合 ——
     * 因为解析期看不到被引用状态的 kind，只能在这里补。
     */
    const checkStatusRef = (eff: { type?: unknown; status?: unknown; duration?: unknown }, p: (string | number)[]): void => {
      if (eff.type !== "applyStatus" && eff.type !== "cureStatus") return;
      const id = eff.status;
      if (typeof id !== "string") return;
      if (!statusIds.has(id)) {
        add([...p, "status"], `未知状态：${id}`);
        return;
      }
      if (eff.type !== "applyStatus") return;
      const kind = statusKindById.get(id);
      if (kind === "battle") {
        add([...p, "status"], `世界效果不能施加 kind: battle（${id} 只能在战斗里产生）`);
        return;
      }
      if (kind === "talent" && eff.duration !== undefined) {
        add([...p, "duration"], "天赋没有时钟：施加 talent 时不要写 duration");
      } else if (kind === "modifier" && eff.duration === undefined) {
        add([...p, "duration"], "kind: modifier 必须写 duration");
      }
    };
    const checkEffectRefs = (
      effects: readonly unknown[] | undefined,
      path: (string | number)[],
      opts: { allowTalentMetric?: boolean } = {},
    ): void => {
      (effects ?? []).forEach((eff, j) => {
        if (!isCoreEffect(eff)) return;
        const p = [...path, j];
        checkStatusRef(eff, p);
        if (eff.type === "adjustAttribute") {
          if (!attributeIds.has(eff.attribute)) add(p, `未知属性：${eff.attribute}`);
          else if (derivedIds.has(eff.attribute)) {
            add(p, `派生属性只读：${eff.attribute}（要改它就去改它的依赖，或写 attributeModifiers）`);
          } else if (!isNumericAttr(eff.attribute)) {
            add(p, `adjustAttribute 只接受数值属性：${eff.attribute}（${kindOf(eff.attribute)}）`);
          }
        }
        if (eff.type === "setAttribute") {
          if (!attributeIds.has(eff.attribute)) add(p, `未知属性：${eff.attribute}`);
          else if (derivedIds.has(eff.attribute)) add(p, `派生属性只读：${eff.attribute}`);
          else checkAttributeValue(eff.attribute, eff.value, p);
        }
        if (eff.type === "adjustResource" && !resourceIds.has(eff.resource)) {
          add(p, `未知资源：${eff.resource}`);
        }
        if (eff.type === "grantAllocation") {
          eff.targets.forEach((t, k) => {
            if (!attributeIds.has(t.attribute)) add([...p, "targets", k], `未知属性：${t.attribute}`);
            else if (derivedIds.has(t.attribute)) add([...p, "targets", k], `派生属性只读：${t.attribute}`);
            else if (!isNumericAttr(t.attribute)) {
              add([...p, "targets", k], `加点只接受数值属性：${t.attribute}（${kindOf(t.attribute)}）`);
            }
          });
        }
        if (eff.type === "advanceTalent") {
          if (!statusIds.has(eff.talent)) add([...p, "talent"], `未知天赋：${eff.talent}`);
          else if (statusKindById.get(eff.talent) !== "talent") {
            add([...p, "talent"], `advanceTalent 只能指向 kind: talent（${eff.talent} 不是）`);
          }
          if (typeof eff.amount !== "number" && opts.allowTalentMetric !== true) {
            add([...p, "amount"], "世界效果里 advanceTalent.amount 必须是数字（metric 只允许战评 hooks）");
          }
        }
        if (eff.type === "observeActor" && eff.actorId !== null && eff.actorId !== "__self__") {
          if (eff.actorId !== PLAYER_ID && !characterIds.has(eff.actorId)) {
            add([...p, "actorId"], `未知角色：${eff.actorId}`);
          }
        }
        if (eff.type === "inheritActor") {
          for (const key of ["from", "to"] as const) {
            const id = eff[key];
            if (id !== PLAYER_ID && !characterIds.has(id)) add([...p, key], `未知角色：${id}`);
          }
        }
        /**
         * `who` 必须是已声明角色（ADR-010 D2）。写错时运行期静默跳过 —— 那意味着
         * 「给了一个不存在的人一件关键道具」，东西凭空消失且没有任何线索。
         * 所以在这里拒，而不是等玩家发现背包里少了一件。
         */
        {
          const who = (eff as { who?: unknown }).who;
          if (typeof who === "string" && who !== PLAYER_ID && !characterIds.has(who)) {
            add([...p, "who"], `未知角色：${who}`);
          }
        }
        /**
         * `scope: limited` 必须带名单（ADR-007 D3）。`RelationEdgeSchema` 在**存档校验**时
         * 拒收「limited 却没有 knownBy」，而效果是直接往数组里写、不经过 schema ——
         * 漏了这一步的后果不是报告难看，是这一局再也载不进来（与自环同一类）。
         * 放在这里而不是各调用点：事件 / 时间表 / NPC 行动 / 物品 / 开局都走 `walkEffects`
         * 或直接调它，一处写完全覆盖。
         */
        if (
          (eff.type === "addRelationEdge" || eff.type === "adjustRelation") &&
          eff.scope === "limited" &&
          (eff.knownBy === undefined || eff.knownBy.length === 0)
        ) {
          add([...p, "knownBy"], "scope: limited 必须声明 knownBy（否则等同于 private）");
        }
      });
    };
    w.actions?.forEach((action, i) => checkEffectRefs(action.effects, ["actions", i, "effects"]));
    w.items.forEach((item, i) => checkEffectRefs(item.use, ["items", i, "use"]));
    // 成长阶梯的 `grant` 也是世界效果：同样过一遍引用完整性（ADR-075 §7）。
    w.statuses.forEach((st, i) => {
      st.tiers?.forEach((tier, j) => {
        checkEffectRefs(tier.effects.grant, ["statuses", i, "tiers", j, "effects", "grant"]);
      });
    });
    // 战评 hooks 允许 metric 形态的 advanceTalent（它们有战果上下文）。
    const checkEvalEffects = (hooks: readonly { effects: readonly unknown[] }[] | undefined, path: (string | number)[]): void => {
      (hooks ?? []).forEach((hook, i) => {
        checkEffectRefs(hook.effects, [...path, i, "effects"], { allowTalentMetric: true });
      });
    };
    checkEvalEffects(w.combat?.evaluation?.hooks, ["combat", "evaluation", "hooks"]);
    for (const [setId, hooks] of Object.entries(w.combat?.evaluation?.sets ?? {})) {
      checkEvalEffects(hooks, ["combat", "evaluation", "sets", setId]);
    }

    // ---- ADR-003：条件里的属性引用与类型约束 ----
    const checkConditionRefs = (conditions: readonly unknown[] | undefined, path: (string | number)[]): void => {
      (conditions ?? []).forEach((raw, i) => {
        if (typeof raw !== "object" || raw === null || !("attribute" in raw)) return;
        const cond = raw as {
          attribute: string;
          eq?: unknown;
          ne?: unknown;
          gte?: number;
          lte?: number;
          gt?: number;
          lt?: number;
          tier?: string;
        };
        const p = [...path, i];
        const attr = cond.attribute;
        if (!attributeIds.has(attr)) {
          add(p, `未知属性：${attr}`);
          return;
        }
        const kind = kindOf(attr);
        if (kind === "composite") {
          add(p, `复合属性是只读派生，不能作为条件：${attr}`);
          return;
        }
        const hasNumericOp =
          cond.gte !== undefined || cond.lte !== undefined || cond.gt !== undefined || cond.lt !== undefined;
        if (hasNumericOp && !isNumericAttr(attr)) {
          add(p, `文本属性不支持数值比较：${attr}（${kind}）`);
        }
        for (const [op, value] of [["eq", cond.eq], ["ne", cond.ne]] as const) {
          if (typeof value !== "string") continue;
          if (kind !== "enum") {
            add(p, `${op} 的字符串比较只能用于 enum 属性：${attr}（${kind}）`);
          } else if (!enumValuesOf(attr)?.has(value)) {
            add(p, `未知选项：${value}（属性 ${attr}）`);
          }
        }
        if (cond.tier !== undefined) {
          const def = defs[attr];
          if (def?.kind !== "ladder") {
            add(p, `tier 只能用于阶梯属性：${attr}（${kind}）`);
          } else if (!def.tiers.some((t) => t.id === cond.tier)) {
            add(p, `未知档位：${cond.tier}（属性 ${attr}）`);
          }
        }
      });
    };

    // 性别引用
    w.characters.forEach((c, i) => {
      if (!genderIds.has(c.identity.gender)) add(["characters", i, "identity", "gender"], `未知性别：${c.identity.gender}`);
      // ADR-010 D3：初始装备必须是已声明物品。写错时战斗里会静默少一件，
      // 数值差一点很难被察觉 —— 所以在这里拒。
      (c.equipment ?? []).forEach((itemId, j) => {
        if (!itemIds.has(itemId)) add(["characters", i, "equipment", j], `未知物品：${itemId}`);
      });
    });
    // R2.6 / ADR-0014：初始关系边声明 -> 角色引用（to 只能是已声明角色或 PLAYER_ID）
    w.characters.forEach((c, i) => {
      (c.relations ?? []).forEach((r, j) => {
        if (r.to !== PLAYER_ID && !characterIds.has(r.to)) {
          add(["characters", i, "relations", j, "to"], `未知关系目标：${r.to}`);
        }
        /**
         * ADR-017 D1：指向玩家的边**不许带强度**。
         *
         * 「他视你如何」的强度只有 `relationship` 一个家；边上再写一份 value 就是两个数字，
         * 而事件只改其中一个（标量形态写标量、边形态写边）。这里拒载，而不是静默丢弃 ——
         * 静默丢弃会让作者以为自己写的 70 生效了。
         */
        if (r.to === PLAYER_ID && r.value !== undefined) {
          add(
            ["characters", i, "relations", j, "value"],
            "指向玩家的边不要写 value：强度只由 relationship 标量表达（ADR-017 D1）",
          );
        }
      });
    });
    // 父/母指针（`extensions/family/doc/FAMILY-GRAPH.md` §3.1）：必须指向已声明角色，且不得自引用。
    // 指向不存在的 id 会让「指针是唯一真源」在运行时悄悄断线（族谱缺人、称谓静默降级），
    // 所以在加载期 fail-fast；自引用则是必然的环，同样当场拒载。
    w.characters.forEach((c, i) => {
      (["fatherId", "motherId"] as const).forEach((field) => {
        const target = c[field];
        if (target === undefined) return;
        if (target === c.id) {
          add(["characters", i, field], `${field} 不能指向自己：${c.id}`);
        } else if (!characterIds.has(target)) {
          add(["characters", i, field], `未知角色：${target}（${field} 目标）`);
        }
      });
    });
    if (w.playerTemplate && !genderIds.has(w.playerTemplate.identity.gender)) {
      add(["playerTemplate", "identity", "gender"], `未知性别：${w.playerTemplate.identity.gender}`);
    }
    // 玩家的父/母指针与角色同一条规则：必须指向已声明角色（玩家自身不是 characters 成员，
    // 自引用在这里等价于「指向未知角色」，会被同一条分支拒载）。
    if (w.playerTemplate) {
      (["fatherId", "motherId"] as const).forEach((field) => {
        const target = w.playerTemplate?.[field];
        if (target === undefined) return;
        if (!characterIds.has(target)) {
          add(["playerTemplate", field], `未知角色：${target}（${field} 目标）`);
        }
      });
    }
    if (w.playerTemplate) {
      (w.playerTemplate.skills ?? []).forEach((sk, j) => {
        if (!skillIds.has(sk)) add(["playerTemplate", "skills", j], `未知技能：${sk}`);
      });
      (w.playerTemplate.items ?? []).forEach((it, j) => {
        if (!itemIds.has(it.itemId)) add(["playerTemplate", "items", j], `未知物品：${it.itemId}`);
      });
      // 玩家侧关系边（ADR-017 D2）：`from` 恒为 self，所以 `to` 必须是一个**别人**。
      (w.playerTemplate.relations ?? []).forEach((r, j) => {
        if (!characterIds.has(r.to)) {
          add(["playerTemplate", "relations", j, "to"], `未知关系目标：${r.to}`);
        }
        if (r.value !== undefined) {
          add(
            ["playerTemplate", "relations", j, "value"],
            "玩家侧关系边不要写 value：你自己的观感由行为养成（ADR-017 D1）",
          );
        }
      });
    }

    // 属性引用（战斗技能 hitCheck / scaleBy / 角色属性 / mood 档位修正）
    w.skills.forEach((s, i) => {
      if (s.kind === "combat") {
        // 命中判定的攻防槽位同样是属性 id 引用；写错会静默取 0，必须在加载期拒绝
        if (s.hitCheck) {
          if (!attributeIds.has(s.hitCheck.attacker)) add(["skills", i, "hitCheck", "attacker"], `未知属性：${s.hitCheck.attacker}`);
          else if (!isNumericAttr(s.hitCheck.attacker)) {
            add(["skills", i, "hitCheck", "attacker"], `命中判定只接受数值属性：${s.hitCheck.attacker}（${kindOf(s.hitCheck.attacker)}）`);
          }
          if (!attributeIds.has(s.hitCheck.defender)) add(["skills", i, "hitCheck", "defender"], `未知属性：${s.hitCheck.defender}`);
          else if (!isNumericAttr(s.hitCheck.defender)) {
            add(["skills", i, "hitCheck", "defender"], `命中判定只接受数值属性：${s.hitCheck.defender}（${kindOf(s.hitCheck.defender)}）`);
          }
        }
        const formulas = [...(s.damage ?? []), ...(s.heal ?? [])];
        formulas.forEach((f, j) => {
          if (f.preset === "scaled" && !attributeIds.has(f.scaleBy)) {
            add(["skills", i, "damage", j], `未知属性：${f.scaleBy}`);
          } else if (f.preset === "scaled" && !isNumericAttr(f.scaleBy)) {
            add(["skills", i, "damage", j], `伤害/治疗公式只接受数值属性：${f.scaleBy}（${kindOf(f.scaleBy)}）`);
          }
        });
      }
    });
    w.characters.forEach((c, i) => {
      checkAttributeValues(c.attributes, ["characters", i, "attributes"]);
    });

    // 技能 applyStatus/consumeStatus/stack-scaled -> statuses；通用技能 unlocksOptions -> 事件选项（事件侧校验）
    w.skills.forEach((s, i) => {
      if (s.kind === "combat") {
        (s.applyStatus ?? []).forEach((a, j) => {
          if (!statusIds.has(a.status)) add(["skills", i, "applyStatus", j], `未知状态：${a.status}`);
          else if (!isBattleStatus(a.status)) {
            /**
             * ADR-018 D6：战斗施加点只能引用 `battle` 档。
             *
             * 旧写法「战斗技能施加一个世界状态的 2 天」已经退役 —— 那是一个 `duration`
             * 服务两种时钟。要表达「打完还留着」，写在状态定义的 `toModifier` 上，
             * 由战后结算按回合数折算。
             */
            add(["skills", i, "applyStatus", j, "status"], `战斗只能施加 kind: battle（${a.status} 不是）`);
          }
        });
        if (s.consumeStatus && !statusIds.has(s.consumeStatus.status)) {
          add(["skills", i, "consumeStatus"], `未知状态：${s.consumeStatus.status}`);
        }
        checkHooks(s.hooks, ["skills", i, "hooks"]);
        const formulas = [...(s.damage ?? []), ...(s.heal ?? [])];
        formulas.forEach((f, j) => {
          if (f.preset === "stack-scaled" && !statusIds.has(f.status)) {
            add(["skills", i, "damage", j], `未知状态：${f.status}`);
          }
          if (f.preset === "resource-scaled" && !resourceIds.has(f.resource)) {
            add(["skills", i, "damage", j], `未知资源：${f.resource}`);
          }
        });
        // ADR-012 / ADR-013：召唤与献祭点名的角色必须能在模板里解析。
        // 「点名」是这套协议唯一的绑定方式 —— 写错一个 id 就等于多出一个永远召不出的技能，
        // 静默且极难查（技能列表里它在，点了没反应）。
        if (s.summon !== undefined && !characterIds.has(s.summon.ref)) {
          add(["skills", i, "summon", "ref"], `未知角色：${s.summon.ref}`);
        }
      }
    });

    // ADR-012 D7：装备授予的技能必须存在（写错就等于「拿了件没用的东西」，静默且难查）。
    w.items.forEach((item, i) => {
      const granted = (item as { grantsSkill?: string }).grantsSkill;
      if (granted !== undefined && !skillIds.has(granted)) {
        add(["items", i, "grantsSkill"], `未知技能：${granted}`);
      }
    });

    // 角色初始技能 -> skills；combatHints.skillWeights 的 key 必须是该角色已持有的技能
    w.characters.forEach((c, i) => {
      (c.skills ?? []).forEach((sk, j) => {
        if (!skillIds.has(sk)) add(["characters", i, "skills", j], `未知技能：${sk}`);
      });
      (c.statuses ?? []).forEach((st, j) => {
        if (!statusIds.has(st)) add(["characters", i, "statuses", j], `未知状态：${st}`);
        // ADR-018 D6：挂载是世界的动作，只能挂天赋或状态；战斗态由战斗自己产生。
        else if (!isWorldStatus(st)) add(["characters", i, "statuses", j], `挂载只能是 talent / modifier（${st} 是 battle）`);
      });
      const hints = c.private.combatHints as { skillWeights?: Record<string, unknown> } | undefined;
      Object.keys(hints?.skillWeights ?? {}).forEach((sk) => {
        /**
         * ADR-010 D6：技能可以在**运行时**增长（`scheduledFacts` + `unlockSkill` 的 `who`），
         * 所以判据从「此刻持有」放宽到「模板里确有这个技能」。
         *
         * 否则「给某个角色写尚未解锁技能的出招权重」会变成加载错误 —— 成长机制与校验规则自相矛盾。
         * 拼写错误仍然抓得住（`skillIds` 里没有就报）。
         */
        if (!skillIds.has(sk)) {
          add(["characters", i, "private", "combatHints"], `skillWeights 引用未知技能：${sk}`);
        }
      });
    });

    // 物品 use 效果引用
    w.items.forEach((item, i) => {
      (item.use ?? []).forEach((e, j) => {
        // 开放形（扩展效果）的字段归扩展解释，内核的 id 交叉校验跳过它们。
        if (!isCoreEffect(e)) return;
        if (e.type === "cureStatus" && !statusIds.has(e.status)) add(["items", i, "use", j], `未知状态：${e.status}`);
        if (e.type === "grantItem" && !itemIds.has(e.itemId)) add(["items", i, "use", j], `未知物品：${e.itemId}`);
      });
    });

    // 战斗敌人/友军引用
    w.events.forEach((e, i) => {
      if (e.kind === "combat") {
        e.settle.combat.enemies.forEach((en, j) => {
          const id = characterIds.has(en.ref) ? undefined : `未知敌人角色：${en.ref}`;
          if (id) add(["events", i, "settle", "combat", "enemies", j], id);
        });
        (e.settle.combat.allies ?? []).forEach((al, j) => {
          const id = characterIds.has(al.ref) ? undefined : `未知友军角色：${al.ref}`;
          if (id) add(["events", i, "settle", "combat", "allies", j], id);
        });
      }
    });

    // R2.5 / R-EV-13：战斗事件不得作为 pool 来源入池（加载期拒绝，抽取期另有防御）。
    // 战斗会话占槽直至结束，与「抽中→入队→延时触发」叠一层会话状态会污染权重语义。
    w.events.forEach((e, i) => {
      if (e.trigger.source === "pool" && e.kind === "combat") {
        add(
          ["events", i, "trigger", "source"],
          "source: pool 不允许 kind: combat；请改用通常事件/转盘事件入池，再由该事件的 chain 立即步或 nextEventId 触发战斗",
        );
      }
    });

    // R2.5 / #35：同一 onActionId 至多一条「立即」action-hook。
    // 只统计未声明 window / delay 的 hook：延时 hook 不占同一轮槽位，显式豁免；
    // chain / schedule / pool 完全不受约束。
    const immediateHooks = new Map<string, number[]>();
    w.events.forEach((e, i) => {
      const t = e.trigger;
      if (t.source !== "action-hook" || t.onActionId === undefined) return;
      if (t.window !== undefined || t.delay !== undefined) return;
      const group = immediateHooks.get(t.onActionId) ?? [];
      group.push(i);
      immediateHooks.set(t.onActionId, group);
    });
    for (const [onActionId, indexes] of immediateHooks) {
      if (indexes.length < 2) continue;
      add(
        ["events", indexes[1], "trigger", "source"],
        `同一 onActionId「${onActionId}」存在 ${indexes.length} 条立即 action-hook，违反单轮槽位唯一（events[${indexes.join(",")}]）；可为后续 hook 声明 window/delay 转为延时`,
      );
    }

    // 事件/链互引
    const optionIds = new Set<string>();
    w.events.forEach((e) => {
      if (e.kind === "normal") {
        e.settle.normal.options.forEach((o) => optionIds.add(o.id));
      }
    });
    w.events.forEach((e, i) => {
      const checkNext = (nextEventId: string | undefined, path: (string | number)[]) => {
        if (nextEventId && !eventIds.has(nextEventId)) add(path, `未知事件：${nextEventId}`);
      };
      checkConditionRefs(e.trigger.conditions, ["events", i, "trigger", "conditions"]);
      checkConditionRefs(
        "missWhen" in e && Array.isArray(e.missWhen) ? e.missWhen : undefined,
        ["events", i, "missWhen"],
      );
      if (e.kind === "normal") {
        e.settle.normal.options.forEach((o, j) => {
          checkNext(o.nextEventId, ["events", i, "settle", "normal", "options", j]);
          checkConditionRefs(o.visibleWhen, ["events", i, "settle", "normal", "options", j, "visibleWhen"]);
          (o.visibleWhen ?? []).forEach((c, k) => {
            const rec = c as { requiresSkill?: string };
            if (rec.requiresSkill && !skillIds.has(rec.requiresSkill)) {
              add(["events", i, "settle", "normal", "options", j, "visibleWhen", k], `未知技能：${rec.requiresSkill}`);
            }
          });
        });
      }
      if (e.kind === "random") {
        e.settle.random.wheel.segments.forEach((seg, j) => {
          checkNext(seg.nextEventId, ["events", i, "settle", "random", "wheel", "segments", j]);
          Object.keys(seg.weightBy ?? {}).forEach((attr) => {
            if (!attributeIds.has(attr)) {
              add(["events", i, "settle", "random", "wheel", "segments", j, "weightBy"], `未知属性：${attr}`);
            } else if (!isNumericAttr(attr)) {
              add(["events", i, "settle", "random", "wheel", "segments", j, "weightBy"], `转盘权重只接受数值属性：${attr}（${kindOf(attr)}）`);
            }
          });
        });
      }
      if (e.kind === "combat") {
        const c = e.settle.combat;
        checkNext(c.onVictory?.nextEventId, ["events", i, "settle", "combat", "onVictory"]);
        checkNext(c.onDefeat?.nextEventId, ["events", i, "settle", "combat", "onDefeat"]);
        checkNext(c.onFlee?.nextEventId, ["events", i, "settle", "combat", "onFlee"]);
        if (c.canFlee && !c.fleeCheck) {
          add(["events", i, "settle", "combat"], "canFlee 为 true 时需要 fleeCheck");
        }
        /**
         * ADR-012：战斗里出现的每一个角色引用都必须在加载期存在。
         * 召唤 / 中途加入 / 中立 / 斩首目标都是**运行期才建人**的路径，
         * 写错 id 不会在开打时报错，只会在那一回合静默少一个人——那是最难查的一种。
         */
        (c.neutrals ?? []).forEach((n, j) => {
          if (!characterIds.has(n.ref)) add(["events", i, "settle", "combat", "neutrals", j, "ref"], `未知角色：${n.ref}`);
        });
        (c.reinforcements ?? []).forEach((r, j) => {
          if (!characterIds.has(r.ref)) {
            add(["events", i, "settle", "combat", "reinforcements", j, "ref"], `未知角色：${r.ref}`);
          }
          checkConditionRefs(r.when, ["events", i, "settle", "combat", "reinforcements", j, "when"]);
        });
        for (const key of ["victory", "defeat"] as const) {
          (c[key] ?? []).forEach((cond, j) => {
            if (cond.kind === "unit_down" && !characterIds.has(cond.ref)) {
              add(["events", i, "settle", "combat", key, j, "ref"], `未知角色：${cond.ref}`);
            }
          });
        }
        if (c.fleeCheck) {
          if (!attributeIds.has(c.fleeCheck.attacker)) add(["events", i, "settle", "combat", "fleeCheck", "attacker"], `未知属性：${c.fleeCheck.attacker}`);
          else if (!isNumericAttr(c.fleeCheck.attacker)) {
            add(["events", i, "settle", "combat", "fleeCheck", "attacker"], `逃跑判定只接受数值属性：${c.fleeCheck.attacker}（${kindOf(c.fleeCheck.attacker)}）`);
          }
          if (!attributeIds.has(c.fleeCheck.defender)) add(["events", i, "settle", "combat", "fleeCheck", "defender"], `未知属性：${c.fleeCheck.defender}`);
          else if (!isNumericAttr(c.fleeCheck.defender)) {
            add(["events", i, "settle", "combat", "fleeCheck", "defender"], `逃跑判定只接受数值属性：${c.fleeCheck.defender}（${kindOf(c.fleeCheck.defender)}）`);
          }
        }
      }
      // 通用效果里的 chain / 事件 / 角色引用（属性 / 资源引用统一走 checkEffectRefs）
      const walkEffects = (
        effects: readonly unknown[] | undefined,
        path: (string | number)[],
      ) => {
        checkEffectRefs(effects, path);
        (effects ?? []).forEach((raw, j) => {
          if (!isCoreEffect(raw)) return;
          const eff = raw;
          if ((eff.type === "startChain" || eff.type === "advanceChain" || eff.type === "cancelChain") && !chainIds.has(eff.chainId)) {
            add([...path, j], `未知事件链：${eff.chainId}`);
          }
          // R2.5：enqueueEvent 是延时入队的唯一声明式通道，目标事件必须存在
          if (eff.type === "enqueueEvent" && !eventIds.has(eff.eventId)) {
            add([...path, j], `未知事件：${eff.eventId}（enqueueEvent 目标）`);
          }
          // S3：addSecret 的目标必须是已声明角色（`__self__` 之外）。
          if (
            eff.type === "addSecret" &&
            eff.npcId !== "__self__" &&
            !characterIds.has(eff.npcId)
          ) {
            add([...path, j], `未知角色：${eff.npcId}`);
          }
        });
      };
      if (e.kind === "normal") e.settle.normal.options.forEach((o, j) => walkEffects(o.effects, ["events", i, "settle", "normal", "options", j, "effects"]));
      if (e.kind === "random") e.settle.random.wheel.segments.forEach((seg, j) => walkEffects(seg.effects, ["events", i, "settle", "random", "wheel", "segments", j, "effects"]));
    });

    // 事件链引用与起点校验
    (w.chains ?? []).forEach((ch, i) => {
      if (!eventIds.has(ch.startEventId)) add(["chains", i, "startEventId"], `未知事件：${ch.startEventId}`);
      ch.steps.forEach((st, j) => {
        if (!eventIds.has(st.eventId)) add(["chains", i, "steps", j], `未知事件：${st.eventId}`);
      });
      const start = w.events.find((e) => e.id === ch.startEventId);
      if (start && start.trigger.source !== "chain") {
        add(["chains", i, "startEventId"], `链起点事件 ${ch.startEventId} 的 trigger.source 必须为 chain`);
      }
    });

    // 装备分域引用完整性（协议 V2.1 §19 / R-EQ-01..05）
    const eq = w.equipment;
    if (eq) {
      const slotById = new Map<string, EquipmentSlot>();
      (eq.slots ?? []).forEach((s, i) => {
        if (slotById.has(s.id)) add(["equipment", "slots", i, "id"], `重复槽位 id：${s.id}`);
        slotById.set(s.id, s);
      });
      const qualitySet = new Set(eq.qualities ?? []);
      w.items.forEach((item, i) => {
        if (item.type !== "equipment") return;
        if (!slotById.has(item.slot ?? "")) {
          add(["items", i, "slot"], `未知槽位：${item.slot ?? "(缺失)"}`);
          return;
        }
        const slot = slotById.get(item.slot ?? "")!;
        if (!slot.allowedCategories.includes(item.category ?? "")) {
          add(["items", i, "category"], `槽位 ${slot.id} 不允许类别：${item.category ?? "(缺失)"}（allowedCategories: ${slot.allowedCategories.join(", ")}）`);
        }
        /**
         * 品级（2026-11-19）：**引擎的品级阶梯 id 直接合法**，不需要模板在
         * `equipment.qualities` 里再抄一遍；白名单只用于模板自定义的品质词。
         * 这样「装备品级」与「品级标签」是同一套词汇，装备只写 `quality: legend` 即可。
         */
        const quality = item.quality;
        if (quality === undefined) {
          if (qualitySet.size > 0) {
            add(["items", i, "quality"], "未知品质：(缺失)（模板声明了 qualities 白名单，装备必须写 quality）");
          }
        } else if (!isQualityTier(quality) && qualitySet.size > 0 && !qualitySet.has(quality)) {
          add(
            ["items", i, "quality"],
            `未知品质：${quality}（可为品级阶梯 ${QUALITY_TIER_IDS.join("/")}，或模板 qualities：${[...qualitySet].join(", ")}）`,
          );
        }
        for (const [k, spec] of (item.dynamicModifiers ?? []).entries()) {
          const msg = checkDynamicModifierSpec(spec, {
            attributeIds,
            numericAttributeIds: new Set([...attributeIds].filter(isNumericAttr)),
            statusIds,
          });
          if (msg) add(["items", i, "dynamicModifiers", k], msg);
        }
      });
      (eq.initialEquipment ?? []).forEach((init, i) => {
        const item = w.items.find((it) => it.id === init.itemId);
        if (!item) {
          add(["equipment", "initialEquipment", i, "itemId"], `未知物品：${init.itemId}`);
          return;
        }
        if (item.type !== "equipment") {
          add(["equipment", "initialEquipment", i, "itemId"], `初始装备必须引用 type: equipment 物品：${init.itemId}`);
          return;
        }
        if (item.slot && !slotById.has(item.slot)) {
          add(["equipment", "initialEquipment", i], `初始装备引用了未声明槽位的装备：${init.itemId}`);
        }
      });
    }

    // 战斗 AI 分域引用完整性（协议 V2.1 §20 / R-CA-01..06）
    const ai = w.combatAi;
    if (ai) {
      const styleIds = new Set<string>();
      ai.styles.forEach((s, i) => {
        if (styleIds.has(s.styleId)) add(["combatAi", "styles", i, "styleId"], `重复风格 id：${s.styleId}`);
        styleIds.add(s.styleId);
        Object.keys(s.scoreWeights).forEach((actionId, j) => {
          if (!skillIds.has(actionId)) add(["combatAi", "styles", i, "scoreWeights", j], `未知行动/技能：${actionId}`);
        });
        (s.conditions ?? []).forEach((c, j) => {
          c.prefer.forEach((actionId, k) => {
            if (!skillIds.has(actionId)) add(["combatAi", "styles", i, "conditions", j, "prefer", k], `未知行动/技能：${actionId}`);
          });
        });
      });
      Object.entries(ai.assignments).forEach(([characterId, styleId], i) => {
        if (!characterIds.has(characterId)) add(["combatAi", "assignments", i], `未知角色：${characterId}`);

        if (!styleIds.has(styleId)) add(["combatAi", "assignments", i], `未知风格：${styleId}`);
      });
    }

    // ADR-0022：刷新规则引用完整性。规则指向的角色必须存在且不是敌人
    // （敌人由 combat settle 直接 ref 引，不属于「将来出生」语义）。
    // 注意：本段必须留在 superRefine 顶层 —— 曾被误插进 combatAi.assignments 的
    // forEach 回调体内，导致未声明 combatAi 的模板三条校验全不生效（测试因夹具另有
    // 非法引用而假绿）。ADR-0023 施工时复核发现。
    const spawnRuleIds = new Set<string>();
    (w.npcSpawnRules ?? []).forEach((rule, i) => {
      const path = ["npcSpawnRules", i];
      if (spawnRuleIds.has(rule.id)) add(path, `重复的刷新规则 id：${rule.id}`);
      spawnRuleIds.add(rule.id);
      const ch = w.characters.find((c) => c.id === rule.characterRef);
      if (!ch) {
        add([...path, "characterRef"], `未知角色：${rule.characterRef}`);
      } else if (ch.isEnemy) {
        add([...path, "characterRef"], `刷新规则不能指向敌人角色：${rule.characterRef}`);
      }
    });

    // ADR-007 D1：世界时间表。id 唯一、条件与效果都做引用完整性检查
    // （`spawnNpc.ruleId` 之类由 `checkEffectRefs` 统一校验，不在这里另写一份）。
    const factIds = new Set<string>();
    (w.scheduledFacts ?? []).forEach((fact, i) => {
      const path = ["scheduledFacts", i];
      if (factIds.has(fact.id)) add(path, `重复的事实 id：${fact.id}`);
      factIds.add(fact.id);
      checkConditionRefs(fact.when, [...path, "when"]);
      checkEffectRefs(fact.effects, [...path, "effects"]);
      // 事实没有「事件」这层兜底：引用写错就是静默不发生，必须加载期拦住。
      fact.effects.forEach((eff, j) => {
        if (!isCoreEffect(eff)) return;
        const p = [...path, "effects", j];
        if (eff.type === "spawnNpc" && !spawnRuleIds.has(eff.ruleId)) {
          add(p, `未知刷新规则：${eff.ruleId}`);
        }
        if (eff.type === "addRelationEdge" || eff.type === "adjustRelation") {
          // 关系边形态：两端必须是已声明角色或玩家（`__self__` 留给事件里的 NPC 行动）。
          for (const id of [eff.fromId, eff.toId]) {
            if (id === undefined || id === "__self__" || id === PLAYER_ID) continue;
            if (!characterIds.has(id)) add(p, `未知角色：${id}`);
          }
        }
      });
    });

    // 事件级 `npcs`（S1）：把还没登场的人拉上场。引用必须是已声明角色或刷新规则 id。
    w.events.forEach((e, i) => {
      (e.npcs ?? []).forEach((ref, j) => {
        if (!characterIds.has(ref) && !spawnRuleIds.has(ref)) {
          add(["events", i, "npcs", j], `未知角色/刷新规则：${ref}`);
        }
      });
    });

    // NPC 行动效果引用完整性
    (w.npcActions ?? []).forEach((action, i) => {
      checkEffectRefs(action.effects, ["npcActions", i, "effects"]);
      checkConditionRefs(action.trigger.conditions, ["npcActions", i, "trigger", "conditions"]);
      (action.effects ?? []).forEach((eff, j) => {
        const path = ["npcActions", i, "effects", j];
        // 开放形效果由扩展解释字段（内核只认 type 归属），不在这里做引用校验。
        if (!isCoreEffect(eff)) return;
        if ((eff.type === "startChain" || eff.type === "advanceChain" || eff.type === "cancelChain") && !chainIds.has(eff.chainId)) {
          add(path, `未知事件链：${eff.chainId}`);
        }
        if ((eff.type === "grantItem" || eff.type === "removeItem") && !itemIds.has(eff.itemId)) {
          add(path, `未知物品：${eff.itemId}`);
        }
        checkStatusRef(eff, path);
        if ((eff.type === "unlockSkill" || eff.type === "adjustProficiency") && !skillIds.has(eff.skillId)) {
          add(path, `未知技能：${eff.skillId}`);
        }
        if (eff.type === "adjustRelation") {
          if (eff.fromId === undefined && eff.toId === undefined) {
            // 标量形态：npcId 必填
            if (eff.npcId === undefined) {
              add(path, "adjustRelation 需要 npcId（标量形态）或 fromId+toId+kind（关系边形态）");
            } else if (eff.npcId !== "__self__" && !characterIds.has(eff.npcId)) {
              add(path, `未知角色：${eff.npcId}`);
            }
          } else {
            // 关系边形态（R2.6）：toId 与 kind 必填，端点须为已声明角色或玩家
            if (eff.toId === undefined || eff.kind === undefined) {
              add(path, "adjustRelation 关系边形态必须同时声明 toId 与 kind");
            }
            if (
              eff.fromId !== undefined &&
              eff.fromId !== "__self__" &&
              eff.fromId !== PLAYER_ID &&
              !characterIds.has(eff.fromId)
            ) {
              add(path, `未知角色：${eff.fromId}`);
            }
            if (eff.toId !== undefined && eff.toId !== PLAYER_ID && !characterIds.has(eff.toId)) {
              add(path, `未知关系目标：${eff.toId}`);
            }
          }
        }
        if (eff.type === "addRelationEdge") {
          if (eff.fromId !== "__self__" && eff.fromId !== PLAYER_ID && !characterIds.has(eff.fromId)) {
            add(path, `未知角色：${eff.fromId}`);
          }
          if (eff.toId !== PLAYER_ID && !characterIds.has(eff.toId)) {
            add(path, `未知关系目标：${eff.toId}`);
          }
        }
        if (eff.type === "addSecret" && eff.npcId !== "__self__" && !characterIds.has(eff.npcId)) {
          add(path, `未知角色：${eff.npcId}`);
        }
        if (eff.type === "freezeRelationsOnDeath" && eff.npcId !== "__self__" && !characterIds.has(eff.npcId)) {
          add(path, `未知角色：${eff.npcId}`);
        }
        if (eff.type === "enqueueEvent" && !eventIds.has(eff.eventId)) {
          add(path, `未知事件：${eff.eventId}（enqueueEvent 目标）`);
        }
      });
    });
  });

export type WorldTemplateV2 = z.infer<typeof WorldTemplateV2Schema>;
