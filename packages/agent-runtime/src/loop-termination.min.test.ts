import { describe, expect, it } from "vitest";
import { LlmOutcomeSchema, LlmTraceSchema } from "@life-sim/shared";
import { runAgentLoop } from "./loop.js";
import { AgentProviderError } from "./providers/errors.js";
import { StubEngine, makeBareInvocation, type DispatchHandler } from "./testing/fixtures.js";
import {
  ScriptedProvider,
  completion,
  narrativeCall,
  submitCall,
  toolCall,
} from "./testing/scripted.js";

const acceptAll: DispatchHandler = (calls) =>
  calls.map((call) => ({ callId: call.callId, outcome: "accepted" }));

describe("T-04 七种终止条件", () => {
  it("① submitted：content.submit 被接受 ⇒ committed", async () => {
    const engine = new StubEngine(acceptAll);
    const provider = new ScriptedProvider([completion([submitCall()])]);
    const inv = makeBareInvocation();

    const { outcome, trace } = await runAgentLoop(inv, { provider, engineApi: engine });

    expect(outcome.outcome).toBe("committed");
    expect(outcome.outcome === "committed" ? outcome.traceRef : "").toBe("trace:inv-bare-1");
    expect(trace.outcome).toBe("committed");
    expect(trace.receipts).toHaveLength(1);
    expect(trace.receipts[0]).toMatchObject({ outcome: "accepted", callId: "inv-bare-1:0:0" });
    expect(LlmTraceSchema.safeParse(trace).success).toBe(true);
    expect(LlmOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it("② no_tool_calls：provider 只回文本 ⇒ fallback", async () => {
    const engine = new StubEngine(acceptAll);
    const provider = new ScriptedProvider([
      completion([], { text: "这一回合没什么可写的。" }),
    ]);
    const { outcome, trace } = await runAgentLoop(makeBareInvocation(), {
      provider,
      engineApi: engine,
    });

    expect(outcome.outcome).toBe("fallback");
    expect(trace.outcome).toBe("fallback");
    expect(trace.fallbackCode).toBeUndefined();
    expect(trace.receipts).toHaveLength(0);
    expect(outcome.outcome === "fallback" ? outcome.reason : "").toContain("工具调用");
    expect(provider.callCount).toBe(1);
  });

  it("③ maxToolRounds 耗尽 ⇒ fallback", async () => {
    const engine = new StubEngine(acceptAll);
    const provider = new ScriptedProvider([completion([narrativeCall()])]);
    const { outcome, trace } = await runAgentLoop(
      makeBareInvocation({ budget: { maxToolRounds: 2 } }),
      { provider, engineApi: engine },
    );

    expect(provider.callCount).toBe(2);
    expect(outcome.outcome).toBe("fallback");
    expect(outcome.outcome === "fallback" ? outcome.reason : "").toContain("上限");
    expect(trace.receipts).toHaveLength(2);
    expect(trace.outcome).toBe("fallback");
  });

  it("④ retry_exhausted：RETRYABLE 拒绝用尽 2 次重试 ⇒ fallback", async () => {
    const rejecting: DispatchHandler = (calls) =>
      calls.map((call) => ({
        callId: call.callId,
        outcome: "rejected" as const,
        code: "visibility_violation" as const,
        detail: "越窗",
        factsHint: { targetPerspective: "player" },
      }));
    const engine = new StubEngine(rejecting);
    const provider = new ScriptedProvider([completion([narrativeCall()])]);

    const { outcome, trace } = await runAgentLoop(
      makeBareInvocation({ budget: { retryLimit: 2, maxToolRounds: 6 } }),
      { provider, engineApi: engine },
    );

    expect(provider.callCount).toBe(3);
    expect(outcome.outcome).toBe("fallback");
    expect(outcome.outcome === "fallback" ? outcome.code : undefined).toBe("retry_exhausted");
    expect(trace.fallbackCode).toBe("retry_exhausted");
    expect(trace.diagnostics).toContain("visibility_violation");
    expect(trace.diagnostics).toContain("retry_exhausted");
  });

  it("⑤ timeout：provider 抛超时 ⇒ fallback(timeout)", async () => {
    const engine = new StubEngine(acceptAll);
    const provider = new ScriptedProvider([
      new AgentProviderError("timeout", "provider 请求超时"),
    ]);
    const { outcome, trace } = await runAgentLoop(makeBareInvocation(), {
      provider,
      engineApi: engine,
    });

    expect(outcome.outcome === "fallback" ? outcome.code : undefined).toBe("timeout");
    expect(trace.fallbackCode).toBe("timeout");
    expect(trace.diagnostics).toEqual(["timeout"]);
  });

  it("⑥ budget_exceeded：token 预算耗尽 ⇒ fallback", async () => {
    const engine = new StubEngine(acceptAll);
    const provider = new ScriptedProvider([
      completion([narrativeCall()], { inputTokens: 999_999, outputTokens: 1 }),
    ]);
    const { outcome, trace } = await runAgentLoop(makeBareInvocation(), {
      provider,
      engineApi: engine,
    });

    expect(outcome.outcome === "fallback" ? outcome.code : undefined).toBe("budget_exceeded");
    expect(trace.fallbackCode).toBe("budget_exceeded");
    expect(trace.inputTokens).toBe(999_999);
  });

  it("⑦ provider_unavailable：provider 抛非超时异常 ⇒ fallback", async () => {
    const engine = new StubEngine(acceptAll);
    const provider = new ScriptedProvider([new Error("boom")]);
    const { outcome, trace } = await runAgentLoop(makeBareInvocation(), {
      provider,
      engineApi: engine,
    });

    expect(outcome.outcome === "fallback" ? outcome.code : undefined).toBe(
      "provider_unavailable",
    );
    expect(trace.fallbackCode).toBe("provider_unavailable");
    expect(LlmTraceSchema.safeParse(trace).success).toBe(true);
  });
});

describe("T-04 第 1 层校验是 FATAL（不消耗重试）", () => {
  it("未知工具 ⇒ unknown_tool 立即终止，且不再调用 provider", async () => {
    const engine = new StubEngine(acceptAll);
    const provider = new ScriptedProvider([
      completion([toolCall("content.hackState", {})]),
      completion([submitCall()]),
    ]);
    const { outcome, trace } = await runAgentLoop(makeBareInvocation(), {
      provider,
      engineApi: engine,
    });

    expect(provider.callCount).toBe(1);
    expect(outcome.outcome === "fallback" ? outcome.code : undefined).toBe("unknown_tool");
    expect(trace.receipts[0]).toMatchObject({ outcome: "rejected", code: "unknown_tool" });
  });

  it("参数不合 schema ⇒ invalid_arguments 立即终止", async () => {
    const engine = new StubEngine(acceptAll);
    const provider = new ScriptedProvider([
      completion([toolCall("content.writeNarrative", { blockId: "b1" })]),
    ]);
    const { outcome, trace } = await runAgentLoop(makeBareInvocation(), {
      provider,
      engineApi: engine,
    });

    expect(outcome.outcome === "fallback" ? outcome.code : undefined).toBe("invalid_arguments");
    expect(trace.receipts[0]).toMatchObject({ outcome: "rejected", code: "invalid_arguments" });
    expect(provider.callCount).toBe(1);
  });

  it("引擎层面不可重试拒绝（idempotency_conflict）也终止，不空转", async () => {
    const engine = new StubEngine((calls) =>
      calls.map((call) => ({
        callId: call.callId,
        outcome: "rejected" as const,
        code: "idempotency_conflict" as const,
      })),
    );
    const provider = new ScriptedProvider([completion([narrativeCall()])]);
    const { outcome } = await runAgentLoop(makeBareInvocation(), {
      provider,
      engineApi: engine,
    });

    expect(outcome.outcome === "fallback" ? outcome.code : undefined).toBe(
      "idempotency_conflict",
    );
    expect(provider.callCount).toBe(1);
  });
});
