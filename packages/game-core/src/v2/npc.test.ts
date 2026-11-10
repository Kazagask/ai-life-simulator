import { describe, expect, it } from "vitest";
import type { WorldTemplateV2 } from "@life-sim/shared";
import { advanceTurnV2, createWorldV2 } from "./turn.js";
import { createLookup } from "./lookup.js";

function makeTemplate(overrides?: Partial<WorldTemplateV2>): WorldTemplateV2 {
  const base: WorldTemplateV2 = {
    meta: { id: "t", name: "NPC测试", description: "d", startYear: 2000, engineProtocol: "v2" },
    time: { defaultStep: { value: 1, unit: "day" } },
    genders: [{ id: "f", label: "女" }],
    mood: {
      min: 0,
      max: 100,
      defaultValue: 60,
      bands: [{ id: "normal", label: "平静", min: 0, max: 100, attributeModifiers: {} }],
    },
    statusBar: [{ id: "sb1", label: "基本", source: "identity" }],
    attributes: { order: ["str"], defaults: { str: 5 } },
    resources: {
      hp: { base: 100, perLevel: 0 },
      mp: { base: 50, perLevel: 0 },
    },
    regen: { perTurn: { hp: 0, mp: 0 } },
    checks: {},
    characters: [],
    skills: [],
    items: [],
    statuses: [],
    events: [],
  };
  return { ...base, ...overrides };
}

const npcChar = {
  id: "npc-gojo",
  isEnemy: false,
  visibility: "public" as const,
  identity: { name: "五条", age: 28, gender: "f" },
  mood: { value: 70 },
  attributes: { str: 10 },
  public: { personality: "轻浮", knownGoals: ["培养弟子"] },
  private: { goals: ["become-stronger"], traits: ["diligent"], knowledge: ["cursed-energy"] },
  relationship: 0,
};

function makeState(actions: WorldTemplateV2["npcActions"]) {
  const template = makeTemplate({ characters: [npcChar], npcActions: actions });
  const lookup = createLookup(template);
  const state = createWorldV2({ templateId: "t", playerName: "测试者", seed: 1 }, template, "w1");
  return { state, template, lookup };
}

describe("NPC 自主行动 · 触发式 + 效用评分", () => {
  it("满足条件时执行行动并写入历史", () => {
    const { state, template, lookup } = makeState([
      {
        id: "npc-train",
        summary: "{name} 独自修炼。",
        trigger: { probability: 1 },
        utility: { base: 1 },
        effects: [{ type: "setFlag", id: "npcTrained", value: true }],
      },
    ]);
    advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(state.flags.npcTrained).toBe(true);
    const npcEntry = state.history.find((h) => h.type === "npc_action");
    expect(npcEntry?.summary).toContain("五条");
  });

  it("效用评分：目标匹配的行动胜出", () => {
    const { state, template, lookup } = makeState([
      {
        id: "npc-train",
        summary: "{name} 修炼。",
        trigger: { probability: 1 },
        utility: { base: 1, goalMatch: ["become-stronger"] },
        effects: [{ type: "setFlag", id: "trained", value: true }],
      },
      {
        id: "npc-idle",
        summary: "{name} 闲逛。",
        trigger: { probability: 1 },
        utility: { base: 1 },
        effects: [{ type: "setFlag", id: "idle", value: true }],
      },
    ]);
    advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    // 目标命中 +1，稳定超过 base 候选的随机抖动
    expect(state.flags.trained).toBe(true);
    expect(state.flags.idle).toBeUndefined();
  });

  it("信息差：requireKnowledge 不满足则不执行", () => {
    const { state, template, lookup } = makeState([
      {
        id: "npc-domain",
        summary: "{name} 展开领域。",
        trigger: { probability: 1, requireKnowledge: ["domain-expansion"] },
        utility: { base: 1 },
        effects: [{ type: "setFlag", id: "domain", value: true }],
      },
    ]);
    advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(state.flags.domain).toBeUndefined();
    expect(state.history.some((h) => h.type === "npc_action")).toBe(false);
  });

  it("冷却：cooldownTurns 内不重复执行", () => {
    const { state, template, lookup } = makeState([
      {
        id: "npc-train",
        summary: "{name} 修炼。",
        trigger: { probability: 1, cooldownTurns: 2 },
        utility: { base: 1 },
        effects: [{ type: "adjustFlag", id: "trainCount", value: 1 }],
      },
    ]);
    advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(state.flags.trainCount).toBe(1);
    // 下一轮仍在冷却（2 - 1 < 2），不执行
    advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(state.flags.trainCount).toBe(1);
  });

  it("兜底随机：probability 控制触发", () => {
    const { state, template, lookup } = makeState([
      {
        id: "npc-train",
        summary: "{name} 修炼。",
        trigger: { probability: 0 },
        utility: { base: 1 },
        effects: [{ type: "setFlag", id: "trained", value: true }],
      },
    ]);
    advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(state.flags.trained).toBeUndefined();
  });

  it("__self__ 占位符修改 NPC 与玩家的关系", () => {
    const { state, template, lookup } = makeState([
      {
        id: "npc-befriend",
        summary: "{name} 主动示好。",
        trigger: { probability: 1 },
        utility: { base: 1 },
        effects: [{ type: "adjustRelation", npcId: "__self__", value: 10 }],
      },
    ]);
    advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(state.npcs.find((n) => n.id === "npc-gojo")?.relationship).toBe(10);
  });
});
