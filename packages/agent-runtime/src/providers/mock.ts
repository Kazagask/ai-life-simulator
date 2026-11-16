import type { Perspective } from "@life-sim/shared";
import {
  type AgentChatRequest,
  type AgentCompletion,
  type AgentMessage,
  type AgentProvider,
  type ToolCallRequest,
  type ToolDescriptor,
} from "../tool-registry.js";

/**
 * 零 API key 也能玩的**确定性**脚本 provider。
 *
 * 产品口径（用户裁决）：「点击为主，打字输入为辅」——**每一回合**都要给出可点动作；
 * 只产出散文的一回合等于坏回合。回合内按 loop 的 dispatch 轮次推进：
 *   ① 叙事（narrative.write）
 *   ② 分支（可选：story.submitBranch —— 提交一条单节点分支，由引擎调度上桌）
 *   ③ 旁注（narrative.flavor；选项属于事件块，不再由 LLM 写）
 *   ④ 结束（不再发 tool call，运行时补一次内部提交做记账）
 * 因此 `contentBlocks` 顺序恒为 narrative → flavor，前端按 kind 渲染。
 *
 * ② 只在调用上下文声明了 `branchEventIds`（模板声明"本 invocation 可写分支"）时发生。
 * 它只是**能力信号**：提交内容由 mock 确定性生成，事件 id 由引擎分配 —— `contextHints`
 * 仍是**自由文本标签通道，零解释**，发射路径不读它的字符串语义。
 *
 * ⚠ 去重责任边界：`branchEventIds` 是**能力**不是**一次性**。跨回合不重复上桌靠
 * `story.submitBranch` 的编译 / 调度语义与模板 `missWhen`；频率由 ADR-0036 的边沿触发收敛。
 * mock 是**无状态**的（同 invocationId + 同状态 ⇒ 逐字节相同），结构上不做跨回合去重。
 *
 * 文本全部由 `inv.context` 的 facts / recentTurns 与 invocationReason 合成；
 * 无随机、无时钟：同一 invocationId + 同一世界状态 ⇒ 逐字节相同的输出。
 */

interface MockFactItem {
  factRef: string;
  value?: unknown;
  level?: string;
}

interface MockContextView {
  invocationId: string;
  reason: string;
  perspective: Perspective;
  targetPerspective: Perspective;
  facts: {
    perspective?: string;
    facts?: MockFactItem[];
  };
  recentTurns: unknown[];
  contextHints?: string[];
  /** ADR-0038：本轮「可写分支」的能力信号。缺省/空数组 ⇒ 整轮不提交分支。 */
  branchEventIds?: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseContextView(message: AgentMessage | undefined): MockContextView | null {
  if (message === undefined || typeof message.content !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.content);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.reason !== "string" || typeof parsed.invocationId !== "string") return null;
  const factsView = isRecord(parsed.facts) ? parsed.facts : {};
  const rawFacts = Array.isArray(factsView.facts) ? factsView.facts : [];
  const facts = rawFacts.filter(
    (item): item is MockFactItem => isRecord(item) && typeof item.factRef === "string",
  );
  const perspective = (typeof parsed.perspective === "string" ? parsed.perspective : "player") as Perspective;
  const targetRaw = typeof parsed.targetPerspective === "string" ? parsed.targetPerspective : perspective;
  return {
    invocationId: parsed.invocationId,
    reason: parsed.reason,
    perspective,
    targetPerspective: targetRaw as Perspective,
    facts: { facts },
    recentTurns: Array.isArray(parsed.recentTurns) ? parsed.recentTurns : [],
    ...(Array.isArray(parsed.contextHints)
      ? { contextHints: parsed.contextHints.filter((h): h is string => typeof h === "string") }
      : {}),
    // 形状校验与 contextHints 同一套：非字符串项静默丢弃，绝不抛。
    ...(Array.isArray(parsed.branchEventIds)
      ? { branchEventIds: parsed.branchEventIds.filter((h): h is string => typeof h === "string") }
      : {}),
  };
}

const REASON_OPENERS: Array<{ match: string; text: string }> = [
  { match: "chapter", text: "新的篇章在你面前展开。" },
  { match: "task", text: "悬着的事情终于有了着落。" },
  { match: "random", text: "风从尚未命名的街角掠过。" },
  { match: "flavor", text: "四下安静下来，只剩下呼吸与脚步。" },
  { match: "opening", text: "你睁开眼，世界的轮廓一点点清晰起来。" },
];

function openerFor(reason: string): string {
  for (const entry of REASON_OPENERS) {
    if (reason.includes(entry.match)) return entry.text;
  }
  return "此刻，世界安静地向前走了一步。";
}

/** 最近一轮的可读标题（历史条目形状由调用方决定，取第一个可用字段）。 */
function recentTitle(turns: readonly unknown[]): string | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!isRecord(turn)) continue;
    const label = turn.title ?? turn.summary ?? turn.eventTitle ?? turn.text;
    if (typeof label === "string" && label.length > 0) return label;
  }
  return null;
}

// ---------- 单一净化闸门（mock 发出的每一个字符串都必须过这里） ----------

/** 哨兵值：world.yaml 会把初始旗标写成 "unknown"，这类值等价于「没有信息」。 */
const SENTINEL_VALUES = new Set([
  "",
  "unknown",
  "hidden",
  "inferred",
  "known",
  "undefined",
  "null",
  "n/a",
]);

/** 哨兵词：即使作为子串出现在候选值里，也不该出现在玩家文本中。 */
const SENTINEL_WORDS = /\b(unknown|undefined|null|n\/a)\b/i;

/** 机器 id 形态：`fact:x` / `flag:y` / `inv:3` / `node:n1` / `infoVisibility:z` / `npc-x` 等。 */
const MACHINE_TOKEN_PATTERNS: readonly RegExp[] = [
  /\b(?:fact|dag|secret|flag|asset|inv|node):[A-Za-z0-9_.:\-]+/gi,
  /\b[A-Za-z][A-Za-z0-9_]*:npc-[A-Za-z0-9_.\-]+/gi,
  /\binfoVisibility:[A-Za-z0-9_.\-]+/gi,
  /\bvisibility:[A-Za-z0-9_.\-]+/gi,
];

/** 残留的冒号分隔机器 id（净化后仍出现 ⇒ 整个候选不可用）。 */
const RESIDUAL_MACHINE_ID = /[A-Za-z][A-Za-z0-9_]*:[A-Za-z0-9_.\-]+/;

function stripMachineIds(text: string): string {
  let out = text;
  for (const pattern of MACHINE_TOKEN_PATTERNS) out = out.replace(pattern, "");
  // 剥掉 token 后可能留下空引号 / 连续标点，收尾成可读文案。
  return out
    .replace(/「\s*」/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/，\s*，/g, "，")
    .trim();
}

/**
 * 净化闸门：返回 null 表示该候选**不可用**，调用方必须回退到下一个候选；
 * 返回字符串则是可直接展示的中文文案（已去机器 id、去哨兵）。
 *
 * 判定顺序：① 整串命中哨兵清单 ⇒ null；② 含哨兵词（unknown/null…）⇒ null；
 * ③ 剥离机器 id；④ 剥离后为空或仍有冒号 id ⇒ null。
 */
export function sanitizeProse(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (SENTINEL_VALUES.has(trimmed.toLowerCase())) return null;
  if (SENTINEL_WORDS.test(trimmed)) return null;
  const stripped = stripMachineIds(trimmed);
  if (stripped.length === 0) return null;
  if (RESIDUAL_MACHINE_ID.test(stripped)) return null;
  return stripped;
}

/** 从事实值取出一个可用的人话片段；不可用（哨兵 / 机器 id / 与 ref 同值）则返回 null。 */
function readableFactValue(fact: MockFactItem): string | null {
  if (fact.level !== undefined && fact.level !== "known" && fact.level !== "inferred") return null;
  const candidate =
    typeof fact.value === "string"
      ? fact.value
      : isRecord(fact.value)
        ? fact.value.name ?? fact.value.title ?? fact.value.location ?? fact.value.label
        : undefined;
  const cleaned = sanitizeProse(candidate);
  if (cleaned === null) return null;
  if (cleaned === fact.factRef) return null;
  return cleaned;
}

/**
 * 事实值里的人名 / 地名等**可读**片段。
 * 全部经 `sanitizeProse`：`unknown` 这类哨兵、`infoVisibility:npc-mentor` 这类机器 id
 * 一律视为「没有信息」，回退到 reason 派生的自成一体的句子。
 */
function readableValues(view: MockContextView): string[] {
  const out: string[] = [];
  for (const fact of view.facts.facts ?? []) {
    const cleaned = readableFactValue(fact);
    if (cleaned !== null) out.push(cleaned);
  }
  return [...new Set(out)];
}

function visibleFactRefs(view: MockContextView): string[] {
  return (view.facts.facts ?? [])
    .filter((fact) => fact.level === undefined || fact.level === "known" || fact.level === "inferred")
    .map((fact) => fact.factRef);
}

const REASON_LABELS: Array<{ match: string; text: string }> = [
  { match: "chapter", text: "新的篇章" },
  { match: "task", text: "手头这件事" },
  { match: "random", text: "街角的动静" },
  { match: "flavor", text: "此刻的动静" },
  { match: "opening", text: "醒来后的世界" },
  { match: "trial", text: "这场试炼" },
];

/**
 * 自成一体的 reason 句子：当没有任何可用事实值时用它兜底，
 * 绝不把 `unknown` 之类占位拼进模板（`chapter.advance` → 「局势向前推进了一步。」）。
 */
const REASON_SENTENCES: Array<{ match: string; text: string }> = [
  { match: "chapter", text: "局势向前推进了一步。" },
  { match: "task", text: "这件事又往前走了一步。" },
  { match: "random", text: "街上的动静比刚才更近了。" },
  { match: "flavor", text: "此刻的空气里有一点细微的变化。" },
  { match: "opening", text: "新的处境已经在你面前展开。" },
  { match: "trial", text: "试炼的下一段就在眼前。" },
];

function reasonSentence(reason: string): string {
  for (const entry of REASON_SENTENCES) {
    if (reason.includes(entry.match)) return entry.text;
  }
  return "局面又向前挪动了一点。";
}

/** 触发事件的标题：优先历史标题；无历史时从 reason 派生中文标签，避免出现英文 id。 */
function eventTitle(view: MockContextView): string {
  const fromHistory = sanitizeProse(recentTitle(view.recentTurns) ?? undefined);
  if (fromHistory !== null) return fromHistory;
  for (const entry of REASON_LABELS) {
    if (view.reason.includes(entry.match)) return entry.text;
  }
  return "眼前的局面";
}

/**
 * 从可见事实 / 历史合成正文（纯函数、无随机）。
 * 整段在返回前过 `sanitizeProse`；若整段不可用（理论上不会发生），退回 reason 句子。
 */
function synthesizeNarrative(view: MockContextView): string {
  const refs = visibleFactRefs(view);
  const readable = readableValues(view);
  const event = eventTitle(view);
  const sentences: string[] = [openerFor(view.reason)];

  if (readable.length > 0) {
    readable.slice(0, 2).forEach((value) => sentences.push(`你看见了${value}。`));
  } else {
    // 没有任何可用事实值（全是 unknown / 机器 id）⇒ 用 reason 的自成一体句子，
    // 绝不把占位拼进模板凑字数。
    sentences.push(reasonSentence(view.reason));
  }

  sentences.push(
    refs.length > 0
      ? `围绕「${event}」，你手里还攥着 ${refs.length} 条线索。`
      : `「${event}」就在眼前，你得决定怎么应对。`,
  );

  const title = sanitizeProse(recentTitle(view.recentTurns) ?? undefined);
  if (title !== null) sentences.push(`刚才的事还留着余温：${title}。`);

  sentences.push(
    view.targetPerspective === "world"
      ? "众生各怀心事，棋盘上的每一步都已被记录。"
      : "你把这一切收进心里，等着下一步动作。",
  );
  return sanitizeProse(sentences.join("")) ?? reasonSentence(view.reason);
}

/** 稳定哈希（仅用于确定性地挑选选项顺序，不参与任何权威判定）。 */
function stableHash(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/**
 * 2-3 个「玩家可点击的动作」：第二人称、动词开头、具体到眼前的事实 / 人 / DAG 步。
 *
 * 第一条恒为「情境主行动」（跟着事件标题走，保证与当前回合相关）；后两条从候选池里
 * 按 `reason + invocationId + 首条事实` 的稳定哈希轮转取出 —— 连续回合不会逐字重复，
 * 同一 invocationId 永远得到同一组。
 */
/** 到最后仍凑不满两个选项时使用的绝对安全动作（不含任何插值，必过净化门）。 */
const SAFE_OPTIONS = [
  "先退半步，把四周看清楚",
  "径直走上前，不再犹豫",
  "放慢脚步，等对方先动",
];

function optionTexts(view: MockContextView): string[] {
  const names = readableValues(view);
  const refs = visibleFactRefs(view);
  const event = eventTitle(view);

  const lead =
    names[0] !== undefined
      ? `向${names[0]}开口，问清眼前的变故`
      : `走上前，把${event}看个清楚`;

  const rest: string[] = [];
  if (refs.length > 0) rest.push(`循着「${event}」的线索追下去`);
  rest.push("先退半步，把四周看清楚");
  rest.push("径直走上前，不再犹豫");
  rest.push("转身回到来路，暂避锋芒");
  rest.push("放慢脚步，等对方先动");

  const picks: string[] = [];
  const push = (candidate: string): void => {
    // 每个候选都必须过同一个净化门；不可用就静默丢弃，由下一个候选补位。
    const cleaned = sanitizeProse(candidate);
    if (cleaned === null || picks.includes(cleaned)) return;
    picks.push(cleaned);
  };

  push(lead);
  const offset = stableHash(`${view.reason}|${view.invocationId}|${refs[0] ?? ""}`) % rest.length;
  for (let i = 0; i < rest.length && picks.length < 3; i += 1) {
    push(rest[(offset + i) % rest.length]!);
  }
  for (const safe of SAFE_OPTIONS) {
    if (picks.length >= 2) break;
    push(safe);
  }
  return picks.slice(0, 3);
}

/** ② 分支轮唯一会发的「写世界」工具（提交一条分支）。 */
const BRANCH_TOOL = "story.submitBranch";

/**
 * 本轮是否具备分支能力：只认 `view.branchEventIds` 是否声明（ADR-0038 D7 的
 * "模板声明能力"信号保留）。
 *
 * 值本身不再用于入队 —— 写世界已统一走 `story.submitBranch`，事件 id 由引擎分配；
 * mock 不得自己编模板事件。缺省 / 空数组 ⇒ 整轮不发（「沉默 = 没有分支能力」，
 * 空数组**不是**不限制）。
 */
function branchEnabled(view: MockContextView): boolean {
  const declared = view.branchEventIds;
  return declared !== undefined && declared.length > 0;
}

/**
 * ② 分支轮：提交**单节点 + 单选项**的分支（`mode: certain` ⇒ 下一回合上桌）。
 *
 * 排在叙事之后、选项之前：分支先提交，引擎编译成事件后由回合边界调度上桌。
 * 内容完全确定性：同 invocationId + 同状态 ⇒ 逐字节相同，不引入随机。
 */
function branchCalls(view: MockContextView, available: Set<string>): ToolCallRequest[] {
  if (!available.has(BRANCH_TOOL)) return [];
  if (!branchEnabled(view)) return [];
  return [
    {
      id: `${view.invocationId}:call:branch`,
      name: BRANCH_TOOL,
      arguments: {
        trigger: { mode: "certain" },
        branch: [
          {
            node: "mock.branch",
            title: "岔路",
            text: "前方出现了一个岔口，脚步在这里短暂停顿。",
            options: [{ text: "继续前行" }],
          },
        ],
      },
    },
  ];
}

function assetIdFrom(view: MockContextView): string | null {
  // 判据（ADR-0038 D2-a）：形状推断若改变世界节奏（入队 / 推进 DAG / 授知识）⇒ 禁止；
  // 若只选取内容参数（这张图用哪个 assetId）⇒ 允许，且必须由命名空间约定支撑。
  // factRef 是 ref 命名空间（asset: / fact: / secret: 同级），解引用只选内容参数，不改节奏。
  // hints 是自由文本通道、无命名空间约束 ⇒ 任何形状推断都禁止（`hint.startsWith("asset:")`
  // 那一支已按 DECISIONS ADR-0038 与 BACKLOG B-40 删除，不要再加回来）。
  for (const fact of view.facts.facts ?? []) {
    if (fact.factRef.startsWith("asset:")) return fact.factRef.slice("asset:".length);
  }
  return null;
}

const toolNames = (tools: readonly ToolDescriptor[]): Set<string> => new Set(tools.map((t) => t.name));

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 2));

/** 已发出过的工具名集合：阶段判定只依赖消息历史，provider 自身无状态。 */
function emittedToolNames(messages: readonly AgentMessage[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) names.add(call.name);
  }
  return names;
}

function submitted(messages: readonly AgentMessage[]): boolean {
  return messages.some(
    (m) =>
      m.role === "assistant" &&
      (m.toolCalls ?? []).some((call) => call.name === "agent.submit"),
  );
}

/** 本次 invocation 是否已经吐过带标签的正文（assistant 历史里能看到）。 */
function narrativeAlreadyEmitted(messages: readonly AgentMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      typeof message.content === "string" &&
      message.content.includes("<narrative-content>"),
  );
}

/** 把正文包进标签；标签外只留工具调用（mock 不产思维链）。 */
function taggedNarrative(text: string): string {
  return `<narrative-content>\n${text}\n</narrative-content>`;
}

/** 模拟逐片流式：确定性切片 + 让出事件循环，仅用于让 SSE 有真实帧可看。 */
async function streamNarrative(req: AgentChatRequest, text: string): Promise<void> {
  if (req.onDelta === undefined) return;
  const CHUNK = 24;
  for (let i = 0; i < text.length; i += CHUNK) {
    req.onDelta({ text: text.slice(i, i + CHUNK) });
    // 真实 provider 的帧之间必有网络间隔；同步全吐会让订阅者只看到合并后的一帧。
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

/**
 * ② 旁注轮：只发 flavor（确实是叙事文本）。
 *
 * `content.writeOption` 已从函数层删除（AGENTIC-GM 重构）——"写一个选项"在语义上就是错的：
 * 选项是事件块里的 `options`，由引擎分配 id、由事件面板呈现。想给玩家选择，正确做法是
 * `story.submitBranch` 提交一条带 options 的分支。
 */
function optionCalls(view: MockContextView, available: Set<string>): ToolCallRequest[] {
  const calls: ToolCallRequest[] = [];
  if (!available.has("narrative.flavor")) return calls;
  const title = sanitizeProse(recentTitle(view.recentTurns) ?? undefined);
  const flavor = title === null ? null : sanitizeProse(`${title}的余韵还没散去，空气里有细微的变动。`);
  if (flavor !== null) {
    calls.push({
      id: `${view.invocationId}:call:flavor`,
      name: "narrative.flavor",
      arguments: { text: flavor },
    });
  }
  return calls;
}

export class MockAgentProvider implements AgentProvider {
  readonly id = "mock" as const;

  async chat(req: AgentChatRequest): Promise<AgentCompletion> {
    const available = toolNames(req.tools);
    const view = parseContextView(req.messages.find((m) => m.role === "user"));

    if (view === null) {
      const text = "（mock provider 未收到结构化上下文，本回合不产出内容。）";
      return {
        toolCalls: [],
        text,
        inputTokens: estimateTokens(req.messages.map((m) => m.content ?? "").join("")),
        outputTokens: estimateTokens(text),
        finishReason: "stop",
      };
    }

    const toolCalls: ToolCallRequest[] = [];
    const emitted = emittedToolNames(req.messages);
    const done = submitted(req.messages);
    const branch = branchCalls(view, available);

    // 正文走 `<narrative-content>` 标签（与真实 provider 同一契约）；一个 invocation 只吐一次。
    const narrativeText = narrativeAlreadyEmitted(req.messages)
      ? undefined
      : taggedNarrative(synthesizeNarrative(view));

    if (done) {
      // 已有 submit，不再产出（loop 正常情况下已在此前终止）。
    } else if (branch.length > 0 && !emitted.has(BRANCH_TOOL)) {
      // 分支轮：正文与 tool_calls 同轮返回（content + tool_calls 可以并存）。
      toolCalls.push(...branch);
    } else if (!emitted.has("narrative.flavor")) {
      // 有正文后补一句旁注；产不出来就直接收尾。
      const extra = optionCalls(view, available);
      if (extra.length > 0) toolCalls.push(...extra);
    }
    // 末轮：不再发 `agent.submit`（已从工具面移除）。返回空 toolCalls ⇒ 循环自然退出、
    // 由运行时补一次内部提交做记账。

    const text = narrativeText;
    if (text !== undefined) await streamNarrative(req, text);
    const outputPayload = JSON.stringify(toolCalls);
    return {
      toolCalls,
      ...(text !== undefined ? { text } : {}),
      inputTokens: estimateTokens(
        req.messages.map((m) => `${m.role}:${m.content ?? ""}`).join("\n"),
      ),
      outputTokens: estimateTokens(text ?? outputPayload),
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    };
  }
}
