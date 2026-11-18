import { describe, expect, it } from "vitest";
import { RulesSchema, type HistoryEntryV2 } from "@life-sim/shared";
import {
  createConditionRegistry,
  evaluateTriggers,
  type TriggerOptions,
} from "../../packages/game-core/src/v2/condition-evaluator.ts";
import { makeWorld } from "../helpers/world.ts";

/**
 * 触发求值 → `LlmInvocation` 的上下文组装（2026-11-19）。
 *
 * 背景：`recentTurns` 曾经硬编码 `[]`，编排层又没有别的注入点，于是模型只看得到 facts，
 * 看不到「刚刚发生了什么」。逐拍旁白还能硬撑，章节回顾必然写成空话或流水账。
 */

function rulesOf(invoke: Record<string, unknown>) {
  return RulesSchema.parse({
    llmTriggers: [
      {
        when: [{ op: "always", args: {} }],
        invoke: {
          reason: "test.recap",
          perspective: "player",
          targetPerspective: "player",
          toolProfile: "narrative",
          ...invoke,
        },
      },
    ],
    toolProfile: { narrative: ["world.now"] },
    knowledgeGrants: [],
    inferenceRules: [],
  });
}

function historyEntry(turnIndex: number, summary: string, visibility?: "public" | "hidden"): HistoryEntryV2 {
  return {
    id: `h-${turnIndex}`,
    turnIndex,
    worldTime: turnIndex * 10,
    formattedTime: `第 ${turnIndex} 日`,
    type: "event",
    summary,
    ...(visibility !== undefined ? { visibility } : {}),
  };
}

const registry = createConditionRegistry();
const opts: TriggerOptions = { seed: 1, turnIndex: 9 };

describe("触发调用带上滚动历史（v2 §6.1 的 [4] recentTurns）", () => {
  it("填玩家可见的历史摘要，hidden 条目一律不进去", () => {
    const { state } = makeWorld();
    state.history = [
      historyEntry(1, "你在校门口拦下了他"),
      historyEntry(2, "教室里的帐落下来了"),
      historyEntry(3, "有人在暗处看着你", "hidden"),
    ];

    const [inv] = evaluateTriggers(state, rulesOf({ historyTurns: 20 }), registry, opts);
    expect(inv).toBeDefined();
    expect(inv?.context.recentTurns.map((t) => (t as { summary: string }).summary)).toEqual([
      "你在校门口拦下了他",
      "教室里的帐落下来了",
    ]);
    // 条目要带上轮次与时间：模型靠它把回顾排成时间顺序
    expect(inv?.context.recentTurns[0]).toMatchObject({ turnIndex: 1, time: "第 1 日", kind: "event" });
  });

  it("historyTurns 同时改 budget.recentTurns（否则编排层会按 6 条再切一次）", () => {
    const { state } = makeWorld();
    state.history = Array.from({ length: 10 }, (_, i) => historyEntry(i + 1, `第 ${i + 1} 件事`));

    const [recap] = evaluateTriggers(state, rulesOf({ historyTurns: 12 }), registry, opts);
    expect(recap?.budget.recentTurns).toBe(12);
    expect(recap?.context.recentTurns).toHaveLength(10);

    // 不声明时保持缺省窗口（6），不要顺手把所有模板的历史都放大
    const [plain] = evaluateTriggers(state, rulesOf({}), registry, opts);
    expect(plain?.budget.recentTurns).toBe(6);
    expect(plain?.context.recentTurns).toHaveLength(6);
  });

  it("mode / length 透传进 context（契约按体裁渲染的依据）", () => {
    const { state } = makeWorld();
    const [inv] = evaluateTriggers(
      state,
      rulesOf({ mode: "recap", length: { minChars: 320, maxChars: 760 } }),
      registry,
      opts,
    );
    expect(inv?.context.narrativeMode).toBe("recap");
    expect(inv?.context.narrativeLength).toEqual({ minChars: 320, maxChars: 760 });
  });
});
