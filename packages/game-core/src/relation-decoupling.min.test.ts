import { describe, expect, it } from "vitest";
import { WorldTemplateV2Schema, type V2Snapshot, type WorldTemplateV2 } from "@life-sim/shared";

import { createActiveWorldV2, makeTestTemplate } from "./v2/test-utils.js";
import { createLookup } from "./v2/lookup.js";
import { projectSnapshotV2 } from "./v2/projection.js";
import { UNKNOWN_ACTOR } from "./v2/actors.js";
import type { WorldStateV2 } from "@life-sim/shared";

/**
 * B-2「关系投影与 NPC 投影解耦」的验收测试（2026-11-16 用户裁决）。
 *
 * 裁决原文：`关系投影直接独立解耦吧 你可能完全不认识伏黑惠和伏黑甚尔 但是你知道他们的关系
 * 而且是两条边`。补两条硬要求：
 *   1. 未被实例化的关系**必须取到人名**，不能把裸 id 摆到玩家面前；
 *   2. 死亡 NPC 的关系必须照常可用（卡片、名字、称谓都不能塌）。
 *
 * 这两条正好是解耦的边界：解耦放宽了"边能不能上屏"，但**没有**放宽"人有没有名字"。
 */

function makeTemplate(): WorldTemplateV2 {
  const base = makeTestTemplate();
  return {
    ...base,
    // 由刷新规则管辖 ⇒ 建世界时落 unspawned（有定义、没露过面）
    npcSpawnRules: [{ id: "rule-unborn", characterRef: "npc-unborn" }],
    characters: [
      {
        id: "enemy-x",
        isEnemy: true,
        visibility: "public",
        identity: { name: "墙里的影子", age: 1, gender: "f" },
        mood: { value: 50 },
        attributes: { cursedEnergy: 5, agility: 1, luck: 0 },
        skills: ["sk-nuke"],
        public: { personality: "只有手" },
        private: {},
        relationship: -100,
      },
      {
        id: "npc-ally",
        isEnemy: false,
        visibility: "public",
        identity: { name: "同路人", age: 20, gender: "f" },
        mood: { value: 50 },
        attributes: { cursedEnergy: 5, agility: 1, luck: 0 },
        skills: [],
        public: { personality: "沉默" },
        private: {},
        relationship: 10,
        relations: [
          // 指向**永不实例化**的敌人
          { to: "enemy-x", kind: "friend", visibility: "known" },
          // 指向**还没登场**的人
          { to: "npc-unborn", kind: "friend", visibility: "known" },
          // 指向**已故**的人
          { to: "npc-dead", kind: "friend", visibility: "known" },
          // 指向玩家
          { to: "player", kind: "friend", visibility: "known" },
          // 玩家不该知道的边：解耦只放宽"端点在不在图上"，不放宽边自身可见性
          { to: "npc-secret", kind: "friend", visibility: "hidden" },
        ],
      },
      {
        id: "npc-kid",
        isEnemy: false,
        visibility: "public",
        identity: { name: "小孩", age: 8, gender: "f" },
        mood: { value: 50 },
        attributes: { cursedEnergy: 1, agility: 1, luck: 0 },
        skills: [],
        public: { personality: "怕生" },
        private: {},
        relationship: 0,
        // 父亲还没登场：玩家知道"小孩有爸爸"，但没见过这个人
        relations: [{ to: "npc-unborn", kind: "father", visibility: "known" }],
      },
      {
        id: "npc-unborn",
        isEnemy: false,
        visibility: "public",
        identity: { name: "未登场的父亲", age: 40, gender: "f" },
        mood: { value: 50 },
        attributes: { cursedEnergy: 5, agility: 1, luck: 0 },
        skills: [],
        public: { personality: "缺席" },
        private: {},
        relationship: 0,
      },
      {
        id: "npc-dead",
        isEnemy: false,
        visibility: "public",
        identity: { name: "亡故的同门", age: 30, gender: "f" },
        mood: { value: 50 },
        attributes: { cursedEnergy: 5, agility: 1, luck: 0 },
        skills: [],
        public: { personality: "只留在回忆里" },
        private: {},
        relationship: 0,
        // ADR-0020：缺省 alive；这里显式声明已故，验"死亡不塌关系"
        lifecycle: { state: "inactive", reasonCode: "dead" },
        // 死者自己的关系也要能上屏（反向也验一遍）
        relations: [{ to: "npc-ally", kind: "friend", visibility: "known" }],
      },
      {
        id: "npc-secret",
        isEnemy: false,
        visibility: "public",
        identity: { name: "不该被知道的人", age: 30, gender: "f" },
        mood: { value: 50 },
        attributes: { cursedEnergy: 5, agility: 1, luck: 0 },
        skills: [],
        public: { personality: "?" },
        private: {},
        relationship: 0,
      },
    ],
  } as unknown as WorldTemplateV2;
}

function freshWorld(seed = 3) {
  const template = makeTemplate();
  const lookup = createLookup(template);
  const state = createActiveWorldV2({ templateId: "test", playerName: "主角", seed }, template, `rel-${seed}`);
  const snapshot = projectSnapshotV2(state, template, lookup);
  return { template, lookup, state, snapshot };
}

function card(snapshot: V2Snapshot, id: string) {
  const found = snapshot.npcs.find((n) => n.id === id);
  if (!found) throw new Error(`卡片缺失：${id}`);
  return found;
}

function rowOf(snapshot: V2Snapshot, npcId: string, withId: string) {
  return card(snapshot, npcId).relations.find((r) => r.withId === withId);
}

describe("B-2 关系解耦：未被实例化的一端照样有名有姓", () => {
  it("夹具自检：敌人不实例化、刷新规则角色落 unspawned", () => {
    const { state } = freshWorld();
    const ids = state.npcs.map((n) => n.id);
    expect(ids).not.toContain("enemy-x");
    expect(state.npcs.find((n) => n.id === "npc-unborn")?.lifecycle.state).toBe("unspawned");
    expect(state.npcs.find((n) => n.id === "npc-dead")?.lifecycle.state).toBe("inactive");
  });

  it("指向**敌人**的边：上屏、名字来自模板、标为无卡", () => {
    const { snapshot } = freshWorld();
    const row = rowOf(snapshot, "npc-ally", "enemy-x");
    expect(row).toBeDefined();
    // 关键：不是 `enemy-x`
    expect(row!.withName).toBe("墙里的影子");
    expect(row!.counterpartVisible).toBe(false);
    expect(row!.visibility).toBe("known");
  });

  it("指向**未登场**的边：上屏、名字来自模板、标为无卡", () => {
    const { snapshot } = freshWorld();
    const row = rowOf(snapshot, "npc-ally", "npc-unborn");
    expect(row!.withName).toBe("未登场的父亲");
    expect(row!.counterpartVisible).toBe(false);
  });

  it("称谓照算：小孩知道自己有个爸爸，哪怕这个人从未登场", () => {
    const { snapshot } = freshWorld();
    const row = rowOf(snapshot, "npc-kid", "npc-unborn");
    expect(row!.direction).toBe("out");
    expect(row!.withName).toBe("未登场的父亲");
    expect(row!.kinshipTerm).toBe("爸爸");
    expect(row!.counterpartVisible).toBe(false);
  });

  it("指向**玩家**的边：玩家名照旧，且视为有卡", () => {
    const { snapshot } = freshWorld();
    const row = rowOf(snapshot, "npc-ally", "player");
    expect(row!.withName).toBe("主角");
    expect(row!.counterpartVisible).toBe(true);
  });

  it("边自身 hidden ⇒ 仍不投影（解耦不等于泄露）", () => {
    const { snapshot } = freshWorld();
    expect(rowOf(snapshot, "npc-ally", "npc-secret")).toBeUndefined();
  });

  it("数据破损（目标谁都不认识）⇒ 占位名，绝不把裸 id 当人名", () => {
    const { state, template, lookup } = freshWorld();
    state.relations.push({
      from: "npc-ally",
      to: "npc-nowhere",
      kind: "friend",
      source: "effect",
      visibility: "known",
    });
    const snapshot = projectSnapshotV2(state, template, lookup);
    const row = rowOf(snapshot, "npc-ally", "npc-nowhere");
    expect(row!.withName).toBe(UNKNOWN_ACTOR);
    expect(row!.withName).not.toBe("npc-nowhere");
  });

  it("全体卡片：任何一行的 withName 都不等于 withId（无裸 id 上屏）", () => {
    const { state, template, lookup } = freshWorld();
    state.relations.push({
      from: "npc-ally",
      to: "npc-nowhere",
      kind: "friend",
      source: "effect",
      visibility: "known",
    });
    const snapshot = projectSnapshotV2(state, template, lookup);
    for (const npc of snapshot.npcs) {
      for (const rel of npc.relations) {
        expect(rel.withName).toBeTruthy();
        expect(rel.withName).not.toBe(rel.withId);
      }
    }
  });
});

describe("B-2 关系解耦：死亡 NPC 的关系不塌", () => {
  it("已故者仍有卡片（ADR-0020：上屏与生命周期解耦）", () => {
    const { snapshot } = freshWorld();
    expect(card(snapshot, "npc-dead").lifecycle.state).toBe("inactive");
  });

  it("已故者自己的关系行照常列出，名字也照常解析", () => {
    const { snapshot } = freshWorld();
    const row = rowOf(snapshot, "npc-dead", "npc-ally");
    expect(row).toBeDefined();
    expect(row!.withName).toBe("同路人");
    expect(row!.counterpartVisible).toBe(true);
  });

  it("指向已故者的边：对方有卡、名字正确、边没有被 '死' 掉", () => {
    const { snapshot } = freshWorld();
    const row = rowOf(snapshot, "npc-ally", "npc-dead");
    expect(row!.withName).toBe("亡故的同门");
    expect(row!.counterpartVisible).toBe(true);
  });

  it("死亡后重新投影仍然一致（幂等）", () => {
    const { state, template, lookup } = freshWorld();
    const before = projectSnapshotV2(state, template, lookup);
    const after = projectSnapshotV2(state, template, lookup);
    const pick = (s: V2Snapshot) =>
      s.npcs.map((n) => [n.id, n.relations.map((r) => [r.withId, r.withName, r.counterpartVisible])]);
    expect(pick(after)).toEqual(pick(before));
  });

  it("死亡冻结不改写可见性：frozen 边照样上屏（逝者仍是关系人）", () => {
    const { state, template, lookup } = freshWorld();
    state.relations = state.relations.map((e) =>
      e.from === "npc-dead" || e.to === "npc-dead" ? { ...e, frozen: true } : e,
    );
    const snapshot = projectSnapshotV2(state, template, lookup);
    expect(rowOf(snapshot, "npc-ally", "npc-dead")).toBeDefined();
    expect(rowOf(snapshot, "npc-dead", "npc-ally")).toBeDefined();
  });
});

describe("A 期 seam：玩家节点 id 单一来源", () => {
  it("建世界即写入 selfId，且玩家的关系边端点就是它", () => {
    const { state } = freshWorld();
    expect(state.selfId).toBe("player");
    expect(state.player.id).toBe(state.selfId);
    const edge = state.relations.find((e) => e.from === "npc-ally" && e.kind === "friend" && e.to === state.selfId);
    expect(edge).toBeDefined();
  });

  it("旧档没有 selfId 也能投影（回落同值，不炸）", () => {
    const { state, template, lookup } = freshWorld();
    delete (state as { selfId?: string }).selfId;
    const snapshot = projectSnapshotV2(state, template, lookup);
    expect(rowOf(snapshot, "npc-ally", "player")!.withName).toBe("主角");
  });

  it("模板 schema 接受本夹具（isEnemy + relations + 刷新规则同存）", () => {
    // 事件表清空：`makeTestTemplate` 的 `ev-normal` 故意写了一个不存在的技能
    // （`visibleWhen.requiresSkill: sk-none`，用于测选项隐藏），会让加载期校验报未知技能。
    // 本用例只关心角色段（isEnemy / relations / npcSpawnRules）在 schema 里合法。
    const parsed = WorldTemplateV2Schema.safeParse({ ...makeTemplate(), events: [] });
    if (!parsed.success) console.log(parsed.error.issues);
    expect(parsed.success).toBe(true);
  });
});
