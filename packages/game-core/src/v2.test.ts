import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { WorldTemplateV2Schema, type WorldStateV2, type WorldTemplateV2 } from "@life-sim/shared";
import { createLookup } from "./v2/lookup.js";
import { createBattle, finishBattle, performBattleAction } from "./v2/battle.js";
import { applyEffectsV2, computeMax, playerEffectiveAttributes, type EffectContextV2 } from "./v2/engine.js";
import { projectSnapshotV2 } from "./v2/projection.js";
import { advanceTurnV2, battleActionV2, chooseOptionV2 } from "./v2/turn.js";
import { createDefaultOpeningTemplate } from "./v2/opening.js";
import { createActiveWorldV2, makeTestTemplate } from "./v2/test-utils.js";
import {
  buildRelationGraph,
  isKinshipReachable,
  kinshipTerm,
  shortestPath,
} from "./v2/relations.js";

// ---------- JJk 模板经 Schema 校验可加载 ----------

const jjkDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../specs/data/templates/jjk-2006");

function loadJjkTemplate(): WorldTemplateV2 {
  const merged: Record<string, unknown> = {};
  for (const file of ["world.yaml", "characters.yaml", "skills.yaml", "items.yaml", "statuses.yaml", "events.yaml"]) {
    const doc = parse(readFileSync(path.join(jjkDir, file), "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(doc)) {
      if (key === "meta") merged.meta = value;
      else if (merged[key] === undefined) merged[key] = value;
      else if (Array.isArray(merged[key]) && Array.isArray(value)) merged[key] = [...(merged[key] as unknown[]), ...value];
    }
  }
  return WorldTemplateV2Schema.parse(merged);
}

describe("V2 引擎 · 模板加载", () => {
  it("jjk-2006 六文件合并后通过 WorldTemplateV2Schema 校验", () => {
    const template = loadJjkTemplate();
    expect(template.meta.id).toBe("jjk-2006");
    expect(template.events.length).toBeGreaterThan(5);
    expect(template.skills.some((s) => s.id === "sk-domain-empty")).toBe(true);
    expect(template.chains?.map((c) => c.id)).toEqual(["chain-creation"]);
  });

  it("命数转盘：13 步创建链（含性别与年龄）+ 七章主线", () => {
    const template = loadJjkTemplate();
    // 入口事件：chain 源 normal 事件，由 opening handoff 直推待决队列首
    const entry = template.events.find((e) => e.id === "ev-opening-wheel");
    expect(entry?.trigger.source).toBe("chain");
    expect(entry?.kind).toBe("normal");
    const chain = template.chains?.find((c) => c.id === "chain-creation");
    expect(chain).toBeDefined();
    expect(chain?.startEventId).toBe("ev-w01");
    expect(chain?.steps.length).toBe(13);
    const wheelEvents = template.events.filter((e) => /^ev-w(0[1-9]|1[0-3])$/.test(e.id));
    expect(wheelEvents.length).toBe(13);
    // 前 11 步为选择，第 12 步是真的转盘（random），第 13 步是入学式
    for (const e of wheelEvents.slice(0, 11)) expect(e.kind).toBe("normal");
    expect(template.events.find((e) => e.id === "ev-w12")?.kind).toBe("random");
    expect(template.events.find((e) => e.id === "ev-w13")?.kind).toBe("normal");
    // 性别与年龄由玩家在事件里定下（setIdentity），不是模板写死
    const genderStep = template.events.find((e) => e.id === "ev-w01");
    const genderEffects =
      genderStep?.kind === "normal" ? genderStep.settle.normal.options.flatMap((o) => o.effects ?? []) : [];
    expect(genderEffects.some((e) => e.type === "setIdentity")).toBe(true);
    const ageStep = template.events.find((e) => e.id === "ev-w02");
    const ageEffects = ageStep?.kind === "normal" ? ageStep.settle.normal.options.flatMap((o) => o.effects ?? []) : [];
    expect(ageEffects.some((e) => e.type === "setIdentity" && e.age !== undefined)).toBe(true);
    // 七章主线：七个章节 gate（priority 100 + once），内容按原作时间线
    const gates = template.events.filter((e) => e.trigger.source === "pool" && e.trigger.priority === 100);
    expect(gates.map((g) => g.id)).toEqual([
      "ev-ch1-gate",
      "ev-ch2-gate",
      "ev-ch3-gate",
      "ev-ch4-gate",
      "ev-ch5-gate",
      "ev-ch6-gate",
      "ev-ch7-gate",
    ]);
    // 时间线锚定原作：星浆体 2006-08 → 苦夏 2007-06 → 百鬼 2017-12 → 涩谷 2018-10 → 新宿 2018-12
    const gateDay = (id: string): number => {
      const g = template.events.find((e) => e.id === id);
      const cond = g?.trigger.conditions?.find((c) => "time" in c && c.time.gte) as
        | { time: { gte: { value: number; unit: string } } }
        | undefined;
      return cond?.time.gte.value ?? -1;
    };
    expect(gateDay("ev-ch1-gate")).toBe(215);
    expect(gateDay("ev-ch2-gate")).toBe(526);
    expect(gateDay("ev-ch3-gate")).toBe(4370);
    expect(gateDay("ev-ch5-gate")).toBe(4680);
    expect(gateDay("ev-ch7-gate")).toBe(4736);
    // 世界观资产（角色/技能/物品/补正）保留
    expect(template.characters.some((c) => c.id === "npc-riko")).toBe(true);
    expect(template.characters.some((c) => c.id === "enemy-jogo")).toBe(true);
    expect(template.characters.some((c) => c.id === "enemy-kenjaku")).toBe(true);
    expect(template.characters.some((c) => c.id === "npc-nanami")).toBe(true);
  });
});

// ---------- 补正系统、advanceTime 与转盘开局 ----------

describe("V2 引擎 · 补正与六眼", () => {
  it("六眼补正 simulation.attributeModifiers 生效", () => {
    const template = loadJjkTemplate();
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "jjk-2006", playerName: "测试者", seed: 42 }, template, "w-six");
    const base = state.player.attributes.cursedEnergy;
    state.player.statuses = [{ statusId: "six-eyes", stacks: 1, appliedTurn: 0 }];
    const eff = playerEffectiveAttributes(state, lookup);
    expect(eff.cursedEnergy).toBe(base + 20);
    expect(eff.agility).toBe(state.player.attributes.agility + 10);
  });

  it("五条悟初始携带六眼补正", () => {
    const template = loadJjkTemplate();
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "jjk-2006", playerName: "测试者", seed: 42 }, template, "w-gojo");
    const gojo = state.npcs.find((n) => n.id === "npc-gojo");
    expect(gojo?.statuses.some((s) => s.statusId === "six-eyes")).toBe(true);
  });

  it("六眼补正 combat.damageDealt 提升伤害输出", () => {
    const template = loadJjkTemplate();
    const lookup = createLookup(template);
    const setup = () => {
      const s = createActiveWorldV2({ templateId: "jjk-2006", playerName: "测试者", seed: 42 }, template, "w-dmg");
      s.battle = createBattle(
        "ev-curse-ambush",
        { enemies: [{ ref: "enemy-grade2-curse", levelScale: 1 }], canFlee: false },
        s,
        lookup,
      );
      const e = s.battle!.enemies[0];
      e.hp = 1000;
      e.maxHp = 1000;
      e.skills = []; // 隔离敌方反击
      return { s, e };
    };

    const a = setup();
    performBattleAction(a.s, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);
    const noBuff = 1000 - a.e.hp;

    const b = setup();
    b.s.battle!.player.statuses.push({ statusId: "six-eyes", stacks: 1, appliedTurn: 0 });
    performBattleAction(b.s, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);
    const withBuff = 1000 - b.e.hp;

    expect(noBuff).toBe(8);
    expect(withBuff).toBe(10); // 8 × (1 + 0.3)
  });
});

describe("V2 引擎 · advanceTime 绝对/相对时间推进", () => {
  it("advanceTime by 相对推进世界时间与年龄", () => {
    const template = loadJjkTemplate();
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "jjk-2006", playerName: "测试者", seed: 42 }, template, "w-time");
    const before = state.worldTime;
    const ctx: EffectContextV2 = { state, lookup, rng: () => 0.5, logs: [] };
    applyEffectsV2(ctx, [{ type: "advanceBy", value: { value: 1, unit: "year" } }]);
    expect(state.worldTime).toBe(before + 525600);
    expect(state.player.age).toBe(state.playerAgeAtStart + 1);
    expect(ctx.timeAdvanced).toBe(true);
  });

  it("advanceTo 绝对推进：时间跳跃命中目标并同步年龄（公历闰日口径）", () => {
    const template = loadJjkTemplate();
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "jjk-2006", playerName: "测试者", seed: 7 }, template, "w-jump");
    const ageBefore = state.playerAgeAtStart;
    const ctx: EffectContextV2 = { state, lookup, rng: () => 0.5, logs: [] };
    // R2.6 gregorian：2006→2018 含 2008/2012/2016 三个闰日
    applyEffectsV2(ctx, [{ type: "advanceTo", value: { value: 12, unit: "year" } }]);
    expect(state.worldTime).toBe((12 * 365 + 3) * 1440);
    expect(state.player.age).toBe(ageBefore + 12);
    expect(ctx.timeAdvanced).toBe(true);
  });

  it("咒言术为战斗技能，主角初始拥有并附眩晕", () => {
    const template = loadJjkTemplate();
    const skill = template.skills.find((s) => s.id === "sk-cursed-speech");
    expect(skill?.kind).toBe("combat");
    if (skill?.kind === "combat") {
      expect(skill.applyStatus?.[0]?.status).toBe("stun");
      expect(skill.damage?.[0]?.preset).toBe("scaled");
    }
    // 旧 demo 遗留已清：新生只带一门基础体术，术式由命数转盘决定
    expect(template.playerTemplate?.skills).toEqual(["sk-basic-strike"]);
    expect(template.playerTemplate?.attributes.cursedEnergy).toBe(5);
    expect(template.playerTemplate?.items?.map((i) => i.itemId)).toEqual(["item-first-aid"]);
  });
});

describe("V2 引擎 · 事件链起点触发（回归）", () => {
  it("转动转盘 → startChain 把链起点事件压入待决，队列只含 normal，不卡死", () => {
    const template = loadJjkTemplate();
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "jjk-2006", playerName: "测试者", seed: 7 }, template, "w-report");
    state.pendingEvents = [{ eventId: "ev-opening-wheel" }];
    state.firedEvents["ev-opening-wheel"] = state.turnIndex;

    chooseOptionV2(state, { optionId: "opt-begin" }, template, lookup);
    // 链注册为 active
    expect(state.chains.some((c) => c.id === "chain-creation" && c.status === "active")).toBe(true);
    // 链起点 ev-w01 进入待决队列
    expect(state.pendingEvents.some((p) => p.eventId === "ev-w01")).toBe(true);
    // 待决队列里只允许 normal 事件（否则 pendingEventView 返回 null 导致卡死）
    expect(state.pendingEvents.every((p) => lookup.event(p.eventId)?.kind === "normal")).toBe(true);
    // 不处于卡死状态：有待决 normal 事件可结算
    expect(state.pendingEvents.length).toBeGreaterThan(0);
  });
});

// ---------- 组队战斗（友军单位，合成模板夹具） ----------

describe("V2 引擎 · 组队战斗", () => {
  /** 合成组队战斗夹具：友军角色 + 友军技能 + 带 allies 的战斗事件。 */
  function teamFixture(worldId: string) {
    const template = makeTestTemplate();
    template.characters.push({
      id: "ally-y",
      isEnemy: false,
      visibility: "public",
      identity: { name: "测试友军", age: 16, gender: "f" },
      mood: { value: 60 },
      attributes: { cursedEnergy: 5, agility: 1, luck: 0 },
      skills: ["sk-ally"],
      public: { personality: "测试用友军" },
      private: { combatHints: { skillWeights: { "sk-ally": 1 } } },
      relationship: 50,
    });
    template.skills.push({
      id: "sk-ally",
      kind: "combat",
      name: "友军斩",
      cost: { mp: 0 },
      target: "enemy",
      damage: [{ preset: "fixed", value: 30 }],
      cooldownTurns: 0,
      usableInBattle: true,
    });
    template.events.push({
      id: "ev-tb",
      title: "组队战",
      narrative: "测试用组队战斗。",
      trigger: { source: "chain" },
      kind: "combat",
      settle: {
        combat: {
          enemies: [{ ref: "enemy-x", levelScale: 1 }],
          allies: [{ ref: "ally-y", levelScale: 1 }],
          canFlee: false,
        },
      },
    });
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "test", playerName: "测试者", seed: 7 }, template, worldId);
    const event = lookup.event("ev-tb")!;
    if (event.kind !== "combat") throw new Error("ev-tb 必须是 combat");
    state.battle = createBattle("ev-tb", event.settle.combat, state, lookup);
    return { template, lookup, state };
  }

  it("友军参战：按 levelScale 构建单位，与敌人分属两阵营，并进入战斗投影", () => {
    const { template, lookup, state } = teamFixture("w-team-build");
    const b = state.battle!;
    // 友军单位独立于敌人列表，且来自模板 allies 引用
    expect(b.allies.length).toBe(1);
    expect(b.allies[0].characterId).toBe("ally-y");
    expect(b.allies[0].name).toBe("测试友军");
    expect(b.allies[0].alive).toBe(true);
    expect(b.allies[0].hp).toBe(b.allies[0].maxHp);
    expect(b.enemies[0].name).toBe("测试敌人");
    expect(b.enemies).toHaveLength(1);

    // 投影对玩家暴露友军单位（不含隐藏字段）
    const view = projectSnapshotV2(state, template, lookup);
    expect(view.battle?.allies).toHaveLength(1);
    expect(view.battle?.allies[0].name).toBe("测试友军");
    expect(view.battle?.enemies[0].name).toBe("测试敌人");
  });

  it("友军 AI 在玩家行动后自动行动并攻击敌人", () => {
    const { lookup, state } = teamFixture("w-team-ai");
    const b = state.battle!;
    const enemy = b.enemies[0];
    enemy.hp = 100000;
    enemy.maxHp = 100000;
    enemy.skills = []; // 隔离敌人反击
    const ally = b.allies[0];
    ally.skills = ["sk-ally"]; // 友军仅保留攻击技能
    const before = enemy.hp;

    performBattleAction(state, { type: "skill", skillId: "sk-strike" }, lookup, () => 0.5);

    // 友军「测试友军」已施放技能（日志含其名），且敌人受到其伤害
    expect(b.log.some((l) => l.includes("测试友军") && l.includes("友军斩"))).toBe(true);
    expect(enemy.hp).toBeLessThan(before);
  });

  it("组队胜利：玩家与友军合力击败敌人", () => {
    const { lookup, state } = teamFixture("w-team-win");
    const b = state.battle!;
    const enemy = b.enemies[0];
    enemy.hp = 10;
    enemy.maxHp = 10;
    enemy.skills = [];

    // 玩家固定 100 伤害直接击杀
    performBattleAction(state, { type: "skill", skillId: "sk-strike" }, lookup, () => 0.5);

    expect(b.over).toBe("victory");
  });

  it("友军倒下不影响胜负判定，战斗继续", () => {
    const { lookup, state } = teamFixture("w-team-ally-down");
    const b = state.battle!;
    const enemy = b.enemies[0];
    enemy.hp = 100000;
    enemy.maxHp = 100000;
    enemy.skills = [];

    // 友军被击倒
    const ally = b.allies[0];
    ally.hp = 0;
    ally.alive = false;

    performBattleAction(state, { type: "skill", skillId: "sk-strike" }, lookup, () => 0.5);

    // 敌人仍在、玩家存活 → 战斗不因友军倒下而结束
    expect(b.over).toBeNull();
    expect(b.allies[0].alive).toBe(false);
  });
});


function makeState(seed = 42): { state: WorldStateV2; template: WorldTemplateV2 } {
  const template = makeTestTemplate();
  const lookup = createLookup(template);
  const state = createActiveWorldV2({ templateId: "test", playerName: "测试者", seed }, template, "w1");
  return { state, template };
}

describe("V2 引擎 · 世界创建", () => {
  it("玩家资源池与初始物品按模板初始化", () => {
    const { state, template } = makeState();
    // 上限 = base + Σ perAttribute×基础属性：100 + 4×5 = 120；50 + 2×5 = 60
    expect(state.player.hp).toBe(120);
    expect(state.player.mp).toBe(60);
    expect(state.player.mood).toBe(60);
    expect(state.player.attributes.luck).toBe(5);
    expect(state.player.skills).toContain("sk-strike");
    void template;
  });

  it("敌人资源池按自身属性经完整公式计算", () => {
    const { state, template } = makeState();
    const lookup = createLookup(template);
    state.battle = createBattle(
      "ev-ambush",
      { enemies: [{ ref: "enemy-x", levelScale: 1 }], canFlee: false },
      state,
      lookup,
    );
    // enemy-x 咒力 5 → hp = 100 + 4×5 = 120；mp = 50 + 2×5 = 60
    expect(state.battle.enemies[0].maxHp).toBe(120);
    expect(state.battle.enemies[0].mp).toBe(60);
    // levelScale 同时作用于属性与资源池
    state.battle = createBattle(
      "ev-ambush",
      { enemies: [{ ref: "enemy-x", levelScale: 2 }], canFlee: false },
      state,
      lookup,
    );
    expect(state.battle.enemies[0].maxHp).toBe(240);
  });

  it("自定义属性参与资源公式与效果结算", () => {
    const template = makeTestTemplate();
    // 自定义属性 willpower 驱动 HP 上限：50 + 10×3 = 80
    template.resources.hp = { base: 50, perLevel: 0, perAttribute: { willpower: 10 } };
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "test", playerName: "测试者", seed: 42 }, template, "w-custom");
    expect(state.player.hp).toBe(80);
    expect(state.player.attributes.willpower).toBe(3);

    // 事件效果 adjustAttribute 提升自定义属性 → 上限随之增长
    const event = template.events[0];
    if (event.kind === "normal") {
      const opt = event.settle.normal.options.find((o) => o.id === "opt-plain");
      if (opt) opt.effects = [{ type: "adjustAttribute", attribute: "willpower", value: 2 }];
    }
    advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    chooseOptionV2(state, { optionId: "opt-plain" }, template, lookup);
    expect(state.player.attributes.willpower).toBe(5);
    // 新上限 = 50 + 10×5 = 100（当前 hp 不自动回填，clamp 上限即时生效）
    expect(computeMax(template.resources.hp, 0, state.player.attributes, 1)).toBe(100);
  });
});

describe("V2 引擎 · 章节进度投影（D-07）", () => {
  /** 章节机起点由开局 `worldSetup.flags.chapter = 1` 建立（jjk-2006 opening.yaml 同一语义）。 */
  function worldWithChapterOpening(): { state: WorldStateV2; template: WorldTemplateV2; lookup: ReturnType<typeof createLookup> } {
    const template = makeTestTemplate();
    const lookup = createLookup(template);
    const opening = {
      ...createDefaultOpeningTemplate(),
      worldSetup: { flags: { chapter: 1 } },
    };
    const state = createActiveWorldV2({ templateId: "test", playerName: "测试者", seed: 42 }, template, "w-chapter", opening);
    return { state, template, lookup };
  }

  it("开局后 storyChapter === 1（数字透出，不是字符串/布尔）", () => {
    const { state, template, lookup } = worldWithChapterOpening();
    const view = projectSnapshotV2(state, template, lookup);
    expect(view.storyChapter).toBe(1);
  });

  it("flags.chapter 推进到 3 ⇒ 投影为 3（setFlag 语义一致）", () => {
    const { state, template, lookup } = worldWithChapterOpening();
    state.flags.chapter = 3;
    expect(projectSnapshotV2(state, template, lookup).storyChapter).toBe(3);
  });

  it("未使用章节机的世界（无 flags.chapter）⇒ 字段缺省（undefined，不是 0 / null）", () => {
    const { state, template } = makeState();
    const lookup = createLookup(template);
    expect(state.flags.chapter).toBeUndefined();
    const view = projectSnapshotV2(state, template, lookup);
    expect(view.storyChapter).toBeUndefined();
    expect("storyChapter" in view).toBe(false); // 键本身不出现
    // 非数字 flag（模板作者误写字符串）同样不透出，避免前端渲染 "第三章"
    state.flags.chapter = "3";
    expect(projectSnapshotV2(state, template, lookup).storyChapter).toBeUndefined();
  });
});

describe("V2 引擎 · 事件轮次", () => {
  it("普通事件进入待决队列，选项按 visibleWhen 过滤", () => {
    const { state, template } = makeState();
    const lookup = createLookup(template);
    const res = advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(res.snapshot.pendingEvent?.eventId).toBe("ev-normal");
    const optionIds = res.snapshot.pendingEvent!.options.map((o) => o.id);
    expect(optionIds).toContain("opt-plain");
    expect(optionIds).not.toContain("opt-secret");
    // 待决事件存在时禁止推进轮次
    expect(() => advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup)).toThrow(
      "pending_event_required",
    );
  });

  it("选择选项生效：结算推进一轮，尾管线为下一槽位补入池事件", () => {
    const { state, template } = makeState();
    const lookup = createLookup(template);
    advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    const turnBefore = state.turnIndex;
    const res = chooseOptionV2(state, { optionId: "opt-plain" }, template, lookup);
    expect(state.flags.chosePlain).toBe(true);
    // #34 结算轮：turnIndex +1；事件轮跑完整管线，pool 门控立刻为下一槽位重新抽取事件。
    expect(state.turnIndex).toBe(turnBefore + 1);
    expect(res.snapshot.pendingEvent?.eventId).toBe("ev-normal");
  });

  it("转盘事件自动结算，weightBy 随有效属性加权", () => {
    const { state, template } = makeState();
    const lookup = createLookup(template);
    // 低幸运：大吉权重 1+2=3 与 凶 3 平分……改用极高幸运必出大吉
    state.player.attributes.luck = 1000; // 1 + 400 = 401 vs 3
    const res = advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(res.wheelResult?.label).toBe("大吉");
    expect(state.lastWheel?.label).toBe("大吉");

    // 负幸运：大吉权重 max(0, 1-4)=0 → 必为凶
    const { state: s2, template: t2 } = makeState(7);
    s2.player.attributes.luck = -10;
    const res2 = advanceTurnV2(s2, { action: { type: "rest", description: "" } }, t2, createLookup(t2));
    expect(res2.wheelResult?.label).toBe("凶");
  });

  // ---------- D-03：单轮多个转盘结果不再互相覆盖 ----------

  function makeMultiWheelWorld(seed = 42): { state: WorldStateV2; template: WorldTemplateV2; lookup: ReturnType<typeof createLookup> } {
    const base = makeTestTemplate();
    const wheelEvent = (id: string, title: string, label: string) => ({
      id,
      title,
      narrative: `${title}的转盘。`,
      // 两个池事件同轮必中（probability 1），冷却 99 天保证下一轮不再触发 ⇒ 可验证「当轮清空」
      trigger: { source: "pool", probability: 1, cooldown: { value: 99, unit: "day" } },
      kind: "random",
      settle: { random: { wheel: { segments: [{ weight: 1, label, effects: [{ type: "adjustMood", value: 1 }] }] } } },
    });
    const template = {
      ...base,
      // 只保留两个 kind: random 事件，排除普通事件占槽对断言的干扰
      events: [wheelEvent("ev-wheel-a", "晨间占卜", "上上签"), wheelEvent("ev-wheel-b", "夜间抽签", "平")],
    } as unknown as WorldTemplateV2;
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "test", playerName: "测试者", seed }, template, "w-multi");
    return { state, template, lookup };
  }

  it("D-03：同轮两个 random 事件都进入 lastWheels，顺序为触发顺序，lastWheel 仍为最后一个", () => {
    const { state, template, lookup } = makeMultiWheelWorld();
    const res = advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);

    expect(res.snapshot.lastWheels.length).toBe(2);
    expect(res.snapshot.lastWheels.map((w) => w.label)).toEqual(["上上签", "平"]);
    expect(res.snapshot.lastWheels.map((w) => w.eventId)).toEqual(["ev-wheel-a", "ev-wheel-b"]);
    // D-16：标题随结果落进状态，刷新后不必回查本轮 triggeredEvents
    expect(res.snapshot.lastWheels.map((w) => w.title)).toEqual(["晨间占卜", "夜间抽签"]);
    expect(res.snapshot.lastWheel?.title).toBe("夜间抽签");
    // 向后兼容：单槽 lastWheel / V2TurnResult.wheelResult 仍是「最后一个」
    expect(res.snapshot.lastWheel?.label).toBe("平");
    expect(res.wheelResult?.label).toBe("平");
    // 状态层与投影同源（投影不自行推测）
    expect(res.snapshot.lastWheels).toEqual(state.lastWheels);
  });

  it("D-03：lastWheels 是「当轮」而非累计历史（下一轮起点清空，lastWheel 保持最近一次）", () => {
    const { state, template, lookup } = makeMultiWheelWorld();
    advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(state.lastWheels?.length).toBe(2);

    const second = advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    // 冷却期内不再触发转盘 ⇒ 本轮列表为空，而不是沿用/累加上一轮
    expect(second.snapshot.lastWheels).toEqual([]);
    expect(state.lastWheels).toEqual([]);
    expect(second.wheelResult).toBeNull();
    // 单槽语义不变：仍是历史上「最近一次」的转盘
    expect(second.snapshot.lastWheel?.label).toBe("平");
  });

  it("行动钩子触发战斗，胜利结算 onVictory 效果", () => {
    const { state, template } = makeState();
    const lookup = createLookup(template);
    const res = advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);
    expect(state.battle).not.toBeNull();
    expect(state.battle!.enemies[0].name).toBe("测试敌人");

    // 一击必杀（伤害有 ±1 浮动，压低敌人血量保证确定性）
    const b = state.battle!;
    b.enemies[0].hp = 50;
    b.enemies[0].maxHp = 50;
    while (!b.over) {
      performBattleAction(state, { type: "skill", skillId: "sk-strike" }, lookup, () => 0.01);
    }
    expect(b.over).toBe("victory");

    // 结算结果（模拟服务端 battle 端点收尾）
    const battleEvent = lookup.event("ev-ambush")!;
    const outcomeDef = battleEvent.kind === "combat" ? battleEvent.settle.combat.onVictory : undefined;
    applyEffectsV2({ state, lookup, rng: () => 0.5, logs: [] }, outcomeDef?.effects);
    finishBattle(state, lookup);

    expect(state.flags.won).toBe(true);
    expect(state.battle!.over).toBe("victory");
  });

  it("战败保底 1 点生命并施加战败补正", () => {
    const { state, template } = makeState();
    const lookup = createLookup(template);
    advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);
    const b = state.battle!;
    b.enemies[0].hp = 500; // 拉高敌人血量，确保玩家先被反击打倒
    b.enemies[0].maxHp = 500;
    while (!b.over) {
      performBattleAction(state, { type: "skill", skillId: "sk-strike" }, lookup, () => 0.01);
    }
    expect(b.over).toBe("defeat");
    finishBattle(state, lookup);
    expect(state.player.hp).toBe(1);
  });

  it("battleActionV2 战斗结束立即清除会话并返回胜负结果", () => {
    const { state, template } = makeState();
    const lookup = createLookup(template);
    advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);
    const b = state.battle!;
    expect(b).not.toBeNull();
    b.enemies[0].hp = 50; // 压低敌人血量保证一击必杀
    b.enemies[0].maxHp = 50;

    const res = battleActionV2(state, { type: "skill", skillId: "sk-strike" }, template, lookup);
    // 战斗结束后会话立即清除：前端据此直接回到常规行动界面，不再依赖「离开战场」
    expect(state.battle).toBeNull();
    expect(res.snapshot.battle).toBeNull();
    // 胜负效果已结算，且结果作为可展示事件返回
    expect(state.flags.won).toBe(true);
    expect(res.triggeredEvents.some((e) => e.title === "战斗胜利")).toBe(true);
  });

  it("combat 并发：已有战斗时新战斗事件整条跳过，不留触发/历史/冷却痕迹", () => {
    const template = makeTestTemplate();
    // 追加一个 pool 战斗事件，与 action-hook 战斗（ev-ambush）在同轮并发
    template.events.push({
      id: "ev-pool-combat",
      title: "并发战斗",
      narrative: "另一场战斗。",
      trigger: { source: "pool", probability: 1, priority: 99 },
      kind: "combat",
      settle: { combat: { enemies: [{ ref: "enemy-x", levelScale: 1 }] } },
    });
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "test", playerName: "测试者", seed: 42 }, template, "w-conflict");
    const res = advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);

    // 第一场战斗（action-hook）生效
    expect(state.battle).not.toBeNull();
    expect(state.battle!.eventId).toBe("ev-ambush");
    // 第二场战斗被整条跳过：不写 firedEvents（once/冷却不消耗）、不写触发提示、不写历史
    expect(state.firedEvents["ev-pool-combat"]).toBeUndefined();
    expect(res.triggeredEvents.some((e) => e.id === "ev-pool-combat")).toBe(false);
    expect(state.history.some((h) => h.summary.includes("并发战斗"))).toBe(false);
  });

  it("combat 并发优先级：事件链 > 行动触发", () => {
    const template = makeTestTemplate();
    // 追加链战斗事件与链定义：nextTurn 步在本轮推进到战斗步骤
    template.events.push({
      id: "ev-chain-combat",
      title: "主线战斗",
      narrative: "主线遭遇。",
      trigger: { source: "chain" },
      kind: "combat",
      settle: { combat: { enemies: [{ ref: "enemy-x", levelScale: 1 }] } },
    });
    template.chains = [
      {
        id: "chain-test",
        startEventId: "ev-chain-combat",
        steps: [
          { eventId: "ev-chain-combat", advanceWhen: "nextTurn" },
          { eventId: "ev-chain-combat", advanceWhen: "onSettle" },
        ],
      },
    ];
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "test", playerName: "测试者", seed: 42 }, template, "w-priority");
    // 注入 active 链，使 nextTurn 步在本轮触发链战斗
    state.chains.push({ id: "chain-test", stepIndex: 0, status: "active", startedTurn: 0 });

    const res = advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);
    // 链战斗（事件链）优先于行动钩子战斗（action-hook）抢占战斗槽位
    expect(state.battle).not.toBeNull();
    expect(state.battle!.eventId).toBe("ev-chain-combat");
    // 行动钩子战斗被整条跳过，不留痕迹
    expect(state.firedEvents["ev-ambush"]).toBeUndefined();
    expect(res.triggeredEvents.some((e) => e.id === "ev-ambush")).toBe(false);
  });

  it("combat 并发优先级：时间触发 > 行动触发", () => {
    const template = makeTestTemplate();
    // 追加 schedule 战斗事件；窗口起点 1 小时 = 首轮默认步长，故首轮即到期
    template.events.push({
      id: "ev-schedule-combat",
      title: "剧情战斗",
      narrative: "剧情节点。",
      trigger: { source: "schedule", window: { start: { value: 1, unit: "hour" } } },
      kind: "combat",
      settle: { combat: { enemies: [{ ref: "enemy-x", levelScale: 1 }] } },
    });
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "test", playerName: "测试者", seed: 42 }, template, "w-sched");
    const res = advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);

    // schedule 战斗（时间触发）优先于 action-hook 战斗抢占槽位
    expect(state.battle).not.toBeNull();
    expect(state.battle!.eventId).toBe("ev-schedule-combat");
    expect(state.firedEvents["ev-ambush"]).toBeUndefined();
    expect(res.triggeredEvents.some((e) => e.id === "ev-ambush")).toBe(false);
  });

  it("normal 队列优先级：事件链 > 时间触发 > 行动触发 > 事件池", () => {
    const template = makeTestTemplate();
    // 追加三种来源的 normal 事件；pool 的 ev-normal 已存在（优先级最低）
    template.events.push(
      {
        id: "ev-chain-normal",
        title: "链事件",
        narrative: "主线。",
        trigger: { source: "chain" },
        kind: "normal",
        settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
      },
      {
        id: "ev-sched-normal",
        title: "时间事件",
        narrative: "剧情节点。",
        trigger: { source: "schedule", window: { start: { value: 1, unit: "hour" } } },
        kind: "normal",
        settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
      },
      {
        id: "ev-hook-normal",
        title: "行动事件",
        narrative: "行动遭遇。",
        trigger: { source: "action-hook", onActionId: "patrol", probability: 1 },
        kind: "normal",
        settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
      },
    );
    template.chains = [
      {
        id: "chain-normal-test",
        startEventId: "ev-chain-normal",
        steps: [
          { eventId: "ev-chain-normal", advanceWhen: "nextTurn" },
          { eventId: "ev-chain-normal", advanceWhen: "onSettle" },
        ],
      },
    ];
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "test", playerName: "测试者", seed: 42 }, template, "w-normal-prio");
    state.chains.push({ id: "chain-normal-test", stepIndex: 0, status: "active", startedTurn: 0 });

    const res = advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);

    // 队列按优先级有序，与 combat 的抢占顺序一致；取队首即最高优先级
    expect(state.pendingEvents.map((p) => p.eventId)).toEqual([
      "ev-chain-normal",
      "ev-sched-normal",
      "ev-hook-normal",
      "ev-normal",
    ]);
    expect(res.snapshot.pendingEvent?.eventId).toBe("ev-chain-normal");
  });

  it("normal 队列：后到的高优先级事件插队，同优先级保持 FIFO", () => {
    const template = makeTestTemplate();
    // 一个不会自动触发的 pool 事件，用于观察同优先级项的相对顺序
    template.events.push({
      id: "ev-pool-normal-2",
      title: "随机事件二",
      narrative: "另一个随机事件。",
      trigger: { source: "pool", probability: 0 },
      kind: "normal",
      settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
    });
    // 链事件改由 choose 结算路径的 nextEventId 触发（不经过轮次管线的 resolver 顺序）
    const evNormal = template.events.find((e) => e.id === "ev-normal");
    const plain = evNormal?.kind === "normal" ? evNormal.settle.normal.options.find((o) => o.id === "opt-plain") : undefined;
    if (plain) plain.nextEventId = "ev-chain-normal";
    template.events.push({
      id: "ev-chain-normal",
      title: "链事件",
      narrative: "主线。",
      trigger: { source: "chain" },
      kind: "normal",
      settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
    });
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "test", playerName: "测试者", seed: 42 }, template, "w-normal-insert");
    // 预置遗留队列：三个同优先级 pool 事件，相对顺序需保持
    state.pendingEvents.push(
      { eventId: "ev-normal" },
      { eventId: "ev-pool-normal-2" },
      { eventId: "ev-normal" },
    );

    const res = chooseOptionV2(state, { optionId: "opt-plain" }, template, lookup);
    // 队首被消费；结算中新触发的链事件插到最前，剩余 pool 事件仍按原 FIFO 顺序；
    // #34：结算轮尾管线又抽中 ev-normal（probability=1、无冷却），为下一槽位追加一条。
    expect(state.pendingEvents.map((p) => p.eventId)).toEqual([
      "ev-chain-normal",
      "ev-pool-normal-2",
      "ev-normal",
      "ev-normal",
    ]);
    expect(res.snapshot.pendingEvent?.eventId).toBe("ev-chain-normal");
  });

  it("献祭技能按层数结算伤害并消耗补正", () => {
    const { state, template } = makeState();
    const lookup = createLookup(template);
    state.player.skills = ["sk-uzumaki"];
    state.battle = createBattle(
      "ev-ambush",
      { enemies: [{ ref: "enemy-x", levelScale: 1 }], canFlee: false },
      state,
      lookup,
    );
    state.battle.player.statuses.push({ statusId: "absorbed-curses", stacks: 2, appliedTurn: 0 });
    const enemy = state.battle.enemies[0];
    performBattleAction(state, { type: "skill", skillId: "sk-uzumaki" }, lookup, () => 0.5);
    // 敌人上限 120（100 + 4×5），旋涡伤害 10 + 2×15 = 40 ±1 → 79~81
    expect(enemy.hp).toBeGreaterThanOrEqual(79);
    expect(enemy.hp).toBeLessThanOrEqual(81);
    expect(state.battle.player.statuses.some((s) => s.statusId === "absorbed-curses")).toBe(false);
  });

  it("补正模拟域：轮次递减与休息治疗", () => {
    const { state, template } = makeState();
    const lookup = createLookup(template);
    // 遭遇战败以获得 inj（turns 2, restTurns 2）
    advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);
    const b = state.battle!;
    b.enemies[0].hp = 500;
    b.enemies[0].maxHp = 500;
    while (!b.over) {
      performBattleAction(state, { type: "skill", skillId: "sk-strike" }, lookup, () => 0.01);
    }
    const battleEvent = lookup.event("ev-ambush")!;
    const outcomeDef = battleEvent.kind === "combat" ? battleEvent.settle.combat.onDefeat : undefined;
    finishBattle(state, lookup);
    applyEffectsV2({ state, lookup, rng: () => 0.5, logs: [] }, outcomeDef?.effects);
    state.battle = null;
    expect(state.player.statuses.some((s) => s.statusId === "inj")).toBe(true);

    // 休息一次 → restProgress=1，仍存在（先清空巡逻触发的待决事件）
    state.battle = null;
    state.pendingEvents = [];
    advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(state.player.statuses.find((s) => s.statusId === "inj")?.restProgress).toBe(1);
    // 第二次休息 → 痊愈
    state.battle = null;
    state.pendingEvents = [];
    advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(state.player.statuses.some((s) => s.statusId === "inj")).toBe(false);
  });
});

// ---------- 咒术转盘 · 开局角色创建链（事件链 + 获取技能/装备/补正/成长）----------

describe("V2 引擎 · 咒术转盘开局链", () => {
  it("开局 handoff 直挂转盘入口：逐轮获取技能/装备/补正 + 全量标记", () => {
    const template = loadJjkTemplate();
    const lookup = createLookup(template);
    // 与真实开局一致：opening handoff 直接把 ev-opening-wheel 推入待决队列首
    const opening = {
      ...createDefaultOpeningTemplate(),
      openingId: "op-wheel-test",
      handoff: { pendingEvents: ["ev-opening-wheel"], schedule: [] },
    };
    const state = createActiveWorldV2(
      { templateId: "jjk-2006", playerName: "测试者", seed: 7 },
      template,
      "w-wheel",
      opening,
    );

    // 创建世界即为转盘入口事件，无需先推进轮次
    expect(state.pendingEvents[0]?.eventId).toBe("ev-opening-wheel");

    // 开始转盘链
    chooseOptionV2(state, { optionId: "opt-begin" }, template, lookup);
    expect(state.chains.some((c) => c.id === "chain-creation" && c.status === "active")).toBe(true);

    // 逐步推进创建链；每步选一个「能验证机制」的选项
    let guard = 0;
    while (guard++ < 40) {
      const pend = state.pendingEvents[0];
      if (!pend || !/^ev-w\d{2}$/.test(pend.eventId)) break;
      const ev = template.events.find((e) => e.id === pend.eventId);
      if (!ev || ev.kind !== "normal") break;
      let optId = ev.settle.normal.options[0].id;
      const pickByText = (needle: string) => {
        const o = ev.settle.normal.options.find((x) => x.text.includes(needle));
        if (o) optId = o.id;
      };
      switch (ev.title) {
        case "性别":
          pickByText("女性");
          break;
        case "年龄与出身":
          pickByText("十五岁 · 东京都内");
          break;
        case "咒力资质":
          pickByText("绳子烧断了");
          break;
        case "生得术式":
          pickByText("影法术");
          break;
        case "术式的应用":
          pickByText("领域");
          break;
        case "咒具":
          pickByText("天逆");
          break;
        case "引路人":
          pickByText("夜蛾正道");
          break;
        case "代价":
          // 第一个选项（天与咒缚）只在「无术式」时可选，这里选一个恒可选的
          pickByText("没有代价");
          break;
        default:
          break;
      }
      chooseOptionV2(state, { optionId: optId }, template, lookup);
    }

    // 创建链收束（ev-w12 是真转盘：random 即时结算；ev-w13 入学式收尾）
    expect(state.chains.find((c) => c.id === "chain-creation")?.status).toBe("completed");
    // 性别 / 年龄由玩家在事件里定下（setIdentity 生效）
    expect(state.player.gender).toBe("female");
    expect(state.playerAgeAtStart).toBe(15);
    // 术式 = 补正 + 多技能（不是单个技能）
    expect(state.player.statuses.some((s) => s.statusId === "tech-ten-shadow")).toBe(true);
    expect(state.player.skills).toContain("sk-ten-shadow");
    expect(state.player.skills).toContain("sk-ten-nue");
    expect(state.player.skills).toContain("sk-domain-expansion");
    // 咒具真的进背包
    expect((state.player.inventory["eq-ten-spear"] ?? 0) > 0).toBe(true);
    // 入学式：时间跳到 2006-04-03（第 92 天），冻结解除，进入第一章
    expect(state.flags.creationDone).toBe(true);
    expect(state.flags.era).toBe(1);
    expect(state.flags.chapter).toBe(1);
    expect(state.flags.ready1).toBe(true);
    expect(Math.round(state.worldTime / 1440)).toBe(92);
    // 全量标记覆盖（每一步都留下 wNN）
    const wheelCount = template.events.filter((e) => /^ev-w(0[1-9]|1[0-3])$/.test(e.id)).length;
    expect(wheelCount).toBe(13);
    for (let i = 1; i <= 12; i++) {
      expect(state.flags[`w${String(i).padStart(2, "0")}`]).toBeDefined();
    }
  });
});

// ---------- R2.6 关系图谱模板接入（T-B6 验收） ----------

describe("V2 引擎 · R2.6 关系图谱模板接入", () => {
  function worldWithRelations() {
    const template = loadJjkTemplate();
    const lookup = createLookup(template);
    const state = createActiveWorldV2(
      { templateId: "jjk-2006", playerName: "测试者", seed: 7 },
      template,
      "w-relations",
    );
    return { template, lookup, state };
  }

  it("characters[].relations 在新建世界时落为实例边（source=template、known）", () => {
    const { state } = worldWithRelations();
    expect(state.relations.length).toBeGreaterThanOrEqual(10);
    expect(state.relations.every((e) => e.source === "template")).toBe(true);
    // 模板显式声明 known；未声明的默认 unknown 才有资格出现，此处应无 unknown
    expect(state.relations.some((e) => e.visibility === "unknown")).toBe(false);
    // 互识三元组：五条↔夏油、五条↔硝子、夏油↔硝子
    const has = (from: string, to: string, kind: string) =>
      state.relations.some((e) => e.from === from && e.to === to && e.kind === kind);
    expect(has("npc-gojo", "npc-geto", "friend")).toBe(true);
    expect(has("npc-geto", "npc-gojo", "friend")).toBe(true);
    expect(has("npc-gojo", "npc-shoko", "colleague")).toBe(true);
    expect(has("npc-shoko", "npc-geto", "colleague")).toBe(true);
    expect(has("npc-yuta", "npc-gojo", "mentor")).toBe(true);
    // NPC → 玩家 的初始边（「NPC 视你为 X」面板的来源）。方向：kind 属于 from 一侧，
    // 故「夜蛾视你为弟子」= disciple（不是 mentor）；必须显式 known 且不带 value。
    expect(has("npc-yaga", "player", "disciple")).toBe(true);
    expect(has("npc-gojo", "player", "disciple")).toBe(true);
    expect(has("npc-nanami", "player", "colleague")).toBe(true);
    expect(has("npc-shoko", "player", "colleague")).toBe(true);
    expect(has("npc-geto", "player", "friend")).toBe(true);
    expect(
      state.relations
        .filter((e) => e.to === "player")
        .every((e) => e.visibility === "known" && e.value === undefined),
    ).toBe(true);
  });

  it("断代亲属（gap）端到端查询得确定性粗称谓，不猜代数", () => {
    const { state } = worldWithRelations();
    const edge = state.relations.find(
      (e) => e.from === "npc-gojo" && e.to === "npc-yuta" && e.kind === "relative",
    );
    expect(edge?.gap).toBe(true);
    const term = kinshipTerm(state.relations, "npc-gojo", "npc-yuta");
    expect(term?.term).toBe("远亲");
    expect(term?.exact).toBe(false);
    // 确定性：重复查询同结果
    expect(kinshipTerm(state.relations, "npc-gojo", "npc-yuta")).toEqual(term);
  });

  it("社会边构成可达图（师徒/同僚），且不产出亲属称谓", () => {
    const { state } = worldWithRelations();
    const graph = buildRelationGraph(state.relations);
    // 乙骨 → 五条 → 硝子：两跳（社会边）
    const path = shortestPath(graph, "npc-yuta", "npc-shoko", { kinshipOnly: false });
    expect(path?.edges).toHaveLength(2);
    expect(path?.tokens).toEqual(["mentor", "colleague"]);
    // 亲属口径下不可达
    expect(shortestPath(graph, "npc-yuta", "npc-shoko")).toBeNull();
    expect(isKinshipReachable(state.relations, "npc-yuta", "npc-shoko")).toBe(false);
  });

  it("投影只含可见边且带称谓字段（不含 unknown/hidden）", () => {
    const { template, lookup, state } = worldWithRelations();
    const view = projectSnapshotV2(state, template, lookup);
    const gojo = view.npcs.find((n) => n.id === "npc-gojo")!;
    expect(gojo.relations.length).toBeGreaterThan(0);
    expect(gojo.relations.every((r) => r.visibility === "known" || r.visibility === "inferred")).toBe(true);
    // ADR-0022 补记 D-1（反改）：乙骨由 npcSpawnRules[rule-yuta-arrival] 管辖、建世界期
    // unspawned ⇒ 五条→乙骨的 gap 亲属边不进投影，面板不再出现「视 npc-yuta 为亲戚 · 远亲」。
    // 旧断言（`kin?.kinshipTerm === "远亲"`）固化的是本补记认定的缺陷行为，不得回退。
    expect(gojo.relations.some((r) => r.withId === "npc-yuta")).toBe(false);
    expect(view.npcs.some((n) => n.id === "npc-yuta")).toBe(false);
    // 任何 NPC 的 relations 都不得出现指向未登场者的行（id 不外泄）
    expect(view.npcs.some((n) => n.relations.some((r) => r.withId === "npc-yuta"))).toBe(false);
    expect(JSON.stringify(view)).not.toContain("npc-yuta");
    // 反面：NPC → 玩家 的初始边必须照常上屏（面板要能显示「五条悟视你为弟子」）
    expect(gojo.relations.some((r) => r.withId === "player" && r.kind === "disciple")).toBe(true);
    // 引擎侧 graph 事实不变（只改投影期）：边仍在 state 里，模板作者可继续用条件读它
    expect(
      state.relations.some((e) => e.from === "npc-gojo" && e.to === "npc-yuta" && e.kind === "relative"),
    ).toBe(true);
    expect(JSON.stringify(view)).not.toContain("hidden");
  });
});
