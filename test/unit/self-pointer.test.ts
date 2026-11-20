import { describe, expect, it } from "vitest";
import { applyEffectsV2, checkAllConditions, createRng, createWorldV2, selfIdOf } from "@life-sim/game-core";
import { WorldStateV2Schema, type RelationEdge } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";
import { makeWorld } from "../helpers/world.ts";

const silent = { warn: () => {}, error: () => {}, info: () => {} };

/**
 * self 指针的三处收尾（ADR-001 D4，2026-11-19 核对）。
 *
 * ADR-001 把「玩家这个节点」的唯一权威定成 `state.selfId`（`state.player` 是它的实体），
 * 但归一只在**世界创建期**的声明边上做了。运行期还有两条路各自认死了 `"player"`：
 *
 * ① 关系**条件求值**：`{ relation, kind }` 的 `to` 缺省 `PLAYER_ID` ⇒ 扮演角色时
 *    永远匹配不到 `(X → selfId)` 那条边，条件恒假。
 * ② 关系**效果写边**：`addRelationEdge` / `adjustRelation` 的端点不归一 ⇒ 边挂在一个
 *    图上不存在的 `player` 节点上，投影按 `selfId` 找，找不到，也不报错。
 *
 * 这两条都不会报错，只会静默地「什么都不发生」——所以每个都得有一条用例钉住。
 */

const edge = (from: string, to: string, value: number): RelationEdge => ({
  from,
  to,
  kind: "mentor",
  source: "effect",
  scope: "public",
  value,
});

/** self 指向某个模板角色（扮演这个人的那一局）。 */
function playAs(characterId: string) {
  const { state, entry } = makeWorld();
  state.selfId = characterId;
  return { state, entry };
}

describe("self 指针：关系条件读的是当前 self", () => {
  const setScalar = (state: ReturnType<typeof playAs>["state"], npcId: string, value: number) => {
    const npc = state.npcs.find((n) => n.id === npcId);
    if (npc === undefined) throw new Error(`夹具缺 ${npcId}`);
    npc.relationship = value;
  };

  it("缺省 to = selfId：带 kind 的条件读的是「他视你多重」的标量", () => {
    const { state, entry } = makeWorld();
    // ADR-017 D1：端点是 self 的强度只住在标量里（边上不带 value）
    setScalar(state, "npc-friend", 60);

    const ok = checkAllConditions([{ relation: "npc-friend", kind: "mentor", gte: 50 }] as never, {
      state,
      lookup: entry.lookup,
      rng: createRng(1),
    });
    expect(ok).toBe(true);
  });

  it("同一条件在别的 self 下读的是同一个标量（强度属于「他」，不属于观察者）", () => {
    const { state, entry } = makeWorld();
    setScalar(state, "npc-friend", 10);

    const evalWith = (selfId?: string) =>
      checkAllConditions([{ relation: "npc-friend", kind: "mentor", gte: 50 }] as never, {
        state: selfId === undefined ? state : { ...state, selfId },
        lookup: entry.lookup,
        rng: createRng(1),
      });

    // 换 self 不改变「他视你多重」——那是同一个标量（10 < 50）
    expect(evalWith(undefined)).toBe(false);
    expect(evalWith("npc-other")).toBe(false);
  });

  it("显式 to 仍然指向指定的人（不是「所有端点都换成 self」）", () => {
    const { state, entry } = playAs("npc-friend");
    state.relations = [edge("npc-enemy", "npc-other", 80), edge("npc-enemy", "npc-friend", 0)];

    const ok = checkAllConditions(
      [{ relation: "npc-enemy", kind: "mentor", to: "npc-other", gte: 50 }] as never,
      { state, lookup: entry.lookup, rng: createRng(1) },
    );
    expect(ok).toBe(true);
  });
});

describe("self 指针：世界创建期的声明边", () => {
  it("指向 self 的声明边把强度折叠进标量，边上不再留 value", () => {
    // 真实模板 + 真实复用路径：扮演五条时，`to: player` 的声明边全部落到 npc-gojo，
    // 与原本就有的 `to: npc-gojo` 撞在同一个 (from,to,kind) 上。
    const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
    if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");

    const state = createWorldV2(
      { templateId: "jjk-2006", playerName: "五条悟", seed: 21, self: { kind: "reuse", characterId: "npc-gojo" } },
      entry.template,
      "w-self-relations",
    );

    expect(selfIdOf(state)).toBe("npc-gojo");
    const keys = state.relations.map((e) => `${e.from}->${e.to}:${e.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
    // 归一到同一条边，且**没有一条指向 self 的边带 value**（ADR-017 D1）
    expect(state.relations.filter((e) => e.to === "npc-gojo").every((e) => e.value === undefined)).toBe(true);

    // 强度没有丢：「夜蛾视五条为弟子 80」折叠到了夜蛾对你的标量上（原来是卡上的 8）
    const yaga = state.npcs.find((n) => n.id === "npc-yaga");
    expect(yaga?.relationship).toBe(80);
  });
});

describe("self 指针：效果写的关系边端点归一", () => {
  const apply = (state: ReturnType<typeof makeWorld>["state"], entry: ReturnType<typeof makeWorld>["entry"], effects: unknown[]) =>
    applyEffectsV2({ state, lookup: entry.lookup, rng: createRng(3) }, effects as never);

  it("addRelationEdge 写 toId: player ⇒ 落成当前 self", () => {
    const { state, entry } = playAs("npc-friend");
    expect(selfIdOf(state)).toBe("npc-friend");

    apply(state, entry, [
      { type: "addRelationEdge", fromId: "npc-enemy", toId: "player", kind: "mentor", scope: "public", value: 40 },
    ]);

    expect(state.relations.map((e) => `${e.from}->${e.to}`)).toEqual(["npc-enemy->npc-friend"]);
  });

  it("addRelationEdge 写 fromId: player ⇒ 也从当前 self 出发", () => {
    const { state, entry } = playAs("npc-friend");
    apply(state, entry, [
      { type: "addRelationEdge", fromId: "player", toId: "npc-enemy", kind: "disciple", scope: "public", value: 40 },
    ]);

    expect(state.relations.map((e) => `${e.from}->${e.to}`)).toEqual(["npc-friend->npc-enemy"]);
  });

  it("两端都写 player ⇒ 归一后成自环，直接不写（自环存档载不回来）", () => {
    const { state, entry } = playAs("npc-friend");
    apply(state, entry, [
      { type: "addRelationEdge", fromId: "player", toId: "player", kind: "mentor", scope: "public", value: 40 },
    ]);

    expect(state.relations).toHaveLength(0);
  });

  it("adjustRelation 的边形态同样归一：端点落 self 时强度写进标量，不建幽灵边", () => {
    const { state, entry } = makeWorld();
    const before = state.npcs.find((n) => n.id === "npc-friend")?.relationship ?? 0;

    apply(state, entry, [
      { type: "adjustRelation", fromId: "npc-friend", toId: "player", kind: "mentor", value: 15 },
    ]);

    // 端点归一成 player（= selfId），没有 from=npc-friend / to=player 字面量之外的幽灵边
    const toSelf = state.relations.filter((e) => e.from === "npc-friend" && e.to === "player");
    expect(toSelf).toHaveLength(1);
    // ADR-017 D1：强度落在标量上，边上不带 value
    expect(toSelf[0]?.value).toBeUndefined();
    expect(state.npcs.find((n) => n.id === "npc-friend")?.relationship).toBe(before + 15);
  });

  /**
   * `limited` 没有名单，`RelationEdgeSchema` 会拒收 —— 效果若照原样写进去，
   * 这一局就再也载不回来（与自环同一类 P0）。写入口降级成 `private`（最严的一档），
   * 作者该看到的报错在模板加载期，不在这里。
   */
  it("effect 写 scope: limited 却没有 knownBy ⇒ 落库降级 private，存档仍可载", () => {
    const { state, entry } = playAs("npc-friend");
    apply(state, entry, [
      { type: "addRelationEdge", fromId: "npc-enemy", toId: "player", kind: "mentor", scope: "limited", value: 40 },
    ]);

    expect(state.relations[0]?.scope).toBe("private");
    expect(WorldStateV2Schema.safeParse(state).success).toBe(true);
  });
});
