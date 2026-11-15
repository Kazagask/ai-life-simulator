import { describe, expect, it } from "vitest";
import type { WorldTemplateV2 } from "@life-sim/shared";
import { applyEffectsV2, checkCondition } from "./engine.js";
import { createLookup } from "./lookup.js";
import { runNpcActionsV2 } from "./npc.js";
import { projectSnapshotV2 } from "./projection.js";
import { createRng } from "../rng.js";
import { createActiveWorldV2, makeTestTemplate } from "./test-utils.js";

/**
 * ADR-0012 决策 1/2/3 的落地验证（ADR-0020）。
 * 三态只有 alive 参与判定；reasonCode 只是自由字符串，引擎不得对它分支。
 */
function buildWorld(worldId: string, initial?: { state: "alive" | "inactive" | "unspawned"; reasonCode?: string }) {
  const template = makeTestTemplate();
  template.characters.push({
    id: "npc-a",
    isEnemy: false,
    visibility: "public",
    identity: { name: "测试甲", age: 17, gender: "f" },
    mood: { value: 60 },
    attributes: { cursedEnergy: 5, agility: 3, luck: 3 },
    skills: ["sk-strike"],
    public: { personality: "测试用" },
    private: { combatHints: { skillWeights: { "sk-strike": 1 } } },
    relationship: 20,
    ...(initial ? { lifecycle: initial } : {}),
  } as WorldTemplateV2["characters"][number]);
  const state = createActiveWorldV2(
    { templateId: "test", playerName: "测试者", seed: 7 },
    template,
    worldId,
  );
  return { state, template, lookup: createLookup(template) };
}

describe("V2 生命周期（ADR-0012 / ADR-0020）", () => {
  it("默认判活：模板不声明 lifecycle 时 NPC 即在世，sinceTurn/sinceWorldTime 为 0", () => {
    const { state } = buildWorld("w-life-1");
    const npc = state.npcs.find((n) => n.id === "npc-a")!;
    expect(npc.lifecycle).toEqual({ state: "alive", sinceTurn: 0, sinceWorldTime: 0 });
  });

  it("模板可声明初始非在世（如开局已故的角色），reasonCode 原样保留", () => {
    const { state } = buildWorld("w-life-2", { state: "inactive", reasonCode: "开局前已阵亡" });
    const npc = state.npcs.find((n) => n.id === "npc-a")!;
    expect(npc.lifecycle.state).toBe("inactive");
    expect(npc.lifecycle.reasonCode).toBe("开局前已阵亡");
  });

  it("setNpcLifecycle 改状态并记录 since；未知 npcId 抛可诊断错误", () => {
    const { state, lookup } = buildWorld("w-life-3");
    const rng = createRng(1);
    applyEffectsV2({ state, lookup, rng, logs: [] }, [
      { type: "setNpcLifecycle", npcId: "npc-a", state: "inactive", reasonCode: "阵亡" },
    ]);
    const npc = state.npcs.find((n) => n.id === "npc-a")!;
    expect(npc.lifecycle.state).toBe("inactive");
    expect(npc.lifecycle.reasonCode).toBe("阵亡");
    expect(npc.lifecycle.sinceTurn).toBe(state.turnIndex);

    expect(() =>
      applyEffectsV2({ state, lookup, rng, logs: [] }, [
        { type: "setNpcLifecycle", npcId: "npc-ghost", state: "inactive" },
      ]),
    ).toThrow(/未知 NPC/);
  });

  it("inactive 的 NPC 不再进入自主行动候选（模板零书写）", () => {
    const { state, template, lookup } = buildWorld("w-life-4");
    template.npcActions = [
      { id: "act-1", summary: "{name} 四处走动", trigger: { probability: 1 }, utility: { base: 1 }, effects: [] },
    ] as WorldTemplateV2["npcActions"];
    state.turnIndex = 5;

    const alive = runNpcActionsV2(state, lookup, createRng(3));
    expect(alive.summaries.length).toBe(1);

    state.turnIndex = 7;
    state.npcs.find((n) => n.id === "npc-a")!.lifecycle.state = "inactive";
    const dead = runNpcActionsV2(state, lookup, createRng(3));
    expect(dead.summaries).toEqual([]);
  });

  it("非在世 NPC 的关系写入冻结（标量与边都挡），复活不解冻", () => {
    const { state, lookup } = buildWorld("w-life-5");
    const rng = createRng(2);
    const npc = state.npcs.find((n) => n.id === "npc-a")!;
    state.relations = [{ from: "npc-a", to: "player", kind: "friend", source: "template", visibility: "known", value: 10 }];
    const before = npc.relationship;

    applyEffectsV2({ state, lookup, rng, logs: [] }, [
      { type: "setNpcLifecycle", npcId: "npc-a", state: "inactive", reasonCode: "失踪" },
    ]);
    // setNpcLifecycle 本身已把相连边冻结
    expect(state.relations[0].frozen).toBe(true);

    applyEffectsV2({ state, lookup, rng, logs: [] }, [
      { type: "adjustRelation", npcId: "npc-a", value: 30 },
      { type: "adjustRelation", fromId: "npc-a", toId: "player", kind: "friend", value: 30 },
      { type: "addRelationEdge", fromId: "npc-a", toId: "player", kind: "rival" },
    ]);
    expect(npc.relationship).toBe(before);
    expect(state.relations[0].value).toBe(10);
    expect(state.relations.some((e) => e.kind === "rival")).toBe(false);

    // 复活不解冻（单向棘轮）
    applyEffectsV2({ state, lookup, rng, logs: [] }, [
      { type: "setNpcLifecycle", npcId: "npc-a", state: "alive" },
    ]);
    expect(state.relations[0].frozen).toBe(true);
  });

  it("npcState 条件只匹配状态，不匹配 reasonCode", () => {
    const { state, lookup } = buildWorld("w-life-6", { state: "inactive", reasonCode: "阵亡" });
    const ctx = { state, lookup, rng: createRng(1) };
    expect(checkCondition({ npcState: { npcId: "npc-a", state: "inactive" } }, ctx)).toBe(true);
    expect(checkCondition({ npcState: { npcId: "npc-a", state: "alive" } }, ctx)).toBe(false);
    // 未知 npcId 一律 false，不猜测
    expect(checkCondition({ npcState: { npcId: "npc-ghost", state: "alive" } }, ctx)).toBe(false);
  });

  it("投影透出 lifecycle（inactive 照常上屏），不泄露其他私有字段", () => {
    const { state, template, lookup } = buildWorld("w-life-7", { state: "inactive", reasonCode: "阵亡" });
    const view = projectSnapshotV2(state, template, lookup);
    const npc = view.npcs.find((n) => n.id === "npc-a")!;
    expect(npc.lifecycle.state).toBe("inactive");
    expect(npc.lifecycle.reasonCode).toBe("阵亡");
    expect(JSON.stringify(view)).not.toContain("sk-strike 的秘密");
  });
});
