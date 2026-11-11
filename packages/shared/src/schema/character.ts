import { z } from "zod";
import { RelationDeclSchema } from "./relation.js";

/**
 * 角色 Schema：玩家初始模板 / NPC / 敌人角色共用。
 * 性别取值来自 world.genders 自定义枚举（引用完整性在 world.ts 顶层校验）。
 * 心情为角色计量条（非补正）；public/private 资料分层支撑信息可见性。
 */

export const GenderDefSchema = z
  .object({ id: z.string().min(1), label: z.string().min(1) })
  .strict();

export const IdentitySchema = z
  .object({
    name: z.string().min(1),
    age: z.number().int().nonnegative(),
    gender: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();

export const MoodValueSchema = z
  .object({ value: z.number() })
  .strict();

export const CharacterSchema = z
  .object({
    id: z.string().min(1),
    isEnemy: z.boolean(),
    identity: IdentitySchema,
    visibility: z.enum(["public", "hidden"]),
    mood: MoodValueSchema,
    attributes: z.record(z.string(), z.number()),
    /** 角色初始持有的技能（NPC/敌人同样适用；引用完整性在 world.ts 顶层校验） */
    skills: z.array(z.string().min(1)).optional(),
    /** 角色初始携带的补正（如五条的六眼；NPC/敌人同样适用，引用完整性在 world.ts 顶层校验） */
    statuses: z.array(z.string().min(1)).optional(),
    public: z
      .object({
        personality: z.string().optional(),
        knownGoals: z.array(z.string()).optional(),
      })
      .strict(),
    private: z
      .object({
        secrets: z.array(z.string()).optional(),
        knowledge: z.array(z.string()).optional(),
        /** NPC 长期目标标签（效用评分 goalMatch 用，不进投影） */
        goals: z.array(z.string()).optional(),
        /** NPC 性格标签（效用评分 traitAffinity 用，不进投影） */
        traits: z.array(z.string()).optional(),
        /** 敌人角色的战斗行为参数（敌人 AI 权重策略等） */
        combatHints: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    relationship: z.number().min(-100).max(100),
    /**
     * R2.6 / ADR-0014：初始关系边声明（可选；from 隐含为该角色自身）。
     * relationship 标量保留为「NPC→玩家」便捷投影，新代码优先读关系边。
     * visibility 缺省 unknown（R-OP-05：默认不认识）。
     */
    relations: z.array(RelationDeclSchema).optional(),
  })
  .strict();

export type Character = z.infer<typeof CharacterSchema>;
export type GenderDef = z.infer<typeof GenderDefSchema>;
