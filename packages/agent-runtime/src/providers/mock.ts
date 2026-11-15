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
 * 它不是常量文案生成器：叙事由 `inv.context` 里 facts / dagNodes / recentTurns 与
 * invocationReason 合成，所以同一世界状态 ⇒ 同一段中文叙事，换状态 ⇒ 换叙事。
 * 序列：writeNarrative（+ 有资源时 referenceAsset）→ submit。
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
  facts: { perspective?: string; facts?: MockFactItem[]; dagNodes?: Array<{ nodeId: string; status: string }> };
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

function recentTurnLine(turns: readonly unknown[]): string | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!isRecord(turn)) continue;
    const label = turn.title ?? turn.summary ?? turn.eventTitle ?? turn.text;
    if (typeof label === "string" && label.length > 0) return `刚才的事还留着余温：${label}。`;
  }
  return null;
}

/** 从可见事实 / DAG / 历史合成正文（纯函数、无随机）。 */
function synthesizeNarrative(view: MockContextView): string {
  const visibleFacts = view.facts.facts ?? [];
  const nodes = view.facts.dagNodes ?? [];
  const sentences: string[] = [openerFor(view.reason)];

  const knownFacts = visibleFacts.filter(
    (f) => f.level === undefined || f.level === "known" || f.level === "inferred",
  );
  for (const fact of knownFacts.slice(0, 3)) {
    const value = describeValue(fact.value);
    if (value.length === 0 || value === fact.factRef) {
      sentences.push(`你得知了关于「${fact.factRef}」的消息。`);
    } else {
      sentences.push(`你确认了「${fact.factRef}」：${value}。`);
    }
  }

  const activeNode = nodes.find((n) => n.status === "ready" || n.status === "in_progress" || n.status === "active");
  if (activeNode !== undefined) {
    const label = STATUS_LABELS[activeNode.status] ?? activeNode.status;
    sentences.push(`眼下你正处在「${activeNode.nodeId}」这一步，${label}。`);
  } else if (nodes.length > 0) {
    sentences.push(`眼前的路标指向「${nodes[0]!.nodeId}」。`);
  }

  const recent = recentTurnLine(view.recentTurns);
  if (recent !== null) sentences.push(recent);

  sentences.push(
    view.targetPerspective === "world"
      ? "众生各怀心事，棋盘上的每一步都已被记录。"
      : "你把这一切收进心里，继续向前走。",
  );
  return sentences.join("");
}

/** 引用只取窗口内出现过的 factRef / 公有 DAG 节点，避免自造 visibility_violation。 */
function collectRefs(view: MockContextView): string[] {
  const refs: string[] = [];
  for (const fact of (view.facts.facts ?? []).slice(0, 3)) refs.push(fact.factRef);
  for (const node of (view.facts.dagNodes ?? []).slice(0, 2)) refs.push(`dag:${node.nodeId}`);
  return [...new Set(refs)];
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
      const refs = collectRefs(view);
      const target = view.targetPerspective;
      const narrativeId = `${view.invocationId}:narrative`;
      if (available.has("content.writeNarrative")) {
        toolCalls.push({
          id: `${view.invocationId}:call:0`,
          name: "content.writeNarrative",
          arguments: {
            blockId: narrativeId,
            text: synthesizeNarrative(view),
            refs,
            targetPerspective: target,
          },
        });
      }
      const assetId = assetIdFrom(view);
      if (assetId !== null && available.has("content.referenceAsset")) {
        toolCalls.push({
          id: `${view.invocationId}:call:1`,
          name: "content.referenceAsset",
          arguments: {
            blockId: `${view.invocationId}:asset`,
            assetId,
            slot: "scene",
            refs: [`asset:${assetId}`],
          },
        });
      }
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
