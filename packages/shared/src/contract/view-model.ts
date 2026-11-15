import { z } from "zod";

/**
 * P0 最小视图模型：只需能被 rpg-ui import。
 * 字段保持最小形态，后续波次按引擎快照 / 内容层扩写。
 */

export const PlayerVMSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .strict();
export type PlayerVM = z.infer<typeof PlayerVMSchema>;

export const SlotSceneVMSchema = z
  .object({
    eventId: z.string(),
    title: z.string(),
    narrative: z.string().optional(),
  })
  .strict();
export type SlotSceneVM = z.infer<typeof SlotSceneVMSchema>;

export const EvaluationVMSchema = z
  .object({
    summary: z.string(),
  })
  .strict();
export type EvaluationVM = z.infer<typeof EvaluationVMSchema>;

export const MediaVMSchema = z
  .object({
    slot: z.string(),
    assetId: z.string(),
    url: z.string(),
    alt: z.string(),
  })
  .strict();
export type MediaVM = z.infer<typeof MediaVMSchema>;

export const ContentBlockVMSchema = z
  .object({
    blockId: z.string(),
    kind: z.string(),
    text: z.string().optional(),
  })
  .strict();
export type ContentBlockVM = z.infer<typeof ContentBlockVMSchema>;

export const NpcVMSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .strict();
export type NpcVM = z.infer<typeof NpcVMSchema>;

export const ViewModelSchema = z
  .object({
    player: PlayerVMSchema,
    npcs: z.array(NpcVMSchema),
    slot: SlotSceneVMSchema.nullable(),
    evaluation: EvaluationVMSchema,
    media: z.array(MediaVMSchema),
    content: z.array(ContentBlockVMSchema),
  })
  .strict();
export type ViewModel = z.infer<typeof ViewModelSchema>;
