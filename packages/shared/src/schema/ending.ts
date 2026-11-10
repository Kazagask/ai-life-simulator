import { z } from "zod";

/**
 * 终止记录（ADR-0004）：运行 / 已终止二态的唯一终止事实来源。
 * 固化后只读；由 game-core/v2/ending.ts 幂等写入，模板不得声明本记录。
 */

export const TerminationSourceSchema = z.enum([
  "condition",
  "player",
  "battleDefeat",
  "event",
]);

export type TerminationSource = z.infer<typeof TerminationSourceSchema>;

export const TerminationRecordSchema = z
  .object({
    /** 可诊断的终止原因 */
    reason: z.string().min(1),
    /** 终止时的世界时间（分钟标量，取自 WorldStateV2.worldTime） */
    worldTime: z.number(),
    /** 终止时的逻辑轮次（取自 WorldStateV2.turnIndex） */
    turnIndex: z.number().int().nonnegative(),
    /** 命中的结局模板 id（可选） */
    endingId: z.string().min(1).optional(),
    source: TerminationSourceSchema,
  })
  .strict();

export type TerminationRecord = z.infer<typeof TerminationRecordSchema>;
