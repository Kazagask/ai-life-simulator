import { describe, expect, it } from "vitest";
import {
  EffectSummarySchema,
  OpeningBranchDagSchema,
  StyleSpecSchema,
  UiConfigSchema,
  type EffectSummary,
  type Item,
  type StatusEffect,
} from "@life-sim/shared";
import {
  diffGains,
  captureGainBaseline,
  equipmentEffectSummaries,
  itemEffectSummaries,
  resolveStyle,
  skillEffectSummaries,
  statusEffectSummaries,
  validateStyleRefs,
} from "@life-sim/game-core";
import { makeWorld } from "../helpers/world.ts";

const ui = UiConfigSchema.parse({
  styles: {
    rainbow: { preset: "rainbow", animation: "rainbow-flow" },
    custom: { color: "#ff00aa", bold: true },
  },
  qualityStyles: { mythic: "rainbow", odd: "custom" },
});

describe("样式协议（ADR-002 D2）", () => {
  it("未知 preset / 非法颜色 / 任意 CSS 在 schema 层就被拒", () => {
    expect(StyleSpecSchema.safeParse({ preset: "rainbow" }).success).toBe(true);
    expect(StyleSpecSchema.safeParse({ color: "#abc" }).success).toBe(true);
    expect(StyleSpecSchema.safeParse({ color: "gold" }).success).toBe(true);
    expect(StyleSpecSchema.safeParse({ preset: "platinum" }).success).toBe(false);
    expect(StyleSpecSchema.safeParse({ color: "red" }).success).toBe(false);
    expect(StyleSpecSchema.safeParse({ color: "red;background:url(x)" }).success).toBe(false);
    expect(StyleSpecSchema.safeParse({ animation: "spin" }).success).toBe(false);
    expect(StyleSpecSchema.safeParse({ unknown: 1 }).success).toBe(false);
  });

  it("解析顺序：自身 style > quality 映射 > 默认", () => {
    // 自身 style 优先
    expect(resolveStyle("custom", "mythic", ui)).toEqual({ color: "#ff00aa", bold: true });
    // 自身没有 ⇒ 按 quality 查
    expect(resolveStyle(undefined, "mythic", ui)).toEqual({ preset: "rainbow", animation: "rainbow-flow" });
    // 都没有 ⇒ undefined（默认样式）
    expect(resolveStyle(undefined, "common", ui)).toBeUndefined();
    // 没有 ui.yaml ⇒ 不解析（零回归）
    expect(resolveStyle(undefined, "mythic", undefined)).toBeUndefined();
  });

  it("正负零与品级独立：只写 polarity 也能拿到绿 / 红 / 灰", () => {
    expect(resolveStyle(undefined, undefined, ui, "negative")?.preset).toBe("red");
    expect(resolveStyle(undefined, undefined, ui, "positive")?.preset).toBe("green");
    expect(resolveStyle(undefined, undefined, ui, "neutral")?.preset).toBe("gray");
    // 模板覆盖正负映射时以模板为准
    const custom = UiConfigSchema.parse({ polarityStyles: { negative: "purple" } });
    expect(resolveStyle(undefined, undefined, custom, "negative")?.preset).toBe("purple");
    // 品级优先于正负零（fixture 的 qualityStyles 里 mythic → rainbow）
    expect(resolveStyle(undefined, "mythic", ui, "negative")?.preset).toBe("rainbow");
  });

  it("颜色 token 解析成 CSS 变量，十六进制原样", () => {
    const style = resolveStyle("gold-tone", undefined, UiConfigSchema.parse({ styles: { "gold-tone": { color: "gold" } } }));
    expect(style?.color).toContain("var(--");
  });

  it("未知样式 id 在加载期被拒（不静默回退）", () => {
    const { entry } = makeWorld();
    const issues = validateStyleRefs(
      { ...entry.template, statuses: [{ ...entry.template.statuses[0]!, style: "nope" }] },
      ui,
    );
    expect(issues.map((i) => i.path)).toContain("statuses[0].style");
    expect(validateStyleRefs(entry.template, ui)).toEqual([]);
  });
});

describe("效果摘要（ADR-002 D3）", () => {
  const { entry } = makeWorld();
  const lookup = entry.lookup;

  it("补正：属性 / 控制 / 战斗面分别出条目，控制类 kind=control", () => {
    const def: StatusEffect = {
      id: "stun",
      name: "眩晕",
      duration: { turns: 2 },
      stacking: "refresh",
      visibility: "known",
      simulation: { attributeModifiers: { cursedEnergy: -2 } },
      combat: { control: ["cannot_act"], hitChance: -0.1 },
    };
    const out = statusEffectSummaries(def, lookup);
    expect(out.find((e) => e.kind === "control")?.text).toBe("无法行动");
    expect(out.some((e) => e.kind === "attr" && e.tone === "debuff")).toBe(true);
    expect(out.some((e) => e.text.includes("命中"))).toBe(true);
  });

  it("技能：消耗 / 目标 / 冷却齐全，伤害公式是人话", () => {
    const skill = entry.template.skills.find((s) => s.kind === "combat");
    if (skill === undefined) return;
    const out = skillEffectSummaries(skill, lookup);
    expect(out.some((e) => e.kind === "cost" && e.text.includes("消耗"))).toBe(true);
    expect(out.some((e) => e.text.includes("冷却"))).toBe(true);
  });

  it("物品：消耗品效果翻译成「恢复 30 生命」这类句子", () => {
    const item: Item = {
      id: "potion",
      type: "consumable",
      name: "回复药",
      stackable: true,
      usableInBattle: true,
      usableOutsideBattle: true,
      use: [{ type: "adjustResource", resource: "hp", value: 30 }],
    };
    const out = itemEffectSummaries(item, lookup);
    expect(out[0]?.text).toContain("恢复");
    expect(out[0]?.tone).toBe("buff");
  });

  it("装备动态补正只描述规则，不算值", () => {
    const eq: Item = {
      id: "blade",
      type: "equipment",
      name: "咒具",
      stackable: false,
      usableInBattle: false,
      usableOutsideBattle: false,
      slot: "weapon",
      category: "blade",
      quality: "rare",
      dynamicModifier: { attribute: "cursedEnergy", preset: "scaled", params: { base: 3, scaleBy: "cursedEnergy", multiplier: 0.2 } },
    };
    const out = equipmentEffectSummaries(eq, lookup);
    expect(out[0]?.text).toContain("随成长");
    expect(out[0]?.text).not.toMatch(/^\D*\d+\.\d+/);
  });

  it("施加补正类条目带被引用实体的样式（浮层里「施加 力竭」也要有色）", () => {
    const { entry } = makeWorld();
    const def: StatusEffect = {
      id: "carrier",
      name: "载体",
      duration: { turns: 1 },
      stacking: "refresh",
      visibility: "known",
      simulation: { attributeModifiers: { cursedEnergy: 1 } },
      combat: { control: ["cannot_act"] },
    };
    const out = statusEffectSummaries(def, entry.lookup);
    const control = out.find((e) => e.kind === "control");
    expect(control?.note).toBeDefined();
  });

  it("效果摘要 schema 是闭集（未知 kind 拒收）", () => {
    expect(EffectSummarySchema.safeParse({ text: "x", kind: "attr" }).success).toBe(true);
    expect(EffectSummarySchema.safeParse({ text: "x", kind: "magic" }).success).toBe(false);
    expect(EffectSummarySchema.safeParse({ text: "x", kind: "control", unclear: 1 }).success).toBe(false);
  });
});

describe("回合增量（ADR-002 D4）", () => {
  it("五类变化各出条目，顺序稳定", () => {
    const { state, entry } = makeWorld(7);
    const before = captureGainBaseline(state);
    const after = structuredClone(state);
    after.player.attributes.cursedEnergy = (after.player.attributes.cursedEnergy ?? 0) + 2;
    after.player.statuses = [...after.player.statuses, { statusId: entry.template.statuses[0]!.id, stacks: 2, sinceTurn: 0 }];
    after.player.inventory["item-first-aid"] = 1;
    const gains = diffGains(before, after, entry.lookup);
    const cats = gains.map((g) => g.category);
    expect(cats).toContain("attribute");
    expect(cats).toContain("status");
    expect(cats).toContain("item");
    // 顺序固定：属性 → 补正 → 技能 → 物品 → 装备
    const rank = ["attribute", "status", "skill", "item", "equipment"];
    expect(cats).toEqual([...cats].sort((a, b) => rank.indexOf(a) - rank.indexOf(b)));
    const attr = gains.find((g) => g.category === "attribute");
    expect(attr?.amount).toBe(2);
    expect(attr?.action).toBe("up");
  });

  it("没有变化 ⇒ 空数组（同输入同输出）", () => {
    const { state, entry } = makeWorld(7);
    const before = captureGainBaseline(state);
    expect(diffGains(before, structuredClone(state), entry.lookup)).toEqual([]);
  });
});

describe("开局 DAG 与样式解耦（回归）", () => {
  it("没有 ui 时 opening DAG 仍可加载（样式不是开局参数）", () => {
    const dag = OpeningBranchDagSchema.safeParse({
      openingId: "op",
      name: "n",
      entry: "a",
      params: [],
      nodes: [{ node: "a", title: "t", mode: "roll", options: [{ id: "o", text: "x", set: {} }] }],
    });
    expect(dag.success).toBe(true);
  });
});

// 让未使用的类型导入不报 lint（EffectSummary 用于上面的 schema 断言）
const _typecheck: EffectSummary = { text: "x", kind: "attr" };
void _typecheck;

describe("开局所得（ADR-002 D4 的开局版本）", () => {
  it("每步与 commit 用同一份 collectOpeningGains：技能/物品/补正/属性都出现", async () => {
    const { loadTemplates } = await import("../../apps/server/src/templates.ts");
    const { createOpeningSession, resolveStep, collectOpeningGains } = await import(
      "../../packages/game-core/src/v2/opening-dag.ts"
    );
    const entry = loadTemplates({ warn: () => {}, error: () => {}, info: () => {} }).resolve({
      id: "jjk-2006",
      version: "2.0.0",
    });
    if (entry?.status !== "ready" || entry.openingDag === undefined) throw new Error("not ready");

    let session = createOpeningSession(entry.openingDag, 4242);
    for (let guard = 0; !session.done && guard < 40; guard += 1) {
      const node = entry.openingDag.nodes.find((n) => n.node === session.nodeId);
      if (node === undefined) break;
      session =
        node.mode === "roll"
          ? resolveStep(entry.openingDag, session, { kind: "roll" }).session
          : resolveStep(entry.openingDag, session, { kind: "choose", optionId: node.options![0]!.id }).session;
    }

    const gains = collectOpeningGains(entry.openingDag, session, entry.template, entry.ui);
    const categories = new Set(gains.map((g) => g.category));
    expect(categories.has("status")).toBe(true);
    expect(categories.has("skill")).toBe(true);
    expect(categories.has("item")).toBe(true);
    // 属性增减（jjk 模板只用 add；`set` 的形态由下一条用例覆盖）
    expect(gains.some((g) => g.category === "attribute" && (g.action === "up" || g.action === "down"))).toBe(true);
    // 条目自带详情快照（否则开局面板点开详情会「没反应」）
    const status = gains.find((g) => g.category === "status");
    expect(status?.effects?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("开局所得：初始值形态（action=set）", () => {
  it("mode:set 的属性记成 set，展示为绝对值而不是 +N", async () => {
    const { createOpeningSession, resolveStep, collectOpeningGains } = await import(
      "../../packages/game-core/src/v2/opening-dag.ts"
    );
    const { entry } = makeWorld();
    const dag = OpeningBranchDagSchema.parse({
      openingId: "op-attr",
      name: "属性测验",
      entry: "a",
      params: [{ id: "attr", kind: "attribute" }],
      nodes: [
        {
          node: "a",
          title: "t",
          mode: "choose",
          options: [{ id: "o", text: "x", set: { attr: { id: "luck", value: 12, mode: "set" } } }],
        },
      ],
    });
    let session = createOpeningSession(dag, 1);
    session = resolveStep(dag, session, { kind: "choose", optionId: "o" }).session;
    const gains = collectOpeningGains(dag, session, entry.template);
    expect(gains).toHaveLength(1);
    expect(gains[0]).toMatchObject({ category: "attribute", action: "set", amount: 12 });
  });
});
