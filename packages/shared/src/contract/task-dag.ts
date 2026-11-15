import { z } from "zod";
import { ConditionSchema } from "../schema/common.js";

/**
 * 任务 DAG 契约（F3：锚点落账 / 任务完成 / 权威事实进存档）。
 * P0 的条件复用 schema/common.ts 的声明式 DSL，另留开放形作前向 seam。
 */

/** 开放形条件（前向 seam）：P0 引擎不解释，只做结构校验。 */
export const OpenConditionSchema = z
  .object({
    op: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();
export type OpenCondition = z.infer<typeof OpenConditionSchema>;

/**
 * 任务条件：z.union 兼容两形（v2 §3.5 / §11.2⑥）——
 * 形 A 现行声明式扁平 DSL（common.ts:181-192）；形 B 开放形 { op, args }。
 * when / guards / completion / rules.yaml 共用同一份 TaskConditionSchema，不另立第三套语法。
 */
export const TaskConditionSchema = z.union([ConditionSchema, OpenConditionSchema]);
export type TaskCondition = z.infer<typeof TaskConditionSchema>;

/**
 * 条件求值注册表（P0 仅作前向 seam）：求值由 game-core 的 ConditionEvaluator 解释，
 * 引擎不 switch on op；开放形仅做结构校验，新 op 注册在此扩展点上，不改本契约语法。
 */
export type ConditionEvaluator = (condition: TaskCondition, context: unknown) => boolean;
export interface ConditionRegistry {
  evaluate: ConditionEvaluator;
}

export const TaskStatusSchema = z.enum([
  "draft",
  "active",
  "ready",
  "in_progress",
  "completed",
  "expired",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    title: z.string().min(1),
    status: TaskStatusSchema,
    guards: z.array(TaskConditionSchema),
    completion: z.array(TaskConditionSchema),
    /** 截止（世界分钟 / 轮次，视模板约定）；可选。 */
    due: z.number().int().optional(),
    templateRefs: z.array(z.string()),
    visibility: z.enum(["public", "hidden"]),
    contextHints: z.array(z.string()).optional(),
  })
  .strict();
export type TaskNode = z.infer<typeof TaskNodeSchema>;

export const TaskEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    /** 边语义由模板 / 规则约定（如 dependency / sequence / on_complete）。 */
    kind: z.string().min(1),
  })
  .strict();
export type TaskEdge = z.infer<typeof TaskEdgeSchema>;

export const TaskDagSchema = z
  .object({
    dagId: z.string().min(1),
    version: z.number().int().nonnegative(),
    issuedBy: z.enum(["llm", "template"]),
    nodes: z.array(TaskNodeSchema),
    edges: z.array(TaskEdgeSchema),
  })
  .strict();
export type TaskDag = z.infer<typeof TaskDagSchema>;
