import { z } from "zod";
import { ContentVisibilitySchema } from "./content-ref.js";

/** 资源清单契约：资产元数据与可见性，供 referenceAsset / MediaVM 引用。 */

export const AssetDescriptorSchema = z
  .object({
    assetId: z.string().min(1),
    path: z.string().min(1),
    kind: z.enum(["portrait", "diff", "cg", "bgm"]),
    tags: z.array(z.string()),
    characterRef: z.string().min(1).optional(),
    visibility: ContentVisibilitySchema,
    license: z.string().optional(),
    credit: z.string().optional(),
  })
  .strict();
export type AssetDescriptor = z.infer<typeof AssetDescriptorSchema>;

export const AssetManifestSchema = z
  .object({
    assets: z.array(AssetDescriptorSchema),
  })
  .strict();
export type AssetManifest = z.infer<typeof AssetManifestSchema>;
