import { describe, expect, it } from "vitest";
import {
  battleActionV2,
  createBattle,
  createLookup,
  createWorldV2,
  effectiveAttributesOfActor,
  projectSnapshotV2,
} from "@life-sim/game-core";
import type { WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * ADR-077：战斗结束后的停留与战评。
 *
 * 以前判定出 `over` 就在同一个动作里跑战评 / 收场 / 槽位结算 / `nextTurn`，
 * 前端收到的快照里 `battle` 已经是 null —— 最后一击的特效刚起手就被换掉，
 * 玩家既看不到收尾，也看不到战评。
 *
 * 现在：`over` 那一刻只算战评并停住，`{type:"leave"}` 才推进世界。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function loadEntry() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

function setup(opts: { talent?: boolean; crit?: boolean; stacks?: number } = {}): {
  state: WorldStateV2;
  template: WorldTemplateV2;
  lookup: ReturnType<typeof createLookup>;
} {
  const entry = loadEntry();
  const template: WorldTemplateV2 = structuredClone(entry.template);
  // 黑闪是**世界规则**：要验它就把资质骰固定掉，不要验就把整条钩子摘掉
  const hook = template.combat?.hooks?.find((h) => h.id === "black-flash");
  if (hook === undefined) throw new Error("world.combat.hooks 缺 black-flash");
  if (opts.crit === true) {
    template.combat = { ...(template.combat ?? {}), crit: { chance: 1, multiplier: 1.5 } };
    hook.when = [{ crit: true }];
  } else {
    template.combat = { ...(template.combat ?? {}), crit: { chance: 0, multiplier: 1.5 } };
    template.combat.hooks = (template.combat.hooks ?? []).filter((h) => h.id !== "black-flash");
  }

  const lookup = createLookup(template);
  const state = createWorldV2(
    { templateId: "jjk-2006", playerName: "测试", seed: 77 },
    template,
    "w-adr077",
  );
  state.openingCompleted = true;
  if (!state.player.skills.includes("sk-basic-strike")) state.player.skills.push("sk-basic-strike");
  if (opts.talent === true) {
    state.player.statuses.push({ statusId: "t-black-flash", stacks: 1, appliedTurn: 0, appliedAt: 0 });
  }
  // 一只纸糊的敌人：一击必倒，方便把战斗直接推到 over
  state.battle = createBattle("ev:fight", { enemies: [{ ref: "enemy-grade2-curse" }] }, state, lookup);
  state.battle.enemies[0]!.hp = 1;
  state.battle.enemies[0]!.maxHp = 1;
  if ((opts.stacks ?? 0) > 0) {
    // 黑闪余韵是 `stacking: stack`：多次触发落在**同一个实例**上累加层数
    state.battle.player.statuses.push({
      statusId: "black-flash",
      stacks: opts.stacks ?? 0,
      appliedTurn: 0,
      appliedAt: 0,
    });
  }
  return { state, template, lookup };
}

describe("ADR-077 · 战斗结束后停住", () => {
  it("打出 over 只算战评、不结算槽位；leave 才收场", () => {
    const { state, template, lookup } = setup();
    battleActionV2(state, { type: "skill", skillId: "sk-basic-strike" }, template, lookup);

    // 世界停在战斗界面：镜像还在、战评已算、还没收场
    expect(state.battle?.over).toBe("victory");
    expect(state.battle?.evaluation?.outcome).toBe("victory");
    expect(state.lastBattleResult).toBeUndefined();
    expect(state.battle).not.toBeNull();

    battleActionV2(state, { type: "leave" }, template, lookup);
    expect(state.battle).toBeNull();
    expect(state.lastBattleResult?.outcome).toBe("victory");
  });

  it("结束态下别的命令一律拒绝（技能 / 空过都不行）", () => {
    const { state, template, lookup } = setup();
    battleActionV2(state, { type: "skill", skillId: "sk-basic-strike" }, template, lookup);
    expect(state.battle?.over).toBe("victory");

    expect(() => battleActionV2(state, { type: "pass" }, template, lookup)).toThrow("battle_over");
    expect(() =>
      battleActionV2(state, { type: "skill", skillId: "sk-basic-strike" }, template, lookup),
    ).toThrow("battle_over");
  });

  it("战评只算一次：leave 不会把战评钩子再跑一遍", () => {
    const { state, template, lookup } = setup({ stacks: 2 });
    battleActionV2(state, { type: "skill", skillId: "sk-basic-strike" }, template, lookup);
    const afterOver = state.player.statuses.find((s) => s.statusId === "t-black-flash")?.progress ?? 0;
    battleActionV2(state, { type: "leave" }, template, lookup);
    const afterLeave = state.player.statuses.find((s) => s.statusId === "t-black-flash")?.progress ?? 0;
    expect(afterOver).toBe(2);
    expect(afterLeave).toBe(afterOver);
  });
});

describe("ADR-077 · 黑闪的成长", () => {
  it("没有天赋的人打出黑闪，战评后拿到可成长天赋「黑闪」", () => {
    const { state, template, lookup } = setup({ crit: true });
    expect(state.player.statuses.some((s) => s.statusId === "t-black-flash")).toBe(false);
    const before = effectiveAttributesOfActor(state, lookup, state.player).cursedEnergyControl ?? 0;

    battleActionV2(state, { type: "skill", skillId: "sk-basic-strike" }, template, lookup);
    const grown = state.player.statuses.find((s) => s.statusId === "t-black-flash");
    expect(grown).toBeDefined();
    expect(grown?.progress ?? 0).toBeGreaterThanOrEqual(1);

    // 阶 1 的咒力操作补正已经生效 ⇒ 下一次更容易打出黑闪
    const after = effectiveAttributesOfActor(state, lookup, state.player).cursedEnergyControl ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it("层数不设上限：一场闪 4 次就记 4 点（旧口径会夹在 3）", () => {
    const { state, template, lookup } = setup({ stacks: 4 });
    const amount = template.combat?.evaluation?.hooks
      ?.find((h) => h.id === "black-flash-growth")
      ?.effects.find((e) => e.type === "advanceTalent");
    expect(amount !== undefined && amount.type === "advanceTalent" ? amount.amount : undefined).toEqual({
      metric: "statusStacks",
      status: "black-flash",
    });

    battleActionV2(state, { type: "skill", skillId: "sk-basic-strike" }, template, lookup);
    const grown = state.player.statuses.find((s) => s.statusId === "t-black-flash");
    expect(grown?.progress).toBe(4);
  });
});

describe("ADR-079 · 成长进度按阶梯展示", () => {
  const progressOf = (progress: number) => {
    const entry = loadEntry();
    const template = structuredClone(entry.template);
    const lookup = createLookup(template);
    const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed: 5 }, template, "w-adr079");
    state.openingCompleted = true;
    state.player.statuses.push({
      statusId: "t-black-flash",
      stacks: 1,
      appliedTurn: 0,
      appliedAt: 0,
      progress,
      tiersApplied: 3,
    });
    const view = projectSnapshotV2(state, template, lookup).player.statuses.find((s) => s.id === "t-black-flash");
    return view?.progress;
  };

  it("1 → 1/4，5 → 4/8（分母是下一阶，不是抽象上限）", () => {
    expect(progressOf(1)).toEqual({ label: "觉醒次数", value: 1, current: 1, target: 4, done: false });
    expect(progressOf(5)).toEqual({ label: "觉醒次数", value: 5, current: 5, target: 8, done: false });
  });

  it("tier 样式跟着阶走：紫 → 粉 → 橙红（emoji 不是，是 ember）", () => {
    const entry = loadEntry();
    const ui = (entry as unknown as { ui?: Parameters<typeof projectSnapshotV2>[5] }).ui;
    const render = (progress: number) => {
      const template = structuredClone(entry.template);
      const lookup = createLookup(template);
      const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed: 9 }, template, "w-tier");
      state.openingCompleted = true;
      state.player.statuses = state.player.statuses.filter((s) => s.statusId !== "t-black-flash");
      state.player.statuses.push({
        statusId: "t-black-flash",
        stacks: 1,
        appliedTurn: 0,
        appliedAt: 0,
        progress,
        tiersApplied: 3,
      });
      return projectSnapshotV2(state, template, lookup, null, undefined, ui).player.statuses.find((s) => s.id === "t-black-flash");
    };
    // 阶上的 `tier` 是**品质键**，经 ui.qualityStyles 落到样式；丢了它就退回绿/金
    expect(render(1)?.style?.preset).toBe("purple");
    expect(render(4)?.style?.preset).toBe("pink");
    expect(render(8)?.style?.preset).toBe("ember");
  });

  it("到顶 → 8/8 已完成（进度再涨也不越过最后一阶）", () => {
    expect(progressOf(8)).toEqual({ label: "觉醒次数", value: 8, current: 8, target: 8, done: true });
    expect(progressOf(23)).toEqual({ label: "觉醒次数", value: 23, current: 8, target: 8, done: true });
  });
});
