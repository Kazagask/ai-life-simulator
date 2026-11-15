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
 *   ① 叙事（content.writeNarrative，必要时 content.referenceAsset）
 *   ② 分支（可选：fact.enqueueEvent —— 把 DAG 分支上的模板事件上桌）
 *   ③ 选项（2-3 条 content.writeOption，必要时 content.writeFlavor）
 *   ④ 提交（content.submit）
 * 因此 `contentBlocks` 顺序恒为 narrative → option → flavor，前端可直接按序渲染。
 *
 * ② 只在 `contextHints` 出现**显式分支指令**（`branch:evt:xxx` / `hint:branch:evt:xxx` /
 * `{"kind":"enqueueEvent","eventId":"evt:xxx"}`）时才发生。裸 `evt:` 标签与 `facts[].factRef`
 * **不**算指令 —— 见下方 `parseBranchHint` 的 409 事故注释。eventId 必须是模板已有事件，
 * 自造 id 必然吃 `unknown_reference`（FATAL），所以取不到就整轮跳过 —— 宁可少演示一次。
 *
 * ⚠ 去重责任边界（别误以为加了 `branch:` 前缀就万事大吉）：显式前缀只修「读错字段」，
 * 不改变「命中一次就发一次」的频率。跨回合不重复入队靠 core 的 `enqueueEvent` waiting 幂等
 * （+ ADR-0035 IO-1 跨回合守卫）；「同一个事件不该反复上桌」的内容层防线靠模板 `missWhen`。
 * mock 是**无状态**的（同 invocationId + 同状态 ⇒ 逐字节相同），结构上做不到跨回合去重。
 *
 * 文本全部由 `inv.context` 的 facts / dagNodes / recentTurns 与 invocationReason 合成；
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
    dagNodes?: Array<{ nodeId: string; status: string }>;
  };
  recentTurns: unknown[];
  contextHints?: string[];
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
  const rawNodes = Array.isArray(factsView.dagNodes) ? factsView.dagNodes : [];
  const dagNodes = rawNodes.filter(
    (n): n is { nodeId: string; status: string } =>
      isRecord(n) && typeof n.nodeId === "string" && typeof n.status === "string",
  );
  const perspective = (typeof parsed.perspective === "string" ? parsed.perspective : "player") as Perspective;
  const targetRaw = typeof parsed.targetPerspective === "string" ? parsed.targetPerspective : perspective;
  return {
    invocationId: parsed.invocationId,
    reason: parsed.reason,
    perspective,
    targetPerspective: targetRaw as Perspective,
    facts: { facts, dagNodes },
    recentTurns: Array.isArray(parsed.recentTurns) ? parsed.recentTurns : [],
    ...(Array.isArray(parsed.contextHints)
      ? { contextHints: parsed.contextHints.filter((h): h is string => typeof h === "string") }
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

const STATUS_LABELS: Record<string, string> = {
  draft: "尚未展开",
  active: "进行中",
  ready: "已就绪",
  in_progress: "进行中",
  completed: "已完成",
  expired: "已错过",
  cancelled: "已取消",
};

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

function activeNode(view: MockContextView): { nodeId: string; status: string } | undefined {
  return (view.facts.dagNodes ?? []).find(
    (n) => n.status === "ready" || n.status === "in_progress" || n.status === "active",
  );
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
 * 从可见事实 / DAG / 历史合成正文（纯函数、无随机）。
 * 整段在返回前过 `sanitizeProse`；若整段不可用（理论上不会发生），退回 reason 句子。
 */
function synthesizeNarrative(view: MockContextView): string {
  const nodes = view.facts.dagNodes ?? [];
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

  const node = activeNode(view);
  if (node !== undefined) {
    sentences.push(`眼下这一步${STATUS_LABELS[node.status] ?? "正在进行"}，你得决定怎么迈出去。`);
  } else if (nodes.length > 0) {
    sentences.push("前面的路已经铺开，只差你选一个方向。");
  }

  const title = sanitizeProse(recentTitle(view.recentTurns) ?? undefined);
  if (title !== null) sentences.push(`刚才的事还留着余温：${title}。`);

  sentences.push(
    view.targetPerspective === "world"
      ? "众生各怀心事，棋盘上的每一步都已被记录。"
      : "你把这一切收进心里，等着下一步动作。",
  );
  return sanitizeProse(sentences.join("")) ?? reasonSentence(view.reason);
}

/** 引用只取窗口内出现过的 factRef / 公有 DAG 节点，避免自造 visibility_violation。 */
function collectRefs(view: MockContextView): string[] {
  const refs: string[] = [];
  for (const ref of visibleFactRefs(view).slice(0, 3)) refs.push(ref);
  for (const node of (view.facts.dagNodes ?? []).slice(0, 2)) refs.push(`dag:${node.nodeId}`);
  return [...new Set(refs)];
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
  const node = activeNode(view);
  const refs = visibleFactRefs(view);
  const event = eventTitle(view);

  const lead =
    names[0] !== undefined
      ? `向${names[0]}开口，问清眼前的变故`
      : `走上前，把${event}看个清楚`;

  const rest: string[] = [];
  if (refs.length > 0) rest.push(`循着「${event}」的线索追下去`);
  if (node !== undefined) rest.push("继续推进手头这一环，不回头");
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

/** ② 分支轮唯一会发的「写世界」工具（把分支上的模板事件上桌）。 */
const BRANCH_TOOL = "fact.enqueueEvent";

const BRANCH_HINT_PREFIXES = ["hint:branch:", "branch:"] as const;

function normalizeBranchTarget(raw: string): string | null {
  const id = raw.trim();
  return id.startsWith("evt:") && id.length > "evt:".length ? id : null;
}

/**
 * 显式分支提示解析器。
 *
 * ⚠ 只认**显式**形态，绝不从裸 `evt:` 提示或 `facts[].factRef` 推断：
 * 那等于把「模板在上下文里提到过某个事件」偷偷解释成「每次 invocation 都把它重新入队」。
 * 真实事故（demo-agentic, task.completed 的 hints 含裸 `evt:chance`）：每次结算都
 * enqueue 一个 evt:chance，closing → chance → closing 无限交替，最终 409。
 *
 * 支持两种显式形态：
 *   1) `branch:evt:xxx` / `hint:branch:evt:xxx`
 *   2) 结构化 JSON：`{"kind":"enqueueEvent","eventId":"evt:xxx"}`
 */
function parseBranchHint(hint: string): string | null {
  const trimmed = hint.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed) && parsed.kind === "enqueueEvent" && typeof parsed.eventId === "string") {
        return normalizeBranchTarget(parsed.eventId);
      }
    } catch {
      // 不是 JSON，按普通提示忽略。
    }
    return null;
  }
  for (const prefix of BRANCH_HINT_PREFIXES) {
    if (trimmed.startsWith(prefix)) return normalizeBranchTarget(trimmed.slice(prefix.length));
  }
  return null;
}

/**
 * 本轮要上桌的事件 id：只取 contextHints 里的显式分支提示。
 * 取不到 ⇒ null（整轮不发 fact.enqueueEvent），宁可不上桌也不误伤模板节奏。
 *
 * 硬约束：绝不自己编 id —— `fact.enqueueEvent` 的 eventId 会跟模板 ref 全集比对，
 * 编出来的 id 必然吃 `unknown_reference`（FATAL，不消耗重试）。
 *
 * 注意：eventId 是机器引用（与 `refs[]` / assetId 同类），**不过** `sanitizeProse` 闸门 ——
 * 那道闸门针对玩家可见文本，用在这里会把 id 洗成空串。
 */
function branchEventId(view: MockContextView): string | null {
  for (const hint of view.contextHints ?? []) {
    const eventId = parseBranchHint(hint);
    if (eventId !== null) return eventId;
  }
  return null;
}

/**
 * ② 分支轮：把分支事件上桌（`fact.enqueueEvent` 只入队、不占槽）。
 *
 * 排在叙事之后、选项之前：事件先上桌，玩家再在它的分支上做选择。
 * 只认显式 `branch:` 提示；没有显式提示或画像没给该工具 ⇒ 空数组，
 * 原有「叙事 → 选项 → 提交」节奏不变。
 */
function branchCalls(view: MockContextView, available: Set<string>): ToolCallRequest[] {
  if (!available.has(BRANCH_TOOL)) return [];
  const eventId = branchEventId(view);
  if (eventId === null) return [];
  return [
    {
      id: `${view.invocationId}:call:branch`,
      name: BRANCH_TOOL,
      arguments: { eventId },
    },
  ];
}

function assetIdFrom(view: MockContextView): string | null {
  for (const fact of view.facts.facts ?? []) {
    if (fact.factRef.startsWith("asset:")) return fact.factRef.slice("asset:".length);
  }
  for (const hint of view.contextHints ?? []) {
    if (hint.startsWith("asset:")) return hint.slice("asset:".length);
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
      (m.toolCalls ?? []).some((call) => call.name === "content.submit"),
  );
}

interface MockRejection {
  code?: string;
  name?: string;
  factsHint?: Record<string, unknown>;
}

/** 取最后一条 tool 消息里的拒绝回执（loop 以 JSON 回灌 outcome / code / factsHint）。 */
function lastRejection(messages: readonly AgentMessage[]): MockRejection | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.content);
    } catch {
      return null;
    }
    if (!isRecord(parsed) || parsed.outcome !== "rejected") return null;
    return {
      ...(typeof parsed.code === "string" ? { code: parsed.code } : {}),
      ...(typeof message.name === "string" ? { name: message.name } : {}),
      ...(isRecord(parsed.factsHint) ? { factsHint: parsed.factsHint } : {}),
    };
  }
  return null;
}

/** 被拒的是写世界工具（fact.*）：mock 无法通过改写文案修复它，只能跳过。 */
function isFactRejection(name: string | undefined): boolean {
  return typeof name === "string" && name.startsWith("fact.");
}

/** ① 叙事轮：正文 + 至多一次媒体资源挂载。 */
function narrativeCalls(view: MockContextView, available: Set<string>): ToolCallRequest[] {
  const calls: ToolCallRequest[] = [];
  const refs = collectRefs(view);
  if (available.has("content.writeNarrative")) {
    calls.push({
      id: `${view.invocationId}:call:narrative`,
      name: "content.writeNarrative",
      arguments: {
        blockId: `${view.invocationId}:narrative`,
        text: synthesizeNarrative(view),
        refs,
        targetPerspective: view.targetPerspective,
      },
    });
  }
  const assetId = assetIdFrom(view);
  if (assetId !== null && available.has("content.referenceAsset")) {
    calls.push({
      id: `${view.invocationId}:call:asset`,
      name: "content.referenceAsset",
      arguments: {
        blockId: `${view.invocationId}:asset`,
        assetId,
        slot: "scene",
        refs: [`asset:${assetId}`],
      },
    });
  }
  return calls;
}

/** ② 选项轮：2-3 条可点动作（+ 可选 flavor）。必须排在叙事之后。 */
function optionCalls(view: MockContextView, available: Set<string>): ToolCallRequest[] {
  const calls: ToolCallRequest[] = [];
  if (!available.has("content.writeOption")) return calls;
  const refs = collectRefs(view);
  optionTexts(view).forEach((text, index) => {
    calls.push({
      id: `${view.invocationId}:call:opt${index}`,
      name: "content.writeOption",
      arguments: {
        blockId: `${view.invocationId}:opt${index}`,
        optionId: `${view.invocationId}:opt${index}`,
        text,
        refs,
      },
    });
  });
  const title = sanitizeProse(recentTitle(view.recentTurns) ?? undefined);
  const flavor = title === null ? null : sanitizeProse(`${title}的余韵还没散去，空气里有细微的变动。`);
  if (flavor !== null && available.has("content.writeFlavor")) {
    calls.push({
      id: `${view.invocationId}:call:flavor`,
      name: "content.writeFlavor",
      arguments: {
        blockId: `${view.invocationId}:flavor`,
        text: flavor,
        refs,
      },
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
    const rejection = lastRejection(req.messages);
    const emitted = emittedToolNames(req.messages);
    const done = submitted(req.messages);
    const branch = branchCalls(view, available);

    if (done) {
      // 已有 submit，不再产出（loop 正常情况下已在此前终止）。
    } else if (rejection !== null && !isFactRejection(rejection.name)) {
      // 分支①：按被拒工具重生成；窗口类拒绝一律收敛为「不带 refs + 权威窗口」。
      // fact.* 的拒绝不走这里：mock 改不了事件 id / DAG 事实，重写文案修不好它（见下一条分支）。
      const hintTarget =
        typeof rejection.factsHint?.targetPerspective === "string"
          ? (rejection.factsHint.targetPerspective as Perspective)
          : view.targetPerspective;
      if (rejection.name === "content.writeOption" && available.has("content.writeOption")) {
        optionTexts(view).forEach((text, index) => {
          toolCalls.push({
            id: `${view.invocationId}:call:opt-retry${index}`,
            name: "content.writeOption",
            arguments: {
              blockId: `${view.invocationId}:opt${index}`,
              optionId: `${view.invocationId}:opt${index}`,
              text,
              refs: [],
            },
          });
        });
      } else if (available.has("content.writeNarrative")) {
        toolCalls.push({
          id: `${view.invocationId}:call:retry`,
          name: "content.writeNarrative",
          arguments: {
            blockId: `${view.invocationId}:narrative`,
            text: synthesizeNarrative(view),
            refs: [],
            targetPerspective: hintTarget,
          },
        });
      }
    } else if (!emitted.has("content.writeNarrative") && !emitted.has("content.writeOption")) {
      toolCalls.push(...narrativeCalls(view, available));
    } else if (branch.length > 0 && !emitted.has(BRANCH_TOOL)) {
      // ② 分支轮：把分支事件上桌（只入队、不占槽）。`branch` 已按「画像 + 显式分支指令」筛过，
      // 为空则整段跳过，不改变原有三阶段节奏。
      toolCalls.push(...branch);
    } else if (!emitted.has("content.writeOption")) {
      // 有叙事但还没有点击面 ⇒ 本回合继续产出选项（每条回合都必须可点）。
      toolCalls.push(...optionCalls(view, available));
    } else if (available.has("content.submit")) {
      const produced = req.messages
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.toolCalls ?? [])
        .filter((call) => call.name !== "content.submit")
        .map((call) => call.arguments.blockId)
        .filter((id): id is string => typeof id === "string");
      toolCalls.push({
        id: `${view.invocationId}:call:submit`,
        name: "content.submit",
        arguments: {
          blockIds:
            produced.length > 0 ? [...new Set(produced)] : [`${view.invocationId}:narrative`],
        },
      });
    }

    const text = toolCalls.length === 0 ? "本回合没有更多可写的内容。" : undefined;
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
