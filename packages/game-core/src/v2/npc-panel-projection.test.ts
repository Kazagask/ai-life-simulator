import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { WorldTemplateV2Schema, type WorldTemplateV2 } from "@life-sim/shared";
import { projectSnapshotV2 } from "./projection.js";
import { createLookup } from "./lookup.js";
import { createActiveWorldV2, makeTestTemplate } from "./test-utils.js";

/** 真实模板夹具（jjk-2006 六文件合并）；与 v2.test.ts 同一加载口径。 */
const jjkDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../specs/data/templates/jjk-2006");

function loadJjkTemplate(): WorldTemplateV2 {
  const merged: Record<string, unknown> = {};
  for (const file of ["world.yaml", "characters.yaml", "skills.yaml", "items.yaml", "statuses.yaml", "events.yaml"]) {
    const doc = parse(readFileSync(path.join(jjkDir, file), "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(doc)) {
      if (key === "meta") merged.meta = value;
      else if (merged[key] === undefined) merged[key] = value;
      else if (Array.isArray(merged[key]) && Array.isArray(value)) merged[key] = (merged[key] as unknown[]).concat(value);
    }
  }
  return WorldTemplateV2Schema.parse(merged);
}

function buildJjkWorld(worldId: string) {
  const template = loadJjkTemplate();
  const lookup = createLookup(template);
  const state = createActiveWorldV2({ templateId: "jjk-2006", playerName: "测试者", seed: 7 }, template, worldId);
  return { state, template, lookup };
}

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

describe("V2 投影 · NPC 属性（ADR-0021 决策 3）", () => {
  it("键集与 template.attributes.order 相等；值为模板 base 原值；未声明的键补 0", () => {
    const { state, template, lookup } = buildWorld("w-npc-attr-1", 17);
    // 夹具 NPC 只声明三项，order 有四项（willpower 未声明）
    expect(template.attributes.order).toEqual(["cursedEnergy", "agility", "luck", "willpower"]);
    const npc = projectSnapshotV2(state, template, lookup).npcs.find((n) => n.id === "npc-a")!;
    expect(Object.keys(npc.attributes).sort()).toEqual([...template.attributes.order].sort());
    expect(npc.attributes).toEqual({ cursedEnergy: 5, agility: 3, luck: 3, willpower: 0 });
  });

  it("order 外的键一律不透（内部/派生键不得变成新 API 面）", () => {
    const { state, template, lookup } = buildWorld("w-npc-attr-2", 17);
    const instance = state.npcs.find((n) => n.id === "npc-a")!;
    instance.attributes.hiddenBonus = 99;
    instance.attributes.proficiencySword = 7;
    const npc = projectSnapshotV2(state, template, lookup).npcs.find((n) => n.id === "npc-a")!;
    expect(npc.attributes.hiddenBonus).toBeUndefined();
    expect(npc.attributes.proficiencySword).toBeUndefined();
    expect(JSON.stringify(npc.attributes)).not.toContain("hiddenBonus");
  });

  it("下发的是 base 值：状态补正不叠进去（补正只走 statuses）", () => {
    const { state, template, lookup } = buildWorld("w-npc-attr-3", 17);
    const instance = state.npcs.find((n) => n.id === "npc-a")!;
    // 夹具已挂 inj（simulation.attributeModifiers.agility = -2）
    expect(instance.statuses.map((s) => s.statusId)).toContain("inj");
    const npc = projectSnapshotV2(state, template, lookup).npcs.find((n) => n.id === "npc-a")!;
    expect(npc.attributes.agility).toBe(3); // base 原值，不是 1
    // 也不下发任何 effective / delta 派生字段
    expect(Object.keys(npc)).not.toContain("attributeModifiers");
    expect(Object.keys(npc)).not.toContain("effectiveAttributes");
  });

  it("模板 order 为空 ⇒ 下发 {}（必填字段，前端可直接遍历）", () => {
    const { state, template, lookup } = buildWorld("w-npc-attr-4", 17);
    template.attributes = { order: [], defaults: {} };
    const view = projectSnapshotV2(state, template, lookup);
    for (const npc of view.npcs) expect(npc.attributes).toEqual({});
    // 必填：字段存在（不是 undefined），JSON 里也保留空对象
    expect(JSON.parse(JSON.stringify(view.npcs[0])).attributes).toEqual({});
  });

  it("真实模板 jjk-2006：每个 NPC 的属性键集都等于模板 order", () => {
    const { state, template, lookup } = buildJjkWorld("w-npc-attr-jjk");
    const view = projectSnapshotV2(state, template, lookup);
    expect(view.npcs.length).toBeGreaterThan(3);
    for (const npc of view.npcs) {
      expect(Object.keys(npc.attributes).sort()).toEqual([...template.attributes.order].sort());
      for (const value of Object.values(npc.attributes)) expect(typeof value).toBe("number");
    }
  });
});
