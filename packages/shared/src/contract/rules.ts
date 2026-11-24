import { z } from "zod";
import { TaskConditionSchema } from "../schema/common.js";
import {
  ObserverIdSchema,
  PerspectiveSchema,
  KnowledgeLevelSchema,
  KnowledgeSourceSchema,
} from "./perspective.js";

/**
 * rules.yaml 专用 schema（v2 §3.5 :260-310）。
 *
 * ⚠ 不并入 apps/server/src/templates.ts 的 TEMPLATE_MERGE_FILES：
 * rules.yaml 走独立加载通道，不与世界模板 yaml 合并，
 * 否则 rules.yaml 的域会污染模板指纹与合并语义。
 *
 * when / guards / completion 统一复用 TaskConditionSchema（现行扁平 DSL ∪ { op, args } 开放形），
 * 不另立第三套语法、引擎不 switch on op（ConditionRegistry 仅作前向 seam）。
 */

/**
 * `instruction` 的一个**条件变体**（2026-11-21）。
 *
 * 为什么需要：同一章下面会有不同分支（玩家是星浆体本人，还是护卫她的人），
 * 一句写死的「本幕要求」要么把两条线写成同一条，要么谁都不像。
 *
 * - `as`：**当前 self 是谁**的快捷写法（与事件节点级的 `as` 同一套语义）：
 *   `as: npc-riko` ⇔ `when: [{ selfIs: npc-riko }]`；也可以写数组
 *   `as: [npc-a, npc-b]`，表示「这几个角色共用同一段提示词」。
 *   自建角色的 id 按出身区分（`player-civilian` 等），因此数组也能做「同出身同线」的分派。
 *   可与 `when` 叠加（AND），用旗标进一步收窄。
 * - `when`：条件数组（与触发器同一个 DSL，AND）；缺省 / 空数组 = 兜底。
 *   按声明序取第一条命中的；**有 as 变体时，必须留一条无 as 的兜底**（与 ADR-010 D4 同规）。
 * - `text`：本幕要求本体（与单字符串写法同一个上限 300 字）。
 */
export const InstructionVariantSchema = z
  .object({
    as: z
      .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(8)])
      .optional(),
    when: z.array(TaskConditionSchema).optional(),
    text: z.string().min(1).max(300),
  })
  .strict();
export type InstructionVariant = z.infer<typeof InstructionVariantSchema>;

/** 条件 instruction：单字符串（旧写法）或变体数组（按 as / when 取第一条命中的）。 */
export const InstructionSchema = z.union([
  z.string().min(1).max(300),
  z
    .array(InstructionVariantSchema)
    .min(1)
    .max(12)
    /**
     * 「多变体必须有一份无 `as` 的兜底」（ADR-010 D4 的同一条规矩）：
     * 否则「玩家既不是 A 也不是 B」这类局面会连一句本幕要求都拿不到，
     * 而且这种缺口在运行期完全静默。加载期直接拒。
     */
    .superRefine((variants, ctx) => {
      const hasAs = variants.some((variant) => variant.as !== undefined);
      const hasFallback = variants.some((variant) => variant.as === undefined);
      if (hasAs && !hasFallback) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "as 变体必须留一条无 as 的兜底（否则其它 self 拿不到 instruction）",
        });
      }
    }),
]);
export type Instruction = z.infer<typeof InstructionSchema>;

/** 触发时构造的 LLM invocation 规格（v2 §3.5 :264-269）。 */
export const InvokeSchema = z
  .object({
    reason: z.string().min(1),
    perspective: PerspectiveSchema,
    targetPerspective: PerspectiveSchema,
    contextHints: z.array(z.string()).optional(),
    /**
     * **本幕要求**（模板定制提示词）：一句话说清「这一次写什么、不要写什么」。
     *
     * 与 `contextHints` 的分工：hints 只是**标签**（引擎完全不解释，只当上下文记号），
     * instruction 是**给模型看的话**。上限 300 字——它是"一句话"，不是第二个设定集；
     * 需要长篇设定就写 `lore.md`（按 keys 命中，不占每次调用）。
     *
     * 2026-11-21：也接受**条件变体数组**（`InstructionVariant[]`）——同一章的不同分支
     * 各写一句，由 `when` 选第一条命中的；单字符串等价于「只有一个兜底变体」。
     */
    instruction: InstructionSchema.optional(),
    /**
     * 叙事体裁（2026-11-19）：
     * - `narration`（缺省）：逐拍旁白——写「这一回合主角经历的一小段」，紧接上一轮往下写；
     * - `recap`：回顾——收束**已经发生的**一段（章节小结、长休、回忆），允许回看与跨回合。
     *
     * 为什么不是靠 `instruction` 口头约定：输出契约里有两条硬约束（"只写这一回合的一小段"、
     * "紧接 recentTurns 最后一条往下写"）是给逐拍写的。回顾类调用必须把这两条**换掉**，
     * 否则模型一边被要求回顾整章、一边被告知只能写一拍，只能写出缩水的流水账。
     */
    mode: z.enum(["narration", "recap"]).optional(),
    /**
     * 本次调用带多少轮滚动历史（覆盖 `budget.recentTurns`，缺省 6）。
     *
     * 章节回顾必须看到整章，而缺省窗口只有 6 轮——不够就只能靠 facts 猜，写出来必然空。
     * 逐拍旁白不需要调大：窗口越大越容易让模型"重写已经演过的场面"。
     */
    historyTurns: z.number().int().positive().max(200).optional(),
    /**
     * 篇幅（覆盖输出契约与后处理截断的默认 80–220 字 / 1–3 段）。
     * 章节小结这类调用需要更长的正文，靠 `instruction` 喊"多写点"是无效的——长度上限在契约里。
     */
    length: z
      .object({
        minChars: z.number().int().positive(),
        maxChars: z.number().int().positive(),
        minParagraphs: z.number().int().positive().optional(),
        maxParagraphs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    /**
     * ADR-0038：本轮允许 LLM 写分支的能力声明（历史上是模板事件 id 白名单）。
     *
     * 这是**能力声明**，不是用途声明 —— 声明 ≠ 只写一次：
     * - 频率由 ADR-0036 的边沿触发、`story.submitBranch` 的编译 / 调度语义、
     *   模板的 `missWhen` 三处共同保证；
     * - 引擎侧不再有 enqueue 白名单闸门（`fact.enqueueEvent` 已于 2026-11-16 下线）；
     *   本字段目前只作为「本轮可写分支」的能力信号供 provider / mock 使用。
     *
     * ⚠ 挂在每轮都命中的触发器上（如 `flagSet`）会每轮尝试提交一次分支 —— 那是作者选择，
     * 运行时不替其兜底。
     */
    branchEventIds: z.array(z.string().min(1)).optional(),
    toolProfile: z.string().min(1),
  })
  .strict();
export type Invoke = z.infer<typeof InvokeSchema>;

export const LlmTriggerSchema = z
  .object({
    id: z.string().min(1).optional(),
    when: z.array(TaskConditionSchema),
    /**
     * ADR-0036 求值策略（与 `when` / `invoke` 并列，不是 invocation 的属性）：
     * - `edge`（缺省）：仅当**上一轮为假、本轮为真**时发 invocation；
     * - `level`：命中即发（旧行为），供「每轮都要有 AI 旁白」的模板显式选择。
     *
     * 缺省值站在「省钱且符合设计口径」一侧：漏写不是每轮烧钱。
     */
    fireMode: z.enum(["edge", "level"]).optional(),
    invoke: InvokeSchema,
  })
  .strict();
export type LlmTrigger = z.infer<typeof LlmTriggerSchema>;

/** 工具画像：profile 名 → 允许的工具名列表（Record<string, string[]>）。 */
export const ToolProfileSchema = z.record(z.string().min(1), z.array(z.string().min(1)));
export type ToolProfile = z.infer<typeof ToolProfileSchema>;

/** 知识授予 / 推断规则的 grant 载荷（v2 §3.5 :274-277）。 */
export const KnowledgeGrantPayloadSchema = z
  .object({
    observers: z.array(ObserverIdSchema),
    factRefs: z.array(z.string()),
    level: KnowledgeLevelSchema,
    source: KnowledgeSourceSchema,
  })
  .strict();
export type KnowledgeGrantPayload = z.infer<typeof KnowledgeGrantPayloadSchema>;

/** knowledgeGrants[] / inferenceRules[] 同构条目：when 命中时按 grant 落账。 */
export const KnowledgeGrantRuleSchema = z
  .object({
    when: z.array(TaskConditionSchema),
    grant: KnowledgeGrantPayloadSchema,
  })
  .strict();
export type KnowledgeGrantRule = z.infer<typeof KnowledgeGrantRuleSchema>;

/** 兼容具名导出（语义与 KnowledgeGrantRuleSchema 相同）。 */
export const KnowledgeGrantSchema = KnowledgeGrantRuleSchema;
export type KnowledgeGrant = KnowledgeGrantRule;
export const InferenceRuleSchema = KnowledgeGrantRuleSchema;
export type InferenceRule = KnowledgeGrantRule;

/** 模板级文风约束（可选；随 rules.yaml 进语义指纹，最终进 stable prefix）。 */
export const PromptConfigSchema = z
  .object({
    style: z.string().min(1).optional(),
  })
  .strict();
export type PromptConfig = z.infer<typeof PromptConfigSchema>;

/** v2 §3.5 形状（4 个必需键 + 可选 prompt）。 */
export const RulesSchema = z
  .object({
    llmTriggers: z.array(LlmTriggerSchema),
    toolProfile: ToolProfileSchema,
    knowledgeGrants: z.array(KnowledgeGrantRuleSchema),
    inferenceRules: z.array(KnowledgeGrantRuleSchema),
    prompt: PromptConfigSchema.optional(),
  })
  .strict();
export type Rules = z.infer<typeof RulesSchema>;

/** 兼容别名：既有 RulesTemplateSchema / RulesTemplate 引用点继续可用。 */
export const RulesTemplateSchema = RulesSchema;
export type RulesTemplate = Rules;
