import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createP0 } from "../helpers/p0-flow.ts";
import { startReplayOpenAi, type ReplayOpenAi } from "../helpers/replay-openai.ts";
import { api, startServer, type RunningServer } from "../helpers/server.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface SseFrame {
  type: string;
  text?: string;
  outcome?: string;
  diagnostics?: string[];
}

function parseSse(raw: string): SseFrame[] {
  return raw
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data:"))
    .map((frame) => frame.slice("data:".length).trim())
    .filter((data) => data.length > 0 && data !== "[DONE]")
    .map((data) => JSON.parse(data) as SseFrame);
}

describe("API 叙事：录制回放 + SSE 服务端剥标签", () => {
  let app: RunningServer | undefined;
  let fake: ReplayOpenAi | undefined;

  afterEach(async () => {
    await app?.stop();
    await fake?.close();
    app = undefined;
    fake = undefined;
  });

  it("先订阅后触发：>1 帧、无 `<`、拼接与 GET /narrative 逐字相等", async () => {
    fake = await startReplayOpenAi({ fixture: "test/fixtures/llm/p0-narrative.jsonl" });
    app = await startServer({
      env: {
        LIFE_SIM_LLM_BASE_URL: fake.baseUrl,
        LIFE_SIM_LLM_MODEL: "replay",
        LIFE_SIM_LLM_API_KEY: "test-key",
      },
    });

    const world = await createP0(app.baseUrl, "op-gojo");
    const patrol = await api<{ snapshot: { turnIndex: number } }>(
      app.baseUrl,
      "POST",
      `/api/worlds/${world.worldId}/turns`,
      { action: { type: "patrol", description: "" }, mode: "single" },
    );

    // 先订阅、300ms 后触发（前端真实顺序）；不要 await 再触发，否则互锁。
    const streamPromise = fetch(`${app.baseUrl}/api/worlds/${world.worldId}/narrative/stream`, {
      method: "POST",
    }).then((res) => res.text());
    await sleep(300);
    const chosen = await api<{ snapshot: { turnIndex: number } }>(
      app.baseUrl,
      "POST",
      `/api/worlds/${world.worldId}/events/choose`,
      { optionId: "opt-go" },
    );
    const frames = parseSse(await streamPromise);
    const deltas = frames.filter((frame) => frame.type === "delta");
    expect(frames.some((frame) => frame.type === "idle")).toBe(false);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.some((frame) => (frame.text ?? "").includes("<"))).toBe(false);

    const narrative = await api<{ blocks: Array<{ kind: string; text?: string }> }>(
      app.baseUrl,
      "GET",
      `/api/worlds/${world.worldId}/narrative?fromTurn=0`,
    );
    const official = narrative.blocks
      .filter((block) => block.kind === "narrative")
      .map((block) => block.text ?? "")
      .join("\n\n");
    expect(deltas.map((frame) => frame.text ?? "").join("")).toBe(official);
  });

  it("mock provider：模板回合也写叙事段 + 响应带 gains（ADR-002 D5/D4）", async () => {
    // 不注入 LLM env ⇒ 服务端用 mock（`source: template`），这是「没有 LLM」的正式口径。
    app = await startServer();
    const world = await createP0(app.baseUrl, "op-gojo");
    const turn = await api<{ snapshot: { turnIndex: number }; gains?: unknown[] }>(
      app.baseUrl,
      "POST",
      `/api/worlds/${world.worldId}/turns`,
      { action: { type: "patrol", description: "" }, mode: "single" },
    );
    expect(Array.isArray(turn.gains)).toBe(true);

    const narrative = await api<{ blocks: Array<{ kind: string; text?: string; turnIndex?: number }> }>(
      app.baseUrl,
      "GET",
      `/api/worlds/${world.worldId}/narrative?fromTurn=0`,
    );
    const blocks = narrative.blocks.filter((block) => block.kind === "narrative");
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0]?.turnIndex).toBe(turn.snapshot.turnIndex);
    expect((blocks[0]?.text ?? "").length).toBeGreaterThan(0);
  });

  it("无标签：SSE 零 delta + narrative_tag_missing + 玩家侧无正文", async () => {
    fake = await startReplayOpenAi({
      fixture: "test/fixtures/llm/p0-narrative.jsonl",
      noTag: true,
    });
    app = await startServer({
      env: {
        LIFE_SIM_LLM_BASE_URL: fake.baseUrl,
        LIFE_SIM_LLM_MODEL: "replay",
        LIFE_SIM_LLM_API_KEY: "test-key",
      },
    });

    const world = await createP0(app.baseUrl, "op-gojo");
    await api(app.baseUrl, "POST", `/api/worlds/${world.worldId}/turns`, {
      action: { type: "patrol", description: "" },
      mode: "single",
    });
    const streamPromise = fetch(`${app.baseUrl}/api/worlds/${world.worldId}/narrative/stream`, {
      method: "POST",
    }).then((res) => res.text());
    await sleep(300);
    await api(app.baseUrl, "POST", `/api/worlds/${world.worldId}/events/choose`, {
      optionId: "opt-go",
    });
    const frames = parseSse(await streamPromise);
    expect(frames.filter((frame) => frame.type === "delta")).toEqual([]);

    const traceLines = readFileSync(`${app.dataDir}/${world.worldId}.trace.jsonl`, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "");
    const trace = JSON.parse(traceLines[traceLines.length - 1]!) as {
      diagnostics: string[];
      contentBlocks?: Array<{ kind: string }>;
    };
    expect(trace.diagnostics).toContain("narrative_tag_missing");
    // LLM 这一趟确实没有产出正文（回归：标签缺失时不得伪造 LLM 段落）。
    expect((trace.contentBlocks ?? []).filter((block) => block.kind === "narrative")).toEqual([]);

    const narrative = await api<{ blocks: Array<{ kind: string; text?: string }> }>(
      app.baseUrl,
      "GET",
      `/api/worlds/${world.worldId}/narrative?fromTurn=0`,
    );
    // 有真实 LLM 但没写出标签 ⇒ 不伪造正文（模板兜底只在 mock 下生效）。
    expect(narrative.blocks.filter((block) => block.kind === "narrative")).toEqual([]);
  });
});
