import { describe, expect, it } from "vitest";
import type { LlmInvocation, PerspectiveFactView } from "@life-sim/shared";
import { buildLlmContext, buildOutputContract, OUTPUT_CONTRACT } from "@life-sim/agent-runtime";

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

describe("输出契约按体裁渲染（2026-11-19：章节小结要更长、且能回看整章）", () => {
  it("缺省逐拍：与旧契约逐字节相同", () => {
    expect(buildOutputContract()).toBe(OUTPUT_CONTRACT);
    expect(OUTPUT_CONTRACT).toContain("一次 invocation 正文 80–220 个汉字，1–3 段。");
    expect(OUTPUT_CONTRACT).toContain("只写这一回合内");
    expect(OUTPUT_CONTRACT).toContain("必须紧接 `recentTurns`");
  });

  it("recap：换掉两条逐拍约束，字数/段数按 length 渲染", () => {
    const recap = buildOutputContract("recap", {
      minChars: 320,
      maxChars: 760,
      minParagraphs: 3,
      maxParagraphs: 6,
    });
    expect(recap).toContain("一次 invocation 正文 320–760 个汉字，3–6 段。");
    expect(recap).toContain("收束一段已经发生的经历");
    // 两条逐拍硬约束必须消失：留着它们，模型就只能写出缩水的流水账
    expect(recap).not.toContain("只写这一回合内");
    expect(recap).not.toContain("必须紧接 `recentTurns`");
    // 其余段落照旧（不要顺手改掉别的口径）
    expect(recap).toContain("**用第二人称「你」指主角**");
    expect(recap).toContain("所有事实变更只能通过工具调用提交");
  });

  it("buildLlmContext 逐字段重建时不能丢 narrativeMode / narrativeLength", () => {
    const inv = {
      invocationId: "inv-r",
      reason: "chapter",
      context: {
        stablePrefix: "",
        facts: {},
        recentTurns: [],
        invocationReason: "chapter",
        narrativeMode: "recap",
        narrativeLength: { minChars: 320, maxChars: 760 },
      },
      tools: [],
      replyTo: "dispatch",
      perspective: "player",
      targetPerspective: "player",
      budget: { recentTurns: 6 },
    } as unknown as LlmInvocation;

    const built = buildLlmContext(inv, {
      engineApi: { buildFacts: () => ({}) as PerspectiveFactView },
      worldSkeleton: "骨架",
    });

    expect(built.context.narrativeMode).toBe("recap");
    expect(built.context.stablePrefix).toContain("320–760 个汉字");
    expect(built.context.stablePrefix).not.toContain("只写这一回合内");
  });
});
