import { z } from "zod";
import { ObserverIdSchema, PerspectiveSchema } from "./perspective.js";

/**
 * 内容层契约（F3 / v2 §5.4）：叙事 / 记忆 / 选项 / flavor / 资源引用都以 ContentBlock 表达，
 * 正文只经 content.* 工具写入 trace，绝不进 WorldStateV2。
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

export const CONTENT_TOOL_NAMES = [
  "writeNarrative",
  "writeMemory",
  "writeOption",
  "referenceAsset",
  "writeFlavor",
  "submit",
] as const;
export const ContentToolNameSchema = z.enum(CONTENT_TOOL_NAMES);
export type ContentToolName = z.infer<typeof ContentToolNameSchema>;

/** content.* 工具 args schema（回程一律走引擎 API）。 */
export const WriteNarrativeArgsSchema = z
  .object({
    blockId: z.string().min(1),
    text: z.string().min(1),
    refs: z.array(z.string()),
    targetPerspective: PerspectiveSchema,
  })
  .strict();
export type WriteNarrativeArgs = z.infer<typeof WriteNarrativeArgsSchema>;

export const WriteMemoryArgsSchema = z
  .object({
    blockId: z.string().min(1),
    text: z.string().min(1),
    refs: z.array(z.string()),
    observer: ObserverIdSchema,
  })
  .strict();
export type WriteMemoryArgs = z.infer<typeof WriteMemoryArgsSchema>;

export const WriteOptionArgsSchema = z
  .object({
    blockId: z.string().min(1),
    text: z.string().min(1),
    optionId: z.string().min(1),
    refs: z.array(z.string()),
  })
  .strict();
export type WriteOptionArgs = z.infer<typeof WriteOptionArgsSchema>;

export const ReferenceAssetArgsSchema = z
  .object({
    blockId: z.string().min(1),
    assetId: z.string().min(1),
    slot: z.string().min(1).optional(),
    refs: z.array(z.string()),
  })
  .strict();
export type ReferenceAssetArgs = z.infer<typeof ReferenceAssetArgsSchema>;

export const WriteFlavorArgsSchema = z
  .object({
    blockId: z.string().min(1),
    text: z.string().min(1),
    refs: z.array(z.string()),
  })
  .strict();
export type WriteFlavorArgs = z.infer<typeof WriteFlavorArgsSchema>;

export const SubmitArgsSchema = z
  .object({
    blockIds: z.array(z.string().min(1)),
  })
  .strict();
export type SubmitArgs = z.infer<typeof SubmitArgsSchema>;

export const ContentToolArgsSchemas = {
  writeNarrative: WriteNarrativeArgsSchema,
  writeMemory: WriteMemoryArgsSchema,
  writeOption: WriteOptionArgsSchema,
  referenceAsset: ReferenceAssetArgsSchema,
  writeFlavor: WriteFlavorArgsSchema,
  submit: SubmitArgsSchema,
} as const;
