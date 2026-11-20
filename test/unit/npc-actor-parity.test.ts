import { describe, expect, it } from "vitest";
import {
  ACTOR_FIELD_GROUPS,
  advanceTurnV2,
  applyEffectsV2,
  createRng,
  createRunnerContext,
  createWorldV2,
  effectiveAttributesOfActor,
  transplantActor,
  writableActorOf,
  type WorldStateV2,
} from "@life-sim/game-core";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * 演员同构与能力流转（ADR-010）。
 *
 * 这一组守的是审计出来的十项不对称里最容易复发的那几项：
 * 物品/状态/技能只能给玩家、NPC 的装备词条从不参与数值、以及
 * 「NPC 想变强只能再造一张角色卡」。每一条都是既有 bug，不是新功能。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };
const DAY = 1440;

function loadEntry() {
  const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

function newWorld(seed = 21) {
  const entry = loadEntry();
  const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed }, entry.template, `w-parity-${seed}`);
  state.openingCompleted = true;
  return { state, entry };
}

function npc(state: WorldStateV2, id: string) {
  const found = state.npcs.find((n) => n.id === id);
  if (found === undefined) throw new Error(`夹具里没有 ${id}`);
  return found;
}

function run(state: WorldStateV2, entry: ReturnType<typeof loadEntry>, effects: unknown[]) {
  applyEffectsV2(
    { state, lookup: entry.lookup, rng: createRng(7), logs: [] },
    effects as Parameters<typeof applyEffectsV2>[1],
  );
}

describe("能力流转的 who（ADR-010 D2）", () => {
  it("物品可以给 NPC：进他的背包，玩家的不动", () => {
    // 用开局就在场的人：toji / megumi 是 unspawned（由 spawnRule 管辖），
    // 对他们施加会被 `writableActorOf` 正确拦下 —— 那条规则下面单独测。
    const { state, entry } = newWorld();
    run(state, entry, [{ type: "grantItem", itemId: "eq-ten-spear", count: 1, who: "npc-gojo" }]);

    expect(npc(state, "npc-gojo").inventory["eq-ten-spear"]).toBe(1);
    expect(state.player.inventory["eq-ten-spear"]).toBeUndefined();
  });

  it("状态可以落在 NPC 身上，并按世界时间过期", () => {
    const { state, entry } = newWorld();
    run(state, entry, [
      { type: "applyStatus", status: "curse-poison", who: "npc-gojo", duration: { value: 3, unit: "day" } },
    ]);
    const gojo = () => npc(state, "npc-gojo");
    expect(gojo().statuses.some((s) => s.statusId === "curse-poison")).toBe(true);
    expect(state.player.statuses.some((s) => s.statusId === "curse-poison")).toBe(false);

    // 到期判定走绝对时刻（ADR-009）：推到 4 天后就该没了。
    state.worldTime = 4 * DAY;
    const step = () =>
      advanceTurnV2(
        state,
        { action: { type: "rest", description: "" } },
        entry.template,
        entry.lookup,
        createRunnerContext(state.seed),
      );
    step();
    expect(gojo().statuses.some((s) => s.statusId === "curse-poison")).toBe(false);
  });

  it("技能可以给 NPC（这就是「五条学会赫」的通道）", () => {
    const { state, entry } = newWorld();
    expect(npc(state, "npc-gojo").skills).not.toContain("sk-gojo-red");
    run(state, entry, [{ type: "unlockSkill", skillId: "sk-gojo-red", who: "npc-gojo" }]);
    expect(npc(state, "npc-gojo").skills).toContain("sk-gojo-red");
  });

  it("who 指向不存在的人：静默无效，不抛错、不改任何人", () => {
    const { state, entry } = newWorld();
    const before = JSON.stringify(state.player.inventory);
    expect(() =>
      run(state, entry, [{ type: "grantItem", itemId: "eq-ten-spear", count: 1, who: "npc-nobody" }]),
    ).not.toThrow();
    expect(JSON.stringify(state.player.inventory)).toBe(before);
  });

  it("who 指向已离场的人：同样静默无效（不给尸体发东西）", () => {
    const { state, entry } = newWorld();
    const gojo = npc(state, "npc-gojo");
    gojo.lifecycle = { state: "inactive", sinceTurn: 0, sinceWorldTime: 0 };
    run(state, entry, [{ type: "grantItem", itemId: "eq-ten-spear", count: 1, who: "npc-gojo" }]);
    expect(gojo.inventory["eq-ten-spear"]).toBeUndefined();
  });

  it("who 指向未登场的人（unspawned）：也拦下", () => {
    const { state, entry } = newWorld();
    const toji = npc(state, "npc-toji");
    expect(toji.lifecycle.state).toBe("unspawned");
    run(state, entry, [{ type: "grantItem", itemId: "eq-ten-spear", count: 1, who: "npc-toji" }]);
    expect(toji.inventory["eq-ten-spear"]).toBeUndefined();
  });

  it("缺省 who = self：行为与改造前逐字段一致", () => {
    const { state, entry } = newWorld();
    run(state, entry, [{ type: "grantItem", itemId: "eq-ten-spear", count: 2 }]);
    expect(state.player.inventory["eq-ten-spear"]).toBe(2);
    expect(writableActorOf(state)?.isSelf).toBe(true);
  });
});

describe("NPC 的装备词条（ADR-010 D3）", () => {
  it("装备进有效属性，与玩家同一条链路", () => {
    const { state, entry } = newWorld();
    const base = { attributes: { cursedEnergy: 10, physique: 5 }, statuses: [], mood: 50 };
    const withGear = effectiveAttributesOfActor(state, entry.lookup, {
      ...base,
      equipment: [{ instanceId: "t#1", itemId: "eq-ten-spear", ownerId: "npc-toji", slot: "weapon" }],
    });
    const without = effectiveAttributesOfActor(state, entry.lookup, base);

    // 天逆鉾的 dynamicModifier 按诅咒能量缩放，所以「穿了」必须比「裸着」高。
    expect(withGear.cursedEnergy).toBeGreaterThan(without.cursedEnergy);
  });

  it("没装备时不产生任何额外修正（缺省不改旧行为）", () => {
    const { state, entry } = newWorld();
    const eff = effectiveAttributesOfActor(state, entry.lookup, {
      attributes: { cursedEnergy: 10 },
      statuses: [],
      mood: 50,
      equipment: [],
    });
    expect(eff.cursedEnergy).toBe(10);
  });
});

describe("演员搬运（ADR-010 D1）", () => {
  it("搬 body 不动 mind：夺舍的字段基础", () => {
    const { state } = newWorld();
    const gojo = npc(state, "npc-gojo");
    const beforeSkills = [...state.player.skills];
    transplantActor(gojo, state.player, ["body"]);

    expect(state.player.attributes.cursedEnergy).toBe(gojo.attributes.cursedEnergy);
    expect(state.player.skills).toEqual(beforeSkills);
  });

  it("搬 mind 不动 body：继承的字段基础", () => {
    const { state } = newWorld();
    const gojo = npc(state, "npc-gojo");
    const beforeHp = state.player.hp;
    transplantActor(gojo, state.player, ["mind"]);

    expect(state.player.skills).toEqual(gojo.skills);
    expect(state.player.hp).toBe(beforeHp);
  });

  it("源没有的字段会被删掉，不留上一个人的残影", () => {
    const { state } = newWorld();
    // 硝子身上没有任何装备（甚尔有天逆鉾，不能再用他做「源没有」的样本）
    const shoko = npc(state, "npc-shoko");
    state.player.equipment = [{ instanceId: "p#1", itemId: "eq-ten-spear", ownerId: "player", slot: "weapon" }];
    transplantActor(shoko, state.player, ["body"]);
    expect(state.player.equipment).toBeUndefined();
  });

  it("id 永不参与搬运（关系图节点与 self 名字由调用方决定）", () => {
    const { state } = newWorld();
    const gojo = npc(state, "npc-gojo");
    transplantActor(gojo, state.player, ["body", "mind", "identity", "standing"]);
    expect(state.player.id).toBe("player");
    expect(state.player.name).toBe(gojo.name);
  });

  it("字段分组覆盖了四个场景要用的全部键", () => {
    expect(ACTOR_FIELD_GROUPS.body).toContain("equipment");
    expect(ACTOR_FIELD_GROUPS.body).toContain("inventory");
    expect(ACTOR_FIELD_GROUPS.mind).toContain("skills");
    // age 故意不在任何组里：NPC 是起始快照、玩家是当前年龄，搬了就错
    const all = Object.values(ACTOR_FIELD_GROUPS).flat() as readonly string[];
    expect(all).not.toContain("age");
  });
});

