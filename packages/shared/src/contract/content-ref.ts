import { z } from "zod";
import { PerspectiveSchema } from "./perspective.js";

/**
 * 内容层契约（F3 / v2 §5.4）：叙事 / 记忆 / 选项 / flavor / 资源引用都以 ContentBlock 表达，
 * 正文只进 trace（ContentSink），绝不进 WorldStateV2。
 * targetPerspective / refs / visibility 是窗口与可见性元数据（F4）；`maskText?` 仅作 trace
 * 元数据，不参与 player 输出投影（见下方字段注释与 T-05a 裁决）。
 */

export const ContentBlockKindSchema = z.enum(["narrative", "memory", "option", "flavor", "asset"]);
export type ContentBlockKind = z.infer<typeof ContentBlockKindSchema>;

export const ContentVisibilitySchema = z.enum(["public", "hidden"]);
export type ContentVisibility = z.infer<typeof ContentVisibilitySchema>;

export const ContentBlockSchema = z
  .object({
    blockId: z.string().min(1),
    kind: ContentBlockKindSchema,
    text: z.string().optional(),
    refs: z.array(z.string()),
    visibility: ContentVisibilitySchema,
    targetPerspective: PerspectiveSchema,
    /**
     * trace 元数据：该块写入 `LlmTrace.contentBlocks` 时附带的掩码文案
     * （v2 §5.4 / §6.3.5-3）。T-05a 裁决：非 world 窗口的 hidden 块**整块不下发**，
     * 不替换成掩码文案；maskText 绝不进入 player 输出 / ViewModel，也不参与可见性判定。
     */
    maskText: z.string().optional(),
    assetId: z.string().min(1).optional(),
    slot: z.string().min(1).optional(),
  })
  .strict();
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

