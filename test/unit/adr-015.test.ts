import { describe, expect, it } from "vitest";
import {
  applyStatusToPlayer,
  battleSealOf,
  createBattle,
  createLookup,
  createWorldV2,
  performBattleAction,
  projectSnapshotV2,
  remainingLabel,
  skillSealOf,
  statusEffectSummaries,
  type WorldStateV2,
} from "@life-sim/game-core";
import type { BattleState, StatusEffect } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * ADR-015：两件「玩家看不懂」的展示债，一起收口。
 *
 * D1 战斗面的文案要写明**战斗中**每回合（同一条状态可能同时带模拟面），
 * D2 战斗中的时长不许再按世界天数说（战斗不推进世界时间），
 * D3 用不了的技能不再藏起来，改成「封印 + 原因」。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };
const DAY = 1440;

function loadEntry() {
  const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

function getoWorld(seed = 31) {
  const entry = loadEntry();
  const state = createWorldV2(
    { templateId: "jjk-2006", seed, self: { kind: "reuse", characterId: "npc-geto" } },
    entry.template,
    `w-adr015-${seed}`,
  );
  return { state, entry };
}

function battleWith(
  state: WorldStateV2,
  entry: ReturnType<typeof loadEntry>,
  settle: BattleState["settle"],
): BattleState {
  const battle = createBattle("ev:test", settle, state, entry.lookup);
  state.battle = battle;
  return battle;
}

/** 打不动的一根木桩：这里测的是面板写了什么，不是打不打得赢。 */
function dummyBattle(state: WorldStateV2, entry: ReturnType<typeof loadEntry>): BattleState {
  const battle = battleWith(state, entry, { enemies: [{ ref: "enemy-grade2-curse" }] });
  const foe = battle.enemies[0];
  foe.hp = 5000;
  foe.maxHp = 5000;
  battle.player.mp = 99;
  return battle;
}

const summons = (battle: BattleState) => battle.allies.filter((a) => a.summonedBy !== undefined);

describe("ADR-015 D1 · 战斗面的「每回合」写明是战斗中", () => {
  it("咒火：模拟面说「每回合」= 回合推进，战斗面说「战斗中每回合」", () => {
    const { entry } = getoWorld();
    const def = entry.lookup.status("cursed-burn") as StatusEffect;
    expect(def).toBeDefined();
    const texts = statusEffectSummaries(def, entry.lookup).map((e) => e.text);

    // 模拟面：体术 / 心情，保持「每回合」（它是世界回合，不是战斗回合）
    expect(texts).toContain("体术 -1");
    expect(texts).toContain("每回合 心情 -1");
    // 战斗面：加前缀，两条「每回合」不再互相冒充
    expect(texts).toContain("战斗中每回合受到 4 点伤害");
    expect(texts.some((t) => t === "每回合受到 4 点伤害")).toBe(false);
  });

  it("战斗面的增减伤也带「战斗中」（同一面板里两个域的数值一眼可分）", () => {
    const { entry } = getoWorld();
    const def = entry.lookup.status("mahoraga-adapt") as StatusEffect;
    const texts = statusEffectSummaries(def, entry.lookup).map((e) => e.text);
    expect(texts).toContain("战斗中受到伤害 -15%");
  });
});

describe("ADR-015 D2 · 战斗中的时长：整场有效 + 战后还剩多久", () => {
  it("按世界时间计的两天，战斗面板不再说「还剩 2 天」", () => {
    const { state, entry } = getoWorld();
    applyStatusToPlayer(state, "cursed-burn", 1, entry.lookup, { value: 2, unit: "day" });
    const inst = state.player.statuses.find((s) => s.statusId === "cursed-burn")!;

    // 战斗外（玩家卡 / 个人页）：照旧是绝对到期点
    expect(remainingLabel(inst, state.worldTime)).toBe("还剩 2 天");

    // 战斗内（战斗面板）：先说这一场不会掉，再给战后余额
    dummyBattle(state, entry);
    const snap = projectSnapshotV2(state, entry.template, entry.lookup);
    const chip = snap.battle?.player.statuses.find((s) => s.id === "cursed-burn");
    expect(chip?.durationLabel).toBe("整场战斗有效（战后还剩 2 天）");
  });

  it("回合制的状态口径不变（它本来就是战斗内的计数）", () => {
    const { state, entry } = getoWorld();
    const battle = dummyBattle(state, entry);
    battle.player.statuses.push({
      statusId: "cursed-burn",
      stacks: 1,
      appliedTurn: state.turnIndex,
      appliedAt: state.worldTime,
      roundsLeft: 2,
      battleOnly: true,
    });
    const snap = projectSnapshotV2(state, entry.template, entry.lookup);
    const chip = snap.battle?.player.statuses.find((s) => s.id === "cursed-burn");
    expect(chip?.durationLabel).toBe("还剩 2 回合");
  });

  it("战斗不推进世界时间：打完一场，咒火一天也没少", () => {
    const { state, entry } = getoWorld();
    applyStatusToPlayer(state, "cursed-burn", 1, entry.lookup, { value: 2, unit: "day" });
    const before = state.worldTime;
    dummyBattle(state, entry);
    performBattleAction(state, { type: "pass" }, entry.lookup, () => 0.5);
    expect(state.worldTime).toBe(before);
    const inst = state.player.statuses.find((s) => s.statusId === "cursed-burn")!;
    expect(inst.expiresAt).toBe(before + 2 * DAY);
  });
});

describe("ADR-015 D3 · 封印：技能还在，说明为什么用不了", () => {
  it("虹龙被献祭 ⇒ 技能页里那一栏还在，带 `summon_lost` 与名字", () => {
    const { state, entry } = getoWorld();
    const battle = dummyBattle(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-summon-dragon" }, entry.lookup, () => 0.5);
    performBattleAction(state, { type: "skill", skillId: "sk-uzumaki" }, entry.lookup, () => 0.5);
    expect(state.lostSummons).toContain("curse-rainbow-dragon");

    // 技能页（个人页）：技能还在列表里，只是封印
    const seal = skillSealOf(state, "sk-summon-dragon", entry.lookup);
    expect(seal?.code).toBe("summon_lost");
    expect(seal?.text).toContain("虹龙");
    expect(seal?.text).toContain("再也召不出来");

    // 没被牵连的技能不该有封印
    expect(skillSealOf(state, "sk-summon-curse", entry.lookup)).toBeUndefined();
  });

  it("战斗面板：封印的技能**照常列出**（旧实现会把它删掉）", () => {
    const { state, entry } = getoWorld();
    const battle = dummyBattle(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-summon-dragon" }, entry.lookup, () => 0.5);
    performBattleAction(state, { type: "skill", skillId: "sk-uzumaki" }, entry.lookup, () => 0.5);
    battle.player.skillCooldowns["sk-summon-dragon"] = 0;

    const snap = projectSnapshotV2(state, entry.template, entry.lookup);
    const listed = snap.battle?.player.skills.find((s) => s.id === "sk-summon-dragon");
    expect(listed).toBeDefined();
    expect(listed?.seal?.code).toBe("summon_lost");
    // 技能页与战斗面板同一句文案（一份判据，不是两处各拼一次）
    expect(listed?.seal?.text).toBe(skillSealOf(state, "sk-summon-dragon", entry.lookup)?.text);
  });

  it("满员**不算**封印（ADR-016：满员是替换，不是用不了）", () => {
    const { state, entry } = getoWorld();
    const battle = dummyBattle(state, entry);
    performBattleAction(state, { type: "skill", skillId: "sk-summon-curse" }, entry.lookup, () => 0.5);
    expect(summons(battle)).toHaveLength(3);
    battle.player.skillCooldowns["sk-summon-curse"] = 0;

    expect(battleSealOf(state, battle, state.player.id, "sk-summon-curse", entry.lookup)).toBeUndefined();
  });

  it("没有祭品 ⇒ `sacrifice_empty`；能放的时候没有封印", () => {
    const { state, entry } = getoWorld();
    const battle = dummyBattle(state, entry);
    expect(battleSealOf(state, battle, state.player.id, "sk-uzumaki", entry.lookup)?.code).toBe(
      "sacrifice_empty",
    );

    performBattleAction(state, { type: "skill", skillId: "sk-summon-curse" }, entry.lookup, () => 0.5);
    battle.player.skillCooldowns["sk-uzumaki"] = 0;
    expect(battleSealOf(state, battle, state.player.id, "sk-uzumaki", entry.lookup)).toBeUndefined();
  });

  it("冷却不算封印（面板另有「冷却 N」一行，盖两层会让一件事看着像两件）", () => {
    const { state, entry } = getoWorld();
    const battle = dummyBattle(state, entry);
    battle.player.skillCooldowns["sk-basic-strike"] = 2;
    expect(
      battleSealOf(state, battle, state.player.id, "sk-basic-strike", entry.lookup),
    ).toBeUndefined();
  });

  it("够了钱就没有封印；不够钱封的是 `not_enough_mp`（面板上也终于说出原因）", () => {
    const { state, entry } = getoWorld();
    const battle = dummyBattle(state, entry);
    expect(battleSealOf(state, battle, state.player.id, "sk-basic-strike", entry.lookup)).toBeUndefined();

    battle.player.mp = 0;
    // 消耗判定在祭品判定之前（引擎顺序），所以这里拿到的一定是「不够钱」，不是「没祭品」。
    const seal = battleSealOf(state, battle, state.player.id, "sk-uzumaki", entry.lookup);
    expect(seal?.code).toBe("not_enough_mp");
    // 资源名归模板（`statusBar[].label`）：引擎不再写死「咒力」这个词。
    const mpLabel = entry.lookup.resourceLabel("mp");
    expect(mpLabel).toBe("咒力");
    expect(seal?.text).toBe(`${mpLabel}不足`);
  });

  it("换个世界就换叫法：mp 叫「能量」时封的是「能量不足」", () => {
    const { state, entry } = getoWorld();
    const battle = dummyBattle(state, entry);
    battle.player.mp = 0;

    // 只改称呼，不改数值：证明这句话是查模板得来的，不是常量。
    const renamed = structuredClone(entry.template);
    for (const section of renamed.statusBar) {
      if (section.key === "mp") section.label = "能量";
    }
    const seal = battleSealOf(state, battle, state.player.id, "sk-uzumaki", createLookup(renamed));
    expect(seal?.text).toBe("能量不足");
  });
});
