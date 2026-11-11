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
import { createActiveWorldV2 } from "./v2/test-utils.js";

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
    expect(template.skills.some((s) => s.id === "sk-domain-void")).toBe(true);
    expect(template.chains?.length).toBe(6);
  });

  it("怀玉·玉折主线：schedule 绝对时间开场 + 事件链 + 分支结局", () => {
    const template = loadJjkTemplate();
    // 开场为绝对时间事件（到达指定日期自动触发）
    const briefing = template.events.find((e) => e.id === "ev-sp-briefing");
    expect(briefing?.trigger.source).toBe("schedule");
    if (briefing?.trigger.source === "schedule") {
      expect(briefing.trigger.window).toEqual({ start: { value: 1, unit: "day" } });
      expect(briefing.trigger.once).toBe(true);
    }
    // 事件链存在，且起点为 source: chain 的 normal 事件
    const chain = template.chains?.find((c) => c.id === "chain-star-plasma");
    expect(chain).toBeDefined();
    const start = template.events.find((e) => e.id === chain?.startEventId);
    expect(start?.trigger.source).toBe("chain");
    expect(start?.kind).toBe("normal");
    // 四条结局事件均存在
    for (const id of [
      "ev-sp-ending-survival",
      "ev-sp-ending-riko-lives",
      "ev-sp-ending-canon",
      "ev-sp-ending-gojo-dead",
      "ev-sp-ending-decline",
    ]) {
      expect(template.events.some((e) => e.id === id)).toBe(true);
    }
    // 星浆体 NPC 天内里子已加入角色表
    expect(template.characters.some((c) => c.id === "npc-riko")).toBe(true);
  });
});

// ---------- 怀玉·玉折主线的链式分支链路（正常路径） ----------

describe("V2 引擎 · 怀玉玉折主线链路", () => {
  it("识破伏击 → 里子·甚尔存活结局", () => {
    const template = loadJjkTemplate();
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "jjk-2006", playerName: "测试者", seed: 7 }, template, "w-sp");
    // 直接注入开场事件（等价于 schedule 事件在绝对时间到达时被触发）
    state.pendingEvents = [{ eventId: "ev-sp-briefing" }];
    state.firedEvents["ev-sp-briefing"] = state.turnIndex;
    consumeScheduleInstance(state, "ev-sp-briefing");

    // 1. 加入护卫队 → startChain 把链起点 ev-sp-riko-meet 压入待决
    let res = chooseOptionV2(state, { optionId: "opt-join-guard" }, template, lookup);
    expect(res.snapshot.pendingEvent?.eventId).toBe("ev-sp-riko-meet");
    expect(state.chains.some((c) => c.id === "chain-star-plasma" && c.status === "active")).toBe(true);

    // 2. 制定护卫路线 → 进入同化前夜
    res = chooseOptionV2(state, { optionId: "opt-plan-guard" }, template, lookup);
    expect(res.snapshot.pendingEvent?.eventId).toBe("ev-sp-vigil");

    // 3. 全程警惕（guardPlan 解锁）→ 进入伏击
    res = chooseOptionV2(state, { optionId: "opt-watch" }, template, lookup);
    expect(res.snapshot.pendingEvent?.eventId).toBe("ev-sp-ambush");
    expect(state.flags.spAware).toBe(true);

    // 4. 看穿伏击（spAware 解锁）→ 里子·甚尔存活结局
    res = chooseOptionV2(state, { optionId: "opt-foresee" }, template, lookup);
    expect(res.snapshot.pendingEvent?.eventId).toBe("ev-sp-ending-survival");
    expect(state.flags.rikoAlive).toBe(true);
    expect(state.flags.tojiAlive).toBe(true);
    expect(state.flags.getoDarkened).toBe(false);
    expect(state.flags.spEnding).toBe("survival");

    // 5. 结局收束 → 事件链完成
    res = chooseOptionV2(state, { optionId: "opt-ack-survival" }, template, lookup);
    // #34：事件轮跑完整管线，结算末尾的 pool 门控会为下一槽位抽出世界事件，
    // 故「结算后队列必为空」的旧断言不再成立；主线链本身必须已收束且无残留链事件。
    expect(state.pendingEvents.some((p) => p.chainId === "chain-star-plasma")).toBe(false);
    expect(state.chains.find((c) => c.id === "chain-star-plasma")?.status).toBe("completed");
    expect(state.flags.canonDeviation).toBe(5);
  });

  it("迟疑 → 原作玉折结局；鲁莽 → 五条死亡结局", () => {
    const template = loadJjkTemplate();
    const lookup = createLookup(template);

    const canon = createActiveWorldV2({ templateId: "jjk-2006", playerName: "甲", seed: 7 }, template, "w-canon");
    canon.pendingEvents = [{ eventId: "ev-sp-ambush" }];
    canon.firedEvents["ev-sp-ambush"] = canon.turnIndex;
    const rc = chooseOptionV2(canon, { optionId: "opt-hesitate" }, template, lookup);
    expect(rc.snapshot.pendingEvent?.eventId).toBe("ev-sp-ending-canon");
    expect(canon.flags.getoDarkened).toBe(true);
    expect(canon.flags.gojoAlive).toBe(true);

    const dead = createActiveWorldV2({ templateId: "jjk-2006", playerName: "乙", seed: 7 }, template, "w-dead");
    dead.pendingEvents = [{ eventId: "ev-sp-ambush" }];
    dead.firedEvents["ev-sp-ambush"] = dead.turnIndex;
    const rd = chooseOptionV2(dead, { optionId: "opt-reckless" }, template, lookup);
    expect(rd.snapshot.pendingEvent?.eventId).toBe("ev-sp-ending-gojo-dead");
    expect(dead.flags.gojoAlive).toBe(false);
    expect(dead.flags.getoDarkened).toBe(true);
  });
});

// ---------- 补正系统、advanceTime 与百鬼夜行 ----------

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
        { enemies: [{ ref: "enemy-curse-larva", levelScale: 1 }], canFlee: false },
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

  it("玉折结局 → 时间跳跃至百鬼夜行并开启二选一", () => {
    const template = loadJjkTemplate();
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "jjk-2006", playerName: "测试者", seed: 7 }, template, "w-night");
    state.pendingEvents = [{ eventId: "ev-sp-ending-canon" }];
    state.firedEvents["ev-sp-ending-canon"] = state.turnIndex;
    // 模拟已走过的 schedule 开场事件，避免 advanceTo 后重复触发
    state.firedEvents["ev-sp-briefing"] = state.turnIndex;
    consumeScheduleInstance(state, "ev-sp-briefing");

    const res = chooseOptionV2(state, { optionId: "opt-ack-canon" }, template, lookup);
    // 时间跳跃约 12 年，年龄同步推进
    expect(state.worldTime).toBe(12 * 525600);
    expect(state.player.age).toBe(state.playerAgeAtStart + 12);
    // 开启百鬼夜行事件链，待决为「决战前夜」二选一
    expect(state.chains.some((c) => c.id === "chain-night-parade" && c.status === "active")).toBe(true);
    expect(res.snapshot.pendingEvent?.eventId).toBe("ev-night-parade-prologue");

    // 选择随乙骨迎战夏油杰 → 进入高专战线战斗
    const res2 = chooseOptionV2(state, { optionId: "opt-yuta-line" }, template, lookup);
    expect(state.flags.nightLine).toBe("kyoto");
    expect(state.battle).not.toBeNull();
    expect(state.battle?.enemies[0].name).toBe("夏油杰");
  });

  it("咒言术为战斗技能，主角初始拥有并附眩晕", () => {
    const template = loadJjkTemplate();
    const skill = template.skills.find((s) => s.id === "sk-cursed-speech");
    expect(skill?.kind).toBe("combat");
    if (skill?.kind === "combat") {
      expect(skill.applyStatus?.[0]?.status).toBe("stun");
      expect(skill.damage?.[0]?.preset).toBe("scaled");
    }
    expect(template.playerTemplate?.skills).toContain("sk-cursed-speech");
    // 主角已强化：初始咒力高于默认值
    expect(template.playerTemplate?.attributes.cursedEnergy).toBeGreaterThan(5);
  });
});

describe("V2 引擎 · 事件链起点触发（回归）", () => {
  it("上报高专 → startChain 随机起点事件即时结算，不再卡死", () => {
    const template = loadJjkTemplate();
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "jjk-2006", playerName: "测试者", seed: 7 }, template, "w-report");
    state.pendingEvents = [{ eventId: "ev-curse-sighting" }];
    state.firedEvents["ev-curse-sighting"] = state.turnIndex;

    chooseOptionV2(state, { optionId: "opt-report" }, template, lookup);
    // 链注册为 active
    expect(state.chains.some((c) => c.id === "chain-curse-investigation" && c.status === "active")).toBe(true);
    // 随机起点事件 ev-curse-investigate 已即时结算，未被塞进待决队列
    expect(state.pendingEvents.some((p) => p.eventId === "ev-curse-investigate")).toBe(false);
    // 待决队列里只允许 normal 事件（否则 pendingEventView 返回 null 导致卡死）
    expect(state.pendingEvents.every((p) => lookup.event(p.eventId)?.kind === "normal")).toBe(true);
    // 不处于卡死状态：要么已进入战斗（转盘命中讨伐战），要么有待决 normal 事件可结算
    const hasBattle = state.battle !== null && !state.battle!.over;
    expect(hasBattle || state.pendingEvents.length > 0).toBe(true);
  });
});

// ---------- 组队战斗（友军单位） ----------

describe("V2 引擎 · 组队战斗", () => {
  const template = loadJjkTemplate();
  const lookup = createLookup(template);

  function teamBattle(eventId: string, worldId: string) {
    const state = createActiveWorldV2({ templateId: "jjk-2006", playerName: "测试者", seed: 7 }, template, worldId);
    const event = lookup.event(eventId);
    if (!event || event.kind !== "combat") throw new Error(`not a combat event: ${eventId}`);
    state.battle = createBattle(eventId, event.settle.combat, state, lookup);
    return state;
  }

  it("友军参战：按 levelScale 构建单位，与敌人分属两阵营，并进入战斗投影", () => {
    const state = teamBattle("ev-fight-geto", "w-team-build");
    const b = state.battle!;
    // 友军单位独立于敌人列表，且来自模板 allies 引用
    expect(b.allies.length).toBe(1);
    expect(b.allies[0].characterId).toBe("npc-yuta");
    expect(b.allies[0].name).toBe("乙骨忧太");
    expect(b.allies[0].alive).toBe(true);
    expect(b.allies[0].hp).toBe(b.allies[0].maxHp);
    expect(b.enemies[0].name).toBe("夏油杰");
    expect(b.enemies).toHaveLength(1);

    // 投影对玩家暴露友军单位（不含隐藏字段）
    const view = projectSnapshotV2(state, template, lookup);
    expect(view.battle?.allies).toHaveLength(1);
    expect(view.battle?.allies[0].name).toBe("乙骨忧太");
    expect(view.battle?.enemies[0].name).toBe("夏油杰");
  });

  it("友军 AI 在玩家行动后自动行动并攻击敌人", () => {
    const state = teamBattle("ev-fight-geto", "w-team-ai");
    const b = state.battle!;
    const enemy = b.enemies[0];
    enemy.hp = 100000;
    enemy.maxHp = 100000;
    enemy.skills = []; // 隔离敌人反击
    const ally = b.allies[0];
    ally.skills = ["sk-cursed-strike"]; // 友军仅保留攻击技能
    const before = enemy.hp;

    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);

    // 友军「乙骨忧太」已施放技能（日志含其名），且敌人受到其伤害
    expect(b.log.some((l) => l.includes("乙骨忧太") && l.includes("咒力斩击"))).toBe(true);
    expect(enemy.hp).toBeLessThan(before);
  });

  it("组队胜利：玩家与友军合力击败敌人", () => {
    const state = teamBattle("ev-fight-geto", "w-team-win");
    const b = state.battle!;
    const enemy = b.enemies[0];
    enemy.hp = 10;
    enemy.maxHp = 10;
    enemy.skills = [];

    // 玩家体术命中（命中率 0.65）后敌人残血，友军补刀击杀
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);

    expect(b.over).toBe("victory");
  });

  it("友军倒下不影响胜负判定，战斗继续", () => {
    const state = teamBattle("ev-fight-geto", "w-team-ally-down");
    const b = state.battle!;
    const enemy = b.enemies[0];
    enemy.hp = 100000;
    enemy.maxHp = 100000;
    enemy.skills = [];

    // 友军被击倒
    const ally = b.allies[0];
    ally.hp = 0;
    ally.alive = false;

    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);

    // 敌人仍在、玩家存活 → 战斗不因友军倒下而结束
    expect(b.over).toBeNull();
    expect(b.allies[0].alive).toBe(false);
  });
});

// ---------- 受控行为的最小测试模板 ----------

function makeTestTemplate(): WorldTemplateV2 {
  return {
    meta: { id: "test", name: "测试世界", description: "d", startYear: 2000, engineProtocol: "v2" },
    time: { defaultStep: { value: 1, unit: "hour" } },
    genders: [{ id: "f", label: "女" }],
    mood: {
      min: 0,
      max: 100,
      defaultValue: 60,
      bands: [
        { id: "low", label: "消沉", min: 0, max: 39, attributeModifiers: { cursedEnergy: -1 } },
        { id: "normal", label: "平静", min: 40, max: 100, attributeModifiers: {} },
      ],
    },
    statusBar: [{ id: "sb1", label: "基本", source: "identity" }],
    attributes: {
      order: ["cursedEnergy", "agility", "luck", "willpower"],
      defaults: { cursedEnergy: 5, agility: 5, luck: 5, willpower: 3 },
    },
    resources: {
      hp: { base: 100, perLevel: 0, perAttribute: { cursedEnergy: 4 } },
      mp: { base: 50, perLevel: 0, perAttribute: { cursedEnergy: 2 } },
    },
    regen: { perTurn: { hp: 2, mp: 1 } },
    characters: [
      {
        id: "enemy-x",
        isEnemy: true,
        visibility: "public",
        identity: { name: "测试咒灵", age: 0, gender: "f" },
        mood: { value: 50 },
        attributes: { cursedEnergy: 5, agility: 1, luck: 0 },
        skills: ["sk-nuke"],
        public: { personality: "测试用" },
        private: { combatHints: { skillWeights: { "sk-nuke": 1 } } },
        relationship: -100,
      },
    ],
    playerTemplate: {
      identity: { age: 16, gender: "f" },
      mood: 60,
      attributes: { cursedEnergy: 5, agility: 5, luck: 5 },
      skills: ["sk-strike"],
    },
    actions: [
      { id: "patrol", label: "巡逻", duration: { value: 1, unit: "hour" } },
      { id: "rest", label: "休息", duration: { value: 1, unit: "hour" } },
    ],
    skills: [
      {
        id: "sk-strike",
        kind: "combat",
        name: "强击",
        cost: { mp: 0 },
        target: "enemy",
        damage: [{ preset: "fixed", value: 100 }],
        cooldownTurns: 0,
        usableInBattle: true,
      },
      {
        id: "sk-nuke",
        kind: "combat",
        name: "湮灭",
        cost: { mp: 0 },
        target: "enemy",
        damage: [{ preset: "fixed", value: 500 }],
        cooldownTurns: 0,
        usableInBattle: true,
      },
      {
        id: "sk-uzumaki",
        kind: "combat",
        name: "旋涡",
        cost: { mp: 0 },
        target: "enemy",
        hitCheck: { preset: "opposed", attacker: "cursedEnergy", defender: "agility", baseChance: 1 },
        damage: [{ preset: "stack-scaled", base: 10, perStack: 15, status: "absorbed-curses" }],
        consumeStatus: { status: "absorbed-curses" },
        cooldownTurns: 0,
        usableInBattle: true,
      },
    ],
    items: [],
    statuses: [
      {
        id: "absorbed-curses",
        name: "收集咒灵",
        duration: { turns: 5 },
        stacking: "stack",
        combat: {},
        visibility: "known",
      },
      {
        id: "inj",
        name: "轻伤",
        duration: { turns: 2 },
        stacking: "refresh",
        simulation: { attributeModifiers: { agility: -2 }, moodDeltaPerTurn: -2 },
        cureConditions: [{ restTurns: 2 }],
        visibility: "known",
      },
    ],
    events: [
      {
        id: "ev-normal",
        title: "抉择",
        narrative: "一个待决事件。",
        trigger: { source: "pool", probability: 1 },
        kind: "normal",
        settle: {
          normal: {
            options: [
              {
                id: "opt-secret",
                text: "秘密选项",
                visibleWhen: [{ requiresSkill: "sk-none" }],
                effects: [{ type: "setFlag", id: "choseSecret", value: true }],
              },
              {
                id: "opt-plain",
                text: "普通选项",
                effects: [{ type: "setFlag", id: "chosePlain", value: true }],
              },
            ],
          },
        },
      },
      {
        id: "ev-wheel",
        title: "抽签",
        narrative: "命运转盘。",
        // R2.5：事件触发冷却改为时间维度（天）；技能/NPC 行动的 cooldownTurns 保持不变
        trigger: { source: "pool", probability: 1, cooldown: { value: 99, unit: "day" } },
        kind: "random",
        settle: {
          random: {
            wheel: {
              segments: [
                { weight: 1, weightBy: { luck: 0.4 }, label: "大吉", effects: [{ type: "adjustMood", value: 10 }] },
                { weight: 3, label: "凶", effects: [{ type: "adjustMood", value: -5 }] },
              ],
            },
          },
        },
      },
      {
        id: "ev-ambush",
        title: "遇袭",
        narrative: "敌人出现！",
        trigger: { source: "action-hook", onActionId: "patrol", probability: 1 },
        kind: "combat",
        settle: {
          combat: {
            enemies: [{ ref: "enemy-x", levelScale: 1 }],
            onVictory: { effects: [{ type: "setFlag", id: "won", value: true }] },
            onDefeat: { effects: [{ type: "applyStatus", status: "inj" }] },
          },
        },
      },
    ],
  } as unknown as WorldTemplateV2;
}

function makeState(seed = 42): { state: WorldStateV2; template: WorldTemplateV2 } {
  const template = makeTestTemplate();
  const lookup = createLookup(template);
  const state = createActiveWorldV2({ templateId: "test", playerName: "测试者", seed }, template, "w1");
  return { state, template };
}

/**
 * R2.5：createWorldV2 会为全部 source: schedule 定义入队。测试手工把某事件标记为
 * 「已触发」时，须同步把对应 waiting 实例标 cancelled——once 是**入队门控**（用户裁决），
 * 出队判定不再重查 once，否则会与「模拟已发生」的夹具语义冲突。
 */
function consumeScheduleInstance(state: WorldStateV2, eventId: string): void {
  for (const inst of state.scheduledEvents) {
    if (inst.definitionId === eventId && inst.status === "waiting") inst.status = "cancelled";
  }
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

  it("行动钩子触发战斗，胜利结算 onVictory 效果", () => {
    const { state, template } = makeState();
    const lookup = createLookup(template);
    const res = advanceTurnV2(state, { action: { type: "patrol", description: "" } }, template, lookup);
    expect(state.battle).not.toBeNull();
    expect(state.battle!.enemies[0].name).toBe("测试咒灵");

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
  it("开局转盘链跑通：逐轮获取技能/装备/补正 + 全量标记", () => {
    const template = loadJjkTemplate();
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "jjk-2006", playerName: "测试者", seed: 7 }, template, "w-wheel");

    // 开局时间由模板配置（meta.startYear=2006），转盘链由定时事件 ev-opening-wheel 触发
    advanceTurnV2(state, { action: { type: "rest", description: "" } }, template, lookup);
    expect(state.pendingEvents.some((p) => p.eventId === "ev-opening-wheel")).toBe(true);

    // 开始转盘链
    chooseOptionV2(state, { optionId: "opt-begin" }, template, lookup);
    expect(state.chains.some((c) => c.id === "chain-wheel-creation" && c.status === "active")).toBe(true);

    // 逐轮推进转盘链；按轮次获取技能/装备/补正
    let guard = 0;
    while (guard++ < 90) {
      const pend = state.pendingEvents[0];
      if (!pend || !/^ev-w\d{2}$/.test(pend.eventId)) break;
      const ev = template.events.find((e) => e.id === pend.eventId);
      if (!ev || ev.kind !== "normal") break;
      let optId = ev.settle.normal.options[0].id;
      if (ev.title === "生得术式") {
        const o = ev.settle.normal.options.find((x) => x.text.includes("影法术"));
        if (o) optId = o.id;
      } else if (ev.title === "咒具") {
        const o = ev.settle.normal.options.find((x) => x.text.includes("天逆"));
        if (o) optId = o.id;
      } else if (ev.title === "天与咒缚") {
        const o = ev.settle.normal.options.find((x) => !/无|未|不|没/.test(x.text));
        if (o) optId = o.id;
      }
      chooseOptionV2(state, { optionId: optId }, template, lookup);
    }

    // 链收束
    expect(state.chains.find((c) => c.id === "chain-wheel-creation")?.status).toBe("completed");
    // 获取技能（生得术式 → 十种影法术）
    expect(state.player.skills).toContain("sk-ten-shadow");
    // 获取装备（咒具 → 天逆鉾）
    expect((state.player.inventory["eq-ten-spear"] ?? 0) > 0).toBe(true);
    // 获取补正（天与咒缚 → heavenly-restriction）
    expect(state.player.statuses.some((s) => s.statusId === "heavenly-restriction")).toBe(true);
    // 全量标记覆盖（开局转盘链全部维度：出身地点..神人语录）
    const wheelCount = template.events.filter((e) => /^ev-w\d{2}$/.test(e.id)).length;
    for (let i = 1; i <= wheelCount; i++) {
      expect(state.flags[`w${String(i).padStart(2, "0")}`]).toBeDefined();
    }
  });
});
