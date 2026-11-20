import { z } from "zod";
import { CallReceiptSchema, DiagnosticCodeSchema } from "./engine-api.js";
import { PerspectiveSchema, PerspectiveFactViewSchema } from "./perspective.js";

/**
 * LLM 调用契约（F3 / 稀疏参与）：core -> llm 回调，回程一律走引擎 API。
 * LLM 不直接写权威状态；LlmOutcome 只携带「已提交回执 / 回退 / 延后」三态。
 */

/** 预算默认值（封闭 schema，任何字段都可省，解析时补全）。 */
export const LlmBudgetSchema = z
  .object({
    maxToolRounds: z.number().int().nonnegative().default(6),
    retryLimit: z.number().int().nonnegative().default(2),
    perCallTimeoutMs: z.number().int().nonnegative().default(60000),
    invocationTimeoutMs: z.number().int().nonnegative().default(180000),
    turnLlmBudgetMs: z.number().int().nonnegative().default(240000),
    maxInputTokens: z.number().int().nonnegative().default(8000),
    maxOutputTokens: z.number().int().nonnegative().default(8000),
    maxTotalTokens: z.number().int().nonnegative().default(48000),
    recentTurns: z.number().int().nonnegative().default(6),
  })
  .strict();
export type LlmBudget = z.infer<typeof LlmBudgetSchema>;
export const DEFAULT_LLM_BUDGET: LlmBudget = LlmBudgetSchema.parse({});

export const ToolDescriptorSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

/**
 * 设定条目（`lore.md` 的运行时切片）。`always` 由引擎按模板元信息标记：
 * true ⇒ 进 stable prefix；false/缺省 ⇒ 只进本次 reactive `[设定]` 段。
 */
export const LoreEntrySchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    text: z.string().min(1),
    always: z.boolean().optional(),
  })
  .strict();
export type LoreEntry = z.infer<typeof LoreEntrySchema>;

/** loader 侧完整规则：比 `LoreEntry` 多保留匹配/排序字段，只在引擎内部使用。 */
export interface LoreRule extends LoreEntry {
  keys: readonly string[];
  always: boolean;
  priority: number;
}

/**
 * LlmContext（v2 §6.1 分层上下文）：让 LlmInvocation.context 不是 loose record，
 * 编排层「不得裁剪 / 补齐 facts 段」才有类型依据——facts 由 core 的 buildFacts() 投影。
 * [1] stablePrefix  字节稳定（世界观骨架 + 能力画像 + 工具 schema + 输出契约）；
 * [2] facts         core buildFacts(inv.perspective) 产出的 PerspectiveFactView；
 * [3] secrets       仅 world 窗口的隐秘段（结构化引用 id，不给原文）；
 * [4] recentTurns   最近 6 轮滚动窗口；
 * [5] invocationReason / contextHints 本次触发原因 / 开放标签。
 */
export const LlmContextSchema = z
  .object({
    stablePrefix: z.string(),
    facts: PerspectiveFactViewSchema,
    secrets: z.array(z.string()).optional(),
    recentTurns: z.array(z.unknown()),
    invocationReason: z.string().min(1),
    contextHints: z.array(z.string()).optional(),
    /**
     * 模板的**本幕要求**（`rules.yaml` 的 `invoke.instruction`）：一句话说清这一次写什么、不写什么。
     * 与 `contextHints` 不同，它是给模型看的自然语言，不是标签。
     */
    instruction: z.string().min(1).optional(),
    /** 体裁（对应 `rules.yaml` 的 `invoke.mode`）：`recap` 会换掉输出契约里两条逐拍约束。 */
    narrativeMode: z.enum(["narration", "recap"]).optional(),
    /** 篇幅（对应 `invoke.length`）：同时约束提示词与后处理截断。 */
    narrativeLength: z
      .object({
        minChars: z.number().int().positive(),
        maxChars: z.number().int().positive(),
        minParagraphs: z.number().int().positive().optional(),
        maxParagraphs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    /** 关键词命中的设定条目（reactive `[设定]` 段）；常驻条目在 stablePrefix 里。 */
    lore: z.array(LoreEntrySchema).optional(),
    /**
     * ADR-0038：本轮允许摆上桌的事件白名单（由 core 求值产出，**不来自模型输出**）。
     *
     * 放在 `LlmContext` 而非 `LlmInvocation` 顶层的两个理由：
     * 1) 它既是引擎闸门也是提示内容 —— 真实模型必须知道「本轮可以摆 evt:trial」，
     *    否则能力被锁起来却没给钥匙，只有 mock 能演；
     * 2) `contextHash = sha256(stableStringify(inv.context))` 因此自动覆盖它 ——
     *    两次只有白名单不同的 invocation 必然得到不同哈希，回放归因才成立。
     */
    branchEventIds: z.array(z.string().min(1)).optional(),
    /**
     * 白名单的**可读版**：`id` + `title`（2026-11-21）。
     *
     * `branchEventIds` 是闸门（精确匹配），但只把 id 交给模型等于给了一串变量名 ——
     * 真实模型会照着 `ev-hv-04` 编内容，或者干脆不敢用。两者同源同序，`title` 缺失时
     * 回退成 id（运行时的渲染只做「id（title）」，不再猜）。
     */
    branchEvents: z
      .array(z.object({ id: z.string().min(1), title: z.string().min(1) }).strict())
      .optional(),
  })
  .strict();
export type LlmContext = z.infer<typeof LlmContextSchema>;

export const LlmInvocationSchema = z
  .object({
    invocationId: z.string().min(1),
    reason: z.string().min(1),
    context: LlmContextSchema,
    tools: z.array(ToolDescriptorSchema),
    /**
     * 能力画像名（模板 `invoke.toolProfile`）。
     *
     * 为什么必须随 invocation 传下来：`tools` 的**参数 schema 只有 agent-runtime 知道**
     * （`buildToolDescriptors` 在那边），core 只会给出工具名。曾经 core 用
     * `rules.toolProfile[name].map(name => ({ name }))` 造了一个「只有名字、没有 parameters」
     * 的工具表，agent-runtime 又因为 `inv.tools.length > 0` 而跳过自己的描述符构建 ⇒
     * 模型收到 6 个 `parameters: {}` 的工具，只能瞎猜参数（实测 glm-5.3 直接发空对象，
     * 整轮 invocation 作废）。画像名是唯一能让 runtime 重建正确描述符的凭据。
     */
    toolProfile: z.string().min(1).optional(),
    /** 模板 `rules.yaml prompt.style`：进 stable prefix，与输出契约并列。 */
    promptStyle: z.string().min(1).optional(),
    /** 本次 invocation 选中的设定（常驻 + 关键词命中），已由引擎按 p/id 排序并截断。 */
    lore: z.array(LoreEntrySchema).optional(),
    budget: LlmBudgetSchema.default({}),
    replyTo: z.literal("dispatch"),
    perspective: PerspectiveSchema,
    targetPerspective: PerspectiveSchema,
  })
  .strict();
export type LlmInvocation = z.infer<typeof LlmInvocationSchema>;

/**
 * LlmOutcome 三态：committed / fallback 两支必须带 traceRef（F3），
 * 使存档能定位叙事正文唯一落点（trace 记录），否则刷新后 AI 叙事不消失落空。
 */
export const LlmOutcomeSchema = z.union([
  z
    .object({
      outcome: z.literal("committed"),
      invocationId: z.string().min(1),
      receipts: z.array(CallReceiptSchema),
      traceRef: z.string().min(1),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("fallback"),
      invocationId: z.string().min(1),
      code: DiagnosticCodeSchema.optional(),
      reason: z.string().optional(),
      traceRef: z.string().min(1),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("deferred"),
      invocationId: z.string().min(1),
      reason: z.string().optional(),
    })
    .strict(),
]);
export type LlmOutcome = z.infer<typeof LlmOutcomeSchema>;

/** LLM 网关：invoke 返回结构化结果，绝不直接写 WorldStateV2。异步只留在网关 / agent-runtime。 */
export interface LlmGateway {
  invoke(inv: LlmInvocation): Promise<LlmOutcome>;
}
