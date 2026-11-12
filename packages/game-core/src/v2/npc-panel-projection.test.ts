import { describe, expect, it } from "vitest";
import { projectSnapshotV2 } from "./projection.js";
import { createLookup } from "./lookup.js";
import { createActiveWorldV2, makeTestTemplate } from "./test-utils.js";

/**
 * ADR-0019：NPC 面板需要「关系 / 状态 / 生命周期」三块。
 * 这里钉两件事：
 * 1. 状态只透 visibility=known 的定义（hidden/unknown 不得成为侧信道）；
 * 2. 人生阶段由年龄按模板阶段表推导，与玩家同一口径。
 */
function buildWorld(worldId: string, npcAge: number) {
  const template = makeTestTemplate();
  template.characters.push({
    id: "npc-a",
    isEnemy: false,
    visibility: "public",
    identity: { name: "测试甲", age: npcAge, gender: "f" },
    mood: { value: 60 },
    attributes: { cursedEnergy: 5, agility: 3, luck: 3 },
    skills: ["sk-strike"],
    public: { personality: "测试用" },
    private: { combatHints: { skillWeights: { "sk-strike": 1 } } },
    relationship: 20,
  });
  // 隐藏补正：只存在于模板与实例，不得进投影
  template.statuses.push({
    id: "secret-mark",
    name: "秘密烙印",
    duration: { turns: 3 },
    stacking: "refresh",
    combat: {},
    visibility: "hidden",
  });
  const state = createActiveWorldV2(
    { templateId: "test", playerName: "测试者", seed: 7 },
    template,
    worldId,
  );
  const lookup = createLookup(template);
  const npc = state.npcs.find((n) => n.id === "npc-a");
  if (!npc) throw new Error("夹具里没有 npc-a");
  npc.statuses = [
    { statusId: "inj", stacks: 2, appliedTurn: 1 },
    { statusId: "secret-mark", stacks: 1, appliedTurn: 1 },
  ];
  return { state, template, lookup };
}

describe("V2 投影 · NPC 面板字段（ADR-0019）", () => {
  it("NPC 状态只透 known 定义，hidden 补正不进投影也不留名字", () => {
    const { state, template, lookup } = buildWorld("w-npc-panel-1", 17);
    const view = projectSnapshotV2(state, template, lookup);
    const npc = view.npcs.find((n) => n.id === "npc-a");
    expect(npc).toBeDefined();
    expect(npc!.statuses).toEqual([{ id: "inj", name: "轻伤", stacks: 2 }]);
    // hidden 补正既不出现在数组里，也不应留下任何字符串痕迹
    expect(JSON.stringify(view)).not.toContain("secret-mark");
    expect(JSON.stringify(view)).not.toContain("秘密烙印");
  });

  it("NPC 人生阶段按年龄推导（与玩家同口径），并带显示标签", () => {
    const young = buildWorld("w-npc-panel-2", 17);
    const youngView = projectSnapshotV2(young.state, young.template, young.lookup);
    const youngNpc = youngView.npcs.find((n) => n.id === "npc-a")!;
    expect(youngNpc.lifeStage).toBe("youth");
    expect(typeof youngNpc.lifeStageLabel).toBe("string");
    expect(youngNpc.lifeStageLabel.length).toBeGreaterThan(0);

    const child = buildWorld("w-npc-panel-3", 8);
    const childView = projectSnapshotV2(child.state, child.template, child.lookup);
    expect(childView.npcs.find((n) => n.id === "npc-a")!.lifeStage).toBe("childhood");

    const elder = buildWorld("w-npc-panel-4", 70);
    const elderView = projectSnapshotV2(elder.state, elder.template, elder.lookup);
    expect(elderView.npcs.find((n) => n.id === "npc-a")!.lifeStage).toBe("elderhood");
  });

  it("无补正时给空数组，不伪造状态", () => {
    const { state, template, lookup } = buildWorld("w-npc-panel-5", 17);
    const npc = state.npcs.find((n) => n.id === "npc-a")!;
    npc.statuses = [];
    const view = projectSnapshotV2(state, template, lookup);
    expect(view.npcs.find((n) => n.id === "npc-a")!.statuses).toEqual([]);
  });
});
