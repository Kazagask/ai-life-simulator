import { describe, expect, it } from "vitest";
import { buildLlmContext, buildStablePrefix, sha256, stableStringify } from "./context.js";
import { loadDemoFixture, makeInvocation } from "./testing/fixtures.js";

describe("T-05b buildLlmContext", () => {
  it("facts 段逐条透传 buildFacts，不裁剪 / 不补默认值", () => {
    const fixture = loadDemoFixture();
    const inv = makeInvocation(fixture, { perspective: "player" });
    const direct = fixture.engine.buildFacts("player");
    const { context } = buildLlmContext(inv, {
      engineApi: fixture.engine,
      rules: fixture.rules,
      toolProfile: "narrative",
    });

    expect(context.facts.perspective).toBe("player");
    expect(context.facts.facts.length).toBe(direct.facts.length);
    expect(context.facts.facts.length).toBeGreaterThan(0);
    expect(stableStringify(context.facts)).toBe(stableStringify(direct));
    for (const fact of direct.facts) {
      expect(context.facts.facts.some((f) => f.factRef === fact.factRef)).toBe(true);
    }
    expect(context.facts.dagNodes).toHaveLength(direct.dagNodes?.length ?? 0);
  });

  it("stablePrefix 对同一模板 / 画像字节稳定（两次调用哈希一致）", () => {
    const fixture = loadDemoFixture();
    const deps = {
      engineApi: fixture.engine,
      rules: fixture.rules,
      toolProfile: "narrative",
      worldSkeleton: `${fixture.template.meta.name}\n${fixture.template.meta.description}`,
    };
    const first = buildLlmContext(makeInvocation(fixture), deps);
    const second = buildLlmContext(makeInvocation(fixture), deps);

    expect(first.context.stablePrefix).toBe(second.context.stablePrefix);
    expect(sha256(first.context.stablePrefix)).toBe(sha256(second.context.stablePrefix));
    expect(first.contextHash).toBe(second.contextHash);
  });

  it("换能力画像 ⇒ stablePrefix 与 contextHash 都变", () => {
    const fixture = loadDemoFixture();
    const rules = {
      ...fixture.rules,
      toolProfile: {
        ...fixture.rules.toolProfile,
        "flavor-only": ["content.writeFlavor"],
      },
    };
    const skeleton = "最小骨架模板";
    const narrative = buildLlmContext(makeInvocation(fixture, { toolProfile: "narrative" }), {
      engineApi: fixture.engine,
      rules,
      toolProfile: "narrative",
      worldSkeleton: skeleton,
    });
    const flavor = buildLlmContext(makeInvocation(fixture, { toolProfile: "flavor-only" }), {
      engineApi: fixture.engine,
      rules,
      toolProfile: "flavor-only",
      worldSkeleton: skeleton,
    });

    expect(narrative.context.stablePrefix).not.toBe(flavor.context.stablePrefix);
    expect(sha256(narrative.context.stablePrefix)).not.toBe(sha256(flavor.context.stablePrefix));
    expect(narrative.contextHash).not.toBe(flavor.contextHash);
    expect(flavor.context.stablePrefix).toContain("flavor-only");
  });

  it("recentTurns 只取末尾 budget.recentTurns 条", () => {
    const fixture = loadDemoFixture();
    const inv = makeInvocation(fixture, { budget: { recentTurns: 2 } });
    const history = [{ title: "t1" }, { title: "t2" }, { title: "t3" }, { title: "t4" }];
    const { context } = buildLlmContext(inv, {
      engineApi: fixture.engine,
      rules: fixture.rules,
      toolProfile: "narrative",
      history,
    });
    expect(context.recentTurns).toEqual([{ title: "t3" }, { title: "t4" }]);
  });

  it("stablePrefix 含输出契约与画像工具名，且不含本轮 facts 内容", () => {
    const fixture = loadDemoFixture();
    const inv = makeInvocation(fixture);
    const prefix = buildStablePrefix(inv, {
      engineApi: fixture.engine,
      rules: fixture.rules,
      toolProfile: "narrative",
      worldSkeleton: "骨架",
    });
    expect(prefix).toContain("content.writeNarrative");
    expect(prefix).toContain("content.submit");
    expect(prefix).toContain("# 输出契约");
    expect(prefix).not.toContain("fact:gate-location");
  });
});
