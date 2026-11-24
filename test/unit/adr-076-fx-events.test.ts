import { describe, expect, it } from "vitest";
import { createBattle, createLookup, createWorldV2, performBattleAction, type WorldStateV2 } from "@life-sim/game-core";
import type { BattleEvent, WorldTemplateV2 } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function loadEntry() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

/** 暴击率拉满的模板副本：要验的是「事件长什么样」，不是四十分之一的运气。 */
function battleOf(opts: { talent?: boolean; enemy?: string; seed?: number }): {
  state: WorldStateV2;
  template: WorldTemplateV2;
  lookup: ReturnType<typeof createLookup>;
} {
  const seed = opts.seed ?? 11;
  const entry = loadEntry();
  const template = structuredClone(entry.template);
  template.combat = { ...(template.combat ?? {}), crit: { chance: 1, multiplier: 1.5 } };
  // 黑闪是**世界规则**（world.combat.hooks），不再是天赋上的钩子
  const bfHook = template.combat?.hooks?.find((h) => h.id === "black-flash");
  if (bfHook === undefined) throw new Error("world.combat.hooks 缺 black-flash");
  if (opts.talent === true) {
    // 要验黑闪：把资质骰固定掉
    bfHook.when = [{ crit: true }];
  } else {
    // 不要黑闪：摘掉这条**世界**钩子，否则任何暴击都会被放大成 critTier 2
    template.combat!.hooks = (template.combat?.hooks ?? []).filter((h) => h.id !== "black-flash");
  }

  const lookup = createLookup(template);
  const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed }, template, `w-fx-${seed}`);
  if (!state.player.skills.includes("sk-basic-strike")) state.player.skills.push("sk-basic-strike");
  if (opts.talent === true) {
    state.player.statuses.push({ statusId: "t-black-flash", stacks: 1, appliedTurn: 0, appliedAt: 0 });
  }
  state.battle = createBattle("ev:fx", { enemies: [{ ref: opts.enemy ?? "enemy-grade2-curse" }] }, state, lookup);
  return { state, template, lookup };
}

const eventsOf = (state: WorldStateV2): BattleEvent[] => state.battle?.events ?? [];
/** 只取玩家打出的伤害：敌方在回合末尾也会还手，不能拿「最后一条」当结论。 */
const playerDamage = (state: WorldStateV2) => {
  const list = eventsOf(state).filter((e) => e.kind === "damage" && e.actor === state.player.id);
  const last = list.at(-1);
  if (last?.kind !== "damage") throw new Error("玩家没有造成伤害");
  return last;
};

describe("ADR-076 §9/§10 结构化战斗事件", () => {
  it("damage 带 seq / skillId，普通暴击是 critTier 1", () => {
    const { state, lookup } = battleOf({});
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);

    const dmg = playerDamage(state);
    expect(dmg.skillId).toBe("sk-basic-strike");
    expect(dmg.critical).toBe(true);
    expect(dmg.critTier).toBe(1);
    expect(dmg.amplifiedBy).toBeUndefined();
    expect(typeof dmg.seq).toBe("number");
    expect(dmg.seq).toBeGreaterThan(0);
  });

  it("黑闪：被钩子放大的暴击是 critTier 2，并记下 amplifiedBy", () => {
    const { state, lookup } = battleOf({ talent: true });
    let call = 0;
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => {
      call += 1;
      return 0.5;
    });

    const dmg = playerDamage(state);
    expect(dmg.critical).toBe(true);
    expect(dmg.critTier).toBe(2);
    expect(dmg.amplifiedBy).toBe("black-flash");
  });

  it("seq 单调递增，且不因 events 截断而回退", () => {
    const { state, lookup } = battleOf({ enemy: "enemy-grade2-curse" });
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);
    const first = eventsOf(state).at(-1)?.seq ?? 0;
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);
    const second = eventsOf(state).at(-1)?.seq ?? 0;

    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(state.battle?.eventSeq).toBe(second);
  });

  it("闪避：产生 miss(evade)，没有 damage —— 前端据此画断线与 MISS", () => {
    const entry = loadEntry();
    const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed: 5 }, entry.template, "w-fx-evade");
    if (!state.player.skills.includes("sk-basic-strike")) state.player.skills.push("sk-basic-strike");
    state.battle = createBattle("ev:fx", { enemies: [{ ref: "npc-gojo" }] }, state, entry.lookup);
    // 2006 年的五条没有常时无下限：手动挂上，让闪避变成 100%
    state.battle.enemies[0]?.statuses.push({
      statusId: "infinity",
      stacks: 1,
      appliedTurn: state.turnIndex,
      appliedAt: state.worldTime,
    });

    let call = 0;
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, entry.lookup, () => {
      call += 1;
      return call === 1 ? 0.01 : 0.5; // 命中骰过，闪避门被 100% 拦下
    });

    const miss = eventsOf(state).find((e) => e.kind === "miss");
    expect(miss).toBeDefined();
    if (miss?.kind !== "miss") throw new Error("unreachable");
    expect(miss.stage).toBe("evade");
    expect(miss.skillId).toBe("sk-basic-strike");
    expect(eventsOf(state).some((e) => e.kind === "damage" && e.actor === state.player.id)).toBe(false);
  });
});
