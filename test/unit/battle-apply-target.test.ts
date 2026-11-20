import { describe, expect, it } from "vitest";
import {
  createBattle,
  createWorldV2,
  performBattleAction,
  skillEffectSummaries,
  type WorldStateV2,
} from "@life-sim/game-core";
import { WorldTemplateV2Schema, type CombatSkill } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function loadEntry() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

/** 两个二级咒灵的战场：本用例只关心「施加落在谁身上」，不打完。 */
function twoEnemyBattle(seed = 3): {
  state: WorldStateV2;
  entry: ReturnType<typeof loadEntry>;
  skill: CombatSkill;
} {
  const entry = loadEntry();
  const state = createWorldV2(
    { templateId: "jjk-2006", playerName: "测试", seed },
    entry.template,
    `w-apply-${seed}`,
  );
  const skill = entry.lookup.skill("sk-domain-empty");
  if (skill === undefined || skill.kind !== "combat") throw new Error("sk-domain-empty 缺失");
  if (!state.player.skills.includes(skill.id)) state.player.skills.push(skill.id);
  state.player.mp = 200;
  state.battle = createBattle(
    "ev:test",
    { enemies: [{ ref: "enemy-grade2-curse" }, { ref: "enemy-grade2-curse" }] },
    state,
    entry.lookup,
  );
  return { state, entry, skill };
}

const stacksOf = (list: readonly { statusId: string; stacks: number }[], id: string): number =>
  list.filter((s) => s.statusId === id).reduce((sum, s) => sum + s.stacks, 0);

describe("施加点收件人（ADR-006 D1）", () => {
  it("领域：自己一层领域展开，全体敌人各一层压制与眩晕", () => {
    const { state, entry } = twoEnemyBattle();
    performBattleAction(state, { type: "skill", skillId: "sk-domain-empty" }, entry.lookup, () => 0);

    // 旧实现在目标循环里判 onSelf ⇒ 两个敌人 = 自己叠两层。
    expect(stacksOf(state.battle!.player.statuses, "domain-active")).toBe(1);
    expect(state.battle!.enemies).toHaveLength(2);
    for (const enemy of state.battle!.enemies) {
      expect(stacksOf(enemy.statuses, "domain-pin")).toBe(1);
    }
    // 眩晕只撑一回合，结算后就被 tick 掉了 ⇒ 从战斗日志确认「每个敌人各中一次」。
    // （两只都是「二级咒灵」，日志里同名 ⇒ 只数条数。）
    expect(state.battle!.log.filter((l) => l.includes("陷入了「眩晕」"))).toHaveLength(2);
    // 自己身上不该沾敌人的那一份
    expect(stacksOf(state.battle!.player.statuses, "domain-pin")).toBe(0);
  });

  /**
   * 这条用例原先写「命中判定落空 ⇒ 敌人不掉血」，靠的是 `rng() => 0.999`。
   * 但无量空处从来就没掷过命中骰（无 `hitCheck` ⇒ 命中率 1），当时血量不变其实是
   * 另一个 bug：领域伤害刚算完就被阵营状态（`domain-pin`）用旧快照回写擦掉了。
   * 修掉回写（ADR-008）并把领域标成必中之后，这里改成断言**真相**：
   * 必中不吃命中骰，随机数再差也照样造成伤害，而「挂自己」那一份与命中无关。
   */
  it("必中技能不掷命中骰：随机数再差也照样命中，自身增益照挂", () => {
    const { state, entry } = twoEnemyBattle();
    performBattleAction(state, { type: "skill", skillId: "sk-domain-empty" }, entry.lookup, () => 0.999);
    expect(state.battle!.enemies.every((e) => e.hp < e.maxHp)).toBe(true);
    expect(stacksOf(state.battle!.player.statuses, "domain-active")).toBe(1);
  });

  it("技能详情把收件人写出来（无量空处：自身 / 全体敌人）", () => {
    const { entry, skill } = twoEnemyBattle();
    const texts = skillEffectSummaries(skill, entry.lookup).map((e) => e.text);
    // 时长属于**这一次施加**，写在技能行里（「（3 回合，自身）」）；状态详情本身不带时长。
    expect(texts).toContain("施加 领域展开 ×1（3 回合，自身）");
    expect(texts).toContain("施加 领域压制 ×1（3 回合，全体敌人）");
    expect(texts).toContain("施加 眩晕（1 回合，全体敌人）");
    // 技能目标那一档不重复写（上一行已有「目标：全体敌人」）
    expect(texts.some((t) => t.includes("（技能目标）"))).toBe(false);
  });

  /**
   * 回合末施加（`combat.onRoundEnd.applyStatus`）没有「施放者」，按「谁身上挂着这条状态」
   * 逐个结算 ⇒ 全阵营目标既没有阵营可算，也会在状态挂在三个人身上时重复施加三次。
   * 加载期拒掉，而不是让引擎猜一个收件人。
   */
  it("回合末施加只能指向携带者自己：写 all_enemies 会被加载期拒掉", () => {
    const { entry } = twoEnemyBattle();
    const raw = JSON.parse(JSON.stringify(entry.template)) as Record<string, unknown>;
    const statuses = raw.statuses as Array<Record<string, unknown>>;
    const poison = statuses.find((s) => s.id === "curse-poison");
    expect(poison).toBeDefined();
    (poison!.combat as Record<string, unknown>).onRoundEnd = [
      { applyStatus: [{ status: "domain-pin", target: "all_enemies", duration: { rounds: 3 } }] },
    ];

    const bad = WorldTemplateV2Schema.safeParse(raw);
    expect(bad.success).toBe(false);
    const messages = bad.success ? [] : bad.error.issues.map((i) => i.message);
    expect(messages.some((m) => m.includes("回合末施加只能指向携带者自己"))).toBe(true);

    // self 是允许的写法
    (poison!.combat as Record<string, unknown>).onRoundEnd = [
      { applyStatus: [{ status: "domain-pin", target: "self", chance: 0.5, duration: { rounds: 3 } }] },
    ];
    expect(WorldTemplateV2Schema.safeParse(raw).success).toBe(true);
  });
});
