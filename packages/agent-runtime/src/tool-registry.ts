import {
  ContentToolArgsSchemas,
  SetKnowledgeArgsSchema,
  TaskDagSchema,
  type ApiCall,
  type Perspective,
  type RulesTemplate,
  type ToolDescriptor,
} from "@life-sim/shared";

/**
 * T-03：能力画像 → 工具描述（OpenAI `tools` 结构）+ 第 1 层参数校验 + ApiCall 翻译。
 *
 * ---------- 已知契约缺口（不改契约，只在此存档；改动需走协议评审） ----------
 * [缺口 3] `WriteNarrativeArgsSchema` / `WriteMemoryArgsSchema` 等 LLM 侧 args 没有 `kind` /
 *          `visibility`，而 game-core 的 `writeContent` 直接 `ContentBlockSchema.parse(args)`。
 *          本包在 `toApiCall` 里补齐 kind / visibility / 默认 targetPerspective 作为桥接；
 *          若将来把 ContentBlock 形状搬到工具 schema，可删掉这层翻译。
 * [缺口 4] `LlmInvocation` 不带 `turnIndex` / `worldTime`，loop 只能从
 *          `engineApi.snapshot()` 读时钟。当 server 注入 `projectSnapshotV2` 时，trace 的
 *          时钟字段就依赖投影路径；若要「trace 可脱离投影独立回放」，应把时钟放进 invocation。
 * [缺口 5] `content.writeOption.optionId` 在 `ContentBlock` 上没有落点，引擎边界会丢弃它，
 *          只剩 `blockId` 可做稳定 key。当前前端提交的是选项 `text`，故可接受；
 *          若将来要「选项 → 事件分支」精确映射，需要在 ContentBlock 上补 optionId 字段。
 *
 * 硬不变量：
 * - 工具调用走**结构化** `tools` / `tool_calls`，本文件绝不从自由文本里正则抠工具名。
 * - 工具名集合是封闭的（与 game-core 的 `RpgEngineAPI` 注册表逐字一致）；
 *   能力画像 `rules.toolProfile[name]` 只能**收窄**，不能新增。
 * - `content.*` 的 args 在这里补齐 `kind` / `visibility` / `targetPerspective`，
 *   翻译成 game-core 校验的完整 `ContentBlock`；正文仍只进 sink，不进 `WorldStateV2`。
 */

// ---------- Provider 抽象（本包私有，不进 shared 契约） ----------

/** 复用 shared 的工具描述符，避免两套形状漂移。 */
export type { ToolDescriptor } from "@life-sim/shared";

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  toolCalls?: ToolCallRequest[];
  toolCallId?: string;
  name?: string;
}

export interface AgentCompletion {
  toolCalls: ToolCallRequest[];
  text?: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: "tool_calls" | "stop" | "length";
}

export interface AgentChatRequest {
  messages: AgentMessage[];
  tools: ToolDescriptor[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AgentProvider {
  readonly id: "mock" | "openai-compatible";
  chat(req: AgentChatRequest): Promise<AgentCompletion>;
}

// ---------- 工具清单 ----------

/** 事实写入工具（与 game-core `defaultToolRegistry()` 对齐）。 */
export const FACT_TOOL_NAMES = ["fact.setKnowledge", "fact.advanceDag"] as const;

/** 内容写入工具（与 game-core `defaultToolRegistry()` 对齐）。 */
export const CONTENT_TOOL_NAMES_ALL = [
  "content.writeNarrative",
  "content.writeMemory",
  "content.writeOption",
  "content.writeFlavor",
  "content.referenceAsset",
] as const;

/**
 * 常驻工具（不受能力画像收窄影响）：
 * - `content.submit`：唯一的「提交」终止信号，缺了它一次 invocation 永远进不了 committed；
 * - `content.writeOption`：产品口径「点击为主、打字输入为辅」，决策点必须给出可点击选项。
 *   现有 demo 模板的 `toolProfile.narrative` 只列
 *   `[content.writeNarrative, content.referenceAsset, fact.enqueueEvent]`（且最后一个引擎未注册），
 *   漏了 writeOption —— 模板冻结不归本包改，先按常驻处理并通过 REPORT 反馈；
 *   画像补齐后可把本项移出常驻集合。
 */
export const CONTROL_TOOL_NAMES = ["content.submit", "content.writeOption"] as const;

export const ALL_TOOL_NAMES: readonly string[] = [
  ...FACT_TOOL_NAMES,
  ...CONTENT_TOOL_NAMES_ALL,
  ...CONTROL_TOOL_NAMES,
];

const schemaOf = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const contentRefsSchema = {
  type: "array",
  items: { type: "string" },
  description: "本次内容引用的事实 / DAG / 资源引用 id（必须落在 targetPerspective 窗口内）",
};

const CONTENT_DESCRIPTORS: Record<string, ToolDescriptor> = {
  "content.writeNarrative": {
    name: "content.writeNarrative",
    description: "写入一段叙事正文（只进 trace，不进权威状态）。",
    parameters: schemaOf(
      {
        blockId: { type: "string", minLength: 1 },
        text: { type: "string", minLength: 1, description: "叙事正文（中文）" },
        refs: contentRefsSchema,
        targetPerspective: { type: "string", description: "player | world | npc:<id>" },
      },
      ["blockId", "text", "refs", "targetPerspective"],
    ),
  },
  "content.writeMemory": {
    name: "content.writeMemory",
    description: "写入某个观察者的记忆片段。",
    parameters: schemaOf(
      {
        blockId: { type: "string", minLength: 1 },
        text: { type: "string", minLength: 1 },
        refs: contentRefsSchema,
        observer: { type: "string", description: "player | npc:<id>" },
      },
      ["blockId", "text", "refs", "observer"],
    ),
  },
  "content.writeOption": {
    name: "content.writeOption",
    description:
      "写入一个玩家可点击的行动选项（本游戏以点击选项推进，打字输入只是兜底）。" +
      "在决策点（章节 / 场景 / 任务推进）应给出 2-3 个选项，顺序排在叙事之后；" +
      "text 必须是第二人称、动词开头的具体动作（例：「撬开后门的电子锁」），不要写成对选项的描述。",
    parameters: schemaOf(
      {
        blockId: { type: "string", minLength: 1 },
        text: { type: "string", minLength: 1 },
        optionId: { type: "string", minLength: 1 },
        refs: contentRefsSchema,
      },
      ["blockId", "text", "optionId", "refs"],
    ),
  },
  "content.writeFlavor": {
    name: "content.writeFlavor",
    description: "写入风味文本（环境描写）。",
    parameters: schemaOf(
      {
        blockId: { type: "string", minLength: 1 },
        text: { type: "string", minLength: 1 },
        refs: contentRefsSchema,
      },
      ["blockId", "text", "refs"],
    ),
  },
  "content.referenceAsset": {
    name: "content.referenceAsset",
    description: "把已有媒体资源挂到叙事的一个槽位上。",
    parameters: schemaOf(
      {
        blockId: { type: "string", minLength: 1 },
        assetId: { type: "string", minLength: 1 },
        slot: { type: "string", minLength: 1 },
        refs: contentRefsSchema,
      },
      ["blockId", "assetId", "refs"],
    ),
  },
  "content.submit": {
    name: "content.submit",
    description: "提交本次 invocation 的全部内容块，结束调用。",
    parameters: schemaOf(
      { blockIds: { type: "array", items: { type: "string", minLength: 1 } } },
      ["blockIds"],
    ),
  },
};

const FACT_DESCRIPTORS: Record<string, ToolDescriptor> = {
  "fact.setKnowledge": {
    name: "fact.setKnowledge",
    description: "给观察者授一条知识（known / inferred）。",
    parameters: schemaOf(
      {
        observer: { type: "string", description: "player | npc:<id>" },
        factRef: { type: "string", minLength: 1 },
        level: { type: "string", enum: ["known", "inferred"] },
        source: {
          type: "string",
          enum: ["witness", "told", "inferred", "llm", "rule"],
        },
        sinceTurn: { type: "integer", minimum: 0 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      ["observer", "factRef", "level", "source", "sinceTurn"],
    ),
  },
  "fact.advanceDag": {
    name: "fact.advanceDag",
    description: "用一份新的任务 DAG 覆盖当前 DAG（整体校验后落账）。",
    parameters: schemaOf({ dag: { type: "object" } }, ["dag"]),
  },
};

const descriptorOf = (name: string): ToolDescriptor | undefined =>
  FACT_DESCRIPTORS[name] ?? CONTENT_DESCRIPTORS[name];

/** 画像里列出、但本包不认识（引擎也没注册）的工具名，供诊断 / 契约漂移测试断言。 */
export function unknownProfileTools(
  rules: RulesTemplate,
  toolProfileName: string,
): string[] {
  const listed = rules.toolProfile[toolProfileName] ?? [];
  return listed.filter((name) => !ALL_TOOL_NAMES.includes(name));
}

/** 画像收窄后的工具名集合（含常驻控制通道 `content.submit`）。 */
export function resolveToolNames(
  rules: RulesTemplate | undefined,
  toolProfileName: string | undefined,
): string[] {
  const listed =
    rules !== undefined && toolProfileName !== undefined
      ? rules.toolProfile[toolProfileName]
      : undefined;
  const narrowed =
    listed === undefined ? ALL_TOOL_NAMES : [...listed, ...CONTROL_TOOL_NAMES];
  const known = narrowed.filter((name) => ALL_TOOL_NAMES.includes(name));
  // 去重 + 稳定排序：stablePrefix 的字节稳定性依赖这里的确定性。
  return [...new Set(known)].sort();
}

/**
 * T-03：按能力画像构建 OpenAI `tools` 描述符。
 * 画像缺省 / 不存在 ⇒ 全量表面（仍确定性）；画像里未知工具静默跳过（`unknownProfileTools` 可取诊断）。
 */
export function buildToolDescriptors(
  rules: RulesTemplate | undefined,
  toolProfileName: string | undefined,
): ToolDescriptor[] {
  const names = resolveToolNames(rules, toolProfileName);
  const out: ToolDescriptor[] = [];
  for (const name of names) {
    const descriptor = descriptorOf(name);
    if (descriptor !== undefined) out.push(descriptor);
  }
  return out;
}

// ---------- 第 1 层：参数校验（FATAL） ----------

export type ArgValidation =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; code: "unknown_tool" | "invalid_arguments"; detail: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const CONTENT_SCHEMA_BY_TOOL: Record<
  string,
  (typeof ContentToolArgsSchemas)[keyof typeof ContentToolArgsSchemas]
> = {
  "content.writeNarrative": ContentToolArgsSchemas.writeNarrative,
  "content.writeMemory": ContentToolArgsSchemas.writeMemory,
  "content.writeOption": ContentToolArgsSchemas.writeOption,
  "content.writeFlavor": ContentToolArgsSchemas.writeFlavor,
  "content.referenceAsset": ContentToolArgsSchemas.referenceAsset,
  "content.submit": ContentToolArgsSchemas.submit,
};

/**
 * 第 1 层校验：工具名 ∈ 允许表面、args 是对象、通过 shared Zod schema。
 * 失败即 FATAL（unknown_tool / invalid_arguments），**不消耗**重试额度。
 */
export function validateToolCall(
  call: ToolCallRequest,
  allowed: ReadonlySet<string>,
): ArgValidation {
  if (!allowed.has(call.name)) {
    return { ok: false, code: "unknown_tool", detail: `未授权的工具：${call.name}` };
  }
  if (!isRecord(call.arguments)) {
    return { ok: false, code: "invalid_arguments", detail: `${call.name} 的 arguments 不是对象` };
  }
  const contentSchema = CONTENT_SCHEMA_BY_TOOL[call.name];
  if (contentSchema !== undefined) {
    const parsed = contentSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return { ok: false, code: "invalid_arguments", detail: `${call.name} 参数未通过 schema` };
    }
    return { ok: true, args: call.arguments };
  }
  if (call.name === "fact.setKnowledge") {
    const batch = isRecord(call.arguments) && Array.isArray(call.arguments.entries)
      ? call.arguments.entries
      : null;
    const candidates = batch ?? [call.arguments];
    for (const candidate of candidates) {
      if (!SetKnowledgeArgsSchema.safeParse(candidate).success) {
        return {
          ok: false,
          code: "invalid_arguments",
          detail: "fact.setKnowledge 参数未通过 SetKnowledgeArgsSchema",
        };
      }
    }
    return { ok: true, args: call.arguments };
  }
  if (call.name === "fact.advanceDag") {
    if (!TaskDagSchema.safeParse(call.arguments.dag).success) {
      return { ok: false, code: "invalid_arguments", detail: "fact.advanceDag.dag 未通过 TaskDagSchema" };
    }
    return { ok: true, args: call.arguments };
  }
  return { ok: false, code: "unknown_tool", detail: `无参数契约的工具：${call.name}` };
}

// ---------- 第 1.5 层：LLM args → ContentBlock / ApiCall ----------

const CONTENT_KIND_BY_TOOL: Record<string, string> = {
  "content.writeNarrative": "narrative",
  "content.writeMemory": "memory",
  "content.writeOption": "option",
  "content.writeFlavor": "flavor",
  "content.referenceAsset": "asset",
};

const asPerspective = (v: unknown): Perspective | undefined => {
  if (typeof v !== "string") return undefined;
  if (v === "world" || v === "player" || v.startsWith("npc:")) return v as Perspective;
  return undefined;
};

/**
 * 把 LLM 侧 args（`WriteNarrativeArgs` 等）翻译成引擎侧完整 `ContentBlock`，
 * 再包成 `ContentCall`。`targetPerspective` **不做纠正**：LLM 写错就让它撞
 * `visibility_violation`（RETRYABLE，带 factsHint 回灌），这正是分支①要练的路径。
 */
export function toApiCall(
  tool: string,
  args: Record<string, unknown>,
  ctx: { callId: string; targetPerspective: Perspective },
): ApiCall {
  if (tool === "content.submit") {
    return { callId: ctx.callId, tool, args };
  }
  const kind = CONTENT_KIND_BY_TOOL[tool];
  if (kind === undefined) {
    return { callId: ctx.callId, tool, args };
  }
  const refs = Array.isArray(args.refs)
    ? args.refs.filter((r): r is string => typeof r === "string")
    : [];
  const declaredTarget = asPerspective(args.targetPerspective);
  const observerTarget = tool === "content.writeMemory" ? asPerspective(args.observer) : undefined;
  const block: Record<string, unknown> = {
    blockId: args.blockId,
    kind,
    refs,
    visibility: "public",
    targetPerspective: declaredTarget ?? observerTarget ?? ctx.targetPerspective,
  };
  if (typeof args.text === "string") block.text = args.text;
  if (typeof args.assetId === "string") block.assetId = args.assetId;
  if (typeof args.slot === "string") block.slot = args.slot;
  return { callId: ctx.callId, tool, args: block, refs };
}
