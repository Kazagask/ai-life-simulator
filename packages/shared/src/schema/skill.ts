import { z } from "zod";
import { CombatDurationSchema, EffectSchema, FormulaSchema } from "./common.js";
import { BattleHookSchema, CritSpecSchema } from "./battle-hooks.js";

/**
 * 技能 Schema：战斗技能（消耗/命中/伤害/施加状态/冷却）与通用技能（解锁选项/效率/熟练度）。
 * 以 kind 判别联合。
 */

export const OpposedCheckSchema = z
  .object({
    preset: z.literal("opposed"),
    attacker: z.string().min(1),
    defender: z.string().min(1),
    baseChance: z.number().min(0).max(1),
  })
  .strict();

/**
 * 施加点收件人（ADR-006 D1）。
 *
 * 为什么必须显式：一个技能可以同时往**不同阵营**写状态 —— 同一招可以给自己挂增幅、
 * 给全场敌人挂压制与眩晕。只写「技能目标」时这条信息是**推不出来**的：技能目标是
 * `all_enemies`，可自身增幅明明落在自己身上。旧字段 `onSelf` 只能表达「自己 vs 技能目标」
 * 两档，且它在目标循环里执行 ⇒ 打三个敌人就给自身上三层（同一个增幅叠三次）。
 *
 * · `self`：施放者本人。**不参与命中判定**（命中是打人的事，不是挂自己的事），只走 `chance`。
 * · `skill`（缺省）：技能目标，逐个结算，走技能命中。
 * · `all_enemies` / `all_allies`：**施放者视角**的全场敌方 / 我方（施放者是敌人时，
 *   「敌方」就是玩家与友军）。逐个结算，不重复跑技能的命中判定，只走 `chance`。
 */
export const StatusApplyTargetSchema = z.enum(["self", "skill", "all_enemies", "all_allies"]);
export type StatusApplyTarget = z.infer<typeof StatusApplyTargetSchema>;

/**
 * 召唤单位的档位（ADR-012 D2）。
 *
 * `minion` = 一般咒灵 / 杂兵：前端三分之一宽的小框，缺省上限 3；
 * `hero`   = 虹龙 / 魔虚罗这类：前端与真实战斗角色一致，缺省上限 1。
 *
 * 放在单位上而不是技能上：同一只召唤物可能被两种技能叫出来（收集 vs 献祭），
 * 它的「大小」是它自己的属性。
 */
export const SummonTierSchema = z.enum(["minion", "hero"]);
export type SummonTier = z.infer<typeof SummonTierSchema>;

/**
 * 召唤物的阵营（ADR-014 D1）。
 *
 * 只有两档，因为战场上能站的就这两种「你的」与「不是你的」：
 * `summoner` = 跟随施放者（友军召的进友军、敌人召的进敌人），`neutral` = 进中立项。
 * 敌人召唤物不需要单独一档 —— 施放者是敌人，`summoner` 自然落进敌人。
 */
export const SummonFactionSchema = z.enum(["summoner", "neutral"]);
export type SummonFaction = z.infer<typeof SummonFactionSchema>;

/**
 * 召唤声明（ADR-012 D1 / ADR-013 简化）。
 *
 * 一句话：**技能点名，单位自己活**。`ref` 指向角色定义（`characters.yaml`），引擎拿那张卡
 * 现场实例化 —— 召唤物与开场单位同源，不存在第二套迷你数值。
 *
 * ADR-013 砍掉的东西（都不再需要）：
 * - 没有 `consume`：召唤**不烧资源**。杂兵是兵力不是库存（D2），英雄是个体（D3）——
 *   两者的稀缺性都不靠池子维持，前者靠场上的 `limit`，后者靠永久损失。
 * - 没有 `refundOnDeath`：没有东西可退。死在场上就是死了；英雄还会进 `state.lostSummons`。
 *
 * 上限按**档**统计（同召唤者的存活召唤物），所以「三只杂兵混编」成立。
 * **上限是召唤规则，不是技能参数**（2026-11-20 用户裁决）：档位决定场上最多几只
 * （minion 3 / hero 1，唯一出口 `SUMMON_TIER_LIMITS`），技能只声明「一次几只」（`count`）
 * 与「这一批有多强」（`levelScale`）。技能再写 `limit` 会被 `.strict()` 拒载 ——
 * 因为「同一个数写两处」正是上限和实际召唤数对不上的来源。
 * `onSummonerDown` 缺省 `dismiss`：术式绑的式神随主人倒下消失，独立的召唤物写 `stay`。
 */
export const SummonSpecSchema = z
  .object({
    ref: z.string().min(1),
    count: z.number().int().positive().max(5).optional(),
    tier: SummonTierSchema.optional(),
    levelScale: z.number().positive().optional(),
    /**
     * 它站哪边（ADR-014 D1）：缺省 `summoner` = 施放者阵营；`neutral` = 进 `battle.neutrals`。
     *
     * 与 `target` 是两件事：`target` 是「这一发打谁」，`faction` 是「叫出来的东西听谁的」。
     * 未调伏的魔虚罗两者都属于「不听话」那一档：召出来站中间，玩家和敌人一起打。
     *
     * 中立的召唤物**不参与胜负**（它不在 `enemies` 里）—— 打死它不会白送一场胜利，
     * 这正是 B-07 拒绝「塞进 enemies 再加一条不死判定」的原因。
     */
    faction: SummonFactionSchema.optional(),
    /** 召唤者倒下时：`dismiss`（缺省）一并消失；`stay` 独立留场 */
    onSummonerDown: z.enum(["dismiss", "stay"]).optional(),
  })
  .strict();

/**
 * 召回（取消召唤，ADR-012 D1 / ADR-013 D4）。
 *
 * 收回的单位进 `battle.bench`，**状态原样保留**（血量、状态、冷却、入场回合）——
 * 同一场战斗里再喊一次就原位回来。没有返还字段，因为召唤本来就不花钱。
 */
export const RecallSpecSchema = z
  .object({
    count: z.number().int().positive().max(9).optional(),
  })
  .strict();

/**
 * 献祭（ADR-013 D5）：把**场上自己召来的单位**当消耗品烧掉，换来这一击的威力。
 *
 * 与已删的 `consumeResource` 的区别：那条路烧的是「库存计数」，这条烧的是**单位本身**。
 * 没有池子之后「我有几只」就等于「场上有几只」，不需要再维护一份计数 ——
 * 少一份状态，就少一处能对不上的地方。
 *
 * `perTier` 是**每一档单位折多少伤害**：虹龙与杂兵当然是两个价（用户口径：
 * 「献祭虹龙和杂兵伤害要不一样」），而这个差价属于技能不属于单位 ——
 * 同一只杂兵被不同术式烧掉，能换来的东西本来就不一样。
 */
export const SacrificeSpecSchema = z
  .object({
    /** 烧几支：缺省 `all`（倾尽）。写数字时取不到那么多就烧几只算几只。 */
    count: z.union([z.literal("all"), z.number().int().positive()]).optional(),
    /** 每档单位折合的伤害。没写的档按 0 算。 */
    perTier: z
      .object({
        minion: z.number().nonnegative().optional(),
        hero: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const StatusApplicationSchema = z
  .object({
    status: z.string().min(1),
    chance: z.number().min(0).max(1).optional(),
    stacks: z.number().int().positive().optional(),
    /** 缺省 `skill`（技能目标）。见 `StatusApplyTargetSchema`。 */
    target: StatusApplyTargetSchema.optional(),
    /**
     * @deprecated 等价 `target: "self"`（ADR-006 D1）。为旧模板保留解析，新写法一律用 `target`。
     * 与 `target` 同时出现且指向不同收件人 ⇒ 拒载（两处说法打架，不猜哪个优先）。
     */
    onSelf: z.boolean().optional(),
    /**
     * **施加点**的时长（ADR-018 D5），省略 = 整场战斗。
     *
     * 「多久」是这次施加的属性，不是状态类型的属性：同一个「眩晕」，杂兵打中一回合、
     * BOSS 打中三回合。状态定义上没有任何时长（D1），所以这里没有可继承的默认值。
     *
     * 只接受 `{ rounds }`：战斗域不再能写世界时间（旧 `{ value, unit }` 那 16 处
     * 「打完之后还持续」由状态定义上的 `toModifier` 单向折算承担）。
     * 只能引用 `kind: battle` 的状态 —— 加载期校验，见 `world.ts`。
     */
    duration: CombatDurationSchema.optional(),
  })
  .strict()
  .superRefine((app, ctx) => {
    if (app.onSelf === undefined || app.target === undefined) return;
    const fromOnSelf = app.onSelf ? "self" : "skill";
    if (fromOnSelf !== app.target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: `onSelf 与 target 冲突（onSelf=${String(app.onSelf)} ⇒ ${fromOnSelf}，target=${app.target}）`,
      });
    }
  });

/**
 * 合法目标（2026-11-20 用户裁决）：**目标不合法就不能放**，不是「放了没效果」。
 *
 * 流程是「先选目标、再点技能」：技能声明 `legalTarget` 后，选中不满足条件的单位会
 * 直接把这一招置灰，并显示 `disableReason`。第一个（也是目前唯一）谓词是
 * `summonedBy: self` —— 收灵只能选中**自己的**召唤物，选自己 / 真实友军 / 别人的召唤物
 * 都不是合法目标。
 *
 * 形状留成可扩展：以后要「只能选带某状态的单位」时加字段，而不是再写一个 if。
 */
export const LegalTargetSchema = z
  .object({
    /** 只接受「召唤者是施放者自己」的单位。 */
    summonedBy: z.literal("self").optional(),
    /** 选到非法目标时给玩家看的固定文案（不拼接）。 */
    disableReason: z.string().min(1).optional(),
  })
  .strict();
export type LegalTarget = z.infer<typeof LegalTargetSchema>;

/**
 * 技能目标词表（唯一来源）。
 *
 * `ally` 是**单个友军**、`all_allies` 是**全体友军**；`none` 是**无目标**
 * （召唤 / 收灵）—— 无目标不等于「对自己施法」：它跳过整个目标循环，
 * 只跑技能自己声明的那部分（`summon` / `recall` / `applyStatus.target: self`）。
 *
 * 单独导出是因为战斗 AI 的 `includeTargets` / `excludeTargets` 也按这套词表过滤。
 * 两处各写一份枚举，迟早出现「AI 认识、引擎不认识」的目标类型。
 */
/**
 * 召唤名额缺省（世界没写 `summonLimits` 时）：**按档共享**，不是每个召唤物一份。
 * 唯一出口 `summonLimitOfTier` —— 引擎、投影、展示文案都从这里取，避免三处各写一份数字。
 */
export const SUMMON_TIER_LIMITS = { minion: 3, hero: 1 } as const;

export function summonLimitOfTier(
  tier: "minion" | "hero" | undefined,
  template?: { summonLimits?: { minion?: number; hero?: number } | undefined },
): number {
  const key = tier ?? "minion";
  return template?.summonLimits?.[key] ?? SUMMON_TIER_LIMITS[key];
}

export const SkillTargetSchema = z.enum([
  "enemy",
  "self",
  "ally",
  "all_allies",
  "all_enemies",
  "none",
]);
export type SkillTarget = z.infer<typeof SkillTargetSchema>;

export const CombatSkillSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("combat"),
    name: z.string().min(1),
    description: z.string().optional(),
    /**
     * 施放消耗（ADR-003 D9）：`mp` 仍必填（可写 0），其余键必须是已声明的自定义资源
     * （如 `beans: 3`）。加载期校验键集，运行期逐项检查与扣除。
     */
    cost: z.object({ mp: z.number().nonnegative() }).catchall(z.number().nonnegative()),
    target: SkillTargetSchema,
    /** 合法目标判定（缺省 = 任意目标都合法）。 */
    legalTarget: LegalTargetSchema.optional(),
    /**
     * 命中词表（ADR-008 D1）。缺省 = 按 `hitCheck` 掷骰；没有 `hitCheck` 就只掷满值。
     *
     * `guaranteed` = **必中**：跳过命中判定**与**对方闪避（`combat.evade`）。
     * 这是底层词表，与世界观无关——范围必中、无视闪避的斩击、强行解除都走这一条。
     * 没有它就表达不了「无限」：闪避 100% 的东西只有必中能碰到。
     */
    hit: z.literal("guaranteed").optional(),
    hitCheck: OpposedCheckSchema.optional(),
    damage: z.array(FormulaSchema).optional(),
    heal: z.array(FormulaSchema).optional(),
    applyStatus: z.array(StatusApplicationSchema).optional(),
    /** 施放结算后移除施放者自身该状态（献祭类技能：打出去就把存货清掉） */
    consumeStatus: z.object({ status: z.string().min(1) }).strict().optional(),
    /** 召唤（ADR-012 D1）：战斗中动态入场，落进施放者同阵营。 */
    summon: SummonSpecSchema.optional(),
    /** 召回到 `battle.bench`（ADR-013 D4）：收回不返还、状态保留，再召就原位回来。 */
    recall: RecallSpecSchema.optional(),
    /**
     * 献祭自己召来的单位（ADR-013 D5）：旋涡把场上的全烧了换成伤害。
     * 在伤害之前结算 —— 烧掉的那几只正是这一击威力的来源。
     */
    sacrifice: SacrificeSpecSchema.optional(),
    /**
     * 结算后回复资源池（ADR-012 D9）。
     *
     * 注意它不是「自然恢复」：专属池（`characters[].resources`）不随休息 / 时间 / 回合回复，
     * 想涨只能靠这一条或事件效果显式给。咒灵操术已不用（ADR-013 撤掉了池子），
     * 留着是给「打中就吸取」这类需要计数的术式用的。
     */
    gainResource: z
      .object({ resource: z.string().min(1), amount: z.number().int().positive() })
      .strict()
      .optional(),
    cooldownTurns: z.number().int().nonnegative(),
    usableInBattle: z.literal(true),
    quality: z.string().min(1).optional(),
    style: z.string().min(1).optional(),
    /**
     * 技能自带的暴击词条（ADR-073 D2）：与状态/世界默认累加，`chance: 1` 即必暴。
     * 只影响这一招的 `damage`。
     */
    crit: CritSpecSchema.optional(),
    /**
     * 技能自带的战斗钩子（ADR-073）：只在这**一招**的结算里收集，其余时刻不存在。
     * 咒具「命中时解除术式」写在这里，不写成一个独立的常驻光环。
     */
    hooks: z.array(BattleHookSchema).optional(),
  })
  .strict();

export const GeneralSkillSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("general"),
    name: z.string().min(1),
    description: z.string().optional(),
    unlocksOptions: z.array(z.string().min(1)).optional(),
    efficiency: z
      .object({ key: z.string().min(1), bonus: z.number() })
      .strict()
      .optional(),
    proficiency: z
      .object({ maxLevel: z.number().int().positive(), growthPerUse: z.number().positive() })
      .strict()
      .optional(),
    quality: z.string().min(1).optional(),
    style: z.string().min(1).optional(),
  })
  .strict();

export const SkillSchema = z
  .discriminatedUnion("kind", [CombatSkillSchema, GeneralSkillSchema])
  .superRefine((s, ctx) => {
    if (s.kind !== "combat") return;
    // 必中与命中骰互斥：写了 `hit: guaranteed` 又一并写 `hitCheck`，两个说法打架 ——
    // 不猜哪个优先（同 `onSelf`/`target` 的处置），直接拒载。
    if (s.hit === "guaranteed" && s.hitCheck !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hit"],
        message: "hit: guaranteed 与 hitCheck 冲突（必中不掷命中骰）",
      });
    }
    const hasEffect =
      (s.damage && s.damage.length > 0) ||
      (s.heal && s.heal.length > 0) ||
      (s.applyStatus && s.applyStatus.length > 0) ||
      s.summon !== undefined ||
      s.recall !== undefined ||
      s.sacrifice !== undefined ||
      s.gainResource !== undefined;
    if (!hasEffect) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["damage"],
        message: "战斗技能需要至少定义 damage/heal/applyStatus/summon/recall/sacrifice 之一",
      });
    }
  });

export type Skill = z.infer<typeof SkillSchema>;
export type CombatSkill = z.infer<typeof CombatSkillSchema>;
export type GeneralSkill = z.infer<typeof GeneralSkillSchema>;
export type StatusApplication = z.infer<typeof StatusApplicationSchema>;
export type SummonSpec = z.infer<typeof SummonSpecSchema>;
export type RecallSpec = z.infer<typeof RecallSpecSchema>;
export type SacrificeSpec = z.infer<typeof SacrificeSpecSchema>;
export type { EffectSchema };
