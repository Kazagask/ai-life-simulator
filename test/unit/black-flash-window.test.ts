import { describe, expect, it } from "vitest";
import {
  createBattle,
  createLookup,
  createWorldV2,
  performBattleAction,
  projectSnapshotV2,
  type WorldStateV2,
} from "@life-sim/game-core";
import type { WorldTemplateV2 } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function loadEntry() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

/**
 * 黑闪（2026-11-24 用户裁决）：**世界通用规则**，不是天赋、也不是术式。
 *
 * 它挂在 `world.combat.hooks`：任何人只要打出暴击（`when: [{ crit: true }]`），
 * 再按「咒力操作 × 0.3%」掷第二道骰；命中就把这次暴击的倍率按 2.5 次方放大
 * （1.5^2.5 ≈ 2.755），并留下 `black-flash` 余韵。
 *
 * **天赋只负责记录成长**（进度 / 阶梯 / 加点），不再放行这一击 ——
 * 所以下面有一条用例专门验「没有天赋也能打出黑闪」。
 *
 * 用例里把世界的暴击率拉到 100%、并去掉第二道资质骰 —— 要验的是「暴击之后的倍率
 * 与余韵」，不是「四十分之一的运气」。
 */
function battle(opts: { talent: boolean; seed?: number; keepChance?: boolean; blackFlash?: boolean }): {
  state: WorldStateV2;
  template: WorldTemplateV2;
  lookup: ReturnType<typeof createLookup>;
} {
  const seed = opts.seed ?? 7;
  const entry = loadEntry();
  const template = structuredClone(entry.template);
  template.combat = { ...(template.combat ?? {}), crit: { chance: 1, multiplier: 1.5 } };
  // 黑闪挂在**世界**上（2026-11-24）：天赋不再是放行条件
  const bfHook = template.combat.hooks?.find((h) => h.id === "black-flash");
  if (bfHook === undefined) throw new Error("world.combat.hooks 缺 black-flash");
  // 大多数用例要验「暴击之后」，把第二道资质骰固定掉；资质骰本身单独一条用例。
  if (opts.keepChance !== true) bfHook.when = [{ crit: true }];
  // 少数用例要一个「干净的暴击」：把世界钩子摘掉
  if (opts.blackFlash === false) {
    template.combat.hooks = (template.combat.hooks ?? []).filter((h) => h.id !== "black-flash");
  }

  const lookup = createLookup(template);
  const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed }, template, `w-bf-${seed}`);
  if (!state.player.skills.includes("sk-basic-strike")) state.player.skills.push("sk-basic-strike");
  if (opts.talent) {
    state.player.statuses.push({ statusId: "t-black-flash", stacks: 1, appliedTurn: 0, appliedAt: 0 });
  }
  state.battle = createBattle("ev:bf", { enemies: [{ ref: "enemy-grade2-curse" }] }, state, lookup);
  return { state, template, lookup };
}

function strikeDamage(opts: { talent: boolean }): number {
  const { state, lookup } = battle(opts);
  performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);
  const event = state.battle!.events?.find((e) => e.kind === "damage");
  if (event?.kind !== "damage") throw new Error("没有伤害事件");
  return event.amount;
}

describe("黑闪：暴击之后的第二道判定", () => {
  it("世界规则：**没有天赋**也能打出黑闪（2.5 次方）", () => {
    // 体术打击固定 8 点：8 × 1.5^2.5 = 22.04 → 22。
    // 天赋不再放行这一击 —— 这里刻意不带 `t-black-flash`。
    expect(strikeDamage({ talent: false })).toBe(22);
    // 对照组：把世界钩子摘掉，才回到普通暴击的 12
    const { state, lookup } = battle({ talent: false, blackFlash: false });
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);
    const event = state.battle!.events?.find((e) => e.kind === "damage");
    expect(event?.kind === "damage" ? event.amount : 0).toBe(12);
  });

  it("黑闪要过第二道资质骰：资质 0 时暴击也不会黑闪", () => {
    const hit = (aptitude: number): { damage: number; flashed: boolean } => {
      // 不带天赋：天赋本身在阶 1 就给了咒力操作补正，测「资质 0」必须用白板角色
      const { state, lookup } = battle({ talent: false, seed: 13, keepChance: true });
      state.player.attributes.cursedEnergyTotal = aptitude;
      /**
       * 骰序：命中 → 闪避 → 暴击 → 黑闪。敏捷闪避（ADR-074）让「恒 0」不再能打中人
       * （0 永远小于任何闪避率），所以第二颗骰给 0.9，其余给 0。
       */
      let call = 0;
      performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => {
        call += 1;
        return call === 2 ? 0.9 : 0;
      });
      const event = state.battle!.events?.find((e) => e.kind === "damage");
      if (event?.kind !== "damage") throw new Error("没有伤害事件");
      return {
        damage: event.amount,
        flashed: state.battle!.log.some((line) => line.includes("黑闪")),
      };
    };

    // rng 恒 0 ⇒ 暴击必中、资质骰也必中；操作 40（总量 100）⇒ 12% > 0。
    // 总量 0 ⇒ 操作 0 ⇒ 概率 0，掷不出来。
    expect(hit(100)).toEqual({ damage: 22, flashed: true });
    expect(hit(0)).toEqual({ damage: 12, flashed: false });
  });

  it("黑闪留下两回合的余韵，镜像与投影都能看见", () => {
    const { state, template, lookup } = battle({ talent: true });
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);

    const mirror = state.battle!.player.statuses.find((s) => s.statusId === "black-flash");
    expect(mirror, "战斗镜像里应该有黑闪余韵").toBeDefined();
    // 2026-11-23：层数无上限、撑到战斗结束（没有 roundsLeft）。
    expect(mirror!.roundsLeft).toBeUndefined();

    const snap = projectSnapshotV2(state, template, lookup);
    expect(snap.battle?.player.statuses.some((s) => s.id === "black-flash")).toBe(true);
    expect(snap.player.statuses.some((s) => s.id === "black-flash")).toBe(true);
  });

  it("下一击吃到余韵的 +50%（同一骰子下比没有余韵更疼）", () => {
    const strikeAfterWindow = (withWindow: boolean): number => {
      const { state, lookup } = battle({ talent: true, seed: 11, blackFlash: withWindow });
      if (withWindow) {
        // 第一击打出余韵；第二击才是被放大的那一下。
        performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);
      }
      const before = state.battle!.enemies[0]!.hp;
      performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);
      return before - state.battle!.enemies[0]!.hp;
    };

    const boosted = strikeAfterWindow(true);
    const plain = strikeAfterWindow(false);
    // 没有天赋的一条：两击都只吃 1.5x（8 → 12）；有余韵的一条：第二击 8 × 1.5 × 1.5^2.5 ≈ 33。
    expect(plain).toBe(12);
    expect(boosted).toBe(33);
  });
});
