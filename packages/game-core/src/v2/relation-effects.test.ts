import { describe, expect, it } from "vitest";
import type { Effect, WorldStateV2 } from "@life-sim/shared";
import { createRng } from "../rng.js";
import { applyEffectsV2, type EffectContextV2 } from "./engine.js";
import { createLookup } from "./lookup.js";
import { kinshipTerm } from "./relations.js";
import { createActiveWorldV2, makeTestTemplate } from "./test-utils.js";

/** 最小效果执行上下文（关系效果不读 rng/lookup，但契约要求存在）。 */
function ctxFor(state: WorldStateV2, selfNpcId?: string): EffectContextV2 {
  const template = makeTestTemplate();
  const ctx: EffectContextV2 = {
    state,
    lookup: createLookup(template),
    rng: createRng(1),
    ...(selfNpcId !== undefined ? { selfNpcId } : {}),
  };
  return ctx;
}

/** 夹具里补一个**非敌人**角色（createWorldV2 会把 isEnemy 角色排除出 state.npcs）。 */
function withNpcFixture(): ReturnType<typeof makeTestTemplate> {
  const template = makeTestTemplate();
  template.characters.push({
    id: "npc-a",
    isEnemy: false,
    visibility: "public",
    identity: { name: "测试乙", age: 17, gender: "f" },
    mood: { value: 60 },
    attributes: { cursedEnergy: 5, agility: 3, luck: 3 },
    skills: ["sk-strike"],
    public: { personality: "测试用" },
    private: { combatHints: { skillWeights: { "sk-strike": 1 } } },
    relationship: 0,
  });
  return template;
}

function freshState(worldId: string): WorldStateV2 {
  const template = withNpcFixture();
  const state = createActiveWorldV2({ templateId: "test", playerName: "测试者", seed: 7 }, template, worldId);
  state.relations = [];
  return state;
}

function run(state: WorldStateV2, effects: Effect[], selfNpcId?: string): void {
  applyEffectsV2(ctxFor(state, selfNpcId), effects);
}

describe("R2.6-T-B4 效果 DSL · adjustRelation 双形态", () => {
  it("旧形态（npcId）仍调整 NPC→玩家 标量，不受关系图影响", () => {
    const state = freshState("w-b4-legacy");
    const npc = state.npcs[0];
    const before = npc.relationship;
    run(state, [{ type: "adjustRelation", npcId: npc.id, value: 10 }]);
    expect(npc.relationship).toBe(Math.min(100, before + 10));
    expect(state.relations).toHaveLength(0); // 不改关系图
  });

  it("关系边形态：已存在边按增量调整并 clamp 到 [-100,100]", () => {
    const state = freshState("w-b4-edge");
    state.relations = [
      { from: "a", to: "b", kind: "friend", source: "template", visibility: "known", value: 50 },
    ];
    run(state, [{ type: "adjustRelation", fromId: "a", toId: "b", kind: "friend", value: 30 }]);
    expect(state.relations[0].value).toBe(80);
    run(state, [{ type: "adjustRelation", fromId: "a", toId: "b", kind: "friend", value: 50 }]);
    expect(state.relations[0].value).toBe(100); // 上限截断
  });

  it("关系边不存在时建边，visibility 缺省 unknown（不误建为 known）", () => {
    const state = freshState("w-b4-create");
    run(state, [{ type: "adjustRelation", fromId: "player", toId: "npc-x", kind: "friend", value: 12 }]);
    expect(state.relations).toHaveLength(1);
    const e = state.relations[0];
    expect(e).toMatchObject({
      from: "player",
      to: "npc-x",
      kind: "friend",
      source: "effect",
      visibility: "unknown",
      value: 12,
    });
  });

  it("__self__ 解析为当前行动 NPC", () => {
    const state = freshState("w-b4-self");
    run(state, [{ type: "adjustRelation", npcId: "__self__", value: 5 }], state.npcs[0].id);
    expect(state.npcs[0].relationship).toBeGreaterThan(0);

    run(
      state,
      [{ type: "adjustRelation", fromId: "__self__", toId: "player", kind: "mentor", value: 20 }],
      state.npcs[0].id,
    );
    expect(state.relations[0]).toMatchObject({ from: state.npcs[0].id, to: "player", kind: "mentor" });
  });

  it("配置自相矛盾时抛可诊断错误（不静默放过）", () => {
    const state = freshState("w-b4-invalid");
    // 两种形态都不完整：无 npcId 也无 toId
    expect(() => run(state, [{ type: "adjustRelation", value: 1 } as Effect])).toThrow(/npcId/);
    // 关系边形态缺 kind
    expect(() =>
      run(state, [{ type: "adjustRelation", fromId: "a", toId: "b", value: 1 } as Effect]),
    ).toThrow(/kind/);
  });
});

describe("R2.6-T-B4 效果 DSL · addRelationEdge / freezeRelationsOnDeath", () => {
  it("addRelationEdge 建边并可指定 visibility/gap/value", () => {
    const state = freshState("w-b4-add");
    run(state, [
      {
        type: "addRelationEdge",
        fromId: "a",
        toId: "b",
        kind: "father",
        visibility: "known",
        value: 70,
        gap: true,
      },
    ]);
    expect(state.relations[0]).toMatchObject({
      from: "a",
      to: "b",
      kind: "father",
      source: "effect",
      visibility: "known",
      value: 70,
      gap: true,
    });
  });

  it("addRelationEdge 重复声明同一 (from,to,kind) 合并而非重复，frozen 为单向棘轮", () => {
    const state = freshState("w-b4-merge");
    run(state, [
      { type: "addRelationEdge", fromId: "a", toId: "b", kind: "friend", value: 10 },
      { type: "addRelationEdge", fromId: "a", toId: "b", kind: "friend", value: 30 },
    ]);
    expect(state.relations).toHaveLength(1);
    expect(state.relations[0].value).toBe(30);

    // 冻结后再写入不得解冻
    run(state, [{ type: "freezeRelationsOnDeath", npcId: "b" }]);
    expect(state.relations[0].frozen).toBe(true);
    run(state, [{ type: "addRelationEdge", fromId: "a", toId: "b", kind: "friend", value: 40 }]);
    expect(state.relations[0].frozen).toBe(true);
  });

  it("freezeRelationsOnDeath 冻结相连边；冻结边不再被 adjustRelation 改动", () => {
    const state = freshState("w-b4-freeze");
    state.relations = [
      { from: "a", to: "b", kind: "father", source: "template", visibility: "known", value: 60 },
      { from: "b", to: "c", kind: "father", source: "template", visibility: "known", value: 60 },
      { from: "d", to: "e", kind: "friend", source: "template", visibility: "known", value: 20 },
    ];
    run(state, [{ type: "freezeRelationsOnDeath", npcId: "b" }]);
    expect(state.relations.map((e) => e.frozen === true)).toEqual([true, true, false]);

    run(state, [{ type: "adjustRelation", fromId: "a", toId: "b", kind: "father", value: 25 }]);
    expect(state.relations[0].value).toBe(60); // 冻结后不变

    // 未冻结的边照常可调
    run(state, [{ type: "adjustRelation", fromId: "d", toId: "e", kind: "friend", value: 25 }]);
    expect(state.relations[2].value).toBe(45);
  });

  it("冻结冻结不影响称谓推导：逝者仍是亲属", () => {
    const state = freshState("w-b4-freeze-kinship");
    run(state, [
      { type: "addRelationEdge", fromId: "player", toId: "toji", kind: "father", visibility: "known" },
      { type: "addRelationEdge", fromId: "toji", toId: "naobito", kind: "father", visibility: "known" },
      { type: "freezeRelationsOnDeath", npcId: "toji" },
    ]);
    expect(kinshipTerm(state.relations, "player", "naobito")?.term).toBe("爷爷");
  });
});
