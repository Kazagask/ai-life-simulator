import { z } from "zod";

/**
 * 加点（ADR-004 / ADR-019）：开局与世界内共用同一份声明形状与同一套校验。
 *
 * 为什么放进协议而不是留在开局 DAG 里：世界内加点是**轮外动作**（不推进回合），
 * 它的预算与目标由模板在运行时声明（`grantAllocation` 效果），提交时又要用
 * 与开局**完全一致**的四条边界（不超预算 / 单项上下限 / 非负整数 / 只能是数值属性）。
 * 两处各写一份判定，玩家会在两个地方收到不一致的反馈。
 */

/**
 * 一个加点目标。`min` / `max` 限制的是**这一次分配到的点数**，不是属性终值 ——
 * 「体魄 4，这次最多加 3 点」与「体魄上限 10」是两件事（后者是 `attributes.caps`）。
 */
export const AllocationTargetSchema = z
  .object({
    attribute: z.string().min(1),
    min: z.number().optional(),
    max: z.number().optional(),
    /** 展示名覆盖（缺省取模板的属性标签）。 */
    label: z.string().min(1).optional(),
    /** 属性名着色（样式 id）。 */
    style: z.string().min(1).optional(),
  })
  .strict();
export type AllocationTarget = z.infer<typeof AllocationTargetSchema>;

/**
 * 世界里**待完成的加点**（`state.pendingAllocation`）。同一时刻最多一条 ——
 * 两笔同时挂着时，「点确定」到底提交哪一笔只能靠猜。
 */
export const PendingAllocationSchema = z
  .object({
    /** 模板侧 id：提交时要原样带回，防止「点确定」落到另一笔上。 */
    id: z.string().min(1),
    budget: z.number().int().positive(),
    targets: z.array(AllocationTargetSchema).min(1),
    /** 为什么给这些点（「切磋之后」「读完一册」），展示用，不参与判定。 */
    reason: z.string().min(1).optional(),
    sinceTurn: z.number().int().nonnegative(),
    sinceWorldTime: z.number().int().nonnegative(),
  })
  .strict();
export type PendingAllocation = z.infer<typeof PendingAllocationSchema>;
