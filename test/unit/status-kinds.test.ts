import { describe, expect, it } from "vitest";
import { WorldTemplateV2Schema, type WorldTemplateV2 } from "@life-sim/shared";
import { createWorldV2, derivedAttributeKeys, derivedAttributeValues, effectiveAttributesOfActor, statusTotalsOf } from "@life-sim/game-core";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * ADR-018 · 状态三类（talent / battle / modifier）。
 *
 * 这一组测的是**加载期约束**与**状态合计**：三条边界（谁能施加谁、谁能挂载、
 * 谁能折算成谁）如果只写在文档里，第一个破坏它的就是下一次改模板的人。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function loadEntry() {
  const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function expectRejected(template: WorldTemplateV2, fragment: string): void {
  const parsed = WorldTemplateV2Schema.safeParse(template);
  expect(parsed.success).toBe(false);
  const messages = parsed.success ? [] : parsed.error.issues.map((i) => i.message);
  expect(messages.join("\n")).toContain(fragment);
}

describe("ADR-018 · 三类的加载期约束", () => {
  const entry = loadEntry();
  const base = (): WorldTemplateV2 => clone(entry.template);

  it("天赋不写 stacking（不是写 unique，是连字段都不该出现）", () => {
    const template = base();
    const sixEyes = template.statuses.find((s) => s.id === "six-eyes")!;
    const withStacking = { ...sixEyes, stacking: "unique" } as unknown as (typeof template.statuses)[number];
    template.statuses = [...template.statuses.filter((s) => s.id !== "six-eyes"), withStacking];
    expectRejected(template, "talent 不写 stacking");
  });

  it("战斗态不能有 simulation 面", () => {
    const template = base();
    const stun = template.statuses.find((s) => s.id === "stun")!;
    template.statuses = template.statuses.map((s) =>
      s.id === "stun" ? ({ ...stun, simulation: { moodDeltaPerTurn: -1 } } as typeof s) : s,
    );
    expectRejected(template, "battle 不能有 simulation 面");
  });

  it("战斗态必须有点用：combat 或 toModifier 至少一个", () => {
    const template = base();
    const stun = template.statuses.find((s) => s.id === "stun")!;
    const hollow = { ...stun } as Record<string, unknown>;
    delete hollow.combat;
    template.statuses = template.statuses.map((s) => (s.id === "stun" ? (hollow as typeof s) : s));
    expectRejected(template, "battle 需要 combat 面或 toModifier");
  });

  it("toModifier 只能指向 modifier", () => {
    const template = base();
    template.statuses = template.statuses.map((s) =>
      s.id === "battle-cursed-burn" ? { ...s, toModifier: { id: "stun", timePerRound: { value: 1, unit: "day" } } } : s,
    );
    expectRejected(template, "toModifier 只能指向 kind: modifier");
  });

  it("世界效果不能施加 battle（模拟域里没有「战斗结束」这个边界）", () => {
    const template = base();
    template.items = template.items.map((item, i) =>
      i === 0
        ? { ...item, use: [{ type: "applyStatus", status: "domain-active", duration: { value: 1, unit: "day" } }] as typeof item.use }
        : item,
    );
    expectRejected(template, "世界效果不能施加 kind: battle");
  });

  it("战斗技能不能施加 modifier（旧写法「战斗中施加 2 天」已退役）", () => {
    const template = base();
    template.skills = template.skills.map((s) =>
      s.id === "sk-basic-strike" && s.kind === "combat"
        ? { ...s, applyStatus: [{ status: "cursed-burn", duration: { rounds: 2 } }] as typeof s.applyStatus }
        : s,
    );
    expectRejected(template, "战斗只能施加 kind: battle");
  });

  it("挂载只能是 talent / modifier", () => {
    const template = base();
    template.characters = template.characters.map((c, i) => (i === 0 ? { ...c, statuses: ["domain-active"] } : c));
    expectRejected(template, "挂载只能是 talent / modifier");
  });
});

describe("ADR-018 · 状态合计（一张账本）", () => {
  const entry = loadEntry();

  function worldWith(ids: string[]) {
    const template = clone(entry.template);
    const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed: 5 }, template, "w-ledger");
    for (const id of ids) {
      state.player.statuses.push({ statusId: id, stacks: 1, appliedTurn: 0, appliedAt: state.worldTime });
    }
    return { state, template };
  }

  it("六眼：效率 +90 走属性通道（mp 消耗由派生属性承担）", () => {
    const { state } = worldWith(["six-eyes"]);
    const channels = statusTotalsOf(state, entry.lookup);
    const eff = channels.find((c) => c.id === "attr:cursedEnergyEfficiency");
    expect(eff?.total).toBeCloseTo(90);
    expect(eff?.sources.map((s) => s.name)).toContain("六眼");
    // 状态不再直接写 costMultiplier：这条通道现在是空的（派生属性在算账，不在状态上）。
    expect(channels.find((c) => c.id === "cost:mp")).toBeUndefined();
  });

  it("属性通道的总值就是结算用的值：有效值 − 基础值（派生属性用「公式裸值」作基础）", () => {
    const { state } = worldWith(["six-eyes"]);
    const derived = derivedAttributeKeys(entry.template);
    const total = statusTotalsOf(state, entry.lookup).filter(
      (c) => c.id.startsWith("attr:") && !derived.has(c.id.slice("attr:".length)),
    );
    const eff = effectiveAttributesOfActor(state, entry.lookup, state.player);
    for (const channel of total) {
      const key = channel.id.slice("attr:".length);
      const baseValue = state.player.attributes[key] as number;
      expect(channel.total).toBe(eff[key]! - baseValue);
    }
    // 派生通道：总值 = 有效值 − 不含补正的公式值（六眼的效率 +60 就是这么来的）。
    const bare = derivedAttributeValues(state.player.attributes, entry.template);
    for (const channel of statusTotalsOf(state, entry.lookup)) {
      const key = channel.id.slice("attr:".length);
      if (!derived.has(key)) continue;
      expect(channel.total).toBe(eff[key]! - (bare[key] ?? 0));
    }
  });

  it("心情档位的贡献走残差项，不另起一套算法", () => {
    const { state } = worldWith(["six-eyes"]);
    state.player.mood = 5; // 消沉档：属性被压，但那条状态不来自任何 status
    const residual = statusTotalsOf(state, entry.lookup)
      .filter((c) => c.id.startsWith("attr:"))
      .flatMap((c) => c.sources)
      .find((s) => s.name === "装备 / 心情");
    expect(residual).toBeDefined();
  });

  it("没有状态时不下发零值通道", () => {
    const { state } = worldWith([]);
    expect(statusTotalsOf(state, entry.lookup).every((c) => c.total !== 0)).toBe(true);
  });
});
