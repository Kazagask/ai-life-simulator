import { describe, expect, it } from "vitest";
import type { LlmTrace } from "@life-sim/shared";
import { AgentGateway } from "./gateway.js";
import { runAgentLoop } from "./loop.js";
import { StubEngine, loadDemoFixture, makeBareInvocation, makeInvocation } from "./testing/fixtures.js";
import { ScriptedProvider, completion, narrativeCall, submitCall } from "./testing/scripted.js";

/**
 * 流式透传只多一路「正文碎片」出口，**不改** `AgentCompletion` / `LlmOutcome` / `LlmTrace`：
 * - 提供 `onDelta` ⇒ provider 收到回调并可在返回前吐碎片；
 * - 缺省 ⇒ provider 收不到任何流式参数（非流式路径零行为变化）；
 * - 两种情况下最终 outcome 与 trace 逐字段一致（除延迟测量）。
 */

const acceptAll = (calls: readonly { callId: string }[]) =>
  calls.map((call) => ({ callId: call.callId, outcome: "accepted" as const }));

describe("loop / gateway 的 onDelta 透传", () => {
  it("提供 onDelta ⇒ provider 收到，碎片按序外发；outcome 与 trace 不变", async () => {
    const deltas: string[] = [];
    const providerSeen: boolean[] = [];
    const provider = new ScriptedProvider([
      (req) => {
        providerSeen.push(req.onDelta !== undefined);
        req.onDelta?.({ text: "风" });
        req.onDelta?.({ text: "起" });
        return completion([submitCall()]);
      },
    ]);
    const engine = new StubEngine(acceptAll);

    const { outcome, trace } = await runAgentLoop(makeBareInvocation(), {
      provider,
      engineApi: engine,
      onDelta: (chunk) => deltas.push(chunk.text ?? ""),
      now: () => 0,
    });

    expect(providerSeen).toEqual([true]);
    expect(deltas).toEqual(["风", "起"]);
    expect(outcome.outcome).toBe("committed");
    expect(trace.outcome).toBe("committed");
    expect(trace.diagnostics).toEqual([]);
  });

  it("缺省 ⇒ provider 收不到 onDelta；trace 与流式逐字段一致", async () => {
    const build = () =>
      new ScriptedProvider([
        completion([narrativeCall({ refs: [] })]),
        completion([submitCall()]),
      ]);

    const plainProvider = build();
    const plainSeen: boolean[] = [];
    const plain = await runAgentLoop(makeBareInvocation(), {
      provider: {
        id: "mock",
        chat: async (req) => {
          plainSeen.push(req.onDelta !== undefined);
          return plainProvider.chat(req);
        },
      },
      engineApi: new StubEngine(acceptAll),
      now: () => 0,
    });

    const streamProvider = new ScriptedProvider([
      (req) => {
        req.onDelta?.({ text: "正文" });
        return completion([narrativeCall({ refs: [] })]);
      },
      (req) => {
        req.onDelta?.({ text: "续" });
        return completion([submitCall()]);
      },
    ]);
    const streamed = await runAgentLoop(makeBareInvocation(), {
      provider: streamProvider,
      engineApi: new StubEngine(acceptAll),
      onDelta: () => {},
      now: () => 0,
    });

    expect(plainSeen).toEqual([false, false]);
    expect(streamed.outcome).toEqual(plain.outcome);
    expect(streamed.trace).toEqual(plain.trace);
    // onDelta 只是展示通道：不会往 trace 的正文里多塞任何东西。
    expect(JSON.stringify(streamed.trace.contentBlocks)).toBe(
      JSON.stringify(plain.trace.contentBlocks),
    );
  });

  it("gateway 把 onDelta / signal 透传到每一次 provider 调用", async () => {
    const fixture = loadDemoFixture();
    const deltas: string[] = [];
    const seen: { onDelta: boolean; signal?: AbortSignal }[] = [];
    const controller = new AbortController();
    const provider = new ScriptedProvider([
      (req) => {
        seen.push({ onDelta: req.onDelta !== undefined, ...(req.signal ? { signal: req.signal } : {}) });
        req.onDelta?.({ text: "第一段" });
        return completion([narrativeCall({ refs: ["fact:gate-location"] })]);
      },
      (req) => {
        seen.push({ onDelta: req.onDelta !== undefined, ...(req.signal ? { signal: req.signal } : {}) });
        req.onDelta?.({ text: "第二段" });
        return completion([submitCall()]);
      },
    ]);
    const traces: LlmTrace[] = [];
    const gateway = new AgentGateway({
      provider,
      engineApi: fixture.engine,
      templateRef: "demo-agentic@1.0.0",
      rules: fixture.rules,
      toolProfile: "narrative",
      onDelta: (chunk) => deltas.push(chunk.text ?? ""),
      signal: controller.signal,
      onTrace: (trace) => traces.push(trace),
      now: () => 0,
    });

    const outcome = await gateway.invoke(makeInvocation(fixture));

    expect(outcome.outcome).toBe("committed");
    expect(deltas).toEqual(["第一段", "第二段"]);
    expect(seen.map((s) => s.onDelta)).toEqual([true, true]);
    // loop / gateway 原样透传取消信号（合成超时是 provider 层的事）。
    expect(seen[0]!.signal).toBe(controller.signal);
    expect(traces).toHaveLength(1);
    // trace 仍然只在收尾出现一次（流式不会中途落盘）。
    expect(traces[0]!.outcome).toBe("committed");
  });
});
