import { describe, expect, it } from "vitest";
import {
  advanceTalent,
  applyStatusToPlayer,
  createLookup,
  createRng,
  createWorldV2,
  resolveDeathRoute,
  statusFor,
} from "@life-sim/game-core";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * ADR-075 §7 + §5：jjk-2006 的数据面。
 *
 * 守三件事：
 * 1. 黑闪天赋真正带上了 `progress + tiers`，且常驻战斗钩子不会被阶效果抹掉；
 * 2. 挡枪败北由 `deathRoutes` 直接指向早夭（不再靠 worldState 终止条件）；
 * 3. 模板加载期没有因为新协议报错。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function jjk() {
  const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  const state = createWorldV2(
    { templateId: "jjk-2006", playerName: "测试", seed: 91 },
    entry.template,
    "w-adr075-jjk",
  );
  state.openingCompleted = true;
  return { entry, state };
}

describe("ADR-075 · jjk-2006 数据", () => {
  it("黑闪：初始 1 = 紫阶；触发规则在世界层，不在这条天赋上", () => {
    const { entry, state } = jjk();
    applyStatusToPlayer(state, "t-black-flash", 1, entry.lookup);
    const inst = state.player.statuses.find((s) => s.statusId === "t-black-flash")!;
    expect(inst.progress).toBe(1);
    expect(inst.tiersApplied).toBe(1);

    const def = entry.lookup.status("t-black-flash")!;
    const effective = statusFor(def, inst)!;
    expect(effective.quality).toBe("purple");
    /**
     * 2026-11-24 用户裁决：黑闪是**世界通用规则**（`world.combat.hooks`），
     * 不是天赋的常驻钩子 —— 没这条天赋的人照样能触发，天赋只负责记成长。
     */
    expect(effective.combat?.hooks?.some((h) => h.id === "black-flash")).toBeFalsy();
    expect(entry.template.combat?.hooks?.some((h) => h.id === "black-flash")).toBe(true);
  });

  it("黑闪 1 → 4：粉阶 + 2 点加点", () => {
    const { entry, state } = jjk();
    applyStatusToPlayer(state, "t-black-flash", 1, entry.lookup);
    advanceTalent({ state, lookup: entry.lookup, rng: createRng(1) }, "t-black-flash", 3, false);

    const inst = state.player.statuses.find((s) => s.statusId === "t-black-flash")!;
    expect(inst.progress).toBe(4);
    expect(inst.tiersApplied).toBe(2);
    expect(statusFor(entry.lookup.status("t-black-flash"), inst)?.quality).toBe("pink");
    expect(state.pendingAllocation?.id).toBe("bf-4");
    expect(state.pendingAllocation?.budget).toBe(2);
  });

  it("挡枪败北：deathRoutes 直接引用早夭", () => {
    const { entry, state } = jjk();
    state.flags.hvEarlyDeath = true;
    const hit = resolveDeathRoute(
      state,
      entry.template.deathRoutes ?? [],
      { state, lookup: entry.lookup, rng: createRng(2) },
      "battle",
      undefined,
    );
    expect(hit.action).toEqual({ kind: "ending", endingId: "end-hv-early-death" });
  });

  it("没有 flag 的死斗走兜底，也不会抛 death_route_missing", () => {
    const { entry, state } = jjk();
    const hit = resolveDeathRoute(
      state,
      entry.template.deathRoutes ?? [],
      { state, lookup: entry.lookup, rng: createRng(3) },
      "battle",
      undefined,
    );
    expect(hit.route.id).toBe("default-death");
  });
});
