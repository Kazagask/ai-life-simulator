import { cpSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { assignPendingInvocation } from "@life-sim/game-core";
import type { LlmInvocation, LlmTrace } from "@life-sim/shared";
import { loadTemplates, type ReadyTemplateEntry, type TemplateScanLogger } from "../templates.js";
import { worldStore } from "../store.js";
import { beginNarrativeInvocation, registerNarrativeStreamRoute } from "./stream.js";

/**
 * SSE 转发路由最小集：
 * - 无在飞 invocation ⇒ 明确的 `idle`（不是 404、不干等）；
 * - 已收尾的轮次 ⇒ 补发整段正文 + done，再 `[DONE]`；
 * - 在飞 ⇒ 先补发已累积正文，后续增量实时到达；
 * - 客户端断开 ⇒ 退订并在仍有在飞调用时取消它（不残留「书写中」）。
 */

const silentLogger: TemplateScanLogger = { warn: () => {}, error: () => {}, info: () => {} };
const SPEC_TEMPLATES = fileURLToPath(new URL("../../../../specs/data/templates", import.meta.url));

let app: FastifyInstance;
let baseUrl = "";
let entry: ReadyTemplateEntry;
let templatesDirPath: string;
let dataDirPath: string;

const trace = (invocationId: string, outcome: "committed" | "fallback"): LlmTrace => ({
  invocationId,
  turnIndex: 1,
  worldTime: 60,
  reason: "turn.advance",
  contextHash: "sha256:x",
  toolProfile: "narrative",
  callsHash: "sha256:y",
  receipts: [],
  diagnostics: [],
  inputTokens: 1,
  outputTokens: 1,
  latencyMs: 0,
  outcome,
  templateRef: "demo-agentic@1.0.0",
});

function newWorld(): string {
  const world = worldStore.create({ templateId: "demo-agentic", playerName: "旅人" }, entry);
  return world.id;
}

interface SseFrame {
  events: Record<string, unknown>[];
  sawDone: boolean;
}

async function readSse(response: Response): Promise<SseFrame> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  let sawDone = false;
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done === true) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf("\n\n");
    while (split >= 0) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      if (!frame.startsWith(":")) {
        const line = frame.startsWith("data:") ? frame.slice(5).trim() : "";
        if (line === "[DONE]") sawDone = true;
        else if (line.length > 0) events.push(JSON.parse(line) as Record<string, unknown>);
      }
      split = buffer.indexOf("\n\n");
    }
  }
  return { events, sawDone };
}

const post = (worldId: string, signal?: AbortSignal): Promise<Response> =>
  fetch(`${baseUrl}/api/worlds/${worldId}/narrative/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    ...(signal !== undefined ? { signal } : {}),
  });

beforeAll(async () => {
  templatesDirPath = mkdtempSync(path.join(tmpdir(), "life-sim-tpl-stream-"));
  cpSync(path.join(SPEC_TEMPLATES, "demo-agentic"), path.join(templatesDirPath, "demo-agentic"), {
    recursive: true,
  });
  process.env.TEMPLATES_DIR = templatesDirPath;
  dataDirPath = mkdtempSync(path.join(tmpdir(), "life-sim-data-stream-"));
  process.env.LIFE_SIM_DATA_DIR = dataDirPath;

  const registry = loadTemplates(silentLogger);
  const resolved = registry.resolve({ id: "demo-agentic", version: "1.0.0" });
  if (resolved === undefined) throw new Error("demo-agentic@1.0.0 未加载");
  entry = resolved;

  app = Fastify({ logger: false });
  await registerNarrativeStreamRoute(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  rmSync(templatesDirPath, { recursive: true, force: true });
  rmSync(dataDirPath, { recursive: true, force: true });
});

describe("POST /api/worlds/:id/narrative/stream", () => {
  it("世界不存在 ⇒ 404（不是空流）", async () => {
    const res = await post("world-missing");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "world_not_found" });
  });

  it("没有在飞 invocation ⇒ idle 事件 + [DONE]", async () => {
    const worldId = newWorld();
    const res = await post(worldId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const { events, sawDone } = await readSse(res);
    expect(events).toEqual([{ type: "idle" }]);
    expect(sawDone).toBe(true);
  });

  it("已收尾 ⇒ 补发整段正文 + done（LLM 比开流更快时不空屏）", async () => {
    const worldId = newWorld();
    const stream = beginNarrativeInvocation(worldId);
    stream.delta("风穿过");
    stream.delta("门廊。");
    stream.done(trace("inv-1", "committed"));

    const { events, sawDone } = await readSse(await post(worldId));

    expect(events).toEqual([
      { type: "delta", text: "风穿过门廊。" },
      {
        type: "done",
        outcome: "committed",
        traceRef: "trace:inv-1",
        diagnostics: [],
      },
    ]);
    expect(sawDone).toBe(true);
  });

  it("在飞 ⇒ 先补发已累积正文，后续增量实时到达", async () => {
    const worldId = newWorld();
    const stream = beginNarrativeInvocation(worldId);
    stream.delta("第一段");

    const res = await post(worldId);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("第一段")) {
      const { value, done } = await reader.read();
      if (done === true) break;
      seen += decoder.decode(value, { stream: true });
    }
    expect(seen).toContain('"type":"delta"');
    expect(seen).toContain("第一段");

    stream.delta("第二段");
    stream.done(trace("inv-2", "fallback"));

    for (;;) {
      const { value, done } = await reader.read();
      if (done === true) break;
      seen += decoder.decode(value, { stream: true });
    }
    expect(seen).toContain("第二段");
    expect(seen).toContain('"outcome":"fallback"');
    expect(seen).toContain('"traceRef":"trace:inv-2"');
    expect(seen).toContain("data: [DONE]");
  });

  it("客户端断开 ⇒ 退订，并取消仍在飞的 invocation", async () => {
    const worldId = newWorld();
    const stream = beginNarrativeInvocation(worldId);
    stream.delta("写到一半");
    const record = worldStore.get(worldId);
    assignPendingInvocation(record!.state, { invocationId: "inv-live" } as LlmInvocation);

    const controller = new AbortController();
    const res = await post(worldId, controller.signal);
    const reader = res.body!.getReader();
    await reader.read();

    expect(stream.signal.aborted).toBe(false);
    controller.abort();
    // 触发服务端 `close` → dispose → abortIfUnwatched（给事件循环一拍）。
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stream.signal.aborted).toBe(true);
    expect(worldStore.get(worldId)!.state.pendingInvocation?.invocationId).toBe("inv-live");
  });
});
