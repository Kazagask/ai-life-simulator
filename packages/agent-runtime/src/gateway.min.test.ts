import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LlmTrace } from "@life-sim/shared";
import { AgentGateway } from "./gateway.js";
import { loadDemoFixture, makeInvocation } from "./testing/fixtures.js";
import { ScriptedProvider, completion, narrativeCall, submitCall } from "./testing/scripted.js";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".min.test.ts")) out.push(full);
  }
  return out;
}

describe("AgentGateway", () => {
  it("onTrace 在 invoke 返回前同步调用，且 trace 携带 contentBlocks", async () => {
    const fixture = loadDemoFixture();
    const provider = new ScriptedProvider([
      completion([narrativeCall({ refs: ["fact:gate-location"] })]),
      completion([submitCall()]),
    ]);
    const events: string[] = [];
    const traces: LlmTrace[] = [];
    const gateway = new AgentGateway({
      provider,
      engineApi: fixture.engine,
      templateRef: "demo-agentic@1.0.0",
      rules: fixture.rules,
      toolProfile: "narrative",
      onTrace: (trace) => {
        events.push("onTrace");
        traces.push(trace);
      },
    });

    const outcome = await gateway.invoke(makeInvocation(fixture));
    events.push("after-await");

    expect(outcome.outcome).toBe("committed");
    expect(events).toEqual(["onTrace", "after-await"]);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.contentBlocks?.length).toBeGreaterThan(0);
    expect(traces[0]!.templateRef).toBe("demo-agentic@1.0.0");
    expect(traces[0]!.toolProfile).toBe("narrative");
  });

  it("onTrace 抛错被吞掉并记诊断，outcome 不变", async () => {
    const fixture = loadDemoFixture();
    const provider = new ScriptedProvider([
      completion([narrativeCall()]),
      completion([submitCall()]),
    ]);
    let captured: LlmTrace | undefined;
    const gateway = new AgentGateway({
      provider,
      engineApi: fixture.engine,
      rules: fixture.rules,
      toolProfile: "narrative",
      onTrace: (trace) => {
        captured = trace;
        throw new Error("disk full");
      },
    });

    const outcome = await gateway.invoke(makeInvocation(fixture));
    expect(outcome.outcome).toBe("committed");
    expect(captured?.diagnostics).toContain("provider_unavailable");
  });

  it("同一 invocationId 重入 ⇒ duplicate_invocation，且不再次调用 provider", async () => {
    const fixture = loadDemoFixture();
    const provider = new ScriptedProvider([
      completion([narrativeCall()]),
      completion([submitCall()]),
    ]);
    const gateway = new AgentGateway({
      provider,
      engineApi: fixture.engine,
      rules: fixture.rules,
      toolProfile: "narrative",
    });
    const inv = makeInvocation(fixture);

    const first = await gateway.invoke(inv);
    const callsAfterFirst = provider.callCount;
    const second = await gateway.invoke(inv);

    expect(first.outcome).toBe("committed");
    expect(second.outcome).toBe("fallback");
    expect(second.outcome === "fallback" ? second.code : undefined).toBe("duplicate_invocation");
    expect(provider.callCount).toBe(callsAfterFirst);
    expect(second.outcome === "fallback" ? second.traceRef : "").toBe(
      first.outcome === "committed" ? first.traceRef : "",
    );
  });

  it("invoke 绝不抛异常：provider 同步抛出也折算为 fallback", async () => {
    const fixture = loadDemoFixture();
    const provider = new ScriptedProvider([new Error("kaboom")]);
    const gateway = new AgentGateway({
      provider,
      engineApi: fixture.engine,
      rules: fixture.rules,
      toolProfile: "narrative",
    });
    await expect(gateway.invoke(makeInvocation(fixture))).resolves.toMatchObject({
      outcome: "fallback",
      code: "provider_unavailable",
    });
  });
});

describe("traceRef 唯一生成点（源码守卫）", () => {
  it("全包只有 loop.ts 的 traceRefFor 拼 `trace:${...}`", () => {
    const offenders: string[] = [];
    let occurrences = 0;
    for (const file of sourceFiles(SRC_DIR)) {
      const text = readFileSync(file, "utf8");
      const hits = text.match(/`trace:\$\{/g) ?? [];
      if (hits.length > 0) {
        occurrences += hits.length;
        if (path.basename(file) !== "loop.ts") offenders.push(path.relative(SRC_DIR, file));
      }
    }
    expect(offenders).toEqual([]);
    expect(occurrences).toBe(1);
  });

  it("gateway / loop 的 traceRef 都由 traceRefFor 产出（形状断言）", async () => {
    const fixture = loadDemoFixture();
    const provider = new ScriptedProvider([
      completion([narrativeCall()]),
      completion([submitCall()]),
    ]);
    const gateway = new AgentGateway({
      provider,
      engineApi: fixture.engine,
      rules: fixture.rules,
      toolProfile: "narrative",
    });
    const inv = makeInvocation(fixture, { invocationId: "inv-trace-shape" });
    const outcome = await gateway.invoke(inv);
    expect(outcome.outcome === "committed" ? outcome.traceRef : "").toBe("trace:inv-trace-shape");
  });
});
