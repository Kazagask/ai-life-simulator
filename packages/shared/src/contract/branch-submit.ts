import { z } from "zod";
import { ConditionSchema, EffectSchema } from "../schema/common.js";

/**
 * `story.submitBranch` 的入参（AGENTIC-GM 重构 · 设计 §4.2）。
 *
 * LLM 只表达三件事：**怎么触发、事件是什么、整条编排是什么**。
 * 槽 / 队列 / 候选池 / DAG / 权重这些是引擎规则，**不出现在这里**。
 *
 * 关键约束（引擎侧校验，不靠模型自觉）：
 * - `goto` 只能指向**本次提交内**的 `node`；跨提交一律拒。
 * - `node` 是本次提交内的**局部别名**，全局 id 由引擎分配（`gen:<invocationId>:<node>`），
 *   防止模型伪造引用。
 * - 选项 id 也由引擎分配。
 */
export const SubmitBranchOptionSchema = z
  .object({
    /** 选项文案（第二人称、动词开头） */
    text: z.string().min(1).max(120),
    /** 该选项的效果（走模板同一套 effect 白名单校验） */
    effects: z.array(EffectSchema).max(8).optional(),
    /** 指向**本次提交内**的另一个 node；缺省 = 到此为止 */
    goto: z.string().min(1).optional(),
  })
  .strict();

export const SubmitBranchNodeSchema = z
  .object({
    /** 局部别名，仅在本次提交内有效 */
    node: z.string().min(1).max(40),
    title: z.string().min(1).max(40),
    /** 事件正文（玩家在事件区看到的那段） */
    text: z.string().min(1).max(600),
    /** 参与角色 id：引擎在**呈现前**复核存活/在场，不依赖模型写守卫（防诈尸） */
    actors: z.array(z.string().min(1)).max(6).optional(),
    options: z.array(SubmitBranchOptionSchema).min(1).max(4),
  })
  .strict();

export const SubmitBranchArgsSchema = z
  .object({
    trigger: z
      .object({
        /** 触发前置条件（与模板同一套 condition DSL） */
        conditions: z.array(ConditionSchema).max(6).optional(),
        /**
         * `certain` = 条件满足即发生；`random` = 进候选池、按引擎节奏抽取。
         * 语义只到这一层——"池 / 权重 / 到期"是引擎内部实现，模型不感知。
         */
        mode: z.enum(["random", "certain"]),
      })
      .strict(),
    /** 整条编排：1..12 个事件块。单事件是 N=1 的退化形态。 */
    branch: z.array(SubmitBranchNodeSchema).min(1).max(12),
  })
  .strict();

export type SubmitBranchArgs = z.infer<typeof SubmitBranchArgsSchema>;
