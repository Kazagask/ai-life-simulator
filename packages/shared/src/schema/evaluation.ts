import { z } from "zod";
import { NarrativeSourceSchema } from "./ending.js";

/**
 * 人生评价分域 Schema（协议 V2.1 §18）。全部 strict；类型经 z.infer 派生。
 * 本模块是评价的**唯一事实来源**：结局类型仅作背景，不得作为评分维度或权重来源。
 */

/** 单个维度定义：可增删改名调权；id 以协议 §18 为权威。 */
export const EvaluationDimensionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    /** 有限正数 */
    weight: z.number().positive().finite(),
    /** 得分区间 [下界, 上界]，下界须小于上界 */
    ranges: z
      .tuple([z.number().finite(), z.number().finite()])
      .refine(([lo, hi]) => lo < hi, { message: "ranges 下界须小于上界" }),
    explainRules: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const EvaluationConfigSchema = z
  .object({
    dimensions: z.array(EvaluationDimensionSchema).default([]),
    /** 世界观专属维度，与通用维度同构（守护/探索/知识/名望/自由等） */
    worldSpecificDimensions: z.array(EvaluationDimensionSchema).default([]),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    const check = (list: z.infer<typeof EvaluationDimensionSchema>[], field: string) => {
      list.forEach((d, i) => {
        if (seen.has(d.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field, i, "id"],
            message: `重复维度 id：${d.id}`,
          });
        }
        seen.add(d.id);
        if (d.id === "overall") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field, i, "id"],
            message: "不得声明硬编码 overall 总分维度（分项不得被取代）",
          });
        }
      });
    };
    check(cfg.dimensions, "dimensions");
    check(cfg.worldSpecificDimensions, "worldSpecificDimensions");
  });

export type EvaluationDimension = z.infer<typeof EvaluationDimensionSchema>;
export type EvaluationConfig = z.infer<typeof EvaluationConfigSchema>;

/** 单维度评分结果：evidenceIds 必须能在本局 history / 选择记录中解析（P6）。 */
export const EvaluationDimensionResultSchema = z
  .object({
    id: z.string().min(1),
    score: z.number().finite(),
    level: z.string().min(1),
    explanation: z.string(),
    evidenceIds: z.array(z.string().min(1)),
  })
  .strict();

export type EvaluationDimensionResult = z.infer<typeof EvaluationDimensionResultSchema>;

/** 评价记录（独立类型，只读；不写入 WorldStateV2）。 */
export const EvaluationRecordSchema = z
  .object({
    dimensions: z.array(EvaluationDimensionResultSchema),
    /** 由 adapter 组织的自然语言总结，不决定分数、不改写维度或证据 */
    summary: z.string(),
    summarySource: NarrativeSourceSchema,
    /** 总体等级可选，不得取代分项 */
    overall: z.number().finite().optional(),
  })
  .strict();

export type EvaluationRecord = z.infer<typeof EvaluationRecordSchema>;

// ---------- LLM 输出契约（adapter 层校验；game-core 只接收已校验的结构化结果） ----------

/**
 * 结局叙事候选：strict 拒绝任何虚构字段或状态写入（R-EN-06）。
 * evidenceIds 必须全部落在本局已确认证据集合内，否则视为虚构事实。
 */
export const EndingNarrativeOutputSchema = z
  .object({
    title: z.string().min(1),
    summary: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)),
  })
  .strict();

export type EndingNarrativeOutput = z.infer<typeof EndingNarrativeOutputSchema>;

/**
 * 人生总结候选：只允许 summary；strict 拒绝 score / dimensions / evidenceIds / state
 * 等任何试图决定分数、改写维度证据或写状态的字段（R-EV-05 / §10）。
 */
export const EvaluationSummaryOutputSchema = z
  .object({
    summary: z.string().min(1),
  })
  .strict();

export type EvaluationSummaryOutput = z.infer<typeof EvaluationSummaryOutputSchema>;
