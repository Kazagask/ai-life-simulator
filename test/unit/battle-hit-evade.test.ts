import { describe, expect, it } from "vitest";
import { createBattle, createWorldV2, performBattleAction, skillEffectSummaries, statusEffectSummaries, type WorldStateV2 } from "@life-sim/game-core";
import { SkillSchema } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function loadEntry() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

/** 与五条对打：他身上带「无下限」（闪避 100%）。 */
function gojoBattle(seed = 5): { state: WorldStateV2; entry: ReturnType<typeof loadEntry> } {
  const entry = loadEntry();
  const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed }, entry.template, `w-evade-${seed}`);
  for (const id of ["sk-basic-strike", "sk-domain-empty", "sk-reverse-heal"]) {
    if (!state.player.skills.includes(id)) state.player.skills.push(id);
  }
  state.player.mp = 200;
  state.battle = createBattle("ev:test", { enemies: [{ ref: "npc-gojo" }] }, state, entry.lookup);
  return { state, entry };
}

const gojoHp = (state: WorldStateV2): number => state.battle!.enemies[0].hp;

describe("闪避与必中（ADR-008 D1）", () => {
  it("无下限：命中判定过了也打不到（闪避 100%）", () => {
    const { state, entry } = gojoBattle();
    const before = gojoHp(state);
    // rng 恒为 0 ⇒ 命中骰必过（`0 >= chance` 为假）、闪避骰必中（`0 < 1`）。
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, entry.lookup, () => 0);

    expect(gojoHp(state)).toBe(before);
    expect(state.battle!.log.some((l) => l.includes("无下限") && l.includes("隔在了外面"))).toBe(true);
  });

  it("领域是必中：无量空处绕过无下限照常造成伤害（伤害不会被阵营状态擦掉）", () => {
    const { state, entry } = gojoBattle();
    const before = gojoHp(state);
    performBattleAction(state, { type: "skill", skillId: "sk-domain-empty" }, entry.lookup, () => 0);

    // 同一个技能既打全体伤害又给全体挂压制：旧实现里阵营状态收尾时用旧快照回写，
    // 刚算出的伤害被擦回原值（日志说「造成 35 点伤害」，血量不动）。
    expect(gojoHp(state)).toBeLessThan(before);
    expect(state.battle!.enemies[0].statuses.some((s) => s.statusId === "domain-pin")).toBe(true);
  });

  it("闪避只挡攻击，不挡自己的治疗（带无下限也能给自己回血）", () => {
    const { state, entry } = gojoBattle();
    state.player.statuses.push({ statusId: "infinity", stacks: 1, appliedTurn: 0 });
    // 让他这一回合动不了：否则他反手一击就把玩家打进败北，血量被 checkBattleEnd 按 1 兜底。
    state.battle!.enemies[0].statuses.push({ statusId: "stun", stacks: 1, appliedTurn: 0 });
    state.battle!.player.hp = 1;
    performBattleAction(state, { type: "skill", skillId: "sk-reverse-heal" }, entry.lookup, () => 0);

    expect(state.battle!.player.hp).toBeGreaterThan(1);
  });

  it("必中与命中骰互斥：同时写直接拒载", () => {
    const bad = {
      id: "sk-bad",
      kind: "combat" as const,
      name: "矛盾",
      cost: { mp: 0 },
      target: "enemy" as const,
      hit: "guaranteed" as const,
      hitCheck: { preset: "opposed" as const, attacker: "cursedEnergy", defender: "agility", baseChance: 0.7 },
      damage: [{ preset: "fixed" as const, value: 1 }],
      cooldownTurns: 0,
      usableInBattle: true as const,
    };
    expect(SkillSchema.safeParse(bad).success).toBe(false);
  });

  it("展示层把闪避与必中写出来（不是混进命中百分比）", () => {
    const entry = loadEntry();
    const infinity = entry.lookup.status("infinity");
    if (!infinity) throw new Error("infinity 缺失");
    // ADR-015 D1：战斗面统一带「战斗中」前缀（同一面板里模拟面也在写「每回合」）。
    expect(statusEffectSummaries(infinity, entry.lookup).map((e) => e.text)).toContain("战斗中闪避 +100%");

    const domain = entry.lookup.skill("sk-domain-empty");
    if (domain === undefined) throw new Error("sk-domain-empty 缺失");
    expect(skillEffectSummaries(domain, entry.lookup).map((e) => e.text)).toContain("必中：跳过命中判定与闪避");
  });
});
