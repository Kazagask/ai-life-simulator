import { describe, expect, it } from "vitest";
import {
  advanceTurnV2,
  chooseOptionV2,
  createRunnerContext,
  createWorldV2,
  handoff,
  runOpening,
  type TurnPipelineConfig,
} from "@life-sim/game-core";
import type { LlmInvocation } from "@life-sim/shared";
import { fixtureEntry } from "../helpers/world.ts";

describe("引擎组装 invocation：常驻 + 关键词命中 lore", () => {
  it("deferInvocation 时 pendingInvocation 带上 promptStyle 与筛选后的 lore", () => {
    const entry = fixtureEntry();
    const template = entry.template;
    const lookup = entry.lookup;
    const base = createWorldV2({ templateId: "p0", playerName: "L", seed: 1 }, template, "w-lore");
    const opening = entry.openings[0];
    expect(opening).toBeDefined();
    const runCtx = { ...createRunnerContext(base.seed), lookup };
    const opened = runOpening(base, opening!, runCtx);
    const state = handoff(opened.state, opened.run, lookup);

    advanceTurnV2(
      state,
      { action: { type: "patrol", description: "" } },
      template,
      lookup,
      createRunnerContext(state.seed),
    );

    let captured: LlmInvocation | undefined;
    const pipeline: TurnPipelineConfig = {
      rules: entry.rules,
      lore: entry.lore,
      deferInvocation: true,
      gateway: {
        invoke: async (inv) => {
          captured = inv;
          return { outcome: "deferred", invocationId: inv.invocationId };
        },
      },
    };
    chooseOptionV2(state, { optionId: "opt-go" }, template, lookup, pipeline);

    const pending = state.pendingInvocation;
    expect(pending).toBeDefined();
    expect(pending?.promptStyle).toContain("句子短");
    // 常驻 + 「开局」关键词命中（槽标题是「甲线开局」）
    expect(pending?.lore?.map((item) => item.id)).toEqual(["世界基调", "战斗规则"]);
    expect(captured).toBeUndefined(); // defer 交给编排层
  });
});
