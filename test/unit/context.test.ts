import { describe, expect, it } from "vitest";
import type { LlmInvocation, PerspectiveFactView } from "@life-sim/shared";
import { buildLlmContext } from "@life-sim/agent-runtime";

describe("上下文分层：常驻 lore/style 进 stable prefix，关键词 lore 进 reactive", () => {
  it("两段不混在一起", () => {
    const inv = {
      invocationId: "inv-x",
      reason: "test",
      context: {
        stablePrefix: "",
        facts: {},
        recentTurns: [],
        invocationReason: "test",
        contextHints: ["战斗"],
      },
      tools: [],
      replyTo: "dispatch",
      perspective: "world",
      targetPerspective: "player",
      budget: { recentTurns: 6 },
      promptStyle: "句子短。",
      lore: [
        { id: "常驻", title: "常驻", text: "常驻设定。", always: true },
        { id: "战斗", title: "战斗", text: "战斗设定。", always: false },
      ],
    } as unknown as LlmInvocation;

    const built = buildLlmContext(inv, {
      engineApi: { buildFacts: () => ({}) as PerspectiveFactView },
      worldSkeleton: "骨架",
    });

    expect(built.context.stablePrefix).toContain("# 文风约束");
    expect(built.context.stablePrefix).toContain("## 常驻");
    expect(built.context.stablePrefix).not.toContain("## 战斗");
    expect(built.context.lore?.map((entry) => entry.id)).toEqual(["战斗"]);
  });
});
