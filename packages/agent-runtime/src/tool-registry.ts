import {
  ContentToolArgsSchemas,
  SubmitBranchArgsSchema,
  type ApiCall,
  type Perspective,
  type RulesTemplate,
  type ToolDescriptor,
} from "@life-sim/shared";
import { READ_TOOL_NAMES, isReadTool } from "./read-tools.js";

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
 * `fact.*` 写工具已于 2026-11-16 **全部下线**（AGENTIC-GM 重构 §4）。
 *
 * 写世界只剩 `story.submitBranch` 一条通道：LLM 不感知槽 / 队列 / 池 / DAG。
 * 下线原因是三条已被实测确认的事故根因：
 * - `fact.enqueueEvent`：每轮重新入队 ⇒ closing↔chance 无限交替；
 * - `fact.advanceDag`：整份覆盖会静默丢掉模型没看见的 guards / completion / edges；
 * - `fact.upsertDagBranch`：「在已有结构上打补丁」，正是被禁止的写法。
 * 知识授予改由模板 `knowledgeGrants` 规则完成，不需要 LLM 写。
 *
 * **不要**为了兼容把任何一个加回工具面 —— 模型看到它们就会调用，幻觉与 `unknown_tool` 随之而来。
 */

/** 内容写入工具（与 game-core `defaultToolRegistry()` 对齐）。 */
/**
 * 叙事写入工具（与 game-core `defaultToolRegistry()` 对齐）：**只剩两个**。
 * `writeOption` / `writeMemory` / `referenceAsset` 已从函数层删除，理由见引擎注册处注释。
 */
export const CONTENT_TOOL_NAMES_ALL = ["narrative.write", "narrative.flavor"] as const;

/**
 * 常驻工具（不受能力画像收窄影响）：**只留 `agent.submit`**。
 *
 * `agent.submit` 是唯一的「提交」终止信号，缺了它一次 invocation 永远进不了 committed，
 * 任何画像都必须有它。
 *
 * `content.writeOption` **已从常驻里移除**（AGENTIC-GM 重构）：选项是**事件的一部分**
 * （`story.submitBranch` 里的 `options`，带真 optionId、由引擎呈现），不是模型写的一段文本。
 * 它曾经因为"早期 demo 画像漏列"被当常驻兜底，结果是 **gm 画像也照样能写文本选项** ——
 * 前端把它渲染成黄色胶囊，看起来像选项，点下去却只能按自由行动受理，和事件面板里的
 * 真选项是两套东西。画像不列 = 不下发，这才是"能力由画像与槽状态共同决定"。
 */
/**
 * 常驻工具：**空**。
 *
 * `agent.submit` 已从模型工具面移除（2026-11-16）：终止是**运行时责任** ——
 * 模型不再发 tool call 就是"写完了"，运行时自己补一次内部提交做记账
 * （写 `traceRef`、清 `pendingInvocation`）。要求模型显式提交只会多一个
 * "忘了 submit ⇒ 整轮作废"的故障模式。
 */
export const CONTROL_TOOL_NAMES: readonly string[] = [];

/**
 * 剧情编排工具（AGENTIC-GM 重构）。
 *
 * `story.submitBranch` 是**唯一**的写世界结构通道：LLM 提交一整条独立分支
 * （触发方式 + 完整编排），由引擎编译成事件、按声明的方式调度。
 * LLM **永远不入队、不占槽**；旧的 fact.* 写工具已于 2026-11-16 全部下线。
 */
export const STORY_TOOL_NAMES = ["story.submitBranch"] as const;

export const ALL_TOOL_NAMES: readonly string[] = [
  ...CONTENT_TOOL_NAMES_ALL,
  ...CONTROL_TOOL_NAMES,
  ...STORY_TOOL_NAMES,
  ...READ_TOOL_NAMES,
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
  "narrative.write": {
    name: "narrative.write",
    description: "写入一段叙事正文（只进 trace，不进权威状态）。",
    // 只要求 text：blockId / refs / targetPerspective 由运行时补齐（toApiCall）。
    parameters: schemaOf(
      { text: { type: "string", minLength: 1, description: "叙事正文（中文）" } },
      ["text"],
    ),
  },
  "narrative.flavor": {
    name: "narrative.flavor",
    description: "写入风味文本（环境描写）。",
    parameters: schemaOf(
      { text: { type: "string", minLength: 1, description: "环境描写" } },
      ["text"],
    ),
  },
};

const FACT_DESCRIPTORS: Record<string, ToolDescriptor> = {
  /**
   * 只读查询（AGENTIC-GM 重构 · 设计 §3）：**一条查询一个工具**。
   * 视角在调用时固定（player 窗口），**不接受 perspective 参数** —— 看不到的东西
   * 在数据源上就不存在，不是靠过滤。
   */
  "world.now": {
    name: "world.now",
    description:
      "查「此刻」：第几轮、世界时间、当前在演的那一格（事件 id / 标题 / 类型 / 来源 / 玩家可点的选项）。" +
      "槽为空时 slot 为 null，表示可自由行动。",
    parameters: schemaOf({}, []),
  },
  "world.history": {
    name: "world.history",
    description:
      "查最近发生过什么（按轮次倒序取最近 N 条，默认与上限都是 50）。" +
      "返回里带 total / truncated：**必须看 truncated** —— 它告诉你还有更早的历史没返回，" +
      "不要把「只看到 50 条」误当成「世界只发生过 50 件事」。",
    parameters: schemaOf(
      { limit: { type: "integer", minimum: 1, description: "要几条，默认 50（上限 50）" } },
      [],
    ),
  },
  "world.present": {
    name: "world.present",
    description: "查在场的角色：名字、是否活着、与你的关系值、你知道的目标、身上的状态。",
    parameters: schemaOf({}, []),
  },
  "world.self": {
    name: "world.self",
    description: "查你自己：属性、生命/咒力/心情、状态、技能、背包与装备。",
    parameters: schemaOf({}, []),
  },
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
      "③ 角色分两种写法，别混：`actors` 是「这一幕必须在场的人」（引擎呈现前复核，不在场就跳过这一幕）；" +
      "`mentions` 是「只在正文里提到的人」，可以是已故的（纪念 / 缅怀 / 遗物 / 墓前这类戏用它，" +
      "把逝者写进 actors 会让这一幕被判跳过）；" +
      "④ 需要**新角色**时在顶层 `npcs` 里描述（模板里没有的人也可以）：" +
      '{alias,name,age?,gender?,personality?,knownGoals?,attributes?}。' +
      "定义的只是「他是谁」，**登场**要另在选项效果里写 `{\"spawn\":\"<alias>\"}``；" +
      "`spawn` 也可以填模板刷新规则 id（两种来源共用同一实例表）。" +
      "⑤ 关系/生命周期同样写在选项效果里：`{\"relation\":{\"with\":\"<alias或npcId>\",\"to\":12}}`、" +
      '`{"lifecycle":{"npc":"<alias或npcId>","state":"alive|inactive"}}`。' +
      "⑥ 标记 `mode: \"certain\"` 表示条件满足即发生，`random` 表示有机会发生。" +
      " —— 照下面这个例子写。effects 只有三种扁平形状：{\"flag\":\"名字\",\"value\":true} 置旗标、" +
      "{\"mood\":3} 调心情、{\"hp\":-5}/{\"mp\":-5} 调资源；**不要写 type/op 字段**。" +
      '{"trigger":{"mode":"certain"},' +
      '"branch":[{"node":"s1","title":"路口","text":"……","actors":["npc-yuji"],' +
      '"options":[{"text":"推进","effects":[{"flag":"swept","value":true}],"goto":"s2"}]},' +
      '{"node":"s2","title":"残渣","text":"……","options":[{"text":"绕开"}]}]}',
    parameters: schemaOf(
      {
        trigger: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["random", "certain"] },
            // v1 不解释条件：可以不写，写了也会被忽略（写错不会导致整轮失败）。
          },
          required: ["mode"],
        },
        npcs: {
          type: "array",
          maxItems: 4,
          description: "本次提交新造的角色（模板里没有的人）。定义了 ≠ 登场了：登场要用 effect spawn。",
          items: {
            type: "object",
            properties: {
              alias: { type: "string", description: "本次提交内的局部别名" },
              name: { type: "string" },
              age: { type: "integer" },
              gender: { type: "string" },
              personality: { type: "string" },
              knownGoals: { type: "array", items: { type: "string" } },
              attributes: { type: "object", description: "只采纳模板声明的属性键，值钳到 [0,20]" },
            },
            required: ["alias", "name"],
          },
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
              actors: {
                type: "array",
                items: { type: "string" },
                description: "必须在场的角色 id（不在场 ⇒ 这一幕被跳过）",
              },
              mentions: {
                type: "array",
                items: { type: "string" },
                description: "只在正文提到的角色 id，可以是已故的人",
              },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    text: { type: "string" },
                    effects: {
                      type: "array",
                      maxItems: 4,
                      description:
                        "三种扁平形状之一：{flag,value} 置旗标 / {mood} 调心情 / {hp}或{mp} 调资源",
                      items: { type: "object" },
                    },
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

/** 画像收窄后的工具名集合（含常驻控制通道 `agent.submit`）。 */
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
  "narrative.write": ContentToolArgsSchemas.writeNarrative,
  "narrative.flavor": ContentToolArgsSchemas.writeFlavor,
};

/**
 * 第 1 层校验：工具名 ∈ 允许表面、args 是对象、通过 shared Zod schema。
 * 失败即 FATAL（unknown_tool / invalid_arguments），**不消耗**重试额度。
 */
export function validateToolCall(
  call: ToolCallRequest,
  allowed: ReadonlySet<string>,
): ArgValidation {
  /**
   * `agent.submit` 是**内部/兼容**动词，不在模型工具面上（任何画像都不列它），
   * 但仍然允许出现在调用里：
   * - 运行时在"自然退出"时会自己补一次（记账用）；
   * - 旧脚本 / 旧 trace 回放里可能还有它。
   * 模型即使幻觉出它也无害 —— 只是标记"我写完了"。
   */
  if (call.name === "agent.submit") return { ok: true, args: call.arguments };
  // 只读工具：参数由 `runReadTool` 解析（缺省/多余一律容忍，读错不该炸整轮）。
  if (isReadTool(call.name)) return { ok: true, args: call.arguments };
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
  return { ok: false, code: "unknown_tool", detail: `无参数契约的工具：${call.name}` };
}

// ---------- 第 1.5 层：LLM args → ContentBlock / ApiCall ----------

/** 叙事工具 → 内容块 kind。只剩两个：正文与旁注（option/memory/asset 已删）。 */
const CONTENT_KIND_BY_TOOL: Record<string, string> = {
  "narrative.write": "narrative",
  "narrative.flavor": "flavor",
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
  if (tool === "agent.submit") {
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
  // `writeMemory` 已删：记忆由引擎按模板 knowledgeGrants 授予，不是 AI 写的。
  const observerTarget = undefined;
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
