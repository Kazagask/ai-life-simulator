import { describe, expect, it } from "vitest";
import {
  buildUnit,
  canUseSkill,
  createBattle,
  createWorldV2,
  legalTargetsForPlayer,
  performBattleAction,
  projectSnapshotV2,
  skillEffectSummaries,
  summonLimitOfTier,
} from "@life-sim/game-core";
import { toViewModel } from "@life-sim/rpg-ui";
import { SummonSpecSchema, type CombatSkill } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function loadEntry() {
  const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

function worldOf(characterId: string, seed: number) {
  const entry = loadEntry();
  const state = createWorldV2(
    { templateId: "jjk-2006", seed, self: { kind: "reuse", characterId } },
    entry.template,
    `w-battle-view-${seed}`,
  );
  state.battle = createBattle("ev:test", { enemies: [{ ref: "enemy-grade2-curse" }] }, state, entry.lookup);
  return { state, entry };
}

const snapshotOf = (state: ReturnType<typeof worldOf>["state"], entry: ReturnType<typeof loadEntry>) =>
  projectSnapshotV2(state, entry.template, entry.lookup);
const battleOf = (state: ReturnType<typeof worldOf>["state"], entry: ReturnType<typeof loadEntry>) =>
  snapshotOf(state, entry).battle;

describe("战斗展示：实际消耗、状态效果与召唤物详情", () => {
  it("六眼把 MP 价格压到 2；减耗由咒力效率承担", () => {
    const { state, entry } = worldOf("npc-gojo", 21);
    const snapshot = snapshotOf(state, entry);
    const skill = snapshot.battle?.player.skills.find((s) => s.id === "sk-gojo-blue");
    // 价格只有一份：`costs`（可扩展资源），没有 `costMp` 那个兼容副本。
    expect(skill?.costs).toEqual([{ resource: "mp", label: "咒力", amount: 2 }]);
    const sixEyes = snapshot.player.statuses.find((s) => s.id === "six-eyes");
    expect(sixEyes?.effects?.some((e) => e.text.includes("咒力效率") && e.text.includes("+90"))).toBe(true);
  });

  it("个人技能页的 VM 必须原样透传 summon（少这一步界面上就没有入口）", () => {
    const { state, entry } = worldOf("npc-geto", 25);
    const view = toViewModel({ snapshot: snapshotOf(state, entry) });
    const skill = view.player.skills.find((s) => s.id === "sk-summon-curse");
    expect(skill?.summon?.unit.name).toBe("二级咒灵");
    // 参数与面板同一个对象：有召唤就只有这一种形状（不再可能出现「只给一半」）。
    expect(skill?.summon?.count).toBe(3);
    expect(skill?.summon !== undefined && "tierLimit" in skill.summon).toBe(false);
  });

  it("召唤物身上的常驻状态也进浮窗（魔虚罗 · 法轮），并按状态芯片透传给前端", () => {
    const { state, entry } = worldOf("npc-megumi", 29);
    const snapshot = snapshotOf(state, entry);
    const info = snapshot.player.skills.find((s) => s.id === "sk-ten-mahoraga")?.summon?.unit;
    const wheel = info?.statuses.find((s) => s.id === "mahoraga-wheel");
    expect(wheel?.name).toBe("法轮");
    expect(wheel?.effects !== undefined && wheel.effects.length > 0).toBe(true);
    // 定义视图不伪造实例字段：挂载的状态没有「还剩多久」。
    expect(wheel?.durationLabel).toBeUndefined();

    const vm = toViewModel({ snapshot }).player.skills.find((s) => s.id === "sk-ten-mahoraga")?.summon?.unit;
    expect(vm?.statuses?.some((s) => s.id === "mahoraga-wheel")).toBe(true);
  });

  it("隐藏状态整条不拼：玩家面板上不会出现它的名字", () => {
    const { entry } = worldOf("npc-geto", 33);
    const fake = {
      id: "sk-hidden-probe",
      kind: "combat",
      name: "试探",
      cost: { mp: 0 },
      target: "self",
      cooldownTurns: 0,
      usableInBattle: true,
      // enrage 在模板里是 visibility: hidden。
      applyStatus: [{ status: "enrage", chance: 1, duration: { rounds: 1 } }],
    } as unknown as CombatSkill;
    const texts = skillEffectSummaries(fake, entry.lookup).map((e) => e.text);
    expect(texts.some((t) => t.includes("狂化"))).toBe(false);
    // 也不留一个「施加 未知效果」的空壳
    expect(texts.some((t) => t.startsWith("施加"))).toBe(false);
  });

  it("引用条目是三段式：lead + refName + trail 恰好等于 text", () => {
    const { state, entry } = worldOf("npc-megumi", 34);
    const skill = snapshotOf(state, entry).player.skills.find((s) => s.id === "sk-ten-mahoraga");
    const apply = skill?.effects?.find((e) => e.kind === "apply");
    expect(apply?.refName).toBe("脱力");
    expect(`${apply?.lead ?? ""}${apply?.refName ?? ""}${apply?.trail ?? ""}`).toBe(apply?.text);
  });

  it("收灵收的是玩家点选的那只（target: ally），不是永远收最早入场的", () => {
    const { state, entry } = worldOf("npc-geto", 31);
    const battle = state.battle!;
    battle.player.mp = 99;
    battle.enemies[0]!.hp = 5000;
    battle.enemies[0]!.maxHp = 5000;
    performBattleAction(state, { type: "skill", skillId: "sk-summon-curse" }, entry.lookup, () => 0.5);
    const summoned = battle.allies.filter((u) => u.summonedBy === state.player.id && u.alive);
    expect(summoned.length).toBe(3);
    const picked = summoned[1]!;
    performBattleAction(
      state,
      { type: "skill", skillId: "sk-recall", targetInstanceId: picked.instanceId },
      entry.lookup,
      () => 0.5,
    );
    expect(battle.bench?.some((u) => u.instanceId === picked.instanceId)).toBe(true);
  });

  it("施加状态的时长写在技能那一行；状态定义本身不带时长", () => {
    const { state, entry } = worldOf("npc-megumi", 32);
    const skill = snapshotOf(state, entry).player.skills.find((s) => s.id === "sk-ten-mahoraga");
    const apply = skill?.effects?.find((e) => e.kind === "apply");
    // ADR-018：战斗域的时长只剩「回合」，世界时间已经退役（战后折算由 toModifier 承担）。
    expect(apply?.text).toContain("（2 回合");
    expect(apply?.refDetail?.durationLabel).toBeUndefined();
  });

  it("目标词表补齐：召唤/收灵是「无目标」，全体友军可与全体敌人对称表达", () => {
    const { state, entry } = worldOf("npc-megumi", 30);
    const rabbits = snapshotOf(state, entry).player.skills.find((s) => s.id === "sk-ten-rabbits");
    // 召唤不指定任何人：写成「自身」会让面板读成「对自己施法」。
    expect(rabbits?.effects?.some((e) => e.text === "目标：无目标")).toBe(true);

    const fake = {
      id: "sk-fake-all-allies",
      kind: "combat",
      name: "群疗",
      cost: { mp: 0 },
      target: "all_allies",
      cooldownTurns: 0,
      usableInBattle: true,
    } as unknown as CombatSkill;
    expect(skillEffectSummaries(fake, entry.lookup).map((e) => e.text)).toContain("目标：全体友军");
  });

  it("召唤名额是世界规则（按档共享），不是每个召唤物一份", () => {
    const { entry } = worldOf("npc-geto", 28);
    // 模板声明了世界维度的名额；缺省表只是没写时的兜底。
    expect(entry.template.summonLimits?.hero).toBe(1);
    expect(entry.template.summonLimits?.minion).toBe(3);
    expect(summonLimitOfTier("hero")).toBe(1);
    expect(summonLimitOfTier("minion")).toBe(3);
    // 换一个世界想多站一只，只改这个世界，不用动技能。
    expect(summonLimitOfTier("hero", { summonLimits: { hero: 2 } })).toBe(2);
  });

  it("上限是召唤规则（按档），技能只声明一次几只与强度；技能写 limit 直接拒载", () => {
    const { state, entry } = worldOf("npc-geto", 27);
    const skills = snapshotOf(state, entry).player.skills;
    const minionSkill = skills.find((s) => s.id === "sk-summon-curse");
    const heroSkill = skills.find((s) => s.id === "sk-summon-dragon");
    // 模板里已经不再写 limit，名额只能来自世界规则；技能行把它写进文案。
    const textOf = (skill: typeof minionSkill) => (skill?.effects ?? []).map((e) => e.text).join(" | ");
    expect(textOf(minionSkill)).toContain("杂兵档共用 3 个位置");
    expect(textOf(heroSkill)).toContain("英雄档共用 1 个位置");

    expect(SummonSpecSchema.safeParse({ ref: "x", count: 3, tier: "minion", levelScale: 0.8 }).success).toBe(true);
    expect(SummonSpecSchema.safeParse({ ref: "x", tier: "minion", limit: 5 }).success).toBe(false);
  });

  it("召唤物的技能带效果摘要（浮窗里一行一个技能，不再只有名字）", () => {
    const { state, entry } = worldOf("npc-geto", 26);
    const info = snapshotOf(state, entry).player.skills.find((s) => s.id === "sk-summon-curse")?.summon?.unit;
    expect(info?.skills.length).toBeGreaterThan(0);
    for (const skill of info?.skills ?? []) {
      expect(skill.id).not.toBe("");
      expect(skill.name).not.toBe("");
      // 效果摘要由 skillEffectSummaries 派生：战斗技能至少带一条成本行
      // （零消耗写「无消耗」，2026-11-20：不再印「消耗 0 咒力」）。
      expect(skill.effects?.some((e) => e.kind === "cost" && /^(消耗|无消耗)/.test(e.text))).toBe(true);
    }
  });

  it("召唤详情挂在个人技能面板，战斗技能不再带召唤摘要", () => {
    const { state, entry } = worldOf("npc-geto", 22);
    const snapshot = snapshotOf(state, entry);
    const personal = snapshot.player.skills.find((s) => s.id === "sk-summon-curse");
    expect(personal?.summon?.unit.name).toBe("二级咒灵");
    expect(personal?.summon?.unit.tier).toBe("minion");
    expect(personal?.summon?.count).toBe(3);
    const battleSkill = snapshot.battle?.player.skills.find((s) => s.id === "sk-summon-curse");
    expect(battleSkill === undefined || !("summonLabel" in battleSkill)).toBe(true);
  });

  it("召唤者的实例 id 与退场原因进入战斗投影", () => {
    const { state, entry } = worldOf("npc-geto", 23);
    const battle = state.battle!;
    const def = entry.lookup.character("enemy-grade2-curse")!;
    const unit = buildUnit(def, state, entry.lookup, {
      instanceId: "test-summon#1",
      tier: "hero",
      summonedBy: state.player.id,
      summonRef: def.id,
      enteredRound: battle.round,
    });
    unit.deathReason = "被献祭";
    battle.allies.push(unit);

    const view = battleOf(state, entry)?.allies.find((u) => u.instanceId === "test-summon#1");
    expect(view?.summonedBy).toBe(state.player.id);
    expect(view?.summonerName).toBe(state.player.name);
    expect(view?.summonRef).toBe(def.id);
    expect(view?.tier).toBe("hero");
    expect(view?.deathReason).toBe("被献祭");
  });

  it("杂兵被献祭后不进已退场名册（战报里有名字就够）", () => {
    const { state, entry } = worldOf("npc-geto", 35);
    const battle = state.battle!;
    battle.enemies[0]!.hp = 5000;
    battle.enemies[0]!.maxHp = 5000;
    battle.player.mp = 99;
    performBattleAction(state, { type: "skill", skillId: "sk-summon-curse" }, entry.lookup, () => 0.5);
    expect(battle.allies.filter((u) => u.summonedBy === state.player.id && u.alive)).toHaveLength(3);

    performBattleAction(state, { type: "skill", skillId: "sk-uzumaki" }, entry.lookup, () => 0.5);
    /**
     * 数据层照旧记录（战报 / 排查要用），但投影只发英雄档：
     * 三张 108/108 的杂兵卡片会把「谁真的没了」淹掉。
     */
    expect(battle.fallen?.some((u) => u.tier === "minion")).toBe(true);
    expect(battleOf(state, entry)?.fallen ?? []).toHaveLength(0);
  });

  it("英雄被献祭后退场名册仍带原因", () => {
    const { state, entry } = worldOf("npc-geto", 24);
    const battle = state.battle!;
    battle.enemies[0]!.hp = 1000;
    battle.enemies[0]!.maxHp = 1000;
    performBattleAction(state, { type: "skill", skillId: "sk-summon-dragon" }, entry.lookup, () => 0.5);
    performBattleAction(state, { type: "skill", skillId: "sk-uzumaki" }, entry.lookup, () => 0.5);

    const fallen = battleOf(state, entry)?.fallen ?? [];
    expect(fallen.length).toBe(1);
    expect(fallen[0]?.deathReason).toBe("被献祭");
    expect(fallen[0]?.tier).toBe("hero");
  });
});

describe("目标契约：先选目标、再放技能", () => {
  /** 场上一个普通敌人 + 一个中立单位（魔虚罗站中间，两边都打它）。 */
  const battleWithNeutral = (characterId: string, seed: number) => {
    const entry = loadEntry();
    const state = createWorldV2(
      { templateId: "jjk-2006", seed, self: { kind: "reuse", characterId } },
      entry.template,
      `w-neutral-${seed}`,
    );
    state.battle = createBattle(
      "ev:test",
      { enemies: [{ ref: "enemy-grade2-curse" }], neutrals: [{ ref: "shiki-mahoraga" }] },
      state,
      entry.lookup,
    );
    return { state, entry };
  };

  it("阵营随单位走：已退场名册按各自阵营上色（敌方 / 中立 / 我方）", () => {
    const { state, entry } = battleWithNeutral("npc-megumi", 38);
    const battle = state.battle!;
    // 建场：敌人 / 中立各自带 side
    expect(battle.enemies[0]?.side).toBe("enemy");
    expect(battle.neutrals[0]?.side).toBe("neutral");

    // 召唤：落点阵营即 side（中立式神站中立项也是 neutral）
    battle.player.mp = 99;
    performBattleAction(state, { type: "skill", skillId: "sk-ten-shadow" }, entry.lookup, () => 0.5);
    const ally = battle.allies.find((u) => u.summonedBy === state.player.id);
    expect(ally?.side).toBe("ally");

    /**
     * 用户 2026-11-20 实测：敌方献祭的咒灵在名册里是**蓝框** —— 因为前端写死 `kind="ally"`。
     * 名册是混合列表，阵营必须由数据带过来，前端不许猜。
     */
    battle.fallen = [
      { ...battle.enemies[0]!, tier: "hero", side: "enemy", deathReason: "被献祭" },
      { ...battle.neutrals[0]!, tier: "hero", side: "neutral", deathReason: "召唤者倒下，随之消散" },
      { ...ally!, tier: "hero", side: "ally", deathReason: "被献祭" },
    ];
    const fallen = battleOf(state, entry)?.fallen ?? [];
    expect(fallen.map((u) => u.side)).toEqual(["enemy", "neutral", "ally"]);
  });

  it("中立与敌方同侧：伤害打得到它，友方治疗选不中它", () => {
    // 友方技能：家入硝子的单体治疗 —— 中立不在 `friendly` 里，选它就是非法目标。
    const healer = battleWithNeutral("npc-shoko", 36);
    const neutralId = healer.state.battle!.neutrals[0]!.instanceId;
    const heal = healer.entry.lookup.skill("sk-reverse-heal-ally")!;
    expect(legalTargetsForPlayer(healer.state.battle!, healer.state, heal)).not.toContain(neutralId);
    expect(
      canUseSkill(
        healer.state,
        healer.state.battle!,
        healer.state.player.id,
        "sk-reverse-heal-ally",
        healer.entry.lookup,
        neutralId,
      ),
    ).toEqual({ ok: false, reason: "target_not_legal" });

    // 敌方技能：Jogo 的全体火焰（`all_enemies` 取 `hostile`，中立本来就在里面）。
    const attacker = battleWithNeutral("npc-jogo", 37);
    const battle = attacker.state.battle!;
    const target = battle.neutrals[0]!;
    const before = target.hp;
    battle.player.mp = 999;
    performBattleAction(attacker.state, { type: "skill", skillId: "sk-flame" }, attacker.entry.lookup, () => 0.5);
    expect(battle.neutrals[0]!.hp).toBeLessThan(before);
  });

  it("收灵只能选中自己的召唤物：自己不是合法目标，引擎直接拒", () => {
    const { state, entry } = worldOf("npc-megumi", 38);
    const battle = state.battle!;
    battle.player.mp = 999;
    performBattleAction(state, { type: "skill", skillId: "sk-ten-rabbits" }, entry.lookup, () => 0.5);
    const own = battle.allies.find((u) => u.summonedBy === state.player.id)!;
    const recall = entry.lookup.skill("sk-ten-recall")!;

    expect(legalTargetsForPlayer(battle, state, recall)).toContain(own.instanceId);
    expect(legalTargetsForPlayer(battle, state, recall)).not.toContain(state.player.id);
    expect(() =>
      performBattleAction(
        state,
        { type: "skill", skillId: "sk-ten-recall", targetInstanceId: state.player.id },
        entry.lookup,
        () => 0.5,
      ),
    ).toThrow("target_not_legal");
  });

  it("VM 下发玩家 id 与合法目标清单，前端只做 includes", () => {
    const { state, entry } = worldOf("npc-megumi", 39);
    const view = battleOf(state, entry)!;
    // 「选自己」需要一个真实 id：null 只表示「还没选」。
    expect(view.player.id).toBe(state.player.id);
    // 还没召东西 ⇒ 收灵没有任何合法目标，但解释文案照常下发。
    const recall = view.player.skills.find((s) => s.id === "sk-ten-recall")!;
    expect(recall.legalTargets).toEqual([]);
    expect(recall.legalTargetNote).toBe("你只能选中自己的召唤物");
    // 敌方单体技能：合法目标里就有场上那个敌人。
    const strike = view.player.skills.find((s) => s.id === "sk-basic-strike")!;
    expect(strike.legalTargets).toContain(view.enemies[0]!.instanceId);
  });
});

describe("状态正负是一等字段", () => {
  it("VM 下发 polarity，不再下发 battleStyle", () => {
    const { state, entry } = worldOf("npc-gojo", 40);
    const view = toViewModel({ snapshot: snapshotOf(state, entry) });
    const sixEyes = view.player.statuses.find((s) => s.id === "six-eyes");
    expect(sixEyes?.polarity).toBe("positive");
    // 旧字段已删除：后端不再为「战斗中长什么样」做一份解析
    expect(sixEyes !== undefined && "battleStyle" in sixEyes).toBe(false);
  });

  it("战斗施加文案读正负：增益「获得」、异常「陷入」、中性「生效」", () => {
    const { state, entry } = worldOf("npc-sukuna", 41);
    const battle = state.battle!;
    battle.player.mp = 999;
    performBattleAction(state, { type: "skill", skillId: "sk-domain-malevolent" }, entry.lookup, () => 0.5);
    const log = battle.log.join("\n");
    expect(log).toContain("你获得了「领域展开」");
    expect(log).toContain("陷入了「领域压制」");
    expect(log).not.toContain("你陷入了「领域展开」");
  });
});
