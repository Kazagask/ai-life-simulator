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
 * 自环边的运行期守卫。
 *
 * `RelationEdgeSchema.superRefine` 明确拒绝 `from === to`（见 schema/relation.ts），
 * 而 `applyEffectsV2` 的 `adjustRelation` / `addRelationEdge` 直接写数组，不经过 schema。
 * 后果不是显示难看，是**存档读不回来**：世界落盘时 `WorldStateV2Schema.parse`
 * 会在 relations 上失败，这一局再也载入不了。
 *
 * 2026-11-19：这条 P0 **已修**。做法不是在效果里加一句「不许自环」，而是端点归一的
 * 副产品 —— 幂等规则「写 `player` 就是写当前 self」（`normalizeRelationEndpoint`）
 * 会把 `from` 与 `to` 都指向 self 的那条边归一成自环，于是在写入口顺手丢弃。
 * 因为这条路径以前是 `it.fails`（红着），改成普通用例就是回归信号：
 * 谁把归一去掉，这条会立刻变红。
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
      scope: "public" as const,
      value: 0,
    };
    const parsed = WorldStateV2Schema.shape.relations.element.safeParse(bad);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain("自环");
  });

  it("运行时也拒绝把节点连到自己（P0 已修，2026-11-19）", () => {
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
