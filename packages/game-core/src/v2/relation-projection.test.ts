import { describe, expect, it } from "vitest";
import type { Condition, RelationEdge, WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
import { checkAllConditions } from "./engine.js";
import { createLookup } from "./lookup.js";
import { projectSnapshotV2 } from "./projection.js";
import { createRng } from "../rng.js";
import { createActiveWorldV2, makeTestTemplate } from "./test-utils.js";

/** 追加一个最小非敌人角色（与既有 npc-a 同形，不含关系声明）。 */
function addCharacter(template: WorldTemplateV2, id: string, name: string, relationship: number) {
  template.characters.push({
    id,
    isEnemy: false,
    visibility: "public",
    identity: { name, age: 17, gender: "f" },
    mood: { value: 60 },
    attributes: { cursedEnergy: 5, agility: 3, luck: 3 },
    skills: ["sk-strike"],
    public: { personality: "测试用" },
    private: { combatHints: { skillWeights: { "sk-strike": 1 } } },
    relationship,
  });
}

/**
 * `unspawned` 里的角色由 `npcSpawnRules` 管辖 ⇒ 建世界期 `lifecycle.state = "unspawned"`
 * （走真实路径，不手改实例；ADR-0022 决策 4）。
 */
function buildWorld(worldId: string, relations: RelationEdge[], unspawned: string[] = []) {
  const template = makeTestTemplate();
  addCharacter(template, "npc-a", "测试甲", 20);
  addCharacter(template, "npc-b", "测试乙", 15);
  for (const id of unspawned) addCharacter(template, id, `未登场-${id}`, 0);
  if (unspawned.length > 0) {
    template.npcSpawnRules = unspawned.map((id) => ({ id: `rule-${id}`, characterRef: id, age: 10 }));
  }
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

describe("ADR-0022 补记 D-1 · 关系投影剔除未登场端点", () => {
  it("未登场端点：已上屏 NPC 与 unspawned 之间的边不进前者的 relations", () => {
    const { state, template, lookup } = buildWorld(
      "w-d1-hidden",
      [e("npc-a", "npc-hidden", "friend"), e("npc-hidden", "npc-a", "friend")],
      ["npc-hidden"],
    );
    const view = projectSnapshotV2(state, template, lookup);
    const npc = view.npcs.find((n) => n.id === "npc-a")!;
    // 出边与入边都剔除：一端未登场即整条边不可见
    expect(npc.relations).toEqual([]);
    // 未登场角色本身不上屏，开发者 id 不外泄
    expect(view.npcs.some((n) => n.id === "npc-hidden")).toBe(false);
    expect(JSON.stringify(view)).not.toContain("npc-hidden");
    // 决策 5：只动投影期 ⇒ state 层边原样保留（旧档零迁移、引擎侧条件仍可读）
    expect(state.relations).toHaveLength(2);
  });

  it("称谓不跨未登场节点：既不出行，也不得用「远亲」兜底（决策 4）", () => {
    const { state, template, lookup } = buildWorld(
      "w-d1-term",
      [
        // 旧实现：这条 gap 边会出一行并渲染成「远亲」，同时把 npc-hidden 打到面板上
        e("npc-a", "npc-hidden", "relative", { gap: true }),
        // A 与 B 的唯一亲属路径 = a → npc-hidden → b（两跳都落在未登场子图上）
        e("npc-hidden", "npc-b", "father"),
        // 合法可见边：证明过滤不是把 relations 整体清空
        e("npc-a", "player", "disciple"),
      ],
      ["npc-hidden"],
    );
    const view = projectSnapshotV2(state, template, lookup);
    const npc = view.npcs.find((n) => n.id === "npc-a")!;
    expect(npc.relations.map((r) => r.withId)).toEqual(["player"]);
    // 无行：A 与 B 只在「经未登场 C」的图上连通
    expect(npc.relations.some((r) => r.withId === "npc-b")).toBe(false);
    // 无称谓：不可达 ⇒ kinshipTerm 为 null，且**禁止**用「远亲」兜底
    expect(npc.relations.every((r) => r.kinshipTerm === undefined)).toBe(true);
    expect(JSON.stringify(view)).not.toContain("远亲");
    expect(JSON.stringify(view)).not.toContain("npc-hidden");
  });

  it("player 与敌人端点必须保留（判据是「确知未登场」，不是「不在上屏集合内」）", () => {
    const { state, template, lookup } = buildWorld(
      "w-d1-keep",
      [
        e("npc-a", "player", "mentor"),
        e("npc-a", "enemy-x", "enemy"),
        // 无关的未登场边：它的存在不得连带误杀上面两条公开信息
        e("npc-hidden", "npc-a", "friend"),
        // inactive 照常保留边与称谓（决策 1 反例 2：逝去的祖父依旧是祖父）
        e("npc-b", "player", "father"),
      ],
      ["npc-hidden"],
    );
    state.npcs.find((n) => n.id === "npc-b")!.lifecycle.state = "inactive";
    const view = projectSnapshotV2(state, template, lookup);
    const npc = view.npcs.find((n) => n.id === "npc-a")!;
    // 与 `["enemy-x","player"]` 正向断言同向：敌人永不实例化、player 无 NPC 实例 ⇒ 都不 hidden
    expect(npc.relations.map((r) => r.withId).sort()).toEqual(["enemy-x", "player"]);
    // inactive 不因「不再自主行动」而被剔除
    const b = view.npcs.find((n) => n.id === "npc-b")!;
    expect(b.lifecycle.state).toBe("inactive");
    expect(b.relations.map((r) => r.withId)).toEqual(["player"]);
    expect(b.relations[0].kinshipTerm).toBe("爸爸");
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
