import { z } from "zod";
import { ConditionSchema, EffectSchema } from "./common.js";

/**
 * NPC 自主行动定义（A6：触发式 + 效用评分，替代 V1 的每轮轮询）。
 *
 * 触发是「事件驱动 + 兜底随机」：行动受 cooldownTurns / probability /
 * conditions / requireKnowledge 约束，只有满足条件才进入候选集；
 * 候选集内用效用评分（base + 目标匹配 + 性格偏好 + 随机）选择行动，而非纯随机。
 *
 * effects 复用效果 DSL，作用域为世界 flag / 玩家关系 / 玩家物品 / 事件链 / 历史。
 */
export const NpcActionSchema = z
  .object({
    id: z.string().min(1),
    /** 历史记录摘要模板，`{name}` 会被替换为 NPC 名 */
    summary: z.string().min(1),
    trigger: z
      .object({
        /** 同一 NPC 两次执行该行动的最小轮次间隔 */
        cooldownTurns: z.number().int().nonnegative().optional(),
        /** 兜底随机触发概率（0-1）；缺省 1（满足条件即候选） */
        probability: z.number().min(0).max(1).optional(),
        /** 触发条件（数组内 AND） */
        conditions: z.array(ConditionSchema).optional(),
        /** NPC 的 knowledge 必须包含全部标签才可选（信息差约束） */
        requireKnowledge: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    utility: z
      .object({
        /** 基础效用 */
        base: z.number().nonnegative().default(1),
        /** 与 NPC 目标匹配的标签，每命中一个加分 */
        goalMatch: z.array(z.string().min(1)).optional(),
        /** 与 NPC 性格匹配的标签，每命中一个加分 */
        traitAffinity: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    effects: z.array(EffectSchema).optional(),
  })
  .strict();

export type NpcAction = z.infer<typeof NpcActionSchema>;
