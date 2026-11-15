import { z } from "zod";
import { ConditionSchema } from "../schema/common.js";
import { KnowledgeTierSchema, SubjectSchema } from "./visibility.js";
import { TaskDagSchema } from "./task-dag.js";

/**
 * rules.yaml 专用 schema。
 *
 * ⚠ 不并入 apps/server/src/templates.ts 的 TEMPLATE_MERGE_FILES：
 * rules.yaml 走独立加载通道，不与世界模板 yaml 合并，
 * 否则 llmTriggers / inferenceRules / fallbackDag 会污染模板指纹与合并语义。
 */

export const LlmTriggerSchema = z
  .object({
    id: z.string().min(1),
    when: z.array(ConditionSchema),
    invoke: z
      .object({
        reason: z.string().min(1),
        contextHints: z.array(z.string()).optional(),
        toolProfile: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type LlmTrigger = z.infer<typeof LlmTriggerSchema>;

export const ToolProfileSchema = z
  .object({
    id: z.string().min(1),
    tools: z.array(z.string().min(1)),
    budgetRef: z.string().min(1).optional(),
  })
  .strict();
export type ToolProfile = z.infer<typeof ToolProfileSchema>;

export const KnowledgeGrantSchema = z
  .object({
    subject: SubjectSchema,
    refs: z.array(z.string()),
    tier: KnowledgeTierSchema,
  })
  .strict();
export type KnowledgeGrant = z.infer<typeof KnowledgeGrantSchema>;

export const InferenceRuleSchema = z
  .object({
    id: z.string().min(1),
    subject: SubjectSchema,
    when: z.array(ConditionSchema),
    infer: z.string().min(1),
    tier: KnowledgeTierSchema,
    from: z.array(z.string()),
  })
  .strict();
export type InferenceRule = z.infer<typeof InferenceRuleSchema>;

export const RulesTemplateSchema = z
  .object({
    llmTriggers: z.array(LlmTriggerSchema),
    toolProfiles: z.array(ToolProfileSchema),
    knowledgeGrants: z.array(KnowledgeGrantSchema),
    inferenceRules: z.array(InferenceRuleSchema),
    fallbackDag: TaskDagSchema,
  })
  .strict();
export type RulesTemplate = z.infer<typeof RulesTemplateSchema>;
