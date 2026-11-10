import { z } from "zod";
import { EffectSchema, FormulaSchema } from "./common.js";

/**
 * 技能 Schema：战斗技能（消耗/命中/伤害/施加补正/冷却）与通用技能（解锁选项/效率/熟练度）。
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

export const StatusApplicationSchema = z
  .object({
    status: z.string().min(1),
    chance: z.number().min(0).max(1).optional(),
    stacks: z.number().int().positive().optional(),
    /** 缺省施加给技能目标；true 时施加给施放者自身（如收集类技能给自身叠层） */
    onSelf: z.boolean().optional(),
  })
  .strict();

export const CombatSkillSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("combat"),
    name: z.string().min(1),
    description: z.string().optional(),
    cost: z.object({ mp: z.number().nonnegative() }).strict(),
    target: z.enum(["enemy", "self", "ally", "all_enemies"]),
    hitCheck: OpposedCheckSchema.optional(),
    damage: z.array(FormulaSchema).optional(),
    heal: z.array(FormulaSchema).optional(),
    applyStatus: z.array(StatusApplicationSchema).optional(),
    /** 施放结算后移除施放者自身该补正（献祭类技能，如漩涡消耗收集咒灵） */
    consumeStatus: z.object({ status: z.string().min(1) }).strict().optional(),
    cooldownTurns: z.number().int().nonnegative(),
    usableInBattle: z.literal(true),
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
  })
  .strict();

export const SkillSchema = z
  .discriminatedUnion("kind", [CombatSkillSchema, GeneralSkillSchema])
  .superRefine((s, ctx) => {
    if (s.kind !== "combat") return;
    const hasEffect =
      (s.damage && s.damage.length > 0) ||
      (s.heal && s.heal.length > 0) ||
      (s.applyStatus && s.applyStatus.length > 0);
    if (!hasEffect) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["damage"], message: "战斗技能需要至少定义 damage/heal/applyStatus 之一" });
    }
  });

export type Skill = z.infer<typeof SkillSchema>;
export type CombatSkill = z.infer<typeof CombatSkillSchema>;
export type GeneralSkill = z.infer<typeof GeneralSkillSchema>;
export type { EffectSchema };
