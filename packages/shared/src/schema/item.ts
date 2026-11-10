import { z } from "zod";
import { EffectSchema } from "./common.js";

/**
 * 物品 Schema：消耗品/材料/关键物品；equipment 类型 Schema 预留但引擎 V0.1 忽略。
 * 使用效果为效果 DSL；战斗内/外可用性分开声明。
 */

export const ItemSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["consumable", "material", "key", "equipment"]),
    name: z.string().min(1),
    description: z.string().optional(),
    stackable: z.boolean(),
    usableInBattle: z.boolean(),
    usableOutsideBattle: z.boolean(),
    use: z.array(EffectSchema).optional(),
  })
  .strict()
  .refine((i) => i.type !== "consumable" || (i.use && i.use.length > 0), {
    message: "consumable 物品必须定义 use 效果",
  });

export type Item = z.infer<typeof ItemSchema>;
