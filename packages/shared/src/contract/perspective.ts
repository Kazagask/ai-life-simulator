import { z } from "zod";

/**
 * F4 统一观察者知识台账 / 可见窗口契约（v2 §6.3.2）。
 *
 * 硬规则（REFACTOR-DESIGN.md F4）：
 * - 玩家与每个 NPC 共用同一套「观察者知识台账」：ObserverId = "player" | `npc:${string}`。
 * - 视角是字符串字面量联合：Perspective = "world" | "player" | `npc:${string}`
 *   （buildFacts("world") / buildFacts("player") / buildFacts("npc:npc-rival")）。
 * - 未出现在某观察者台账中的 fact 即为该观察者的 hidden；
 *   `unknown` / `hidden` 层级的事实一律不进 player / npc 可见窗口（world 窗口是唯一全量视图）。
 * - 窗口计算归 game-core 的引擎 API 所有（EngineApiHandle.buildFacts），
 *   agent-runtime 不得自行决定可见性。
 */

/** 观察者 id：玩家本体，或任一 NPC。 */
export type ObserverId = "player" | `npc:${string}`;

export const ObserverIdSchema = z
  .string()
  .refine((v): v is ObserverId => v === "player" || v.startsWith("npc:"), {
    message: "ObserverId 必须是 'player' 或 'npc:<id>'",
  });

/**
 * 视角（F4）：world 全量；player / npc 只给 known + inferred。
 * 字符串字面量联合（v2 §6.3.2 :524-525），运行时拒绝非法值，TS 类型即上述联合。
 */
export type Perspective = "world" | "player" | `npc:${string}`;

export const PerspectiveSchema = z
  .string()
  .refine((v): v is Perspective => v === "world" || v === "player" || v.startsWith("npc:"), {
    message: "Perspective 必须是 'world' | 'player' | 'npc:<id>'",
  });

/** 台账条目的层级：只记 known / inferred（hidden 是「不在台账」的缺省态，不落库）。 */
export const KnowledgeLevelSchema = z.enum(["known", "inferred"]);
export type KnowledgeLevel = z.infer<typeof KnowledgeLevelSchema>;

/** 知识来源封闭枚举（KnowledgeEntry / rules.yaml grant 共用；fact.setKnowledge 已下线）。 */
export const KnowledgeSourceSchema = z.enum(["witness", "told", "inferred", "llm", "rule"]);
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;

export const KnowledgeEntrySchema = z
  .object({
    factRef: z.string().min(1),
    level: KnowledgeLevelSchema,
    source: KnowledgeSourceSchema,
    sinceTurn: z.number().int().nonnegative(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

/** 统一观察者知识台账：每个观察者对应自己的知识条目列表。 */
export type ObservationLedger = Record<ObserverId, KnowledgeEntry[]>;

/**
 * 键合法性在运行时按 ObserverIdSchema 校验（z.record 会对每个 key 跑 keyType._parse），
 * 覆盖「存档反序列化」这条不经过 SetKnowledgeArgsSchema.observer 的路径，堵住非法
 * observer 键混进 world 全量台账的泄露缝。zod 3 的 z.record 无法从模板字面量键推断出
 * 精确的键类型，故仍显式把输出类型桥接为 ObservationLedger（保证接口与 z.infer 一致）。
 */
export const ObservationLedgerSchema = z.record(
  ObserverIdSchema,
  z.array(KnowledgeEntrySchema),
) as unknown as z.ZodType<ObservationLedger>;

/** 窗口内事实条目（v2 §6.3.2 :538-542）：level 仅 known / inferred，world 窗口无 level 约束。 */
export const PerspectiveFactItemSchema = z
  .object({
    factRef: z.string().min(1),
    value: z.unknown(),
    level: KnowledgeLevelSchema.optional(),
  })
  .strict();
export type PerspectiveFactItem = z.infer<typeof PerspectiveFactItemSchema>;

/**
 * 视角事实窗口（v2 §6.3.2 :536-545）：
 * world 全量（含全部观察者台账 ledger）；player / npc 只给 known + inferred。
 * 隐秘作为 world 窗口 facts 的一部分，靠 ledger 区分观察者；不再另设独立隐秘字段。
 */
export const PerspectiveFactViewSchema = z
  .object({
    perspective: PerspectiveSchema,
    facts: z.array(PerspectiveFactItemSchema),
    ledger: ObservationLedgerSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    // F4：字符串联合下以 v.perspective !== "world" 判定受限窗口。
    if (v.perspective === "world") return;
    // 仅 world 窗口可携带全部观察者台账；player / npc 窗口只给 known / inferred。
    if (v.ledger !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ledger"],
        message: "仅 world 窗口可携带全部观察者台账（F4）",
      });
    }
    // 显式护栏：player / npc 窗口的 facts 只允许 known / inferred，不得出现 hidden / unknown。
    // PerspectiveFactItemSchema.level 已由 KnowledgeLevelSchema 约束，此处防止放宽枚举时 F4 静默失效。
    v.facts.forEach((f, i) => {
      if (f.level !== undefined && f.level !== "known" && f.level !== "inferred") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["facts", i, "level"],
          message: "player / npc 窗口的 fact 只允许 known / inferred（F4）",
        });
      }
    });
  });
export type PerspectiveFactView = z.infer<typeof PerspectiveFactViewSchema>;

/** 知识授予 args schema：由 `knowledgeGrants` 规则经 `assignKnowledgeGrants` 使用（fact.setKnowledge 已下线）。 */
export const SetKnowledgeArgsSchema = z
  .object({
    observer: ObserverIdSchema,
    factRef: z.string().min(1),
    level: KnowledgeLevelSchema,
    source: KnowledgeSourceSchema,
    sinceTurn: z.number().int().nonnegative(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();
export type SetKnowledgeArgs = z.infer<typeof SetKnowledgeArgsSchema>;

/** 兼容别名：主体集合与 Perspective 相同（既有引用点继续使用）。 */
export type Subject = Perspective;
export const SubjectSchema = PerspectiveSchema;

/** 兼容别名：知识层级与 KnowledgeLevel 相同。 */
export type KnowledgeTier = KnowledgeLevel;
export const KnowledgeTierSchema = KnowledgeLevelSchema;
