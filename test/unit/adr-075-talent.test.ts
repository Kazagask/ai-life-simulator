import { describe, expect, it } from "vitest";
import {
  advanceTalent,
  applyStatusToPlayer,
  createLookup,
  createRng,
  createWorldV2,
  effectiveAttributes,
  statusFor,
} from "@life-sim/game-core";
import { WorldTemplateV2Schema, type StatusEffect, type WorldTemplateV2 } from "@life-sim/shared";
import { fixtureEntry } from "../helpers/world.ts";

/**
 * ADR-075 §7：成长型天赋（progress + tiers）。
 *
 * 守四件事：
 * 1. 阶效果是**替换**（不是叠加），投影与结算读同一份 `statusFor`；
 * 2. 非成长授予只初始化进度，**不补发**阶 grant；
 * 3. `advanceTalent` 跨阶按顺序结算 grant，每阶只发一次；
 * 4. 同批跨两阶、两阶都给加点 ⇒ **合并成一笔**（2026-11-24 用户裁决：黑闪不再夹层数，
 *    一场连闪四下会一次跨过 1/4/8 三阶；逐阶发会在单条 `pendingAllocation` 上撞车）。
 */

const GROWTH: StatusEffect = {
  id: "t-growth",
  name: "成长测试",
  kind: "talent",
  polarity: "positive",
  visibility: "known",
  attributeModifiers: { agility: 1 },
  progress: { label: "觉醒", max: 10, initial: 1 },
  tiers: [
    { at: 1, tier: "blue", effects: { attributeModifiers: { agility: 1 } } },
    {
      at: 3,
      tier: "purple",
      effects: { attributeModifiers: { agility: 3 }, grant: [{ type: "adjustMood", value: 5 }] },
    },
    { at: 6, tier: "pink", effects: { attributeModifiers: { agility: 6 } } },
  ],
};

const CONFLICT: StatusEffect = {
  id: "t-conflict",
  name: "连续跨阶",
  kind: "talent",
  polarity: "positive",
  visibility: "known",
  progress: { max: 10 },
  tiers: [
    {
      at: 1,
      tier: "blue",
      effects: { grant: [{ type: "grantAllocation", id: "ca-1", budget: 1, targets: [{ attribute: "agility" }] }] },
    },
    {
      at: 2,
      tier: "purple",
      effects: { grant: [{ type: "grantAllocation", id: "ca-2", budget: 1, targets: [{ attribute: "agility" }] }] },
    },
  ],
};

function worldWith(extra: StatusEffect[]): {
  state: ReturnType<typeof createWorldV2>;
  lookup: ReturnType<typeof createLookup>;
} {
  const base = fixtureEntry().template;
  const template: WorldTemplateV2 = structuredClone(base);
  template.statuses.push(...structuredClone(extra));
  const lookup = createLookup(template);
  const state = createWorldV2(
    { templateId: "p0", playerName: "测试", seed: 41 },
    template,
    "w-adr075-t3",
  );
  state.openingCompleted = true;
  return { state, lookup };
}

describe("ADR-075 §7 · 进度与阶", () => {
  it("applyStatus 只初始化进度：initial 1 ⇒ 蓝色阶，但不补发 grant", () => {
    const { state, lookup } = worldWith([GROWTH]);
    const moodBefore = state.player.mood;
    applyStatusToPlayer(state, "t-growth", 1, lookup);

    const inst = state.player.statuses.find((s) => s.statusId === "t-growth")!;
    expect(inst.progress).toBe(1);
    expect(inst.tiersApplied).toBe(1);
    expect(state.player.mood).toBe(moodBefore); // 阶 1 没有 grant；阶 3 的 +5 也不该提前发
    expect(effectiveAttributes(state.player.attributes, state.player.statuses, state.player.mood, lookup).agility).toBe(6);
    expect(statusFor(lookup.status("t-growth"), inst)?.quality).toBe("blue");
  });

  it("advanceTalent 跨阶：阶效果替换、grant 只发一次、quality 跟着走", () => {
    const { state, lookup } = worldWith([GROWTH]);
    applyStatusToPlayer(state, "t-growth", 1, lookup);
    const ctx = { state, lookup, rng: createRng(1) };

    advanceTalent(ctx, "t-growth", 2, false); // 1 → 3
    let inst = state.player.statuses.find((s) => s.statusId === "t-growth")!;
    expect(inst.progress).toBe(3);
    expect(inst.tiersApplied).toBe(2);
    expect(state.player.mood).toBe(65); // 阶 3 的 +5
    expect(effectiveAttributes(state.player.attributes, state.player.statuses, state.player.mood, lookup).agility).toBe(8);
    expect(statusFor(lookup.status("t-growth"), inst)?.quality).toBe("purple");

    advanceTalent(ctx, "t-growth", 1, false); // 3 → 4：仍在阶 3，不再发 grant
    inst = state.player.statuses.find((s) => s.statusId === "t-growth")!;
    expect(inst.progress).toBe(4);
    expect(state.player.mood).toBe(65);
  });

  it("create: true 从 0 起算：第一次觉醒只发一次阶 1", () => {
    const { state, lookup } = worldWith([GROWTH]);
    advanceTalent({ state, lookup, rng: createRng(2) }, "t-growth", 1, true);
    const inst = state.player.statuses.find((s) => s.statusId === "t-growth")!;
    expect(inst.progress).toBe(1);
    expect(inst.tiersApplied).toBe(1);
    expect(state.player.mood).toBe(60); // 阶 1 本身没有 grant
  });

  it("进度夹 max：到顶后再推进不越界", () => {
    const { state, lookup } = worldWith([GROWTH]);
    applyStatusToPlayer(state, "t-growth", 1, lookup);
    advanceTalent({ state, lookup, rng: createRng(3) }, "t-growth", 100, false);
    const inst = state.player.statuses.find((s) => s.statusId === "t-growth")!;
    expect(inst.progress).toBe(10);
    expect(inst.tiersApplied).toBe(3);
  });

  it("同批跨两阶、两阶都给加点 ⇒ 合并成一笔（预算相加、目标去重）", () => {
    const { state, lookup } = worldWith([CONFLICT]);
    advanceTalent({ state, lookup, rng: createRng(4) }, "t-conflict", 2, true);

    const pending = state.pendingAllocation;
    expect(pending).toBeDefined();
    expect(pending?.budget).toBe(2); // ca-1 + ca-2
    expect(pending?.targets.map((t) => t.attribute)).toEqual(["agility"]); // 去重
  });
});

describe("ADR-075 §7 · 加载期校验", () => {
  function parseWith(status: unknown) {
    const template = structuredClone(fixtureEntry().template) as unknown as {
      statuses: unknown[];
    };
    template.statuses.push(status);
    return WorldTemplateV2Schema.safeParse(template);
  }

  it("有 tiers 必须有 progress", () => {
    const parsed = parseWith({ ...GROWTH, progress: undefined });
    expect(parsed.success).toBe(false);
  });

  it("tiers.at 必须严格递增", () => {
    const parsed = parseWith({
      ...GROWTH,
      tiers: [
        { at: 3, tier: "blue", effects: {} },
        { at: 2, tier: "purple", effects: {} },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("grant 里不能再写 advanceTalent（递归）", () => {
    const parsed = parseWith({
      ...GROWTH,
      tiers: [
        {
          at: 1,
          tier: "blue",
          effects: { grant: [{ type: "advanceTalent", talent: "t-growth", amount: 1 }] },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});
