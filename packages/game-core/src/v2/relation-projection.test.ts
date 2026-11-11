import { describe, expect, it } from "vitest";
import type { Condition, RelationEdge, WorldStateV2 } from "@life-sim/shared";
import { checkAllConditions } from "./engine.js";
import { createLookup } from "./lookup.js";
import { projectSnapshotV2 } from "./projection.js";
import { createRng } from "../rng.js";
import { createActiveWorldV2, makeTestTemplate } from "./test-utils.js";

function buildWorld(worldId: string, relations: RelationEdge[]) {
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
  });
  const state = createActiveWorldV2(
    { templateId: "test", playerName: "测试者", seed: 7 },
    template,
    worldId,
  );
  state.relations = relations;
  const lookup = createLookup(template);
  return { state, template, lookup };
}

function e(from: string, to: string, kind: RelationEdge["kind"], extra: Partial<RelationEdge> = {}): RelationEdge {
  return { from, to, kind, source: "template", visibility: "known", ...extra };
}

describe("R2.6-T-B5 投影 · 关系可见性（R-OP-05）", () => {
  it("只投影 known / inferred 边，unknown 与 hidden 不出现", () => {
    const { state, template, lookup } = buildWorld("w-b5-vis", [
      e("npc-a", "player", "mentor", { visibility: "known", value: 60 }),
      e("npc-a", "enemy-x", "friend", { visibility: "inferred" }),
      e("npc-a", "ghost", "friend", { visibility: "unknown" }),
      e("npc-a", "shadow", "enemy", { visibility: "hidden" }),
    ]);
    const view = projectSnapshotV2(state, template, lookup);
    const npc = view.npcs.find((n) => n.id === "npc-a")!;
    expect(npc.relations.map((r) => r.withId).sort()).toEqual(["enemy-x", "player"]);
    // 旧标量照常投影
    expect(npc.relationship).toBe(20);
  });

  it("hidden 边不构成称谓侧信道：不可见路径不参与推导", () => {
    const { state, template, lookup } = buildWorld("w-b5-leak", [
      e("player", "npc-a", "father", { visibility: "known" }), // 玩家→甲：爸爸（可见）
      e("npc-a", "secret-dad", "father", { visibility: "hidden" }), // 甲→隐秘父（隐藏）
    ]);
    const view = projectSnapshotV2(state, template, lookup);
    const npc = view.npcs.find((n) => n.id === "npc-a")!;
    // 仅可见边进投影，hidden 目标绝不出现
    expect(npc.relations.map((r) => r.withId)).toEqual(["player"]);
    expect(JSON.stringify(view)).not.toContain("secret-dad");
    // 反向边（player→npc-a）不强行反推称谓
    expect(npc.relations[0].direction).toBe("in");
    expect(npc.relations[0].kinshipTerm).toBeUndefined();
  });

  it("可见的有向亲属边给出确定性中文称谓", () => {
    const { state, template, lookup } = buildWorld("w-b5-term", [
      e("npc-a", "player", "father", { visibility: "known" }),
      e("player", "npc-a", "father", { visibility: "known" }),
    ]);
    const view = projectSnapshotV2(state, template, lookup);
    const npc = view.npcs.find((n) => n.id === "npc-a")!;
    const out = npc.relations.find((r) => r.direction === "out" && r.withId === "player")!;
    const inbound = npc.relations.find((r) => r.direction === "in" && r.withId === "player")!;
    expect(out.kinshipTerm).toBe("爸爸");
    expect(inbound.kinshipTerm).toBeUndefined();
  });

  it("无关系边时投影为空数组（不报错、不缺字段）", () => {
    const { state, template, lookup } = buildWorld("w-b5-empty", []);
    const view = projectSnapshotV2(state, template, lookup);
    expect(view.npcs.every((n) => Array.isArray(n.relations) && n.relations.length === 0)).toBe(true);
  });
});

describe("R2.6-T-B5 条件 DSL · 关系边形态", () => {
  function ctxOf(state: WorldStateV2) {
    const template = makeTestTemplate();
    return { state, lookup: createLookup(template), rng: createRng(1) };
  }

  it("声明 kind 时读边值，to 缺省为玩家", () => {
    const { state } = buildWorld("w-b5-cond", [
      e("npc-a", "player", "mentor", { value: 55 }),
    ]);
    const ctx = ctxOf(state);
    expect(checkAllConditions([{ relation: "npc-a", kind: "mentor", gte: 50 } as Condition], ctx)).toBe(true);
    expect(checkAllConditions([{ relation: "npc-a", kind: "mentor", gte: 60 } as Condition], ctx)).toBe(false);
    expect(checkAllConditions([{ relation: "npc-a", kind: "mentor", lte: 60 } as Condition], ctx)).toBe(true);
  });

  it("边不存在时值为 0（不抛错）", () => {
    const { state } = buildWorld("w-b5-cond2", []);
    const ctx = ctxOf(state);
    expect(checkAllConditions([{ relation: "npc-a", kind: "mentor", lte: 0 } as Condition], ctx)).toBe(true);
    expect(checkAllConditions([{ relation: "npc-a", kind: "mentor", gte: 1 } as Condition], ctx)).toBe(false);
  });

  it("旧形态（无 kind）仍读 npc.relationship 标量", () => {
    const { state } = buildWorld("w-b5-cond3", [
      // 边值与标量故意不同：确认取的是标量
      e("npc-a", "player", "friend", { value: 100 }),
    ]);
    const ctx = ctxOf(state);
    expect(checkAllConditions([{ relation: "npc-a", gte: 10 } as Condition], ctx)).toBe(true);
    expect(checkAllConditions([{ relation: "npc-a", gte: 50 } as Condition], ctx)).toBe(false);
  });

  it("指定 to 时读 NPC↔NPC 边", () => {
    const { state } = buildWorld("w-b5-cond4", [e("npc-a", "enemy-x", "enemy", { value: -80 })]);
    const ctx = ctxOf(state);
    expect(
      checkAllConditions([{ relation: "npc-a", to: "enemy-x", kind: "enemy", lte: -50 } as Condition], ctx),
    ).toBe(true);
  });
});
