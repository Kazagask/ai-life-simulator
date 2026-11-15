import { describe, expect, it } from "vitest";
import type { CallReceipt } from "@life-sim/shared";
import { isRetryable } from "@life-sim/game-core";
import { runAgentLoop } from "./loop.js";
import { loadDemoFixture, makeInvocation } from "./testing/fixtures.js";
import { ScriptedProvider, completion, narrativeCall, submitCall } from "./testing/scripted.js";

/** 真实的 RpgEngineAPI 用来验 visibility_violation 与 factsHint 回灌（不用桩）。 */
const parseToolMessage = (content: string | undefined): Record<string, unknown> => {
  expect(typeof content).toBe("string");
  return JSON.parse(content as string) as Record<string, unknown>;
};

describe("T-04 分支①：RETRYABLE 回执 + factsHint 回灌", () => {
  it("visibility_violation 后带 factsHint 重生成，最终 committed", async () => {
    const fixture = loadDemoFixture();
    const provider = new ScriptedProvider([
      completion([narrativeCall({ targetPerspective: "world" })]),
      completion([narrativeCall({ targetPerspective: "player", refs: [] })]),
      completion([submitCall()]),
    ]);
    const { outcome, trace } = await runAgentLoop(makeInvocation(fixture), {
      provider,
      engineApi: fixture.engine,
      toolProfile: "narrative",
      contextHash: "sha256:test",
    });

    expect(outcome.outcome).toBe("committed");
    const codes = trace.receipts.flatMap((receipt) => (receipt.code ? [receipt.code] : []));
    expect(codes).toContain("visibility_violation");
    expect(provider.callCount).toBe(3);

    // 第 2 轮请求里必须带上一轮的拒绝回执 + factsHint（结构化，不是字符串拼接）。
    const secondRoundToolMsg = provider.requests[1]!.messages.find((m) => m.role === "tool");
    const payload = parseToolMessage(secondRoundToolMsg?.content);
    expect(payload.outcome).toBe("rejected");
    expect(payload.code).toBe("visibility_violation");
    expect(payload.factsHint).toMatchObject({ targetPerspective: "player" });

    // 修正后的叙事块真的进了 trace，而不是权威状态。
    expect(trace.contentBlocks).toHaveLength(1);
    expect(trace.contentBlocks?.[0]?.kind).toBe("narrative");
  });

  it("连续 2 次越窗 ⇒ retry_exhausted，且每次回执都是 RETRYABLE", async () => {
    const fixture = loadDemoFixture();
    const provider = new ScriptedProvider([
      completion([narrativeCall({ targetPerspective: "world" })]),
    ]);
    const { outcome, trace } = await runAgentLoop(
      makeInvocation(fixture, { budget: { retryLimit: 2 } }),
      { provider, engineApi: fixture.engine, toolProfile: "narrative", contextHash: "sha256:test" },
    );

    expect(provider.callCount).toBe(3);
    expect(outcome.outcome === "fallback" ? outcome.code : undefined).toBe("retry_exhausted");
    const rejected = trace.receipts.filter((receipt) => receipt.outcome === "rejected");
    expect(rejected).toHaveLength(3);
    for (const receipt of rejected) {
      expect(receipt.code).toBe("visibility_violation");
      expect(isRetryable(receipt.code!)).toBe(true);
      expect(receipt.factsHint).toBeDefined();
    }
  });

  it("refs 越窗（引用未见过的隐秘）⇒ factsHint 带 allowedRefs 白名单", async () => {
    const fixture = loadDemoFixture();
    const provider = new ScriptedProvider([
      completion([narrativeCall({ refs: ["secret:mentor-plan"] })]),
      completion([narrativeCall({ refs: [] })]),
      completion([submitCall()]),
    ]);
    const { outcome, trace } = await runAgentLoop(makeInvocation(fixture), {
      provider,
      engineApi: fixture.engine,
      toolProfile: "narrative",
      contextHash: "sha256:test",
    });

    expect(outcome.outcome).toBe("committed");
    const rejected: CallReceipt | undefined = trace.receipts.find(
      (receipt) => receipt.code === "visibility_violation",
    );
    const hint = rejected?.factsHint as { allowedRefs?: string[]; violations?: string[] } | undefined;
    expect(hint?.violations).toEqual(["secret:mentor-plan"]);
    expect(hint?.allowedRefs).toContain("fact:gate-location");

    const secondRoundToolMsg = provider.requests[1]!.messages.find((m) => m.role === "tool");
    expect(parseToolMessage(secondRoundToolMsg?.content).factsHint).toMatchObject({
      violations: ["secret:mentor-plan"],
    });
  });
});
