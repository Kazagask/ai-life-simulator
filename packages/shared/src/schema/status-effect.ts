import { z } from "zod";
import { PolaritySchema } from "./style.js";
import { EffectSchema, FormulaSchema, TimeAmountSchema } from "./common.js";
import { StatusApplicationSchema } from "./skill.js";
import { BattleHookSchema, CritSpecSchema } from "./battle-hooks.js";

/**
 * 状态（Status）Schema：挂在角色身上、持续生效的东西的**统一实体**。
 *
 * 词表（2026-11-20 统一，别再混用）：
 * - **状态** = 总称，代码里一律是 `status`（`StatusEffect` / `StatusInstance` / `statuses[]`）；
 * - **天赋** = `talent`，世界授予 / 收回，无时钟、不叠层、不可驱散；
 * - **修正** = `modifier`（旧称「补正」），世界授予 / 收回，世界时间、可叠、不可驱散；
 * - **战斗状态** = `battle`，战斗内授予 / 收回，回合时钟、可叠、可驱散；
 * - **合计** = 所有状态对数值的贡献之和（`PlayerVM.statusTotals`），不叫「补正」。
 *
 * ## 三类 `kind`：谁拥有生命周期（ADR-018）
 *
 * | kind | 授予 | 收回 | 时钟 | 可驱散 | 可叠层 |
 * |---|---|---|---|---|---|
 * | `talent` 天赋 | 世界（挂载 / 事件） | 世界（显式收回） | 无 | 否 | 否 |
 * | `battle` 战斗状态 | 战斗（技能 / 回合末 / 召唤配置） | 战斗（回合耗尽 / 驱散 / 收场） | 战斗回合 | 是 | 是 |
 * | `modifier` 修正 | 世界 | 世界（治愈 / 到期） | 世界时间 | 否 | 是 |
 *
 * 「不可驱散」不是标记而是结构：战斗驱散的候选集里只有 `battle`，
 * 所以「天生」这类天赋根本不在名单上，不需要 `invincible` 字段。
 *
 * ## 面与属性
 *
 * - `attributeModifiers` 在**定义层**，不在 `simulation` 里：`effectiveAttributes()` 是
 *   模拟与战斗共用的入口（战斗建单位也走它），写在 simulation 面里既名不副实，
 *   又让 `battle` 档（禁 simulation）没法改属性。
 * - `battle` 档**禁止** `simulation` 面：它不存在于世界，写世界面就是写了个永远读不到的分支；
 *   战后后果由 `toModifier` 折算出来的状态承担。
 *
 * ## 时长
 *
 * **定义上没有任何时长**（ADR-009 D1）。时长是实例属性，由施加点给，
 * 且词表由 kind 决定：`battle` = `{ rounds }`（省略 = 整场），`modifier` = 世界时间。
 * 挂载在 `characters.yaml` / 开局参数上的视为永久。
 */

export const StatusKindSchema = z.enum(["talent", "battle", "modifier"]);
export type StatusKind = z.infer<typeof StatusKindSchema>;

export const ControlSemanticsSchema = z.enum([
  "cannot_act",
  "cannot_use_skills",
  "cannot_use_items",
  "cannot_attack",
  "cannot_flee",
  "forced_target_self",
]);

/**
 * 模拟域效果。
 *
 * ⚠️ `attributeModifiers` 已经**上提到定义层**（ADR-018 D2）——它同时影响模拟与战斗，
 * 留在这里会让「战斗态改不了属性」和「面板与结算不一致」两件事同时成立。
 *
 * ⚠️ `actionEfficiency` / `eventConditionTag` **尚未实现**：前者只有表现层在读
 * （会向玩家承诺一个引擎不结算的数字），后者全仓没有读取点。按 2026-11-20 裁决，
 * 协议字段保留、代码注释标记，但**不得在表现层呈现**；将来要用，先实现结算再上屏。
 */
export const SimulationFacetSchema = z
  .object({
    /** 未实现：不得在表现层呈现。 */
    actionEfficiency: z.record(z.string(), z.number()).optional(),
    moodDeltaPerTurn: z.number().optional(),
    /** 未实现：全仓无读取点，不得在表现层呈现。 */
    eventConditionTag: z.string().optional(),
  })
  .strict();

export const RoundEndEffectSchema = z
  .object({
    damage: FormulaSchema.optional(),
    heal: FormulaSchema.optional(),
    applyStatus: z.array(StatusApplicationSchema).optional(),
  })
  .strict()
  .refine((e) => e.damage !== undefined || e.heal !== undefined || (e.applyStatus && e.applyStatus.length > 0), {
    message: "onRoundEnd 项需要 damage/heal/applyStatus 至少其一",
  });

export const CombatFacetSchema = z
  .object({
    control: z.array(ControlSemanticsSchema).optional(),
    damageDealt: z.number().optional(),
    damageTaken: z.number().optional(),
    hitChance: z.number().optional(),
    /**
     * 闪避率（0..1，ADR-008 D1）：**命中判定之后**仍可整体落空。
     *
     * 为什么不能复用 `hitChance`：那是「掷骰修正」，而 `hitChance` 的最终值被夹在
     * `[0.05, 0.95]`——永远有 5% 会中，表达不了「无限」这种**绝对到不了**的东西。
     * 闪避是独立的一道门：先掷命中，命中了再掷闪避。
     *
     * 多来源按「至少中一个」合成 `1 - Π(1 - x)`；单一来源 `1` ⇒ 必落空。
     * 唯一的破解是技能的 `hit: "guaranteed"`（必中），见 `CombatSkillSchema.hit`。
     */
    evade: z.number().min(0).max(1).optional(),
    /**
     * 层数是否进战斗结算（ADR-012 D6），缺省 `false`（定值口径）。
     *
     * 为真时 `damageDealt / damageTaken / hitChance / costMultiplier` 乘 `stacks`，
     * `evade` 走 `1 − (1 − v)^stacks`（N 层独立门）。为什么必须显式开关：绝大多数状态要的是
     * 「叠层只影响时长」（毒、眩晕、压制），把 `stacks` 一律乘进去会让「两层眩晕」
     * 变成双倍压制，而它本来只是「更久的眩晕」。
     *
     * 天赋禁写（`stacks` 恒 1，乘 1 是死配置）。
     */
    stacksPerLayer: z.boolean().optional(),
    /**
     * 施放消耗修正（ADR-018 D3）：**按资源 key 各算各的**，同形累加。
     *
     * 结算：`cost[key] = ceil(base[key] × max(0, 1 + Σ costMultiplier[key]))`。
     * 显式向上取整是为了不让 -90% 漂成 -96%（`18 × 0.1 = 1.8`，round 会给 2、也可能会给 1；ceil 恒给 2）。
     *
     * 旧字段 `mpCostMultiplier` 是补丁式协议：技能 `cost` 早就是「mp + 任意资源」，
     * 却只给 mp 打折。key 必须是模板已声明的资源（加载期校验），否则是静默失效的 typo。
     */
    costMultiplier: z.record(z.string(), z.number()).optional(),
    onRoundEnd: z.array(RoundEndEffectSchema).optional(),
    /**
     * 暴击词条（ADR-073 D2）：与世界的默认、技能自己的声明同形累加。
     * `stacksPerLayer` 对它同样生效（每层一份）。
     */
    crit: CritSpecSchema.optional(),
    /**
     * 战斗钩子（ADR-073）：**流程**类的被动挂在这里。天赋（`kind: talent`）挂上即永久，
     * 战斗态随状态一起消失 —— 不需要第二套「谁在战斗里有效」的判定。
     */
    hooks: z.array(BattleHookSchema).optional(),
  })
  .strict();

/**
 * 属性转化（ADR-074）：把 `from` 的**最终值**按比例加到若干目标属性上，`from` 归零。
 *
 * 典型用法：把一种属性总量全部换成另外两种属性。做成通用声明而不是写死
 * 一个 id，是因为「用某种资源换另一种资源」是这套属性系统的通用句式，
 * 引擎不该知道具体是哪种资源。
 *
 * 只能挂在 `kind: talent` 上（身份级的换算，不是临时 buff）：
 * 战斗态里改属性会让同一场战斗前后半段的口径不一致（见 30-战斗.md 的裁决）。
 */
export const AttributeConversionSchema = z
  .object({
    from: z.string().min(1),
    /** 目标属性 → 比例（`to[attr] += from × ratio`）。空表没有意义。 */
    to: z
      .record(z.string().min(1), z.number())
      .refine((t) => Object.keys(t).length > 0, { message: "conversion.to 至少给一个目标属性" }),
  })
  .strict();
export type AttributeConversion = z.infer<typeof AttributeConversionSchema>;

export const CureConditionSchema = z.union([
  z.object({ item: z.string().min(1) }).strict(),
  /** 静养 N **天**痊愈（ADR-009 D7）：累计休息行动消耗的世界时间，不是休息次数。 */
  z.object({ restDays: z.number().int().positive() }).strict(),
]);

/**
 * 战斗 → 模拟的**单向**折算（ADR-018 D4）。
 *
 * 战斗态每存在一回合，离场时就在同一演员身上兑换 `timePerRound` 的世界时间。
 * 结算公式：`duration = timePerRound × max(1, roundsHeld)`。
 *
 * 为什么不做世界级的转换表、也不给 `when` / `chance`：兑换规则属于这条状态自己
 * （同一场战斗里，中毒与力竭的后遗症本来就不是一个量级），而胜负不影响结算——
 * 败北时玩家也活着（hp 保底 1）。随机性留在技能上，不给收场引入新的掷骰点。
 */
export const ToModifierSchema = z
  .object({
    /** 目标状态 id：必须是 `kind: modifier` 且已声明（加载期校验）。 */
    id: z.string().min(1),
    timePerRound: TimeAmountSchema,
  })
  .strict();

/**
 * 成长型天赋的进度条（ADR-075 §7）。
 *
 * `progress` **不是层数**：天赋实例永远一份，层数（`stacks`）在天赋上恒 1。
 * `initial` 是"授予时就有的进度"（开局自带该天赋 = 1），非成长授予不结算阶 `grant`。
 */
export const TalentProgressSchema = z
  .object({
    label: z.string().min(1).optional(),
    /** 进度上限；缺省无上限。 */
    max: z.number().positive().optional(),
    /** 初始进度；缺省 0。 */
    initial: z.number().nonnegative().optional(),
  })
  .strict()
  .refine((p) => p.max === undefined || (p.initial ?? 0) <= p.max, {
    message: "progress.initial 不能超过 progress.max",
  });
export type TalentProgress = z.infer<typeof TalentProgressSchema>;

/**
 * 阶效果是**替换**：当前阶的 `effects` 就是全部，不累加；要累加就把总数写在这一阶上。
 * `grant` 只在跨阶时结算一次（`tiersApplied` 防重复）。
 */
const TalentTierEffectsSchema = z
  .object({
    attributeModifiers: z.record(z.string(), z.number()).optional(),
    combat: CombatFacetSchema.optional(),
    grant: z.array(EffectSchema).optional(),
  })
  .strict();

export const TalentTierSchema = z
  .object({
    /** 进度阈值；`at <= progress` 的最高一阶就是当前阶。 */
    at: z.number().positive(),
    /** 品级 id（`ui.qualityStyles` 的键）。 */
    tier: z.string().min(1),
    effects: TalentTierEffectsSchema,
  })
  .strict();
export type TalentTier = z.infer<typeof TalentTierSchema>;

export const StatusEffectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    /** 三类生命周期（ADR-018）。必填，不给缺省——缺省会让「这是天赋还是临时状态」靠猜。 */
    kind: StatusKindSchema,
    /**
     * 层数语义（ADR-011 D1）：**只有两档**，因为「时长」不再是状态的属性。
     *
     * `stack`  = 再施加一次 ⇒ 层数相加；`unique` = 再施加一次 ⇒ 层数不动。
     * 两者**都**把这次施加的时长盖到实例上（最后一次说了算）。
     *
     * 天赋**禁止写这个字段**（不是写 `unique`）：连「要不要叠」这个问题都不该存在于天赋上，
     * 再授予同一个天赋 id 是幂等。其余两档必填。
     */
    stacking: z.enum(["stack", "unique"]).optional(),
    /**
     * 属性状态（ADR-018 D2）：模拟与战斗**共用**，所以放在定义层。
     * 只接受数值属性（加载期校验）；负数会让有效属性趋 0，但不会被夹穿到负值（ADR-011 D2）。
     */
    attributeModifiers: z.record(z.string(), z.number()).optional(),
    simulation: SimulationFacetSchema.optional(),
    combat: CombatFacetSchema.optional(),
    /** 战后折算（仅 `battle`）。 */
    toModifier: ToModifierSchema.optional(),
    /** 属性转化（仅 `talent`，ADR-074）：例如「资源总量 → 体术/敏捷」。 */
    conversion: z.array(AttributeConversionSchema).min(1).optional(),
    /** 成长型天赋的进度条（ADR-075 §7，仅 `talent`）。 */
    progress: TalentProgressSchema.optional(),
    /** 成长阶梯（ADR-075 §7，仅 `talent`）；没有它就是静态天赋。 */
    tiers: z.array(TalentTierSchema).min(1).optional(),
    cureConditions: z.array(CureConditionSchema).optional(),
    /**
     * 能否被**战斗内**的解除清掉（缺省 true）。只对 `battle` 档有意义：
     * 天赋在结构上不可驱散，这个字段写上去也不会让它变得可驱散。
     * 「打出来就留在身上」的层数（不可驱散）写 false。
     */
    dispellable: z.boolean().optional(),
    /** 展示标签（ADR-002 D2b）：引用 `ui.tags` 的键，顺序即展示顺序。 */
    tags: z.array(z.string().min(1)).optional(),
    visibility: z.enum(["known", "hidden"]),
    /** 品质（纯展示，模板自由定义；配合 `ui.qualityStyles` 决定样式）。 */
    quality: z.string().min(1).optional(),
    /** 样式 id：`ui.styles` 的键或引擎预设 id（ADR-002 D2），优先于 quality 映射。 */
    style: z.string().min(1).optional(),
    /**
     * 正负零（**必填**，2026-11-20 用户裁决）：决定文案动词（获得 / 陷入 / 生效）
     * 与战斗面配色（绿 / 红 / 灰）。
     *
     * 不再从 `tags` 推断 —— 标签是身份/品级的展示词（`epic` / `buff`），
     * 同一个词既当分类又当配色来源时，补一个标签就能改游戏语义。
     */
    polarity: PolaritySchema,
  })
  .strict()
  .superRefine((s, ctx) => {
    const fail = (message: string, path: (string | number)[] = []): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    };

    /**
     * 纯成长天赋（只有 `progress` + `tiers`）是合法的：它本身不改数值，
     * 只在成长时按阶发加点。典型例子是那种「打得出来是世界规则、
     * 记不记得住才是天赋的事」的里程碑，所以它没有战斗面。
     */
    const growthOnlyTalent = s.kind === "talent" && s.progress !== undefined;
    if (
      !growthOnlyTalent &&
      s.attributeModifiers === undefined &&
      s.simulation === undefined &&
      s.combat === undefined &&
      s.toModifier === undefined
    ) {
      fail("状态必须声明 attributeModifiers / simulation / combat / toModifier 至少其一（纯成长天赋除外：写 progress 即可）");
    }

    if (s.kind === "battle") {
      /**
       * 战斗态必须**在战斗里有点用**：要么有 combat 面，要么只是一张「战后折算」的兑换券
       * （`toModifier`）。`battle-blessed` 这种「战斗中什么都不做、散场才见真章」的写法
       * 是合法的 —— 它表达的是「这笔债现在不结算」。
       */
      if (s.combat === undefined && s.toModifier === undefined) {
        fail("kind: battle 需要 combat 面或 toModifier 至少其一", ["combat"]);
      }
      if (s.simulation !== undefined) {
        fail("kind: battle 不能有 simulation 面（它不存在于世界，战后后果由 toModifier 承担）", ["simulation"]);
      }
      if (s.stacking === undefined) fail("kind: battle 必须声明 stacking", ["stacking"]);
    } else {
      if (s.toModifier !== undefined) fail("toModifier 只能写在 kind: battle 上", ["toModifier"]);
      if (s.kind === "modifier" && s.stacking === undefined) fail("kind: modifier 必须声明 stacking", ["stacking"]);
    }

    if (s.kind !== "talent" && s.conversion !== undefined) {
      fail("conversion 只能写在 kind: talent 上（属性换算是身份级的，不是临时状态）", ["conversion"]);
    }

    if (s.kind === "talent") {
      if (s.stacking !== undefined) {
        fail("kind: talent 不写 stacking（天赋不叠层，再授予是幂等）", ["stacking"]);
      }
      if (s.combat?.stacksPerLayer !== undefined) {
        fail("kind: talent 不写 stacksPerLayer（stacks 恒 1，乘 1 是死配置）", ["combat", "stacksPerLayer"]);
      }
      if (s.cureConditions !== undefined) {
        fail("kind: talent 不写 cureConditions（治愈条件属于可移除的状态）", ["cureConditions"]);
      }
      if (s.dispellable !== undefined) {
        fail("kind: talent 不写 dispellable（天赋本来就不在驱散候选集里）", ["dispellable"]);
      }
    }

    /**
     * 成长阶梯（ADR-075 §7）：只有天赋能长；有阶梯就必须有进度条；
     * `at` 严格递增（重复阈值意味着同一阶两套效果）；阶阈值不得超过 `progress.max`（永远不可达）。
     */
    if (s.kind !== "talent") {
      if (s.progress !== undefined) fail("progress 只能写在 kind: talent 上", ["progress"]);
      if (s.tiers !== undefined) fail("tiers 只能写在 kind: talent 上", ["tiers"]);
    }
    if (s.tiers !== undefined) {
      if (s.progress === undefined) fail("有 tiers 必须声明 progress（阶由进度判定）", ["progress"]);
      s.tiers.forEach((tier, i) => {
        if (i > 0 && tier.at <= s.tiers![i - 1]!.at) {
          fail("tiers.at 必须严格递增", ["tiers", i, "at"]);
        }
        if (s.progress?.max !== undefined && tier.at > s.progress.max) {
          fail(`阶阈值 ${tier.at} 超过 progress.max（永远不可达）`, ["tiers", i, "at"]);
        }
        (tier.effects.grant ?? []).forEach((effect, j) => {
          // 递归成长会让"结算一次 grant"变成不可终止的循环；要连续涨就一次给足 amount。
          if (effect.type === "advanceTalent") {
            fail("tiers[].effects.grant 不能再用 advanceTalent", ["tiers", i, "effects", "grant", j]);
          }
        });
      });
    }
  });

export type StatusEffect = z.infer<typeof StatusEffectSchema>;
export type ControlSemantics = z.infer<typeof ControlSemanticsSchema>;
export type ToModifier = z.infer<typeof ToModifierSchema>;
