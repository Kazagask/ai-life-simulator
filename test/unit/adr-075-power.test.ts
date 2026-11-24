import { describe, expect, it } from "vitest";
import { powerOfAttributes, powerWeightsOf } from "@life-sim/game-core";
import { WorldTemplateV2Schema, type WorldTemplateV2 } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * ADR-075 §4：战斗力口径。
 *
 * 核心承诺只有三条：
 * 1. 派生属性折算回**基础属性**，同一条底层属性不重复计入；
 * 2. signed（mpCostRate）与 hidden（infamy）不进战力；
 * 3. 模板 `weights` 完全接管，且加载期拒绝派生 / signed / hidden 键。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function jjkTemplate(): WorldTemplateV2 {
  const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry.template;
}

describe("ADR-075 §4 · 默认战斗力集合", () => {
  it("派生折算去重、signed / hidden 排除：jjk = 咒力总量 + 体魄 + 敏捷 + 智力", () => {
    expect(powerWeightsOf(jjkTemplate())).toEqual({
      cursedEnergyTotal: 1,
      // 智力是三条精神系技能的 `hitCheck.defender` —— 防御面也算战斗面。
      intellect: 1,
      physique: 1,
      agility: 1,
    });
  });

  it("派生属性的三条依赖都指回同一基础属性，只算一次", () => {
    const weights = powerWeightsOf(jjkTemplate());
    // 输出 / 操作 / 效率 都由 cursedEnergyTotal 派生；若各折一次，这里会变成 3 倍。
    expect(powerOfAttributes({ cursedEnergyTotal: 10, physique: 0, agility: 0 }, weights)).toBe(10);
  });

  it("集合外的属性不参与（幸运 / 名誉）", () => {
    const weights = powerWeightsOf(jjkTemplate());
    expect(
      powerOfAttributes(
        { cursedEnergyTotal: 10, physique: 5, agility: 2, luck: 999, reputation: 999 },
        weights,
      ),
    ).toBe(17);
  });
});

describe("ADR-075 §4.3 · 模板覆盖", () => {
  it("写了 weights 就只算这些键", () => {
    const template = structuredClone(jjkTemplate());
    template.combat = {
    ...(template.combat ?? {}),
      ...(template.combat ?? {}),
      evaluation: { power: { weights: { physique: 2, agility: 0.5 } } },
    };
    const weights = powerWeightsOf(template);
    expect(weights).toEqual({ physique: 2, agility: 0.5 });
    expect(powerOfAttributes({ physique: 5, agility: 4, cursedEnergyTotal: 99 }, weights)).toBe(12);
  });

  it.each([
    ["派生属性", "cursedEnergyOutput"],
    ["signed 属性", "mpCostRate"],
    ["hidden 属性", "infamy"],
  ])("加载期拒绝 %s 作为权重键", (_label, key) => {
    const template = structuredClone(jjkTemplate());
    template.combat = {
    ...(template.combat ?? {}),
      ...(template.combat ?? {}),
      evaluation: { power: { weights: { [key]: 1 } } },
    };
    const parsed = WorldTemplateV2Schema.safeParse(template);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((i) => i.message).join(" / ");
      expect(messages).toContain(key);
    }
  });

  it("加载期拒绝未知 stake", () => {
    const template = structuredClone(jjkTemplate());
    template.combat = { ...(template.combat ?? {}), defaultStake: "nope" };
    const parsed = WorldTemplateV2Schema.safeParse(template);
    expect(parsed.success).toBe(false);
  });
});
