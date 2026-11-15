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
 * 产品口径（裁决）：「点击为主，打字输入为辅」——只产出散文的一回合等于坏回合。
 * 因此决策点（章节 / 场景 / 任务推进）必须给出 2-3 个 `content.writeOption`，且顺序是
 * 叙事 → （可选）资源 → 选项 → （可选）flavor，前端按 contentBlocks 顺序渲染。
 *
 * 它不是常量文案生成器：叙事与选项都由 `inv.context` 的 facts / dagNodes / recentTurns
 * 与 invocationReason 合成；同一世界状态 ⇒ 同一段文本（无随机、无时钟）。
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

/** 决策点关键词（产品裁决：只在推进/抉择处给选项）。 */
const DECISION_KEYWORDS = ["chapter", "scene", "task", "trial", "choice", "decision", "opening", "event"];

/** 确定性判定：同一 reason ⇒ 同一结论，回放逐字段一致。 */
function isDecisionPoint(view: MockContextView): boolean {
  return DECISION_KEYWORDS.some((keyword) => view.reason.includes(keyword));
}

function openerFor(reason: string): string {
  for (const entry of REASON_OPENERS) {
    if (reason.includes(entry.match)) return entry.text;
  }
  return "此刻，世界安静地向前走了一步。";
}

function describeValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
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

/** 事实值里的人名 / 地名等可读片段（跳过与 ref 同值的占位）。 */
function readableValues(view: MockContextView): string[] {
  const out: string[] = [];
  for (const fact of view.facts.facts ?? []) {
    if (fact.level !== undefined && fact.level !== "known" && fact.level !== "inferred") continue;
    const value = fact.value;
    if (typeof value === "string" && value.length > 0 && value !== fact.factRef) out.push(value);
    else if (isRecord(value)) {
      const name = value.name ?? value.title ?? value.location ?? value.label;
      if (typeof name === "string" && name.length > 0) out.push(name);
    }
  }
  return [...new Set(out)];
}

/** 展示用：去掉 `fact:` / `dag:` 之类前缀，正文里不出现裸机器 id。 */
function displayRef(ref: string): string {
  return ref.replace(/^(fact|dag|secret|asset|flag):/, "");
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

/** 触发事件的标题：优先历史标题；无历史时从 reason 派生，避免空泛。 */
function eventTitle(view: MockContextView): string {
  return recentTitle(view.recentTurns) ?? view.reason.split(".").slice(-1)[0] ?? "眼前的事";
}

/** 从可见事实 / DAG / 历史合成正文（纯函数、无随机）。 */
function synthesizeNarrative(view: MockContextView): string {
  const nodes = view.facts.dagNodes ?? [];
  const sentences: string[] = [openerFor(view.reason)];

  const refs = visibleFactRefs(view);
  const readable = readableValues(view);
  if (refs.length === 0) {
    // 没有可见事实时用事件标题兜底，避免「什么都没有发生」的空话。
    sentences.push(`「${eventTitle(view)}」就在眼前，你得决定怎么应对。`);
  } else {
    readable.slice(0, 2).forEach((value) => sentences.push(`你看见了${value}。`));
    const firstRef = refs[0]!;
    if (!readable.includes(firstRef)) {
      sentences.push(`「${displayRef(firstRef)}」这条线索已经落在你手里。`);
    }
  }

  const node = activeNode(view);
  if (node !== undefined) {
    sentences.push(`眼下你正处在「${node.nodeId}」这一步，${STATUS_LABELS[node.status] ?? node.status}。`);
  } else if (nodes.length > 0) {
    sentences.push(`眼前的路标指向「${nodes[0]!.nodeId}」。`);
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

/**
 * 2-3 个「玩家可点击的动作」：第二人称、动词开头、具体到眼前的事实 / 人 / DAG 步。
 * 文本本身是按钮文案，不是「选项一」这种占位描述。
 */
function optionTexts(view: MockContextView): string[] {
  const candidates: string[] = [];
  const names = readableValues(view);
  const name = names[0];
  const node = activeNode(view);

  if (name !== undefined) candidates.push(`向${name}开口，问清眼前的变故`);
  if (node !== undefined) candidates.push(`按「${node.nodeId}」继续向前推进`);
  if (names.length > 1) candidates.push(`先去找${names[1]}探探口风`);
  candidates.push("先退半步，把四周看清楚");
  candidates.push("径直走上前，不再犹豫");
  candidates.push("转身回到来路，暂避锋芒");

  const unique: string[] = [];
  for (const candidate of candidates) {
    if (!unique.includes(candidate)) unique.push(candidate);
    if (unique.length === 3) break;
  }
  return unique;
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

/**
 * 轮次判定：以「assistant 已发出的 toolCalls 轮数」为状态，天然可在同一 invocation
 * 内多轮调用且不依赖任何内部可变状态。
 */
function emittedRounds(messages: readonly AgentMessage[]): number {
  return messages.filter((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0).length;
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
      ...(isRecord(parsed.factsHint) ? { factsHint: parsed.factsHint } : {}),
    };
  }
  return null;
}

/** 第一轮：叙事 → 资源 → 选项 → flavor（顺序即 contentBlocks 顺序）。 */
function firstRoundCalls(view: MockContextView, available: Set<string>): ToolCallRequest[] {
  const refs = collectRefs(view);
  const target = view.targetPerspective;
  const calls: ToolCallRequest[] = [];

  if (available.has("content.writeNarrative")) {
    calls.push({
      id: `${view.invocationId}:call:narrative`,
      name: "content.writeNarrative",
      arguments: {
        blockId: `${view.invocationId}:narrative`,
        text: synthesizeNarrative(view),
        refs,
        targetPerspective: target,
      },
    });
  }

  // 至多一次资源挂载，且必须来自可见事实（否则 refs 会越窗）。
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

  if (isDecisionPoint(view) && available.has("content.writeOption")) {
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

    const rounds = emittedRounds(req.messages);
    const toolCalls: ToolCallRequest[] = [];
    const rejection = lastRejection(req.messages);

    if (rejection !== null && !submitted(req.messages) && available.has("content.writeNarrative")) {
      // 分支①：上一轮被拒（如 visibility_violation），重生成时按 factsHint 收敛窗口并清空 refs。
      const hintTarget =
        typeof rejection.factsHint?.targetPerspective === "string"
          ? (rejection.factsHint.targetPerspective as Perspective)
          : view.targetPerspective;
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
    } else if (!submitted(req.messages) && rounds === 0) {
      toolCalls.push(...firstRoundCalls(view, available));
    } else if (!submitted(req.messages) && available.has("content.submit")) {
      const produced = req.messages
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.toolCalls ?? [])
        .filter((call) => call.name !== "content.submit")
        .map((call) => call.arguments.blockId)
        .filter((id): id is string => typeof id === "string");
      toolCalls.push({
        id: `${view.invocationId}:call:submit`,
        name: "content.submit",
        arguments: { blockIds: produced.length > 0 ? produced : [`${view.invocationId}:narrative`] },
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
