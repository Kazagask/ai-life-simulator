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
  it("① submitted：agent.submit 被接受 ⇒ committed", async () => {
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

  it("③ maxToolRounds 耗尽：写过内容 ⇒ committed（内容已在 trace，不再整轮作废）", async () => {
    const engine = new StubEngine(acceptAll);
    const provider = new ScriptedProvider([completion([narrativeCall()])]);
    const { outcome, trace } = await runAgentLoop(
      makeBareInvocation({ budget: { maxToolRounds: 2 } }),
      { provider, engineApi: engine },
    );

    expect(provider.callCount).toBe(2);
    // 新契约：写过内容就 committed（内容已在 trace 里，不该因为"轮数用尽"整轮作废）。
    expect(outcome.outcome).toBe("committed");
    expect(trace.outcome).toBe("committed");
    expect(trace.receipts.length).toBeGreaterThanOrEqual(2);
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

describe("T-04 第 1 层校验失败 ⇒ 回灌模型重试（不再是 FATAL）", () => {
  /**
   * 契约变更（2026-11-16，真实模型实测）：第 1 层（工具名 / 参数 schema）失败原本直接
   * 判死整轮，理由是"不消耗重试额度"。但 glm-5.3 实测第一次发 `narrative.write`
   * 时 arguments 是 `{}` —— 这是**可修的一次格式错误**，判死的结果是玩家一个字都看不到。
   * 现在改为：把错误码 + 明细（未知工具还附可用清单）回灌给模型，受 `retryLimit` 约束。
   */
  it("未知工具 ⇒ 回灌可用工具清单并重试，模型改对后照常提交", async () => {
    const engine = new StubEngine(acceptAll);
    const provider = new ScriptedProvider([
      completion([toolCall("content.hackState", {})]),
      completion([submitCall()]),
    ]);
    const { outcome, trace } = await runAgentLoop(makeBareInvocation(), {
      provider,
      engineApi: engine,
    });

    // 关键：没有再"立即终止"——provider 被第二次调用，且最终 committed。
    expect(provider.callCount).toBe(2);
    expect(outcome.outcome).toBe("committed");
    expect(trace.receipts[0]).toMatchObject({ outcome: "rejected", code: "unknown_tool" });
    // 清单回灌确实发给了模型（否则它没有理由改对）。
    const hint = provider.requests[1]?.messages.at(-1);
    expect(JSON.stringify(hint ?? {})).toContain("narrative.write");
  });

  it("参数不合 schema ⇒ 回灌错误并重试；模型一直不改 ⇒ retry_exhausted", async () => {
    const engine = new StubEngine(acceptAll);
    const provider = new ScriptedProvider([
      completion([toolCall("narrative.write", { blockId: "b1" })]),
    ]);
    const { outcome, trace } = await runAgentLoop(makeBareInvocation(), {
      provider,
      engineApi: engine,
    });

    expect(outcome.outcome === "fallback" ? outcome.code : undefined).toBe("retry_exhausted");
    expect(trace.receipts[0]).toMatchObject({ outcome: "rejected", code: "invalid_arguments" });
    // 每次重试都真的又问了模型一次（不是原地空转）。
    expect(provider.callCount).toBeGreaterThan(1);
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
