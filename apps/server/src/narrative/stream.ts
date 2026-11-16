import type { FastifyInstance } from "fastify";
import { traceRefFor } from "@life-sim/agent-runtime";
import type { LlmTrace } from "@life-sim/shared";
import { worldStore } from "../store.js";

/**
 * 叙事增量转发（SSE）。**只转发，不生产**：
 *
 * - 一次 invocation 的正文碎片由 `AgentGateway.onDelta` 推到本模块的**内存频道**；
 * - 本路由把频道里的碎片按 `text/event-stream` 转发给浏览器；
 * - 权威写入仍只走 loop 内的 `engineApi.dispatch`，trace 仍只在收尾由 server 的
 *   `onTrace` 一次性追加到 `<worldId>.trace.jsonl` —— 本模块**绝不**碰 sink / trace / state。
 *
 * 事件形状（`data:` 后跟 JSON）：
 * - `{"type":"delta","text":"…"}`        正文碎片（首帧可能是已累积正文的整体补发）
 * - `{"type":"done","outcome":"committed|fallback","traceRef":"trace:…","diagnostics":[…]}` 收尾
 * - `{"type":"idle"}`                    该世界没有在飞 invocation（不是错误、不是 404）
 * 之后一律补一行 `data: [DONE]`。
 *
 * 设计取舍：
 * - invocation 是回合结算里 **fire-and-forget** 起来的（`turn.ts` 里 `void gateway.invoke`），
 *   所以本路由只能「贴上」它，不能自己再跑一次（那会二次 dispatch，破坏权威写入的一次性）。
 * - 「在飞」的唯一判据是 `state.pendingInvocation`（`19c309d` 之后它按 id 清除），
 *   故本路由在它缺席时立即回 `idle`，绝不干等。
 * - 频道保留最后一轮的正文与 done：晚到的订阅者（前端在 turn 响应之后才开流）能补看全文，
 *   不会因为「LLM 太快」而看到空屏。
 */

const HEARTBEAT_MS = 15_000;
/** 兜底上限：真挂了也不能把连接吊死（正常路径由 loop 的预算超时收束）。 */
const MAX_STREAM_MS = 180_000;
/**
 * 并发订阅的等待窗：前端「先开流、再发 turn」时，turn 的 `pendingInvocation` 可能晚
 * 几百毫秒才写入。窗口必须覆盖前端正常调用顺序（300ms 级），否则会误判 `idle`。
 */
const PENDING_WAIT_MS = 3_000;

export interface NarrativeStreamDone {
  /** 与 trace 的 outcome 同源（loop 实际只会给 committed / fallback）。 */
  outcome: LlmTrace["outcome"];
  traceRef: string;
  diagnostics: string[];
}

export type NarrativeStreamEvent =
  | { type: "delta"; text: string }
  | ({ type: "done" } & NarrativeStreamDone)
  | { type: "idle" };

/** 一次 invocation 的写入句柄：`pipelineForTurn` 把它接到 gateway 的 onDelta / onTrace 上。 */
export interface NarrativeInvocationStream {
  /** 外部取消（客户端断开）。gateway → loop → provider 逐层透传。 */
  readonly signal: AbortSignal;
  /** provider 的原始 content 碎片；写入频道前会剥掉 `<narrative-content>` 标签。 */
  delta(text: string): void;
  /** 收尾：由 `onTrace` 调用，携带 loop 产出的真实 outcome / 诊断。 */
  done(trace: LlmTrace): void;
}

interface Channel {
  text: string;
  done: NarrativeStreamDone | null;
  subscribers: Set<(event: NarrativeStreamEvent) => void>;
  controller: AbortController;
}

/** 每世界一个频道：世界数量有界，正文只在内存里随最后一轮滚动，不落盘。 */
const channels = new Map<string, Channel>();

function channelFor(worldId: string): Channel {
  let channel = channels.get(worldId);
  if (channel === undefined) {
    channel = { text: "", done: null, subscribers: new Set(), controller: new AbortController() };
    channels.set(worldId, channel);
  }
  return channel;
}

function emit(channel: Channel, event: NarrativeStreamEvent): void {
  for (const listener of [...channel.subscribers]) {
    try {
      listener(event);
    } catch {
      // 单个订阅者（一个 HTTP 连接）出错不能影响广播与其他订阅者。
      channel.subscribers.delete(listener);
    }
  }
}

const OPEN_TAG = "<narrative-content>";
const CLOSE_TAG = "</narrative-content>";

/**
 * 增量标签扫描器（服务端剥标签，SSE 是玩家面通道，不能把 `<narrative-content>` 原样下发）。
 *
 * 与 loop 收尾的 `extractNarrativeContent` 用**同一套边界规则**：
 * - 只输出标签内文字；标签外一个字符都不输出；
 * - 多块按出现顺序 `\n\n` 拼接；每块 `trim`（首尾空白丢弃，块内保留）；
 * - 跨帧的半截开/闭标签缓冲在 `buffer` 里，等后续帧凑齐再判断；
 * - 未闭合的开标签：已流出的内容不回收（收尾按 fallback 清草稿），但不会有落盘正文块。
 */
export function createNarrativeTagFilter(): { push(chunk: string): string } {
  let buffer = "";
  let inside = false;
  let blockStarted = false;
  let pendingWhitespace = "";
  let emittedBlocks = 0;
  let out = "";

  const emitInside = (text: string): void => {
    for (const ch of text) {
      if (!blockStarted) {
        if (/\s/.test(ch)) continue;
        blockStarted = true;
        if (emittedBlocks > 0) out += "\n\n";
        out += ch;
      } else if (/\s/.test(ch)) {
        pendingWhitespace += ch;
      } else {
        out += pendingWhitespace + ch;
        pendingWhitespace = "";
      }
    }
  };

  return {
    push(chunk: string): string {
      buffer += chunk;
      for (;;) {
        if (!inside) {
          const open = buffer.indexOf(OPEN_TAG);
          if (open < 0) {
            // 保留可能是半截开标签的后缀，其余标签外内容直接丢。
            const keep = OPEN_TAG.length - 1;
            if (buffer.length > keep) buffer = buffer.slice(-keep);
            break;
          }
          buffer = buffer.slice(open + OPEN_TAG.length);
          inside = true;
          blockStarted = false;
          pendingWhitespace = "";
          continue;
        }

        const close = buffer.indexOf(CLOSE_TAG);
        if (close < 0) {
          // 不能把可能是半截闭标签的后缀吐出去。
          const cut = Math.max(0, buffer.length - (CLOSE_TAG.length - 1));
          emitInside(buffer.slice(0, cut));
          buffer = buffer.slice(cut);
          break;
        }
        emitInside(buffer.slice(0, close));
        buffer = buffer.slice(close + CLOSE_TAG.length);
        // 块尾空白丢弃（与 `match[1].trim()` 一致）；空块不产分隔符。
        if (blockStarted) emittedBlocks += 1;
        inside = false;
        blockStarted = false;
        pendingWhitespace = "";
      }
      const visible = out;
      out = "";
      return visible;
    },
  };
}

/**
 * 开启一次 invocation 的频道（在 `pipelineForTurn` 构造 gateway 时调用）：
 * 重置上一轮的正文 / 收尾 / 取消控制器，得到本次调用的写入句柄。
 */
export function beginNarrativeInvocation(worldId: string): NarrativeInvocationStream {
  const channel = channelFor(worldId);
  channel.text = "";
  channel.done = null;
  channel.controller = new AbortController();
  const tagFilter = createNarrativeTagFilter();
  return {
    signal: channel.controller.signal,
    delta: (text: string) => {
      const visible = tagFilter.push(text);
      if (visible.length === 0) return;
      channel.text += visible;
      emit(channel, { type: "delta", text: visible });
    },
    done: (trace: LlmTrace) => {
      const done: NarrativeStreamDone = {
        outcome: trace.outcome,
        traceRef: traceRefFor(trace.invocationId),
        diagnostics: [...trace.diagnostics],
      };
      channel.done = done;
      emit(channel, { type: "done", ...done });
    },
  };
}

/**
 * 客户端断开后：没有观众且仍在飞 ⇒ 取消这次 provider 请求。
 * 这不会污染权威状态：abort 在 loop 里折成诊断，`pendingInvocation` 由 gateway 的
 * `clearPending` 清掉，玩家刷新后看到的是「本轮没有 AI 正文」而不是永久「书写中」。
 */
function abortIfUnwatched(worldId: string, channel: Channel): void {
  if (channel.subscribers.size > 0) return;
  if (worldStore.get(worldId)?.state.pendingInvocation === undefined) return;
  channel.controller.abort();
}

/**
 * 前端与 turn **并发**订阅时的抢跑窗口：turn 的 `pendingInvocation` 可能在 SSE 路由
 * 到达后几百毫秒才写入。给 `PENDING_WAIT_MS` 的窗口，避免把一次正常结算误判成 `idle`。
 */
async function waitForInvocation(worldId: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (worldStore.get(worldId)?.state.pendingInvocation !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** SSE 路由注册点：`index.ts` 只需一行 `await registerNarrativeStreamRoute(app)`。 */
export async function registerNarrativeStreamRoute(app: FastifyInstance): Promise<void> {
  app.post("/api/worlds/:id/narrative/stream", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = worldStore.get(id);
    if (record === undefined) return reply.code(404).send({ error: "world_not_found" });

    // 交给 Node 原生响应写 SSE；Fastify 不再接管这条连接。
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const channel = channelFor(id);
    let finished = false;
    let unsubscribe: () => void = () => {};
    let heartbeat: NodeJS.Timeout | undefined;
    let cap: NodeJS.Timeout | undefined;

    const send = (event: NarrativeStreamEvent): void => {
      if (finished || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    /** 正常收尾：清理 + 补 `[DONE]` + 关连接。 */
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (cap !== undefined) clearTimeout(cap);
      unsubscribe();
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    };

    /** 客户端已断开：只清理，不再往死连接写。 */
    const dispose = (): void => {
      if (finished) return;
      finished = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (cap !== undefined) clearTimeout(cap);
      unsubscribe();
      abortIfUnwatched(id, channel);
    };

    // 并发订阅抢跑：turn 的 pendingInvocation 可能晚几十毫秒；先等一个短窗口。
    if (
      channel.done === null &&
      record.state.pendingInvocation === undefined &&
      channel.text.length === 0
    ) {
      await waitForInvocation(id, PENDING_WAIT_MS);
    }
    if (finished) return; // 等待期间客户端断开

    // ① 已收尾（含等待期间刚好收尾）：补发整段正文 + done（不空屏路径）。
    if (channel.done !== null) {
      if (channel.text.length > 0) send({ type: "delta", text: channel.text });
      send({ type: "done", ...channel.done });
      finish();
      return;
    }

    // ② 等完仍没有在飞 invocation 且没有残留正文：明确的 idle，不干等、不 404。
    if (record.state.pendingInvocation === undefined && channel.text.length === 0) {
      send({ type: "idle" });
      finish();
      return;
    }

    // ③ 在飞（或已有正文但收尾未到）：先补发已累积正文，再订阅后续增量。
    if (channel.text.length > 0) send({ type: "delta", text: channel.text });
    unsubscribe = (() => {
      const listener = (event: NarrativeStreamEvent): void => {
        if (event.type === "delta") {
          send(event);
          return;
        }
        send(event);
        finish();
      };
      channel.subscribers.add(listener);
      return () => channel.subscribers.delete(listener);
    })();

    heartbeat = setInterval(() => {
      if (!finished && !res.writableEnded) res.write(": ping\n\n");
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    cap = setTimeout(() => {
      const invocationId = record.state.pendingInvocation?.invocationId;
      send({
        type: "done",
        outcome: "fallback",
        traceRef: invocationId !== undefined ? traceRefFor(invocationId) : `trace:${id}`,
        diagnostics: ["timeout"],
      });
      finish();
    }, MAX_STREAM_MS);
    cap.unref?.();

    // 只认 ServerResponse 的 close：Fastify 消费完请求体后会关掉 `request.raw`，
    // 用它判断「客户端断开」会在连接还活着时就提前收场。
    reply.raw.on("close", dispose);
  });
}
