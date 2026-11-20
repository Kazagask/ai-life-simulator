import { z } from "zod";

/**
 * R2.6 关系图谱（ADR-0014）：NPC↔NPC / NPC↔玩家统一为有向边 `RelationEdge`。
 *
 * 语义约定：`kind` 描述 **from → to** 的关系——
 * `{ from: A, to: B, kind: "father" }` 读作「B 是 A 的父亲」。
 * 多跳中文称谓只沿亲属边推导（kind ∈ KinshipKind，与 relationship.js 关系链记号对齐）；
 * 社会边（mentor/friend/...）只作图查询与叙事标签，不进称谓推导。
 *
 * 知情人范围（2026-11-19 用户裁决，ADR-007 D3）：关系是**世界事实**，
 * 谁掌握它由 `scope` 决定，不再由「玩家视角的可见性」决定 ——
 * 后者把玩家写进了事实本身，做玩家/NPC 视角切换时会立刻失真。
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
  /**
   * 未指明代数的亲属（如「据称是远亲」）。配 `gap: true` 使用 ⇒ 只出粗称谓「远亲」，
   * 不猜代数。专属关系链记号为「亲戚」，relationship.js 无此词条时会自然回退粗称谓。
   */
  "relative",
]);

/** 社会边：无亲属语义；遍历取反向时有配对（mentor↔disciple），对称 kind 取自身。 */
export const SocialKindSchema = z.enum([
  "mentor",
  "disciple",
  "friend",
  "rival",
  "enemy",
  "colleague",
  /**
   * 恋人（2026-11-19 增量，2026-11-19 裁决「kind 边可扩展恋人，不需要 ADR」）。
   *
   * 对称 kind：取反向时仍是 `lover`，不进 `KinshipKind` ⇒ 不参与多跳称谓推导
   * （`kinshipTerm` 只沿亲缘边，见 `game-core/v2/relations.ts`）。
   * 语义上只表达「确立了这层关系」，**强度仍走 `value`**：`lover` + `value: 20` 是冷淡的恋人。
   */
  "lover",
]);

export const RelationKindSchema = z.union([KinshipKindSchema, SocialKindSchema]);

/**
 * 知情人范围（2026-11-19 用户裁决，ADR-007 D3）：**事实**的属性，不是观察者的属性。
 *
 * · `public`  —— 大家都知道（同校、同业界、公开的师承与亲缘）
 * · `limited` —— 部分人知道，名单写 `knownBy`（当事人自动在内）
 * · `private` —— 仅当事人知道（双方的私情、没人知道的父女）
 *
 * 语义要点：`private` 不是「不存在」——它对当事人双方完全成立，
 * 也照常参与称谓推导（惠叫甚尔「爸爸」不需要外人知道）。
 */
export const RelationScopeSchema = z.enum(["public", "limited", "private"]);

/**
 * @deprecated 玩家视角的可见性（R-OP-05 时代）。**只用于读旧模板 / 旧存档**：
 * `known` / `inferred` → `public`，`unknown` / `hidden` → `private`。
 * 新代码一律写 `scope`；两套写在同一处由 `relationScopeOf` 收敛（唯一读法）。
 */
export const RelationVisibilitySchema = z.enum(["known", "inferred", "unknown", "hidden"]);

/**
 * 边来源（事实追溯）：模板初始声明 / 效果运行时建立 / 扩展在投影期合成。
 *
 * `extension` 只出现在**投影的合成边**上（`extensions/family/doc/FAMILY-GRAPH.md` §7.1：指针模式把
 * 指针合成的关系边加回来）。这类边**不写回** `state.relations`，所以存档里仍只有
 * 前两种；加这一档是为了让前端能区分「作者声明的关系」与「推出来的关系」，
 * 也让引擎永远不必把合成边伪装成 `template`。
 */
export const RelationSourceSchema = z.enum(["template", "effect", "extension"]);

/** 关系事实的知情人范围（缺 `scope` 时按旧 `visibility` 推导，见 `relationScopeOf`）。 */
export interface ScopeCarrier {
  readonly scope?: RelationScope | undefined;
  readonly visibility?: RelationVisibility | undefined;
}

/** 关系两端（`relationVisibleTo` 的最小输入）。 */
export interface RelationParties {
  readonly from: string;
  readonly to: string;
  readonly knownBy?: readonly string[] | undefined;
}

/**
 * 这条事实属于哪一档 —— **唯一读法**（投影、扩展、展示层都走这里，不许各自再判一遍）。
 *
 * `scope` 优先；没有时才回退旧 `visibility`。`undefined` 视作 `public`：
 * 调用方能拿到一条边，说明它已经过了存档/模板校验。
 */
export function relationScopeOf(edge: ScopeCarrier): RelationScope {
  if (edge.scope !== undefined) return edge.scope;
  return edge.visibility === "unknown" || edge.visibility === "hidden" ? "private" : "public";
}

/**
 * 某个观察者能不能看见这条事实（当前只喂玩家；将来切视角时同一函数换 `viewerId`）。
 *
 * 判据只有「他是否在知情人范围内」，与"他有多确信"无关 ——
 * 确信度不再是边的属性：玩家压根不知道的关系，就不该出现在他的图里。
 */
export function relationVisibleTo(
  edge: ScopeCarrier & RelationParties,
  viewerId: string,
): boolean {
  if (viewerId === edge.from || viewerId === edge.to) return true;
  const scope = relationScopeOf(edge);
  if (scope === "public") return true;
  if (scope === "private") return false;
  return (edge.knownBy ?? []).includes(viewerId);
}

/** 实例层关系边（WorldStateV2.relations；配置域不复制，运行时追加）。 */
export const RelationEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    kind: RelationKindSchema,
    source: RelationSourceSchema,
    /** 知情人范围（ADR-007 D3）；缺省按 `visibility` 推导 —— 旧存档直载。 */
    scope: RelationScopeSchema.optional(),
    /** `scope: limited` 的知情人名单（当事人不必列，判定时自动算在内）。 */
    knownBy: z.array(z.string().min(1)).optional(),
    /** @deprecated 见 `RelationVisibilitySchema`；旧存档 / 旧模板才有。 */
    visibility: RelationVisibilitySchema.optional(),
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
    if (e.scope === "limited" && (e.knownBy === undefined || e.knownBy.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["knownBy"],
        message: "scope: limited 必须声明 knownBy（否则等同于 private）",
      });
    }
  });

/** 配置层声明（characters.yaml，from 隐含为该角色自身）：scope 缺省 public。 */
export const RelationDeclSchema = z
  .object({
    to: z.string().min(1),
    kind: RelationKindSchema,
    scope: RelationScopeSchema.optional(),
    knownBy: z.array(z.string().min(1)).optional(),
    /** @deprecated 旧模板写法（R-OP-05）；新模板用 `scope`。 */
    visibility: RelationVisibilitySchema.optional(),
    value: z.number().min(-100).max(100).optional(),
    gap: z.boolean().optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.scope === "limited" && (d.knownBy === undefined || d.knownBy.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["knownBy"],
        message: "scope: limited 必须声明 knownBy（否则等同于 private）",
      });
    }
  });

export type KinshipKind = z.infer<typeof KinshipKindSchema>;
export type SocialKind = z.infer<typeof SocialKindSchema>;
export type RelationKind = z.infer<typeof RelationKindSchema>;
export type RelationScope = z.infer<typeof RelationScopeSchema>;
export type RelationVisibility = z.infer<typeof RelationVisibilitySchema>;
export type RelationEdge = z.infer<typeof RelationEdgeSchema>;
export type RelationDecl = z.infer<typeof RelationDeclSchema>;
