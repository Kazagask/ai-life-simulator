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
    /**
     * 「这是不是战斗对手」。**不实例化**：`turn.ts` 建世界时整类跳过，
     * 所以敌人没有 `state.npcs` 条目，也不会跑 NPC 自主行动、不上 NPC 卡。
     * 战斗只按 `settle.combat.enemies[].ref` 直接引用它。
     *
     * 代价（2026-11-16 用户裁决接受）：敌人不能当关系边的端点 —— 它不在实例表里。
     * 「惠 ↔ 甚尔」这类跨敌我关系要靠**关系投影与 NPC 投影解耦**来表达（见 projection.ts）。
     */
    isEnemy: z.boolean(),
    identity: IdentitySchema,
    /** 展示门：`hidden` ⇒ 不进 NPC 卡列表（前提仍是它有实例；敌人根本没有实例）。 */
    visibility: z.enum(["public", "hidden"]),
    /**
     * 初始生命周期（ADR-0020）。缺省 = 在世；用于「开局已故/失踪」的角色（如回忆里的死者）。
     * 只在这里声明**初始态**，运行时变更走效果 `setNpcLifecycle`。
     */
    lifecycle: z
      .object({
        state: z.enum(["alive", "inactive", "unspawned"]),
        reasonCode: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
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
    /**
     * **大众认知的生父**（不是"名分父"）——见 `docs/FAMILY-GRAPH.md` §3.1。
     * 指向 `characters[].id`，必须存在（引用完整性在 world.ts 顶层校验），不得指向自己。
     * 缺省 = 不详（不编）。
     *
     * ⚠ **本轮只是铺路**：字段入契约、建局时复制进实例，但**没有任何推导读它** ——
     * 亲缘仍由 `extensions/family` 从关系边推导（模式一）。指针成为唯一真源是后续轮次的事。
     */
    fatherId: z.string().min(1).optional(),
    /** **大众认知的生母**。同上：指向已声明角色，缺省 = 不详，本轮不参与推导。 */
    motherId: z.string().min(1).optional(),
  })
  .strict();

export type Character = z.infer<typeof CharacterSchema>;
export type GenderDef = z.infer<typeof GenderDefSchema>;
