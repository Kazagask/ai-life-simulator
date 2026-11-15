import { describe, expect, it } from "vitest";
import { AgentProviderError } from "./providers/errors.js";
import { OpenAiCompatibleProvider } from "./providers/openai-tools.js";

/**
 * 流式路径（SSE）与非流式路径的产出形状必须一致：
 * `chat()` 始终返回一份完整 `AgentCompletion`，流式只多一路 `onDelta` 回调。
 */

const encoder = new TextEncoder();

function sseResponse(chunks: readonly string[], status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status, headers: { "content-type": "text/event-stream" } },
  );
}

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const DONE = "data: [DONE]\n\n";

const request = {
  messages: [{ role: "user" as const, content: "{}" }],
  tools: [{ name: "content.writeNarrative", parameters: { type: "object" } }],
  timeoutMs: 1000,
};

function providerWith(impl: typeof fetch): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    baseUrl: "https://llm.example/v1",
    model: "m",
    apiKey: "sk-test",
    fetchImpl: impl,
  });
}

describe("OpenAiCompatibleProvider（SSE 流式）", () => {
  it("delta.content 逐片回调；tool_calls 的 arguments 跨分片拼接后整体 parse", async () => {
    let seenBody: Record<string, unknown> = {};
    const deltas: string[] = [];
    const provider = providerWith((async (_url: unknown, init?: { body?: unknown }) => {
      seenBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return sseResponse([
        sse({ choices: [{ delta: { role: "assistant", content: "你" } }] }),
        sse({ choices: [{ delta: { content: "好" } }] }),
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "content.writeNarrative", arguments: '{"bl' },
                  },
                ],
              },
            },
          ],
        }),
        // 半行 JSON 参数：必须拼完再 parse，不能中途 parse。
        sse({
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: 'ockId":"b1",' } }] } },
          ],
        }),
        sse({
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: '"text":"x"}' } }] } },
          ],
        }),
        sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        sse({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 9 } }),
        DONE,
      ]);
    }) as unknown as typeof fetch);

    const result = await provider.chat({ ...request, onDelta: (d) => deltas.push(d.text ?? "") });

    expect(seenBody.stream).toBe(true);
    expect(seenBody.stream_options).toEqual({ include_usage: true });
    expect(deltas).toEqual(["你", "好"]);
    expect(result.text).toBe("你好");
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "content.writeNarrative", arguments: { blockId: "b1", text: "x" } },
    ]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.inputTokens).toBe(7);
    expect(result.outputTokens).toBe(9);
  });

  it("多条并行 tool_call 按 index 归并，缺失 id 时回落 tool-<index>", async () => {
    const provider = providerWith((async () =>
      sseResponse([
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "a", function: { name: "content.writeNarrative", arguments: "{" } },
                  { index: 1, function: { name: "content.submit", arguments: "" } },
                ],
              },
            },
          ],
        }),
        sse({
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }, { index: 1, function: { arguments: '{"blockIds":[]}' } }] } },
          ],
        }),
        sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        DONE,
      ])) as unknown as typeof fetch);

    const result = await provider.chat({ ...request, onDelta: () => {} });

    expect(result.toolCalls.map((c) => c.name)).toEqual([
      "content.writeNarrative",
      "content.submit",
    ]);
    expect(result.toolCalls[1]).toMatchObject({ id: "tool-1", arguments: { blockIds: [] } });
  });

  it("[DONE] 缺失 ⇒ provider_unavailable；已流出的正文不回收，tool_calls 整批丢弃", async () => {
    const deltas: string[] = [];
    const provider = providerWith((async () =>
      sseResponse([
        sse({ choices: [{ delta: { content: "半句话" } }] }),
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "c", function: { name: "content.writeNarrative", arguments: '{"bl' } },
                ],
              },
            },
          ],
        }),
      ])) as unknown as typeof fetch);

    await expect(
      provider.chat({ ...request, onDelta: (d) => deltas.push(d.text ?? "") }),
    ).rejects.toMatchObject({ name: "AgentProviderError", code: "provider_unavailable" });
    expect(deltas).toEqual(["半句话"]);
  });

  it("usage 缺失 ⇒ 回退 estimateTokens（绝不出 undefined）", async () => {
    const provider = providerWith((async () =>
      sseResponse([
        sse({ choices: [{ delta: { content: "只有正文" } }] }),
        sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        DONE,
      ])) as unknown as typeof fetch);

    const result = await provider.chat({ ...request, onDelta: () => {} });
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe("stop");
    expect(Number.isFinite(result.inputTokens)).toBe(true);
    expect(Number.isFinite(result.outputTokens)).toBe(true);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
  });

  it("没有 onDelta ⇒ 不发 stream:true（默认仍是完整响应）", async () => {
    let seenBody: Record<string, unknown> = {};
    const provider = providerWith((async (_url: unknown, init?: { body?: unknown }) => {
      seenBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "完整" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch);

    const result = await provider.chat(request);
    expect("stream" in seenBody).toBe(false);
    expect("stream_options" in seenBody).toBe(false);
    expect(result.text).toBe("完整");
  });

  it("流式请求 4xx ⇒ 与非流式同一映射，且能读到普通 JSON 错误体（apiKey 脱敏）", async () => {
    const provider = providerWith((async () =>
      new Response(JSON.stringify({ error: { message: "model not found", key: "sk-test" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch);

    const err = await provider
      .chat({ ...request, onDelta: () => {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentProviderError);
    expect((err as AgentProviderError).code).toBe("invalid_arguments");
    expect((err as AgentProviderError).message).toContain("model not found");
    expect((err as AgentProviderError).message).not.toContain("sk-test");
  });

  it("坏分片（非 JSON 的 data 行）⇒ provider_unavailable", async () => {
    const provider = providerWith((async () =>
      sseResponse(["data: {broken\n\n", DONE])) as unknown as typeof fetch);

    await expect(provider.chat({ ...request, onDelta: () => {} })).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });

  it("CRLF 行尾与自定义事件名不干扰解析", async () => {
    const provider = providerWith((async () =>
      sseResponse([
        ": keep-alive\r\n\r\n",
        `event: message\r\ndata: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\r\n\r\n`,
        "data: [DONE]\r\n\r\n",
      ])) as unknown as typeof fetch);

    const result = await provider.chat({ ...request, onDelta: () => {} });
    expect(result.text).toBe("ok");
  });
});
