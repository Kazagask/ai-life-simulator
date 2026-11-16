import { z } from "zod";
import { TaskConditionSchema, TaskDagSchema } from "./task-dag.js";
import {
  ObserverIdSchema,
  PerspectiveSchema,
  KnowledgeLevelSchema,
  KnowledgeSourceSchema,
} from "./perspective.js";

/**
 * rules.yaml 专用 schema（v2 §3.5 :260-310）。
 *
 * ⚠ 不并入 apps/server/src/templates.ts 的 TEMPLATE_MERGE_FILES：
 * rules.yaml 走独立加载通道，不与世界模板 yaml 合并，
 * 否则 llmTriggers / inferenceRules / fallbackDag 会污染模板指纹与合并语义。
 *
 * when / guards / completion 统一复用 TaskConditionSchema（现行扁平 DSL ∪ { op, args } 开放形），
 * 不另立第三套语法、引擎不 switch on op（ConditionRegistry 仅作前向 seam）。
 */

/** 触发时构造的 LLM invocation 规格（v2 §3.5 :264-269）。 */
export const InvokeSchema = z
  .object({
    reason: z.string().min(1),
    perspective: PerspectiveSchema,
    targetPerspective: PerspectiveSchema,
    contextHints: z.array(z.string()).optional(),
    /**
     * ADR-0038：本轮允许 LLM **摆上桌**的事件白名单（模板已有事件 id，`evt:xxx`）。
     *
     * 这是**能力声明**，不是用途声明 —— 声明 ≠ 只摆一次：
     * - 频率由 ADR-0036 的边沿触发、`fact.enqueueEvent` 的 `waiting` 幂等、
     *   模板的 `missWhen` 三处共同保证；
     * - 未声明 ⇒ 一律不许 enqueue（`allowedRefs: []`，「沉默 = 没有分支能力」）；
     * - 显式空数组 ⇒ **同样不许**（空 ≠ 不限制）。
     *
     * ⚠ 挂在每轮都命中的触发器上（如 `flagSet`）会每轮尝试摆一次 —— 那是作者选择，
     * 运行时不替其兜底。
     */
    branchEventIds: z.array(z.string().min(1)).optional(),
    toolProfile: z.string().min(1),
  })
  .strict();
export type Invoke = z.infer<typeof InvokeSchema>;

export const LlmTriggerSchema = z
  .object({
    id: z.string().min(1).optional(),
    when: z.array(TaskConditionSchema),
    /**
     * ADR-0036 求值策略（与 `when` / `invoke` 并列，不是 invocation 的属性）：
     * - `edge`（缺省）：仅当**上一轮为假、本轮为真**时发 invocation；
     * - `level`：命中即发（旧行为），供「每轮都要有 AI 旁白」的模板显式选择。
     *
     * 缺省值站在「省钱且符合设计口径」一侧：漏写不是每轮烧钱。
     */
    fireMode: z.enum(["edge", "level"]).optional(),
    invoke: InvokeSchema,
  })
  .strict();
export type LlmTrigger = z.infer<typeof LlmTriggerSchema>;

/** 工具画像：profile 名 → 允许的工具名列表（Record<string, string[]>）。 */
export const ToolProfileSchema = z.record(z.string().min(1), z.array(z.string().min(1)));
export type ToolProfile = z.infer<typeof ToolProfileSchema>;

/** 知识授予 / 推断规则的 grant 载荷（v2 §3.5 :274-277）。 */
export const KnowledgeGrantPayloadSchema = z
  .object({
    observers: z.array(ObserverIdSchema),
    factRefs: z.array(z.string()),
    level: KnowledgeLevelSchema,
    source: KnowledgeSourceSchema,
  })
  .strict();
export type KnowledgeGrantPayload = z.infer<typeof KnowledgeGrantPayloadSchema>;

/** knowledgeGrants[] / inferenceRules[] 同构条目：when 命中时按 grant 落账。 */
export const KnowledgeGrantRuleSchema = z
  .object({
    when: z.array(TaskConditionSchema),
    grant: KnowledgeGrantPayloadSchema,
  })
  .strict();
export type KnowledgeGrantRule = z.infer<typeof KnowledgeGrantRuleSchema>;

/** 兼容具名导出（语义与 KnowledgeGrantRuleSchema 相同）。 */
export const KnowledgeGrantSchema = KnowledgeGrantRuleSchema;
export type KnowledgeGrant = KnowledgeGrantRule;
export const InferenceRuleSchema = KnowledgeGrantRuleSchema;
export type InferenceRule = KnowledgeGrantRule;

/** v2 §3.5 形状：顶层恰为 5 个键；fallbackDag 与 TaskDag 同构。 */
export const RulesSchema = z
  .object({
    llmTriggers: z.array(LlmTriggerSchema),
    toolProfile: ToolProfileSchema,
    knowledgeGrants: z.array(KnowledgeGrantRuleSchema),
    inferenceRules: z.array(KnowledgeGrantRuleSchema),
    fallbackDag: TaskDagSchema,
  })
  .strict();
export type Rules = z.infer<typeof RulesSchema>;

/** 兼容别名：既有 RulesTemplateSchema / RulesTemplate 引用点继续可用。 */
export const RulesTemplateSchema = RulesSchema;
export type RulesTemplate = Rules;
