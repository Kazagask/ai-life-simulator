import {
  BRANCH_MAX_EFFECTS_PER_OPTION,
  BRANCH_MAX_GENERATED_NPCS,
  BRANCH_MAX_NODES,
  BRANCH_MAX_OPTIONS_PER_NODE,
  GENERATED_NPC_ATTRIBUTE_MAX,
  SubmitBranchArgsSchema,
  type ApiCall,
  type RulesTemplate,
  type ToolDescriptor,
} from "@life-sim/shared";
import {
  EFFECT_SHAPE_COUNT,
  HISTORY_HARD_CAP,
  READ_TOOL_NAMES,
  isReadTool,
} from "./read-tools.js";

/**
 * T-03：能力画像 → 工具描述（OpenAI `tools` 结构）+ 第 1 层参数校验 + ApiCall 翻译。
 *
 * ---------- 已知契约缺口（不改契约，只在此存档；改动需走协议评审） ----------
 * [缺口 4] `LlmInvocation` 不带 `turnIndex` / `worldTime`，loop 只能从
 *          `engineApi.snapshot()` 读时钟。当 server 注入 `projectSnapshotV2` 时，trace 的
 *          时钟字段就依赖投影路径；若要「trace 可脱离投影独立回放」，应把时钟放进 invocation。
 *
 * 硬不变量：
 * - 工具调用走**结构化** `tools` / `tool_calls`，本文件绝不从自由文本里正则抠工具名。
 * - 工具名集合是封闭的（与 game-core 的 `RpgEngineAPI` 注册表逐字一致）；
 *   能力画像 `rules.toolProfile[name]` 只能**收窄**，不能新增。
 * - 写世界只有 `story.submitBranch`；叙事正文只来自 `delta.content` 的
 *   `<narrative-content>` 标签（loop 落 sink / trace），不走工具面。
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

const FACT_DESCRIPTORS: Record<string, ToolDescriptor> = {
  /**
   * 只读查询（AGENTIC-GM 重构 · 设计 §3）：**一条查询一个工具**。
   * 视角在调用时固定（player 窗口），**不接受 perspective 参数** —— 看不到的东西
   * 在数据源上就不存在，不是靠过滤。
   */
  /**
   * 词表（2026-11-21）：**渐进披露**的第二跳。
   *
   * 描述刻意短：先给「什么时候该查」，不把 9 种形状全写进工具表 ——
   * 那会挤掉叙事素材，模型也不会看。真正的内容在调用结果里。
   */
  "rule.lexicon": {
    name: "rule.lexicon",
    description:
      "查词表。**写 story.submitBranch 的 effects 之前必须先查 effects**（凭空编字段名会被整条拒绝）。" +
      `不带 section 返回目录；section=effects 给 ${EFFECT_SHAPE_COUNT} 种效果形状 + 可引用的属性/资源/关系 kind/在场角色，` +
      "items 给物品词表，statuses 给状态词表。",
    parameters: schemaOf(
      {
        section: {
          type: "string",
          enum: ["index", "effects", "items", "statuses"],
          description: "要哪一节；缺省 = 目录",
        },
      },
      [],
    ),
  },
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
      `查最近发生过什么（按轮次倒序取最近 N 条，默认与上限都是 ${HISTORY_HARD_CAP}）。` +
      "返回里带 total / truncated：**必须看 truncated** —— 它告诉你还有更早的历史没返回，" +
      `不要把「只看到 ${HISTORY_HARD_CAP} 条」误当成「世界只发生过 ${HISTORY_HARD_CAP} 件事」。`,
    parameters: schemaOf(
      { limit: { type: "integer", minimum: 1, description: `要几条，默认 ${HISTORY_HARD_CAP}（上限 ${HISTORY_HARD_CAP}）` } },
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
    description: "查你自己：属性、资源、心情、状态、技能、背包与装备。",
    parameters: schemaOf({}, []),
  },
  /**
   * 剧情编排：提交一整条分支。参数 schema 刻意只暴露**创作语义**——
   * 触发方式（随机/必然）、条件、事件块、选项去向；槽/队列/权重/DAG 一律不出现。
   */
  "story.submitBranch": {
    name: "story.submitBranch",
    description:
      `提交一整条独立的分支（1..${BRANCH_MAX_NODES} 个事件块）。你只表达三件事：这条分支**怎么触发**、` +
      "每个事件**是什么**、整条**编排**是什么。引擎会校验后按触发方式调度，你不需要也不允许" +
      "直接让事件上桌或占槽。**写 effects 之前先调 rule.lexicon（section=effects）**核对形状与 id。" +
      "要点：① `goto` 只能指向本次提交内的 `node`，跨提交接续既有剧情会被拒；" +
      "①′ **多个选项指向同一个 `node` 时，它们的 `after` 必须一致**（延迟属于节点，不属于选项），" +
      "不一致会整条被拒——想表达「先扫一遍再走要多花时间」，就把它写成两个不同 node；" +
      "①″ **只写这一刻的正文不要调用本工具**：正文写进 `<narrative-content>` 即可，不调任何工具也算完成；" +
      "调本工具就必须给全 `trigger` 与 `branch`，空参数会被整条拒；" +
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
      "⑦ 延迟是**相对量**：`trigger.after` 表示「提交后过多久开演」（如 {value:2,unit:\"day\"}），" +
      "不是绝对日期；**省略 `after` = 立刻上演**（槽空就当场播，别为了「快一点」写 1 分钟）；" +
      "`goto` 可写字符串，也可写 {node,after} 表示「上一幕之后过多久再进入下一幕」。" +
      "⑧ **每个选项都必须有效果，且至少要有一条改数值的**（mood / hp / mp）——" +
      "玩家点了就要有代价或所得；只写旗标不算：旗标是留给你自己后续引用的记号，模板不会读它，" +
      "对玩家等于什么都没发生。" +
      " —— 照下面这个例子写。effects 只有三种扁平形状：{\"flag\":\"名字\",\"value\":true} 置旗标、" +
      "{\"mood\":3} 调心情、{\"hp\":-5}/{\"mp\":-5} 调资源；**不要写 type/op 字段**。" +
      '{"trigger":{"mode":"certain","after":{"value":2,"unit":"day"}},' +
      '"branch":[{"node":"s1","title":"路口","text":"……","actors":["<角色id>"],' +
      '"options":[{"text":"推进","effects":[{"flag":"swept","value":true},{"mood":-2}],' +
      '"goto":{"node":"s2","after":{"value":1,"unit":"hour"}}}]},' +
      '{"node":"s2","title":"残渣","text":"……","options":[{"text":"绕开","effects":[{"hp":-3}]}]}]}',
    parameters: schemaOf(
      {
        trigger: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["random", "certain"] },
            after: {
              type: "object",
              description: "提交后过多久开演（相对量，不是绝对日期）",
              properties: {
                value: { type: "integer", minimum: 1 },
                unit: { type: "string", enum: ["minute", "hour", "day", "week", "month", "year"] },
              },
              required: ["value", "unit"],
            },
            // v1 不解释条件：可以不写，写了也会被忽略（写错不会导致整轮失败）。
          },
          required: ["mode"],
        },
        npcs: {
          type: "array",
          maxItems: BRANCH_MAX_GENERATED_NPCS,
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
              attributes: { type: "object", description: `只采纳模板声明的属性键，值钳到 [0,${GENERATED_NPC_ATTRIBUTE_MAX}]` },
            },
            required: ["alias", "name"],
          },
        },
        branch: {
          type: "array",
          minItems: 1,
          maxItems: BRANCH_MAX_NODES,
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
                minItems: 1,
                maxItems: BRANCH_MAX_OPTIONS_PER_NODE,
                items: {
                  type: "object",
                  properties: {
                    text: { type: "string" },
                    effects: {
                      type: "array",
                      minItems: 1,
                      maxItems: BRANCH_MAX_EFFECTS_PER_OPTION,
                      description:
                        "至少一条，且**至少一条改数值**（mood / hp / mp）；旗标只作你自己的后续引用，" +
                        "模板不会读。三种扁平形状：{flag,value} / {mood} / {hp}或{mp}",
                      items: { type: "object" },
                    },
                    goto: {
                      description:
                        "本次提交内的另一个 node；字符串 = 立即进入；对象 = 可声明 after（上一幕之后过多久）",
                      oneOf: [
                        { type: "string" },
                        {
                          type: "object",
                          properties: {
                            node: { type: "string" },
                            after: {
                              type: "object",
                              properties: {
                                value: { type: "integer", minimum: 1 },
                                unit: {
                                  type: "string",
                                  enum: ["minute", "hour", "day", "week", "month", "year"],
                                },
                              },
                              required: ["value", "unit"],
                            },
                          },
                          required: ["node"],
                        },
                      ],
                    },
                  },
                  required: ["text", "effects"],
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

const descriptorOf = (name: string): ToolDescriptor | undefined => FACT_DESCRIPTORS[name];

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

// ---------- 第 1.5 层：LLM args → ApiCall ----------

/**
 * LLM args 直通引擎：写世界只剩 `story.submitBranch`，读工具不经过 dispatch。
 * 不再有 `content.*` 的 args→ContentBlock 翻译（叙事正文从 `<narrative-content>` 标签来，
 * 由 loop 直接落 sink / trace）。
 */
export function toApiCall(
  tool: string,
  args: Record<string, unknown>,
  ctx: { callId: string },
): ApiCall {
  return { callId: ctx.callId, tool, args };
}
