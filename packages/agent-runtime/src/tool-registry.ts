import {
  ContentToolArgsSchemas,
  SetKnowledgeArgsSchema,
  SubmitBranchArgsSchema,
  TaskDagSchema,
  TaskEdgeSchema,
  TaskNodeSchema,
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

/** 流式增量：目前只有正文；工具调用不对外流式（只在结束时整体交付）。 */
export interface AgentStreamDelta {
  text?: string;
}

export interface AgentChatRequest {
  messages: AgentMessage[];
  tools: ToolDescriptor[];
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * 可选增量回调。**提供即开启流式**（provider 发 `stream: true` 并按 SSE 增量回调）；
   * 缺省仍是 `stream: false` 的完整响应 —— 「同步完整就加载中」那条口径的落点。
   * 流式不改变返回值形状：`chat()` 仍只在流结束后返回一份完整 `AgentCompletion`。
   */
  onDelta?: (chunk: AgentStreamDelta) => void;
}

export interface AgentProvider {
  readonly id: "mock" | "openai-compatible";
  chat(req: AgentChatRequest): Promise<AgentCompletion>;
}

// ---------- 工具清单 ----------

/**
 * 事实写入工具（与 game-core `defaultToolRegistry()` 对齐）。
 * `fact.enqueueEvent` 是「把 DAG 分支上的事件上桌」的唯一通道（只入队、不占槽）；
 * 缺了它，LLM 侧就只剩 `content.*` —— 分支永远上不了桌。
 *
 * `fact.upsertDagBranch`（ADR-0037 D4）是**增量**续写：只提交新增/改写的节点与边，
 * 不是整份覆盖；但**改写已有节点仍须重发完整节点**（引擎只采纳其中的可改字段：
 * status/guards/completion/due/visibility），只发改字段的补丁会被判 `invalid_arguments`
 * （FATAL，不消耗重试）。它与 `fact.advanceDag`（整份覆盖）并存，但 LLM 侧应优先用它 ——
 * 整份覆盖会静默丢掉模型没看见的 guards/completion/edges。此前引擎已注册、本清单漏列 ⇒
 * `resolveToolNames` 会把它静默过滤掉（画像写了等于没写），模板一切换就只剩散文。
 */
export const FACT_TOOL_NAMES = [
  "fact.setKnowledge",
  "fact.advanceDag",
  "fact.upsertDagBranch",
  "fact.enqueueEvent",
] as const;

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
 *   早期 demo 模板的 `toolProfile.narrative` 漏列了它（模板不归本包改），先按常驻处理；
 *   画像现已显式列出 writeOption，本项保留为兜底不变量。
 */
export const CONTROL_TOOL_NAMES = ["content.submit", "content.writeOption"] as const;

/**
 * 剧情编排工具（AGENTIC-GM 重构）。
 *
 * `story.submitBranch` 是**唯一**的写世界结构通道：LLM 提交一整条独立分支
 * （触发方式 + 完整编排），由引擎编译成事件、按声明的方式调度。
 * LLM **永远不入队、不占槽** —— 那两条通道（`fact.enqueueEvent` / `fact.upsertDagBranch`）
 * 在新架构里会被逐步下线。
 */
export const STORY_TOOL_NAMES = ["story.submitBranch"] as const;

export const ALL_TOOL_NAMES: readonly string[] = [
  ...FACT_TOOL_NAMES,
  ...CONTENT_TOOL_NAMES_ALL,
  ...CONTROL_TOOL_NAMES,
  ...STORY_TOOL_NAMES,
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
    // 只要求 text：blockId / refs / targetPerspective 由运行时补齐（toApiCall）。
    parameters: schemaOf(
      { text: { type: "string", minLength: 1, description: "叙事正文（中文）" } },
      ["text"],
    ),
  },
  "content.writeMemory": {
    name: "content.writeMemory",
    description: "写入某个观察者的记忆片段。",
    parameters: schemaOf(
      {
        text: { type: "string", minLength: 1 },
        observer: { type: "string", description: "player | npc:<id>；缺省按本轮视角" },
      },
      ["text"],
    ),
  },
  "content.writeOption": {
    name: "content.writeOption",
    description:
      "写入一个玩家可点击的行动选项（本游戏以点击选项推进，打字输入只是兜底）。" +
      "在决策点（章节 / 场景 / 任务推进）应给出 2-3 个选项，顺序排在叙事之后；" +
      "text 必须是第二人称、动词开头的具体动作（例：「撬开后门的电子锁」），不要写成对选项的描述。",
    parameters: schemaOf(
      { text: { type: "string", minLength: 1, description: "选项文案：第二人称、动词开头" } },
      ["text"],
    ),
  },
  "content.writeFlavor": {
    name: "content.writeFlavor",
    description: "写入风味文本（环境描写）。",
    parameters: schemaOf(
      { text: { type: "string", minLength: 1, description: "环境描写" } },
      ["text"],
    ),
  },
  "content.referenceAsset": {
    name: "content.referenceAsset",
    description: "把已有媒体资源挂到叙事的一个槽位上。",
    parameters: schemaOf(
      {
        assetId: { type: "string", minLength: 1 },
        slot: { type: "string", minLength: 1, description: "可选：挂到哪个槽位" },
      },
      ["assetId"],
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
  /**
   * 剧情编排：提交一整条分支。参数 schema 刻意只暴露**创作语义**——
   * 触发方式（随机/必然）、条件、事件块、选项去向；槽/队列/权重/DAG 一律不出现。
   */
  "story.submitBranch": {
    name: "story.submitBranch",
    description:
      "提交一整条独立的分支（1..12 个事件块）。你只表达三件事：这条分支**怎么触发**、" +
      "每个事件**是什么**、整条**编排**是什么。引擎会校验后按触发方式调度，你不需要也不允许" +
      "直接让事件上桌或占槽。" +
      "要点：① `goto` 只能指向本次提交内的 `node`，跨提交接续既有剧情会被拒；" +
      "② 同一 invocation 内多次提交的分支互相独立；" +
      "③ 涉及具体角色时在 `actors` 里列 id，引擎会在呈现前复核其存活/在场（防诈尸）；" +
      "④ 标记 `mode: \"certain\"` 表示条件满足即发生，`random` 表示有机会发生。" +
      " —— 照下面这个例子写，注意 **effects 用 type+id，conditions 用 op+args**，两套 DSL 形状不同：" +
      '{"trigger":{"mode":"certain","conditions":[{"op":"flagSet","args":{"flag":"domainDone","eq":true}}]},' +
      '"branch":[{"node":"s1","title":"路口","text":"……","actors":["npc-yuji"],' +
      '"options":[{"text":"推进","effects":[{"type":"setFlag","id":"swept","value":true}],"goto":"s2"}]},' +
      '{"node":"s2","title":"残渣","text":"……","options":[{"text":"绕开"}]}]}',
    parameters: schemaOf(
      {
        trigger: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["random", "certain"] },
            conditions: {
              type: "array",
              description:
                "触发前置条件，**必须用引擎的 condition DSL**：" +
                '[{"op":"flagSet","args":{"flag":"domainDone","eq":true}}]。' +
                "不要自创 {factRef,op,value} 这种形状（会被判参数非法）。" +
                "省略 = 无条件（条件满足即按 mode 调度）。",
              items: {
                type: "object",
                properties: { op: { type: "string" }, args: { type: "object" } },
                required: ["op", "args"],
              },
            },
          },
          required: ["mode"],
        },
        branch: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              node: { type: "string", description: "本次提交内的局部别名" },
              title: { type: "string" },
              text: { type: "string", description: "玩家在事件区看到的事件正文" },
              actors: { type: "array", items: { type: "string" } },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    text: { type: "string" },
                    effects: { type: "array", items: { type: "object" } },
                    goto: { type: "string", description: "本次提交内的另一个 node" },
                  },
                  required: ["text"],
                },
              },
            },
            required: ["node", "title", "text", "options"],
          },
        },
      },
      ["trigger", "branch"],
    ),
  },
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
  "fact.upsertDagBranch": {
    name: "fact.upsertDagBranch",
    description:
      "**增量**续写任务 DAG 分支：只提交新增 / 改写的节点与边，不是整份覆盖（覆盖会丢掉" +
      "你没看见的 guards / completion / edges）。⚠ 改写已有节点**仍须提交完整节点**" +
      "（id/kind/title/status/guards/completion/templateRefs/visibility 全给，due 可省）；" +
      "只发 {id,status} 补丁会被判 invalid_arguments（FATAL）。引擎只采纳 " +
      "status/guards/completion/due/visibility；status 可写但只能前进、终态不可回退；" +
      "kind/title 不可改写（被拒时回灌当前值，RETRYABLE）。edges 按 (from,to,kind) 去重追加，" +
      "永不删除；合并后校验不过（重复 id/悬空端点/自环/成环/未知 templateRef）⇒ 整体拒绝。",
    parameters: schemaOf(
      {
        nodes: {
          type: "array",
          description: "新增或改写的节点（每个都是完整节点，不是补丁）",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              kind: { type: "string" },
              title: { type: "string" },
              status: { type: "string" },
              guards: { type: "array", items: { type: "object" } },
              completion: { type: "array", items: { type: "object" } },
              due: { type: "integer" },
              templateRefs: { type: "array", items: { type: "string" } },
              visibility: { type: "string" },
            },
            required: [
              "id",
              "kind",
              "title",
              "status",
              "guards",
              "completion",
              "templateRefs",
              "visibility",
            ],
            additionalProperties: false,
          },
        },
        edges: {
          type: "array",
          description: "要追加的边",
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              kind: { type: "string" },
            },
            required: ["from", "to", "kind"],
            additionalProperties: false,
          },
        },
        version: { type: "integer" },
      },
      [],
    ),
  },
  "fact.enqueueEvent": {
    name: "fact.enqueueEvent",
    description:
      "把一个**模板里已存在**的事件入队（只入队、不占槽），用于把任务 DAG 分支上桌。" +
      "eventId 必须逐字取自上下文里出现过的 evt:xxx 引用，禁止自行发明事件 id。",
    parameters: schemaOf(
      { eventId: { type: "string", minLength: 1, description: "模板已存在的事件引用 id（evt:xxx）" } },
      ["eventId"],
    ),
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
  /**
   * 第 1 层只校验**模型真正能决定的那部分**：正文/资源引用。
   *
   * `blockId` / `refs` / `targetPerspective` 是运行时簿记（调用身份、引用集、视角），
   * 由 `toApiCall` 补齐，不该要求模型生成 —— 实测 glm-5.3 在这三个字段上反复失败：
   * 一次给空对象，一次给 `body`，一次给 `narrative`，还有一次给了跨轮重复的 `blockId`。
   * 让模型猜簿记字段，只会把"可修的格式错误"变成整轮作废。
   *
   * 完整校验仍然发生：`toApiCall` 归一化之后，引擎侧 handler 用同一套 strict schema 解析。
   */
  if (CONTENT_SCHEMA_BY_TOOL[call.name] !== undefined) {
    const args = call.arguments;
    if (call.name === "content.referenceAsset") {
      if (typeof args.assetId !== "string" || args.assetId.length === 0) {
        return { ok: false, code: "invalid_arguments", detail: "content.referenceAsset 需要 assetId" };
      }
      return { ok: true, args };
    }
    if (call.name === "content.submit") return { ok: true, args };
    if (typeof args.text !== "string" || args.text.trim().length === 0) {
      return {
        ok: false,
        code: "invalid_arguments",
        detail: `${call.name} 需要 text（非空字符串，正文内容）`,
      };
    }
    return { ok: true, args };
  }
  if (call.name === "story.submitBranch") {
    // 与引擎同一份 schema：本层先拦明显的形状错误，省一次 dispatch；
    // 语义级校验（goto 闭合、EventV2 编译、actors 存在性）仍在引擎。
    const parsed = SubmitBranchArgsSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_arguments",
        // 带上**字段路径**：zod 的 "Invalid input" 单看没有信息量，
        // 真实模型照示例写仍会错在 `branch.0.options.0.effects.0` 这种深层位置。
        detail: `story.submitBranch 参数未通过 schema：${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; ")}`,
      };
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
  if (call.name === "fact.enqueueEvent") {
    const eventId = call.arguments.eventId;
    if (typeof eventId !== "string" || eventId.length === 0) {
      return { ok: false, code: "invalid_arguments", detail: "fact.enqueueEvent 需要 { eventId }" };
    }
    return { ok: true, args: call.arguments };
  }
  if (call.name === "fact.upsertDagBranch") {
    /**
     * 增量入参无法用 `TaskDagSchema`（那是整份 DAG）校验，所以逐项对齐引擎的解析：
     * 引擎对 `nodes[]` / `edges[]` 逐个 `TaskNodeSchema` / `TaskEdgeSchema` 解析，
     * 本层用同一对 schema 提前拦下 —— 拒绝码与引擎一致（`invalid_arguments`），
     * 但**不消耗**引擎那一趟 dispatch。
     *
     * 语义级校验（kind/title 不可改写、status 单调、成环、templateRefs 存在性）留在引擎：
     * 那需要读权威状态，本层没有 state，也不该有。
     */
    const nodes = call.arguments.nodes ?? [];
    const edges = call.arguments.edges ?? [];
    if (!Array.isArray(nodes) || !Array.isArray(edges)) {
      return {
        ok: false,
        code: "invalid_arguments",
        detail: "fact.upsertDagBranch 的 nodes / edges 必须是数组",
      };
    }
    for (const node of nodes) {
      if (!TaskNodeSchema.safeParse(node).success) {
        return {
          ok: false,
          code: "invalid_arguments",
          detail: "fact.upsertDagBranch.nodes[] 未通过 TaskNodeSchema（新节点必须是完整节点）",
        };
      }
    }
    for (const edge of edges) {
      if (!TaskEdgeSchema.safeParse(edge).success) {
        return {
          ok: false,
          code: "invalid_arguments",
          detail: "fact.upsertDagBranch.edges[] 未通过 TaskEdgeSchema",
        };
      }
    }
    const version = call.arguments.version;
    if (version !== undefined && (!Number.isInteger(version) || (version as number) < 0)) {
      return {
        ok: false,
        code: "invalid_arguments",
        detail: "fact.upsertDagBranch.version 必须是非负整数",
      };
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
  /**
   * `blockId` 由运行时补齐，**不要求模型生成**。
   *
   * 真实模型实测（glm-5.3）：它要么不给 blockId，要么给一个跨轮重复的 `"b1"` —— 前者过不了
   * 必填校验，后者会让两块正文撞同一个 id（前端 key 冲突）。而 blockId 本来就是
   * 「这次调用的身份」，运行时手里有唯一确定的 `callId`，没有任何理由让模型去编。
   */
  const blockId =
    typeof args.blockId === "string" && args.blockId.length > 0 ? args.blockId : ctx.callId;
  const block: Record<string, unknown> = {
    blockId,
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
