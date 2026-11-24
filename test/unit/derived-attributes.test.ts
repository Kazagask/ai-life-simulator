import { describe, expect, it } from "vitest";
import { WorldTemplateV2Schema, type WorldTemplateV2 } from "@life-sim/shared";
import {
  assignAttributeValue,
  attributeIdOfRole,
  createLookup,
  createWorldV2,
  critOf,
  effectiveAttributes,
  evadeOf,
  makeTestTemplate,
  projectSnapshotV2,
} from "@life-sim/game-core";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silent = { warn: () => {}, error() {}, info() {} };

/**
 * 派生属性（ADR-074）。
 *
 * 三件事必须同时成立，缺一条都会让「面板上的数」与「战斗里的数」分叉：
 * 1. 依赖顺序由拓扑序决定，不是声明顺序；
 * 2. 循环依赖在**加载期**就拒绝；
 * 3. 派生属性只读（set/adjust 都拒绝），但可以被 `attributeModifiers` 补正。
 */
function templateWithDerived(): WorldTemplateV2 {
  const template = makeTestTemplate();
  template.attributes.order = [...template.attributes.order, "a", "b", "c", "signedRate"];
  template.attributes.defaults = { ...template.attributes.defaults, a: 10, b: 0, c: 0 };
  template.attributes.defs = {
    a: { kind: "number" },
    // 故意让 c 声明在 b 前面：拓扑序必须自己算出 b → c。
    c: { kind: "number", derived: { base: 1, from: [{ attribute: "b", perPoint: 0.5 }] } },
    b: { kind: "number", derived: { from: [{ attribute: "a", perPoint: 2 }] } },
    signedRate: { kind: "number", signed: true, derived: { from: [{ attribute: "a", perPoint: -0.1 }] } },
  };
  return template;
}

describe("派生属性（ADR-074）", () => {
  it("按依赖顺序计算：b = 2a，c = 1 + 0.5b（声明顺序是反的也照算）", () => {
    const template = templateWithDerived();
    const eff = effectiveAttributes({ a: 10 }, [], 60, createLookup(template));
    expect(eff.b).toBe(20);
    expect(eff.c).toBe(11);
    // 有符号属性不吃「属性不为负」的兜底。
    expect(eff.signedRate).toBeCloseTo(-1);
  });

  it("派生属性的补正在公式之后叠加（天赋 +60 效率就是这么来的）", () => {
    const template = templateWithDerived();
    template.statuses.push({
      id: "boost-b",
      name: "补正",
      kind: "talent",
      polarity: "positive",
      visibility: "known",
      attributeModifiers: { b: 5 },
    });
    const eff = effectiveAttributes(
      { a: 10 },
      [{ statusId: "boost-b", stacks: 1, appliedTurn: 0, appliedAt: 0 }],
      60,
      createLookup(template),
    );
    // 公式先算 b=20，再加 +5 ⇒ 25；c 读到的是**最终值** 25 ⇒ 13.5。
    expect(eff.b).toBe(25);
    expect(eff.c).toBe(13.5);
  });

  it("属性转化：源归零、按比例加到目标，由源派生的属性一起归零", () => {
    const template = templateWithDerived();
    template.statuses.push({
      id: "convert-a",
      name: "换体",
      kind: "talent",
      polarity: "positive",
      visibility: "known",
      conversion: [{ from: "a", to: { physique: 0.5 } }],
    });
    const eff = effectiveAttributes(
      { a: 10, physique: 5 },
      [{ statusId: "convert-a", stacks: 1, appliedTurn: 0, appliedAt: 0 }],
      60,
      createLookup(template),
    );
    expect(eff.a).toBe(0);
    expect(eff.physique).toBe(10);
    expect(eff.b).toBe(0);
    expect(eff.c).toBe(1);
  });

  it("派生属性只读：assignAttributeValue 直接拒", () => {
    const template = templateWithDerived();
    const lookup = createLookup(template);
    const state = createWorldV2({ templateId: "test", playerName: "甲", seed: 1 }, template, "w-derived");
    expect(() => assignAttributeValue(state, template, "b", 5)).toThrow("attribute_readonly");
    expect(lookup.attributeLabel("b")).toBe("b");
  });

  it("角色由模板声明：属性叫 myCrit 也能当暴击率（不认死 id）", () => {
    const template = templateWithDerived();
    template.attributes.order.push("myCrit", "myEvade");
    template.attributes.defs = {
      ...(template.attributes.defs ?? {}),
      myCrit: { kind: "number", role: "critRate" },
      myEvade: { kind: "number", role: "evadeRate" },
    };
    const lookup = createLookup(template);
    expect(attributeIdOfRole(template, "critRate")).toBe("myCrit");
    expect(critOf([], undefined, lookup, { myCrit: 20 }).chance).toBeCloseTo(0.2);
    expect(evadeOf([], lookup, undefined, { myEvade: 10 }).chance).toBeCloseTo(0.1);
    // 没声明角色的模板：通道不存在，不猜任何一个 id。
    expect(attributeIdOfRole(templateWithDerived(), "critRate")).toBeUndefined();
  });

  it("同一角色只能挂一个属性（两个 critRate 引擎不知道读谁）", () => {
    const registry = loadTemplates(silent);
    const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
    if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
    const duplicated = structuredClone(entry.template);
    duplicated.attributes.defs!.critRateAgain = { kind: "number", role: "critRate" };
    duplicated.attributes.order.push("critRateAgain");
    const parsed = WorldTemplateV2Schema.safeParse(duplicated);
    expect(parsed.success).toBe(false);
    const messages = parsed.success ? [] : parsed.error.issues.map((i) => i.message);
    expect(messages.some((m) => m.includes("已被"))).toBe(true);
  });

  it("视图里的非整数属性保留两位小数（-52.199999 这种浮点噪声不上屏）", () => {
    const registry = loadTemplates(silent);
    const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
    if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
    // 87 ×0.5 = 43.5 效率 ⇒ mpCostRate = -26.1（浮点上常出现 -26.099999999）
    const state = createWorldV2(
      { templateId: "jjk-2006", playerName: "甲", seed: 2 },
      entry.template,
      "w-round",
    );
    state.player.attributes.cursedEnergyTotal = 87;
    const snapshot = projectSnapshotV2(state, entry.template, entry.lookup);
    const cost = snapshot.player.attributeViews.find((v) => v.id === "mpCostRate");
    expect(cost?.display).toBe("-26.1");
    expect(cost?.value).toBe(-26.1);
    const control = snapshot.player.attributeViews.find((v) => v.id === "cursedEnergyControl");
    // 87 ×0.4 = 34.8（不是 34.800000000000004）
    expect(control?.display).toBe("34.8");
    expect(snapshot.player.attributes.mpCostRate).toBe(-26.1);
  });

  it("循环依赖在加载期拒绝（运行期没有「先算谁」的答案）", () => {
    const registry = loadTemplates(silent);
    const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
    if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
    const cyclic = structuredClone(entry.template);
    const defs = cyclic.attributes.defs!;
    defs.critRate = {
      kind: "number",
      derived: { from: [{ attribute: "mpCostRate", perPoint: 1 }] },
    };
    defs.mpCostRate = {
      kind: "number",
      derived: { from: [{ attribute: "critRate", perPoint: -1 }] },
    };
    const parsed = WorldTemplateV2Schema.safeParse(cyclic);
    expect(parsed.success).toBe(false);
    const messages = parsed.success ? [] : parsed.error.issues.map((i) => i.message);
    expect(messages.some((m) => m.includes("循环依赖"))).toBe(true);
  });
});

describe("属性与战斗的接线（jjk-2006）", () => {
  function jjk() {
    const registry = loadTemplates(silent);
    const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
    if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
    return entry;
  }

  it("暴击率 / 闪避率 / 消耗修正都由属性派生，战斗直接读", () => {
    const entry = jjk();
    const state = createWorldV2(
      { templateId: "jjk-2006", playerName: "甲", seed: 3 },
      entry.template,
      "w-derived-jjk",
    );
    const eff = effectiveAttributes(state.player.attributes, state.player.statuses, state.player.mood, entry.lookup);
    // 默认总量 5：操作 2 ⇒ 暴击率 3 + 0.4 = 3.4；敏捷 5 ⇒ 闪避 5%；效率 2.5 ⇒ 消耗 -1.5%。
    expect(eff.critRate).toBeCloseTo(3.4);
    expect(eff.evadeRate).toBe(5);
    expect(eff.mpCostRate).toBeCloseTo(-1.5);

    expect(critOf([], undefined, entry.lookup, eff).chance).toBeCloseTo(0.034);
    expect(evadeOf([], entry.lookup, undefined, eff).chance).toBeCloseTo(0.05);

    // 面板上显示的是派生现值，不是存档里的 0/缺省。
    const snapshot = projectSnapshotV2(state, entry.template, entry.lookup);
    expect(snapshot.player.attributes.critRate).toBeCloseTo(3.4);
    expect(snapshot.player.attributes.cursedEnergyControl).toBeCloseTo(2);
  });
});
