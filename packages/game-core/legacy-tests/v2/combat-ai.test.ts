import { describe, expect, it } from "vitest";
import {
  PublicConditionContextSchema,
  WorldTemplateV2Schema,
  type CombatStyleProfile,
  type WorldTemplateV2,
} from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { createActiveWorldV2 } from "./test-utils.js";
import { createBattle, performBattleAction } from "./battle.js";
import {
  PREFER_BOOST,
  buildPublicConditionContext,
  collectCandidates,
  decide,
  filterCandidates,
  scoreCandidates,
  selectAction,
} from "./combat-ai.js";
import { createRng } from "../rng.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 分层战斗 AI 契约测试（协议 V2.1 §20 / R-CA-01..06 / P1 / P7）：
 * 1) 五步各自可测；候选集不含被禁止行动；选择 = 最高分（R-CA-01）；
 * 2) 风格只解析成权重/过滤参数，引擎无风格名常量（R-CA-02）；
 * 3) 条件化策略命中/不命中；非公有字段加载期拒绝（R-CA-03/06）；
 * 4) 无 LLM、同 seed 决策一致；非法 actionId 回退（R-CA-04/05）；
 * 5) 未映射风格时行为与既有基线逐字段一致（回归保护）。
 */

const RAW_TEMPLATE: Record<string, unknown> = {
  meta: { id: "t-ai", name: "战斗AI测试", description: "d", startYear: 2000, engineProtocol: "v2" },
  time: { defaultStep: { value: 1, unit: "day" as const } },
  genders: [{ id: "f", label: "女" }],
  mood: {
    min: 0,
    max: 100,
    defaultValue: 60,
    bands: [{ id: "n", label: "平静", min: 0, max: 100, attributeModifiers: {} }],
  },
  statusBar: [{ id: "sb-hp", label: "生命值", source: "resource" as const, key: "hp" }],
  attributes: { order: ["power"], defaults: { power: 10 } },
  resources: { hp: { base: 100, perLevel: 0 }, mp: { base: 50, perLevel: 0 } },
  regen: { perTurn: { hp: 0, mp: 0 } },
  characters: [
    {
      id: "mob",
      isEnemy: true,
      identity: { name: "木桩", age: 20, gender: "f" },
      visibility: "public" as const,
      mood: { value: 60 },
      attributes: { power: 5 },
      skills: ["sk-strike", "sk-mend"],
      public: {},
      private: { combatHints: { skillWeights: { "sk-strike": 1, "sk-mend": 0 } } },
      relationship: 0,
    },
  ],
  playerTemplate: { identity: { gender: "f", age: 16 }, attributes: { power: 10 }, skills: ["sk-plink"] },
  skills: [
    {
      id: "sk-strike",
      kind: "combat" as const,
      name: "斩击",
      cost: { mp: 0 },
      target: "enemy" as const,
      damage: [{ preset: "fixed" as const, value: 8 }],
      cooldownTurns: 0,
      usableInBattle: true as const,
    },
    {
      id: "sk-mend",
      kind: "combat" as const,
      name: "疗愈",
      cost: { mp: 5 },
      target: "self" as const,
      heal: [{ preset: "fixed" as const, value: 12 }],
      cooldownTurns: 0,
      usableInBattle: true as const,
    },
    {
      id: "sk-plink",
      kind: "combat" as const,
      name: "弹指",
      cost: { mp: 0 },
      target: "enemy" as const,
      damage: [{ preset: "fixed" as const, value: 3 }],
      cooldownTurns: 0,
      usableInBattle: true as const,
    },
  ],
  statuses: [
    { id: "st-stun", name: "眩晕", duration: { turns: 1 }, stacking: "refresh" as const, combat: { control: ["cannot_act" as const] }, visibility: "known" as const },
    { id: "st-mute", name: "禁攻", duration: { turns: 1 }, stacking: "refresh" as const, combat: { control: ["cannot_attack" as const] }, visibility: "known" as const },
  ],
  items: [],
  events: [],
};

function makeTemplate(patch?: (raw: Record<string, unknown>) => void): WorldTemplateV2 {
  const raw = structuredClone(RAW_TEMPLATE);
  patch?.(raw);
  return WorldTemplateV2Schema.parse(raw);
}

function setup(seed = 5, patch?: (raw: Record<string, unknown>) => void) {
  const template = makeTemplate(patch);
  const lookup = createLookup(template);
  const state = createActiveWorldV2({ templateId: template.meta.id, playerName: "挑战者", seed }, template, "w-ai");
  state.battle = createBattle("ev-1", { enemies: [{ ref: "mob" }] }, state, lookup);
  return { template, lookup, state };
}

/** 评分上下文（满血满魔、第 1 回合、1v1）。 */
const PUB = buildPublicConditionContext({
  actor: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
  player: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
  round: 1,
  aliveAllies: 1,
  aliveFoes: 1,
});

function profileOf(patch: Partial<CombatStyleProfile>): CombatStyleProfile {
  return { styleId: "t", candidateFilters: [], scoreWeights: {}, conditions: [], ...patch };
}

describe("Schema 校验 · 战斗 AI 分域（R-CA-06）", () => {
  it("combatAi 分域 + assignments 校验通过；未知角色 / 未知风格 / 未知技能被拒", () => {
    const ok = makeTemplate((raw) => {
      raw.combatAi = {
        styles: [{ styleId: "s1", scoreWeights: { "sk-strike": 2 } }],
        assignments: { mob: "s1" },
      };
    });
    expect(ok.combatAi?.assignments).toEqual({ mob: "s1" });

    const badChar = structuredClone(RAW_TEMPLATE);
    badChar.combatAi = { styles: [{ styleId: "s1", scoreWeights: {} }], assignments: { "ghost-npc": "s1" } };
    expect(() => WorldTemplateV2Schema.parse(badChar)).toThrow(/未知角色：ghost-npc/);

    const badStyle = structuredClone(RAW_TEMPLATE);
    badStyle.combatAi = { styles: [{ styleId: "s1", scoreWeights: {} }], assignments: { mob: "ghost-style" } };
    expect(() => WorldTemplateV2Schema.parse(badStyle)).toThrow(/未知风格：ghost-style/);

    const badSkill = structuredClone(RAW_TEMPLATE);
    badSkill.combatAi = { styles: [{ styleId: "s1", scoreWeights: { "sk-ghost": 1 } }], assignments: {} };
    expect(() => WorldTemplateV2Schema.parse(badSkill)).toThrow(/未知行动\/技能：sk-ghost/);

    const badPrefer = structuredClone(RAW_TEMPLATE);
    badPrefer.combatAi = {
      styles: [{ styleId: "s1", scoreWeights: {}, conditions: [{ when: { round: { gte: 2 } }, prefer: ["sk-ghost"] }] }],
      assignments: {},
    };
    expect(() => WorldTemplateV2Schema.parse(badPrefer)).toThrow(/未知行动\/技能：sk-ghost/);
  });

  it("when 引用非公有字段（hidden / combatHints / knownGoals / secrets）加载期拒绝并含字段路径", () => {
    for (const field of ["hidden", "combatHints", "knownGoals", "secrets", "unknownField"]) {
      const raw = structuredClone(RAW_TEMPLATE);
      raw.combatAi = {
        styles: [
          { styleId: "s1", scoreWeights: { "sk-strike": 1 }, conditions: [{ when: { [field]: { gte: 1 } }, prefer: ["sk-strike"] }] },
        ],
        assignments: {},
      };
      expect(() => WorldTemplateV2Schema.parse(raw)).toThrow(new RegExp(field));
    }
  });

  it("NumericWhen 无比较操作 / when 空对象被拒", () => {
    const raw = structuredClone(RAW_TEMPLATE);
    raw.combatAi = {
      styles: [{ styleId: "s1", scoreWeights: {}, conditions: [{ when: {}, prefer: ["sk-strike"] }] }],
      assignments: {},
    };
    expect(() => WorldTemplateV2Schema.parse(raw)).toThrow(/when 至少引用一个公有字段/);

    const raw2 = structuredClone(RAW_TEMPLATE);
    raw2.combatAi = {
      styles: [{ styleId: "s1", scoreWeights: {}, conditions: [{ when: { round: {} }, prefer: ["sk-strike"] }] }],
      assignments: {},
    };
    expect(() => WorldTemplateV2Schema.parse(raw2)).toThrow(/至少需要一个比较操作/);
  });
});

describe("五步决策（R-CA-01）", () => {
  it("① collectCandidates：MP/CD/未注册 actionId 过滤；cannot_act 为空；cannot_attack 只剩非攻击", () => {
    const { lookup } = setup();
    const base = { skills: ["sk-strike", "sk-mend", "sk-ghost"], skillCooldowns: {}, statuses: [] };
    expect(collectCandidates({ ...base, mp: 50 }, lookup).map((c) => c.actionId)).toEqual(["sk-strike", "sk-mend"]);
    expect(collectCandidates({ ...base, mp: 3 }, lookup).map((c) => c.actionId)).toEqual(["sk-strike"]);
    expect(
      collectCandidates({ ...base, mp: 50, skillCooldowns: { "sk-strike": 1 } }, lookup).map((c) => c.actionId),
    ).toEqual(["sk-mend"]);
    const stunned = [{ statusId: "st-stun", stacks: 1, appliedTurn: 0 }];
    expect(collectCandidates({ ...base, mp: 50, statuses: stunned }, lookup)).toEqual([]);
    const muted = [{ statusId: "st-mute", stacks: 1, appliedTurn: 0 }];
    expect(collectCandidates({ ...base, mp: 50, statuses: muted }, lookup).map((c) => c.actionId)).toEqual(["sk-mend"]);
  });

  it("② filterCandidates：includeTargets / excludeActionIds 生效", () => {
    const { lookup } = setup();
    const candidates = collectCandidates({ mp: 50, skills: ["sk-strike", "sk-mend"], skillCooldowns: {}, statuses: [] }, lookup);
    const selfOnly = filterCandidates(candidates, profileOf({ candidateFilters: [{ includeTargets: ["self"] }] }));
    expect(selfOnly.map((c) => c.actionId)).toEqual(["sk-mend"]);
    const noHeal = filterCandidates(candidates, profileOf({ candidateFilters: [{ excludeActionIds: ["sk-mend"] }] }));
    expect(noHeal.map((c) => c.actionId)).toEqual(["sk-strike"]);
  });

  it("③ scoreCandidates：scoreWeights + prefer 条件加权；不命中不加权；可注入扰动", () => {
    const { lookup } = setup();
    const candidates = collectCandidates({ mp: 50, skills: ["sk-strike", "sk-mend"], skillCooldowns: {}, statuses: [] }, lookup);
    const profile = profileOf({
      scoreWeights: { "sk-strike": 2, "sk-mend": 1 },
      conditions: [{ when: { actorHpRatio: { lte: 0.3 } }, prefer: ["sk-mend"] }],
    });
    const healthy = scoreCandidates(candidates, profile, PUB);
    expect(healthy.map((s) => s.score)).toEqual([2, 1]);
    const low = scoreCandidates(candidates, profile, { ...PUB, actorHpRatio: 0.2 });
    expect(low.map((s) => s.score)).toEqual([2, 1 + PREFER_BOOST]);
    const perturbed = scoreCandidates(candidates, profileOf({ scoreWeights: { "sk-strike": 1 } }), PUB, () => 0.5);
    expect(perturbed.map((s) => s.score)).toEqual([1.5, 1.5]);
  });

  it("④ selectAction：最高分胜出；平局按候选稳定顺序", () => {
    const { lookup } = setup();
    const candidates = collectCandidates({ mp: 50, skills: ["sk-strike", "sk-mend"], skillCooldowns: {}, statuses: [] }, lookup);
    expect(selectAction(scoreCandidates(candidates, profileOf({ scoreWeights: { "sk-strike": 1, "sk-mend": 2 } }), PUB))?.actionId).toBe("sk-mend");
    expect(selectAction(scoreCandidates(candidates, profileOf({ scoreWeights: {} }), PUB))?.actionId).toBe("sk-strike");
  });

  it("⑤ decide：决策 ∈ 候选集；候选为空回退 no_candidate；非法 prefer 被忽略（R-CA-04/05）", () => {
    const { lookup } = setup();
    const candidates = collectCandidates({ mp: 50, skills: ["sk-strike", "sk-mend"], skillCooldowns: {}, statuses: [] }, lookup);
    // prefer 引用不在候选集（未注册/被过滤）的行动：忽略并回退合法最高分
    const withIllegalPrefer = profileOf({
      scoreWeights: { "sk-strike": 1, "sk-mend": 2 },
      conditions: [{ when: { round: { gte: 1 } }, prefer: ["sk-ghost", "sk-domain"] }],
    });
    expect(decide({ candidates, profile: withIllegalPrefer, pub: PUB })).toEqual({ actionId: "sk-mend" });
    expect(decide({ candidates: [], profile: profileOf({ scoreWeights: { "sk-strike": 1 } }), pub: PUB })).toEqual({
      actionId: null,
      reason: "no_candidate",
    });
  });

  it("buildPublicConditionContext：比例 clamp 到 0..1，形状经 Zod 校验", () => {
    const pub = buildPublicConditionContext({
      actor: { hp: -5, maxHp: 100, mp: 999, maxMp: 50 },
      player: { hp: 30, maxHp: 0, mp: 0, maxMp: 0 },
      round: 2,
      aliveAllies: 1,
      aliveFoes: 0,
    });
    expect(pub.actorHpRatio).toBe(0);
    expect(pub.actorMpRatio).toBe(1);
    expect(pub.publicPlayerHpRatio).toBe(1);
    expect(PublicConditionContextSchema.parse(pub)).toEqual(pub);
  });
});

describe("风格参数化与条件化（R-CA-02/03）", () => {
  it("同一状态换三种风格至少一次决策不同；引擎无风格名常量（静态扫描）", () => {
    const { lookup } = setup();
    const candidates = collectCandidates({ mp: 50, skills: ["sk-strike", "sk-mend"], skillCooldowns: {}, statuses: [] }, lookup);
    const aggressive = decide({ candidates, profile: profileOf({ styleId: "aggressive", scoreWeights: { "sk-strike": 3 } }), pub: PUB });
    const cautious = decide({
      candidates,
      profile: profileOf({ styleId: "cautious", scoreWeights: { "sk-strike": 1 }, conditions: [{ when: { round: { gte: 1 } }, prefer: ["sk-mend"] }] }),
      pub: PUB,
    });
    const flat = decide({ candidates, profile: profileOf({ styleId: "flat", scoreWeights: {} }), pub: PUB });
    expect(aggressive).toEqual({ actionId: "sk-strike" });
    expect(cautious).toEqual({ actionId: "sk-mend" });
    expect(flat).toEqual({ actionId: "sk-strike" });
    expect(aggressive.actionId).not.toBe(cautious.actionId);

    // 引擎源码不得出现风格名常量（R-CA-02）
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "combat-ai.ts"), "utf8");
    for (const word of ["激进", "保守", "防御反击", "aggressive", "cautious", "counter"]) {
      expect(source.includes(word), `引擎源码出现风格名常量：${word}`).toBe(false);
    }
    // 无 LLM 依赖（R-CA-04）
    for (const word of ["openai", "anthropic", "fetch(", "XMLHttpRequest", "llm-sdk"]) {
      expect(source.toLowerCase().includes(word), `引擎源码出现 LLM/网络依赖：${word}`).toBe(false);
    }
  });

  it("条件化 AI：低血命中治疗；满血不命中（R-CA-03，集成经 aiTurn）", () => {
    // 风格：低血优先治疗
    const patch = (raw: Record<string, unknown>) => {
      raw.combatAi = {
        styles: [
          {
            styleId: "healer",
            scoreWeights: { "sk-strike": 2, "sk-mend": 1 },
            conditions: [{ when: { actorHpRatio: { lte: 0.3 } }, prefer: ["sk-mend"] }],
          },
        ],
        assignments: { mob: "healer" },
      };
    };
    // 满血：不加权 → 选权重最高的 sk-strike
    {
      const { lookup, state } = setup(5, patch);
      performBattleAction(state, { type: "skill", skillId: "sk-plink" }, lookup, createRng(1));
      expect(state.battle!.log.join("\n")).toContain("斩击");
      expect(state.battle!.log.join("\n")).not.toContain("疗愈");
    }
    // 低血（敌人打到 25/100）：命中条件 → 疗愈
    {
      const { lookup, state } = setup(5, patch);
      state.battle!.enemies[0].hp = 25;
      performBattleAction(state, { type: "skill", skillId: "sk-plink" }, lookup, createRng(1));
      expect(state.battle!.log.join("\n")).toContain("疗愈");
    }
  });
});

describe("回归兼容与确定性（R-CA-04/05 / P1 / P7）", () => {
  it("未映射风格：行为与既有基线逐字段一致（log 与 HP 相同）", () => {
    const run = (patch?: (raw: Record<string, unknown>) => void) => {
      const { lookup, state } = setup(9, patch);
      performBattleAction(state, { type: "skill", skillId: "sk-plink" }, lookup, createRng(3));
      return { log: state.battle!.log.join("\n"), playerHp: state.battle!.player.hp, enemyHp: state.battle!.enemies[0].hp };
    };
    const baseline = run();
    const withUnmappedAi = run((raw) => {
      // combat-ai.yaml 存在但该敌人未映射（assignments 只能引用真实角色，未映射者保持既有路径）
      raw.combatAi = { styles: [{ styleId: "unused", scoreWeights: { "sk-strike": 5 } }], assignments: {} };
    });
    expect(withUnmappedAi).toEqual(baseline);
  });

  it("映射风格：行为经五步路径改变且决策 ∈ 候选集", () => {
    const patch = (raw: Record<string, unknown>) => {
      raw.combatAi = {
        styles: [{ styleId: "selfless", candidateFilters: [{ includeTargets: ["self"] }], scoreWeights: { "sk-mend": 1 } }],
        assignments: { mob: "selfless" },
      };
    };
    const { lookup, state } = setup(9, patch);
    performBattleAction(state, { type: "skill", skillId: "sk-plink" }, lookup, createRng(3));
    const log = state.battle!.log.join("\n");
    expect(log).toContain("疗愈");
    expect(log).not.toContain("斩击");
  });

  it("同 seed + 同状态 + 同模板决策一致（P1 / R-CA-04）", () => {
    const { lookup } = setup();
    const candidates = collectCandidates({ mp: 50, skills: ["sk-strike", "sk-mend"], skillCooldowns: {}, statuses: [] }, lookup);
    const profile = profileOf({ scoreWeights: { "sk-strike": 2, "sk-mend": 1 } });
    const a = decide({ candidates, profile, pub: PUB });
    const b = decide({ candidates, profile, pub: PUB });
    expect(a).toEqual(b);
    expect(candidates.map((c) => c.actionId)).toContain((a as { actionId: string }).actionId);
  });
});
