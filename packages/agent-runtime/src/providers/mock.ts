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
 * 只产出散文的一回合等于坏回合。回合内分三轮（与 loop 的 dispatch 轮次一致）：
 *   ① 叙事（content.writeNarrative，必要时 content.referenceAsset）
 *   ② 选项（2-3 条 content.writeOption，必要时 content.writeFlavor）
 *   ③ 提交（content.submit）
 * 因此 `contentBlocks` 顺序恒为 narrative → option → flavor，前端可直接按序渲染。
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

/** 占位 / 哨兵值：world.yaml 会把初始旗标写成 "unknown"，这类值不能进正文。 */
const SENTINEL_VALUES = new Set(["", "unknown", "undefined", "null", "none", "n/a", "hidden"]);

/** 纯 ASCII 的标识符形状（`infoVisibility:npc-mentor` / `gate-location`）当作机器 id，不进正文。 */
const looksMachiney = (value: string): boolean => /^[A-Za-z0-9_.:\-]+$/.test(value);

const isHumanText = (value: string): boolean =>
  !SENTINEL_VALUES.has(value.trim().toLowerCase()) && !looksMachiney(value);

/**
 * 事实值里的人名 / 地名等**可读**片段。
 * 过滤三类噪声：① 与 factRef 同值的占位；② "unknown" 之类哨兵；③ 机器 id 形状的标识符。
 * 这样玩家只会看到「引路人」这种名字，而不会看到 `infoVisibility:npc-mentor`。
 */
function readableValues(view: MockContextView): string[] {
  const out: string[] = [];
  for (const fact of view.facts.facts ?? []) {
    if (fact.level !== undefined && fact.level !== "known" && fact.level !== "inferred") continue;
    const value = fact.value;
    if (typeof value === "string") {
      if (value !== fact.factRef && isHumanText(value)) out.push(value.trim());
    } else if (isRecord(value)) {
      const name = value.name ?? value.title ?? value.location ?? value.label;
      if (typeof name === "string" && name !== fact.factRef && isHumanText(name)) out.push(name.trim());
    }
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

/** 触发事件的标题：优先历史标题；无历史时从 reason 派生中文标签，避免出现英文 id。 */
function eventTitle(view: MockContextView): string {
  const fromHistory = recentTitle(view.recentTurns);
  if (fromHistory !== null) return fromHistory;
  for (const entry of REASON_LABELS) {
    if (view.reason.includes(entry.match)) return entry.text;
  }
  return "眼前的局面";
}

/** 从可见事实 / DAG / 历史合成正文（纯函数、无随机）。 */
function synthesizeNarrative(view: MockContextView): string {
  const nodes = view.facts.dagNodes ?? [];
  const sentences: string[] = [openerFor(view.reason)];

  const refs = visibleFactRefs(view);
  const readable = readableValues(view);
  const event = eventTitle(view);
  if (refs.length === 0) {
    // 没有可见事实时用事件标题兜底，避免「什么都没有发生」的空话。
    sentences.push(`「${event}」就在眼前，你得决定怎么应对。`);
  } else {
    readable.slice(0, 2).forEach((value) => sentences.push(`你看见了${value}。`));
    // 正文只给「有几条线索」这种可读信息；引用 id 只留在 refs[] 里，不泄漏给玩家。
    sentences.push(
      readable.length > 0
        ? `围绕「${event}」，你手里还攥着 ${refs.length} 条线索。`
        : `有些细节还没理清，「${event}」已经摆在你面前。`,
    );
  }

  const node = activeNode(view);
  if (node !== undefined) {
    sentences.push(`眼下这一步${STATUS_LABELS[node.status] ?? "正在进行"}，你得决定怎么迈出去。`);
  } else if (nodes.length > 0) {
    sentences.push("前面的路已经铺开，只差你选一个方向。");
  }

  const title = recentTitle(view.recentTurns);
  if (title !== null) sentences.push(`刚才的事还留着余温：${title}。`);

  sentences.push(
    view.targetPerspective === "world"
      ? "众生各怀心事，棋盘上的每一步都已被记录。"
      : "你把这一切收进心里，等着下一步动作。",
  );
  return sentences.join("");
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

  const picks = [lead];
  const offset = stableHash(`${view.reason}|${view.invocationId}|${refs[0] ?? ""}`) % rest.length;
  for (let i = 0; i < rest.length && picks.length < 3; i += 1) {
    const candidate = rest[(offset + i) % rest.length]!;
    if (!picks.includes(candidate)) picks.push(candidate);
  }
  return picks;
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
  const title = recentTitle(view.recentTurns);
  if (title !== null && available.has("content.writeFlavor")) {
    calls.push({
      id: `${view.invocationId}:call:flavor`,
      name: "content.writeFlavor",
      arguments: {
        blockId: `${view.invocationId}:flavor`,
        text: `${title}的余韵还没散去，空气里有细微的变动。`,
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

    if (done) {
      // 已有 submit，不再产出（loop 正常情况下已在此前终止）。
    } else if (rejection !== null) {
      // 分支①：按被拒工具重生成；窗口类拒绝一律收敛为「不带 refs + 权威窗口」。
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
