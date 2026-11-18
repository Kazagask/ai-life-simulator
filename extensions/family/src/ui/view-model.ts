import { z } from "zod";
import type { ClanView, PedigreeView } from "../contract.js";

/**
 * 家族扩展**自己的**前端契约（`docs/EXTENSIONS.md` §7.1 第 2 条）。
 *
 * 宿主不再认识 `pedigree` / `clans`：`ViewModel.extensions.family` 是一个 `unknown` 切片，
 * 由本文件用 zod 校验成扩展自己的视图模型。字段口径与引擎的 `PedigreeView` / `ClanView`
 * 同形（服务端已算好世代 / 生死态 / 计数），这里只做形状校验，不重算。
 *
 * 注意：`PedigreeEdgeVM` **没有** `back`、`PedigreeNodeVM` **没有** `cyclic` ——
 * 回边不再下发（§7.4），schema 里也没有它们的容身处（`.strict()` 会直接拒绝）。
 */

/** 族谱节点（`extensions/family/doc/CLAN-DESIGN.md` §1.5/§1.6）。 */
export const PedigreeNodeVMSchema = z
  .object({
    /** 关系图节点 id。**仅作 React key / 跳转键**，不能当人名显示。 */
    id: z.string(),
    /** 显示名（服务端已从 actor 目录解析；绝不是裸 id）。 */
    name: z.string(),
    isSelf: z.boolean(),
    /** `false` ⇒ 没有档案：展示层标「无档案」，点了不跳转。 */
    hasCard: z.boolean(),
    genderLabel: z.string(),
    age: z.number(),
    lifeStageLabel: z.string(),
    /** 世代号（0 = 始祖，只按血缘）。 */
    generation: z.number(),
    generationBasis: z.enum(["blood", "marriage", "root"]).optional(),
    lifecycle: z
      .object({
        state: z.enum(["alive", "inactive", "unspawned"]),
        reasonCode: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type PedigreeNodeVM = z.infer<typeof PedigreeNodeVMSchema>;

/** 族谱边（`from` / `to` 只是 id，展示层用 `kind` 选线型）。回边不下发，故无 `back`。 */
export const PedigreeEdgeVMSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    kind: z.enum(["parent", "spouse", "sibling"]),
    parentRole: z.enum(["father", "mother"]).optional(),
    affinal: z.boolean().optional(),
    step: z.boolean().optional(),
    derived: z.boolean().optional(),
  })
  .strict();
export type PedigreeEdgeVM = z.infer<typeof PedigreeEdgeVMSchema>;

/** 族谱视图模型：世代自上而下、同代横排、配偶相邻。 */
export const PedigreeVMSchema = z
  .object({
    rootIds: z.array(z.string()),
    nodes: z.array(PedigreeNodeVMSchema),
    edges: z.array(PedigreeEdgeVMSchema),
    generationRange: z.object({ min: z.number(), max: z.number() }).strict(),
    /** 有人的父/母被判隐藏 ⇒ 展示层画 "?"，不编一个根。 */
    incomplete: z.boolean().optional(),
    /** 被规模上限截断过。 */
    truncated: z.boolean().optional(),
    /** 说不清代数的远亲（不进树）。 */
    looseEnds: z
      .array(z.object({ id: z.string(), name: z.string(), gap: z.literal(true) }).strict())
      .optional(),
  })
  .strict();
export type PedigreeVM = z.infer<typeof PedigreeVMSchema>;

/** 宗族家主（`extensions/family/doc/CLAN-DESIGN.md` §2.4）。`id` 仅作 key / 跳转键，不显示。 */
export const ClanHeadVMSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** false ⇒ 点不了（与 `RelationList` 的 `rel-nocard` 同口径）。 */
    hasCard: z.boolean(),
    isSelf: z.boolean(),
    /** 已故家主仍在任：照常显示，展示层可加「已故」标记。 */
    alive: z.boolean(),
  })
  .strict();
export type ClanHeadVM = z.infer<typeof ClanHeadVMSchema>;

/** 一条大事记：`text` 原样来自 state（**不实时调 LLM 复述史**）。 */
export const ClanHistoryVMSchema = z
  .object({
    at: z.number(),
    formattedAt: z.string(),
    kind: z.string(),
    text: z.string(),
  })
  .strict();
export type ClanHistoryVM = z.infer<typeof ClanHistoryVMSchema>;

export const ClanLegacyVMSchema = z
  .object({ id: z.string(), name: z.string(), unlocked: z.boolean() })
  .strict();
export type ClanLegacyVM = z.infer<typeof ClanLegacyVMSchema>;

/**
 * 宗族视图模型：每个族一张卡片（竖屏可用，不画图）。
 *
 * 计数是**玩家视角**的（不含隐藏成员 / 离族者）；`memberCount` 含已故。
 * 血缘看族谱、归族看这里 —— 两者冲突时**显示冲突**，不在展示层消解。
 */
export const ClanVMSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    seat: z.string().optional(),
    status: z.enum(["active", "extinct", "exiled"]),
    prestige: z.number(),
    head: ClanHeadVMSchema.optional(),
    livingCount: z.number(),
    memberCount: z.number(),
    selfRelation: z.enum(["head", "member", "affine", "outsider"]),
    selfStanding: z.string().optional(),
    legacies: z.array(ClanLegacyVMSchema).optional(),
    history: z.array(ClanHistoryVMSchema),
  })
  .strict();
export type ClanVM = z.infer<typeof ClanVMSchema>;

/**
 * `vm.extensions.family` 的切片（服务端 `FamilyView` 的原样透传）。
 *
 * 切片层**不 strict**：将来服务端加字段不该让前端整块黑屏（扩展只取自己认识的字段）。
 * 内层 `pedigree` / `clans` 仍 strict —— 那是扩展与派生器之间的真契约。
 */
export const FamilyUiSliceSchema = z.object({
  /** 玩家当前在族的宗族 id；本 UI 暂不使用，声明出来只为把切片描述完整。 */
  selfClanIds: z.array(z.string()).optional(),
  pedigree: PedigreeVMSchema.optional(),
  clans: z.array(ClanVMSchema),
});
export type FamilyUiSlice = z.infer<typeof FamilyUiSliceSchema>;

/**
 * 编译期防漂移：zod 推出来的视图模型必须仍是快照契约的超集形状。
 * 改了 `contract.ts` 却忘了改 schema（或反过来）时，这里先红，而不是运行时画出半张图。
 */
type Assert<T extends true> = T;
export type _PedigreeVMMatchesContract = Assert<PedigreeVM extends PedigreeView ? true : false>;
export type _ClanVMMatchesContract = Assert<ClanVM extends ClanView ? true : false>;
