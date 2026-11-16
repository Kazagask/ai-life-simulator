import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenAiCompatibleProvider } from "@life-sim/agent-runtime";
import { loadRecordedInvocations, startReplayOpenAi, type ReplayOpenAi } from "../helpers/replay-openai.ts";

describe("录制 → 回放 provider", () => {
  let fake: ReplayOpenAi;

  beforeAll(async () => {
    fake = await startReplayOpenAi({ fixture: "test/fixtures/llm/p0-tool.jsonl" });
  });

  afterAll(async () => {
    await fake.close();
  });

  it("第一轮原样回放 content + calls，第二轮自然退出", async () => {
    const recorded = loadRecordedInvocations("test/fixtures/llm/p0-tool.jsonl")[0]!;
    const provider = new OpenAiCompatibleProvider({
      baseUrl: fake.baseUrl,
      model: "replay",
      apiKey: "test-key",
    });
    const request = {
      messages: [
        {
          role: "user" as const,
          content: JSON.stringify({ invocationId: recorded.invocationId }),
        },
      ],
      tools: [
        {
          name: "story.submitBranch",
          description: "",
          parameters: { type: "object", properties: {} },
        },
      ],
      timeoutMs: 5_000,
    };

    const first = await provider.chat(request);
    expect(first.text).toContain("<narrative-content>");
    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls[0]?.name).toBe("story.submitBranch");
    expect(first.toolCalls[0]?.arguments).toEqual(recorded.calls[0]?.args);

    const second = await provider.chat(request);
    expect(second.toolCalls).toEqual([]);
    expect(second.text).toBeUndefined();
  });
});
