import { describe, expect, it } from "vitest";
import { AgentProviderError } from "./providers/errors.js";
import { OpenAiCompatibleProvider } from "./providers/openai-tools.js";
import { narrativeCall } from "./testing/scripted.js";

/** 真实 provider 的解析路径：注入 fetch，不联网。 */
function fetchReturning(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const request = {
  messages: [{ role: "user" as const, content: "{}" }],
  tools: [{ name: "narrative.write", parameters: { type: "object" } }],
  timeoutMs: 1000,
};

const toolCallBody = {
  choices: [
    {
      message: {
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "narrative.write",
              arguments: JSON.stringify(narrativeCall().arguments),
            },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 34 },
};

describe("OpenAiCompatibleProvider（结构化 tool_calls）", () => {
  it("解析 choices[0].message.tool_calls 的 JSON arguments", async () => {
    let seenUrl = "";
    let seenBody = "";
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://llm.example/v1/",
      model: "m",
      apiKey: "sk-test",
      fetchImpl: (async (url: unknown, init?: { body?: unknown }) => {
        seenUrl = String(url);
        seenBody = String(init?.body ?? "");
        return new Response(JSON.stringify(toolCallBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const result = await provider.chat(request);
    expect(seenUrl).toBe("https://llm.example/v1/chat/completions");
    expect(JSON.parse(seenBody)).toMatchObject({ model: "m", tool_choice: "auto" });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ id: "call_1", name: "narrative.write" });
    expect(result.toolCalls[0]!.arguments.blockId).toBe("blk-1");
    expect(result.inputTokens).toBe(12);
    expect(result.outputTokens).toBe(34);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("arguments 不是合法 JSON ⇒ 退化为空对象（不再炸整轮）", async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://llm.example/v1",
      model: "m",
      apiKey: "sk-test",
      fetchImpl: fetchReturning({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "c",
                  function: { name: "narrative.write", arguments: "{not-json" },
                },
              ],
            },
          },
        ],
      }),
    });

    // 2026-11-16：坏参数不再抛错——退化成 `{}`，交给第 1 层校验给出可修的提示，
    // 模型下一轮就能改对。抛错会让整轮直接作废、零产出。
    const completion = await provider.chat(request);
    expect(completion.toolCalls).toHaveLength(1);
    expect(completion.toolCalls[0]!.arguments).toEqual({});
  });

  it("HTTP 500 ⇒ provider_unavailable；400 ⇒ invalid_arguments", async () => {
    const make = (status: number): OpenAiCompatibleProvider =>
      new OpenAiCompatibleProvider({
        baseUrl: "https://llm.example/v1",
        model: "m",
        apiKey: "sk-test",
        fetchImpl: fetchReturning({}, status),
      });

    await expect(make(500).chat(request)).rejects.toBeInstanceOf(AgentProviderError);
    await expect(make(500).chat(request)).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(make(400).chat(request)).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("文本-only 响应 ⇒ toolCalls 为空、finishReason stop", async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://llm.example/v1",
      model: "m",
      apiKey: "sk-test",
      fetchImpl: fetchReturning({
        choices: [{ message: { content: "只有文本" }, finish_reason: "stop" }],
      }),
    });
    const result = await provider.chat({ ...request, tools: [] });
    expect(result.toolCalls).toEqual([]);
    expect(result.text).toBe("只有文本");
    expect(result.finishReason).toBe("stop");
  });
});
