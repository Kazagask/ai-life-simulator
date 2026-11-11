import { z } from "zod";

/**
 * R2.6 关系图谱（ADR-0014）：NPC↔NPC / NPC↔玩家统一为有向边 `RelationEdge`。
 *
 * 语义约定：`kind` 描述 **from → to** 的关系——
 * `{ from: A, to: B, kind: "father" }` 读作「B 是 A 的父亲」。
 * 多跳中文称谓只沿亲属边推导（kind ∈ KinshipKind，与 relationship.js 关系链记号对齐）；
 * 社会边（mentor/friend/...）只作图查询与叙事标签，不进称谓推导。
 *
 * 可见性（R-OP-05）：默认 `unknown`（不得默认所有 NPC 都认识主角/彼此）；
 * `known`/`inferred` 进玩家投影，`unknown`/`hidden` 不进（hidden 来源不泄露）。
 */

/** 玩家节点在关系图中的固定 id（NPC↔玩家边与 NPC↔NPC 边同构表达）。 */
export const PLAYER_ID = "player";

/** 亲属边：与 relationship.js 关系链记号一一对应，多跳称谓只沿这些边推导。 */
export const KinshipKindSchema = z.enum([
  "father",
  "mother",
  "son",
  "daughter",
  "husband",
  "wife",
  "elder-brother",
  "younger-brother",
  "elder-sister",
  "younger-sister",
]);

/** 社会边：无亲属语义；遍历取反向时有配对（mentor↔disciple），对称 kind 取自身。 */
export const SocialKindSchema = z.enum([
  "mentor",
  "disciple",
  "friend",
  "rival",
  "enemy",
  "colleague",
]);

export const RelationKindSchema = z.union([KinshipKindSchema, SocialKindSchema]);

/** 关系可见性：known（明确相识）/ inferred（推断得知）/ unknown（默认不认识）/ hidden（对玩家隐藏，来源不泄露）。 */
export const RelationVisibilitySchema = z.enum(["known", "inferred", "unknown", "hidden"]);

/** 边来源（事实追溯）：模板初始声明 / 效果运行时建立。 */
export const RelationSourceSchema = z.enum(["template", "effect"]);

/** 实例层关系边（WorldStateV2.relations；配置域不复制，运行时追加）。 */
export const RelationEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    kind: RelationKindSchema,
    source: RelationSourceSchema,
    visibility: RelationVisibilitySchema,
    /** 关系强度（-100..100，与旧 npc.relationship 标量同域；可被 adjustRelation 调整） */
    value: z.number().min(-100).max(100).optional(),
    /** 谱系断代标记：边为「据称的远亲」等不可精确推导代数的连接（出粗称谓，不猜代数） */
    gap: z.boolean().optional(),
    /** 冻结：一端角色已死亡，边不再被 adjustRelation 改动；仍参与称谓推导（逝者仍是亲属）。 */
    frozen: z.boolean().optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.from === e.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "关系边不允许自环" });
    }
  });

/** 配置层声明（characters.yaml，from 隐含为该角色自身）：visibility 缺省 unknown（R-OP-05）。 */
export const RelationDeclSchema = z
  .object({
    to: z.string().min(1),
    kind: RelationKindSchema,
    visibility: RelationVisibilitySchema.optional(),
    value: z.number().min(-100).max(100).optional(),
    gap: z.boolean().optional(),
  })
  .strict();

export type KinshipKind = z.infer<typeof KinshipKindSchema>;
export type SocialKind = z.infer<typeof SocialKindSchema>;
export type RelationKind = z.infer<typeof RelationKindSchema>;
export type RelationVisibility = z.infer<typeof RelationVisibilitySchema>;
export type RelationEdge = z.infer<typeof RelationEdgeSchema>;
export type RelationDecl = z.infer<typeof RelationDeclSchema>;
