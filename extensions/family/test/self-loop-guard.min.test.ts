import { describe, expect, it } from "vitest";
import { WorldStateV2Schema } from "@life-sim/shared";
import {
  applyEffectsV2,
  createActiveWorldV2,
  createLookup,
  createRunnerContext,
  makeTestTemplate,
} from "@life-sim/game-core";

/**
 * 自环边的运行期守卫（已知缺陷，P0）。
 *
 * `RelationEdgeSchema.superRefine` 明确拒绝 `from === to`（见 schema/relation.ts），
 * 但 `applyEffectsV2` 的 `adjustRelation` / `addRelationEdge` 直接写数组，不经过 schema。
 * 后果不是显示难看，是**存档读不回来**：世界落盘时 `WorldStateV2Schema.parse`
 * 会在 relations 上失败，这一局再也载入不了。
 *
 * 这两条断言与任何剧本无关，只用最小测试模板 —— 原来它挂在 `stress-lineage` 上，
 * 模板删掉后移到这里，避免这条 P0 随模板一起消失。
 */

const template = makeTestTemplate();

function newState() {
  return createActiveWorldV2(
    { templateId: template.meta.id, playerName: "测", seed: 1 },
    template,
    "self-loop-1",
  );
}

describe("自环边", () => {
  it("schema 层拒绝自环（这条是稳定的判据）", () => {
    const bad = {
      from: "enemy-x",
      to: "enemy-x",
      kind: "wife" as const,
      source: "effect" as const,
      visibility: "known" as const,
      value: 0,
    };
    const parsed = WorldStateV2Schema.shape.relations.element.safeParse(bad);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain("自环");
  });

  it.fails("运行时应当拒绝把节点连到自己（P0：修好之前这条会一直红着）", () => {
    const state = newState();
    applyEffectsV2(
      { state, lookup: createLookup(template), rng: createRunnerContext(1).rng },
      [{ type: "adjustRelation", fromId: "enemy-x", toId: "enemy-x", kind: "wife", value: 10 }],
    );
    const selfLoops = state.relations.filter((e) => e.from === e.to);
    // 期望：效果层丢弃自环（可记日志），权威状态里不留非法边。
    expect(selfLoops).toHaveLength(0);
    // 顺带证明后果：只要留下自环，整局存档就通不过校验。
    expect(WorldStateV2Schema.safeParse(state).success).toBe(true);
  });
});
