import { z } from "zod";
import { FormulaSchema } from "./common.js";
import { StatusApplicationSchema } from "./skill.js";

/**
 * 补正（buff/debuff 统称）Schema：单定义双面。
 * - simulation 面：模拟域效果，轮次引擎读取；缺省 = 战斗结束清除。
 * - combat 面：战斗域效果，战斗状态机读取；缺省 = 不带入战斗。
 * - 至少定义其一（refine）。
 * 转换规则为引擎固定逻辑（见规格 6.2），Schema 不表达。
 */

export const ControlSemanticsSchema = z.enum([
  "cannot_act",
  "cannot_use_skills",
  "cannot_use_items",
  "cannot_attack",
  "cannot_flee",
  "forced_target_self",
]);

export const SimulationFacetSchema = z
  .object({
    attributeModifiers: z.record(z.string(), z.number()).optional(),
    actionEfficiency: z.record(z.string(), z.number()).optional(),
    moodDeltaPerTurn: z.number().optional(),
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
    onRoundEnd: z.array(RoundEndEffectSchema).optional(),
    /** 战斗内寿命：N 个战斗回合后失效；缺省整场有效 */
    battleRounds: z.number().int().positive().optional(),
  })
  .strict();

export const DurationSchema = z.union([
  z.object({ turns: z.number().int().positive() }).strict(),
  z.object({ untilCured: z.literal(true) }).strict(),
]);

export const CureConditionSchema = z.union([
  z.object({ item: z.string().min(1) }).strict(),
  z.object({ restTurns: z.number().int().positive() }).strict(),
]);

export const StatusEffectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    duration: DurationSchema,
    stacking: z.enum(["refresh", "stack", "unique"]),
    simulation: SimulationFacetSchema.optional(),
    combat: CombatFacetSchema.optional(),
    cureConditions: z.array(CureConditionSchema).optional(),
    visibility: z.enum(["known", "hidden"]),
  })
  .strict()
  .refine((s) => s.simulation !== undefined || s.combat !== undefined, {
    message: "补正必须定义 simulation 或 combat 至少其一",
  });

export type StatusEffect = z.infer<typeof StatusEffectSchema>;
export type ControlSemantics = z.infer<typeof ControlSemanticsSchema>;
