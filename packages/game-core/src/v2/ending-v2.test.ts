import { describe, expect, it } from "vitest";
import {
  DeathRouteSchema,
  EndingConditionSchema,
  EndingConfigSchema,
  EndingRecordSchema,
  EndingTemplateSchema,
  type Condition,
  type DeathRoute,
  type EndingCondition,
  type EndingTemplate,
  type WorldStateV2,
  type WorldTemplateV2,
} from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import type { ConditionContext } from "./engine.js";
import { createActiveWorldV2 } from "./test-utils.js";
import { createBattle, finishBattle, performBattleAction } from "./battle.js";
import {
  EndingGuardError,
  applyDeathRoute,
  applyTermination,
  assertActive,
  checkTermination,
  createDefaultEndingConfig,
  markTerminated,
  resolveDeathRoute,
  resolveEnding,
  selectEndingTemplates,
} from "./ending.js";
import { advanceTurnV2, battleActionV2, chooseOptionV2, useItemV2 } from "./turn.js";

// ---------- 夹具 ----------

function makeTemplate(): WorldTemplateV2 {
  return {
    meta: { id: "t", name: "结局测试", description: "d", startYear: 2000, engineProtocol: "v2" },
    time: { defaultStep: { value: 1, unit: "day" } },
    genders: [{ id: "f", label: "女" }],
    mood: {
      min: 0,
      max: 100,
      defaultValue: 60,
      bands: [{ id: "normal", label: "平静", min: 0, max: 100, attributeModifiers: {} }],
    },
    statusBar: [{ id: "sb1", label: "基本", source: "identity" }],
    attributes: { order: ["str"], defaults: { str: 5 } },
    resources: { hp: { base: 100, perLevel: 0 }, mp: { base: 50, perLevel: 0 } },
    regen: { perTurn: { hp: 0, mp: 0 } },
    characters: [],
    skills: [],
    items: [],
    statuses: [],
    events: [],
  };
}

/** 带战斗的最小模板，用于 P9 真实结算验证。 */
function makeBattleTemplate(): WorldTemplateV2 {
  const base = makeTemplate();
  return {
    ...base,
    characters: [
      {
        id: "enemy-x",
        isEnemy: true,
        visibility: "public",
        identity: { name: "测试敌人", age: 0, gender: "f" },
        mood: { value: 50 },
        attributes: { str: 5 },
        skills: ["sk-nuke"],
        public: { personality: "测试用" },
        private: { combatHints: { skillWeights: { "sk-nuke": 1 } } },
        relationship: -100,
      },
    ],
    playerTemplate: {
      identity: { age: 16, gender: "f" },
      mood: 60,
      attributes: { str: 5 },
      skills: ["sk-strike"],
    },
    skills: [
      {
        id: "sk-strike", kind: "combat", name: "强击", cost: { mp: 0 }, target: "enemy",
        damage: [{ preset: "fixed", value: 100 }], cooldownTurns: 0, usableInBattle: true,
      },
      {
        id: "sk-nuke", kind: "combat", name: "湮灭", cost: { mp: 0 }, target: "enemy",
        damage: [{ preset: "fixed", value: 500 }], cooldownTurns: 0, usableInBattle: true,
      },
    ],
    events: [
      {
        id: "ev-ambush", title: "遇袭", narrative: "敌人出现！",
        trigger: { source: "action-hook", onActionId: "patrol", probability: 1 },
        kind: "combat",
        settle: { combat: { enemies: [{ ref: "enemy-x", levelScale: 1 }] } },
      },
    ],
  } as unknown as WorldTemplateV2;
}

function makeActive(): WorldStateV2 {
  return createActiveWorldV2({ templateId: "t", playerName: "测试者", seed: 1 }, makeTemplate(), "w1");
}

function makeCtx(state: WorldStateV2, template: WorldTemplateV2 = makeTemplate()): ConditionContext {
  return { state, lookup: createLookup(template), rng: () => 0.5 };
}

const flagCond = (name: string, value: boolean): Condition => ({ flag: name, eq: value });

function condition(
  type: EndingCondition["type"],
  opts: Partial<EndingCondition> = {},
): EndingCondition {
  return {
    type,
    params: { conditions: [] },
    combinator: "AND",
    terminationMode: "afterSettle",
    ...opts,
  };
}

function endingTemplate(id: string, overrides: Partial<EndingTemplate> = {}): EndingTemplate {
  return {
    endingId: id,
    name: id,
    description: "",
    triggerConditions: [],
    priority: 0,
    endingType: "neutral",
    narrativeConfig: { source: "template" },
    fallback: false,
    unlockConditions: [],
    ...overrides,
  };
}

function deathRoute(mode: "event" | "direct", conditions: Condition[], deathEventId?: string): DeathRoute {
  return {
    deathMode: mode,
    conditions,
    ...(deathEventId !== undefined ? { deathEventId } : {}),
  };
}

function guardCode(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof EndingGuardError) return err.code;
    throw err;
  }
  throw new Error("未被门禁拒绝");
}

const AT_BOUNDARY = { atBoundary: true, boundary: "afterEventSettle" } as const;
const MID_SETTLE = { atBoundary: false, boundary: "afterEventSettle" } as const;

// ---------- T4-01 · Schema（加载期拒绝 HP 判据 / 七类白名单 / strict） ----------

describe("T4-01 · 结局 Schema 校验", () => {
  it("七类条件白名单全部接受，未知 type 被拒", () => {
    const types = [
      "timeReached", "characterState", "objective", "worldState",
      "eventOccurred", "playerRequested", "battleDefeat",
    ] as const;
    for (const type of types) {
      expect(EndingConditionSchema.safeParse(condition(type)).success).toBe(true);
    }
    expect(EndingConditionSchema.safeParse({ ...condition("objective"), type: "hpZero" }).success).toBe(false);
  });

  it("combinator / terminationMode 只取白名单，strict 拒绝未知字段", () => {
    expect(EndingConditionSchema.safeParse({ ...condition("objective"), combinator: "XOR" }).success).toBe(false);
    expect(EndingConditionSchema.safeParse({ ...condition("objective"), terminationMode: "later" }).success).toBe(false);
    expect(EndingConditionSchema.safeParse({ ...condition("objective"), extra: 1 }).success).toBe(false);
    expect(EndingConditionSchema.safeParse({ ...condition("objective"), combinator: "OR", terminationMode: "immediate" }).success).toBe(true);
  });

  it("加载期拒绝以 HP 归零 / HP 数值为终止判据的条件（R-EN-07 / P9）", () => {
    const bad = condition("characterState", { params: { conditions: [{ flag: "hp", lte: 0 }] } });
    const result = EndingConditionSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain("conditions");
    }
    const badRoute = deathRoute("direct", [{ flag: "hp", eq: 0 }]);
    expect(DeathRouteSchema.safeParse(badRoute).success).toBe(false);
  });

  it("DeathRoute event 模式需要 deathEventId；结局模板 strict 拒绝评分字段", () => {
    expect(DeathRouteSchema.safeParse(deathRoute("event", [])).success).toBe(false);
    expect(DeathRouteSchema.safeParse(deathRoute("event", [], "ev-death")).success).toBe(true);
    expect(DeathRouteSchema.safeParse(deathRoute("direct", [])).success).toBe(true);
    expect(EndingTemplateSchema.safeParse({ ...endingTemplate("x"), score: 99 }).success).toBe(false);
    expect(EndingTemplateSchema.safeParse(endingTemplate("x")).success).toBe(true);
  });

  it("未提供 endings.yaml 时引擎用最小默认配置：空终止条件不触发结束", () => {
    const state = makeActive();
    const cfg = createDefaultEndingConfig();
    expect(cfg.terminationConditions).toHaveLength(0);
    expect(cfg.endings).toHaveLength(0);
    expect(checkTermination(state, cfg.terminationConditions, AT_BOUNDARY, makeCtx(state))).toBeNull();
  });

  it("EndingRecord / EndingConfig 校验：记录形状与 fallback 引用完整性", () => {
    expect(
      EndingRecordSchema.safeParse({
        endingId: "end-a", evidenceIds: ["h1"], title: "落幕", summary: "一生收束", narrativeSource: "template",
      }).success,
    ).toBe(true);
    expect(
      EndingRecordSchema.safeParse({
        endingId: "end-a", evidenceIds: [], title: "落幕", summary: "", narrativeSource: "unknown",
      }).success,
    ).toBe(false);
    expect(
      EndingConfigSchema.safeParse({ endings: [endingTemplate("end-a")], fallback: "end-missing" }).success,
    ).toBe(false);
    expect(
      EndingConfigSchema.safeParse({ endings: [endingTemplate("end-a")], fallback: "end-a" }).success,
    ).toBe(true);
  });
});

// ---------- T4-01 · 边界检查 / AND-OR / 无半更新 ----------

describe("T4-01 · checkTermination 仅在模拟边界判定", () => {
  it("结算中途临时满足条件不误触发；结算后不满足也不终止（R-EN-02）", () => {
    const state = makeActive();
    state.flags.mainGoal = true;
    const cond = condition("objective", { params: { conditions: [flagCond("mainGoal", true)] } });
    // 中途：不判定
    expect(checkTermination(state, [cond], MID_SETTLE, makeCtx(state))).toBeNull();
    // 结算完成后 flag 已被清除（临时满足不复存在）：边界判定也不触发
    const after = makeActive();
    expect(checkTermination(after, [cond], AT_BOUNDARY, makeCtx(after))).toBeNull();
  });

  it("边界命中：结算中途不判定、边界才判定", () => {
    const state = makeActive();
    state.flags.mainGoal = true;
    const cond = condition("objective", { params: { conditions: [flagCond("mainGoal", true)] } });
    const ctx = makeCtx(state);
    expect(checkTermination(state, [cond], MID_SETTLE, ctx)).toBeNull();
    expect(checkTermination(state, [cond], AT_BOUNDARY, ctx)?.condition.type).toBe("objective");
  });

  it("AND：只满足其一不触发，两者都满足才触发（R-EN-01）", () => {
    const state = makeActive();
    const cond = condition("objective", {
      combinator: "AND",
      params: { conditions: [flagCond("ageReached", true), flagCond("mainGoal", true)] },
    });
    const ctx = makeCtx(state);
    state.flags.ageReached = true;
    expect(checkTermination(state, [cond], AT_BOUNDARY, ctx)).toBeNull();
    state.flags.mainGoal = true;
    expect(checkTermination(state, [cond], AT_BOUNDARY, makeCtx(state))).not.toBeNull();
  });

  it("OR：任一满足即触发", () => {
    const state = makeActive();
    state.flags.ageReached = true;
    const cond = condition("objective", {
      combinator: "OR",
      params: { conditions: [flagCond("ageReached", true), flagCond("mainGoal", true)] },
    });
    expect(checkTermination(state, [cond], AT_BOUNDARY, makeCtx(state))).not.toBeNull();
  });

  it("playerRequested / battleDefeat 仅在对应边界信号为真时命中", () => {
    const state = makeActive();
    const ctx = makeCtx(state);
    expect(checkTermination(state, [condition("playerRequested")], AT_BOUNDARY, ctx)).toBeNull();
    expect(
      checkTermination(state, [condition("playerRequested")], { ...AT_BOUNDARY, playerRequested: true }, ctx)?.source,
    ).toBe("player");
    expect(checkTermination(state, [condition("battleDefeat")], AT_BOUNDARY, ctx)).toBeNull();
    expect(
      checkTermination(state, [condition("battleDefeat")], { ...AT_BOUNDARY, battleDefeat: true }, ctx)?.source,
    ).toBe("battleDefeat");
  });
});

describe("T4-01 · 立即 / 结算后终止均无半更新状态", () => {
  for (const mode of ["immediate", "afterSettle"] as const) {
    it(`${mode} 命中后：结算效果完整 + termination 落定 + 入参逐字段不变`, () => {
      const settled = makeActive();
      // 模拟「当前事件已完整结算」：效果 flag 与历史已落库
      settled.flags.effectApplied = true;
      settled.history.push({
        id: "t1-e-ev-final", turnIndex: 1, worldTime: 1440,
        formattedTime: "第 1 轮", type: "event", summary: "事件完整结算",
      });
      const before = structuredClone(settled);
      const cond = condition("objective", {
        terminationMode: mode,
        params: { conditions: [flagCond("effectApplied", true)] },
      });
      const { state, decision } = applyTermination(settled, [cond], AT_BOUNDARY, makeCtx(settled));
      expect(decision?.mode).toBe(mode);
      // 无半更新：结算效果仍在、termination 已写、入参未被改动
      expect(state.flags.effectApplied).toBe(true);
      expect(state.history.some((h) => h.id === "t1-e-ev-final")).toBe(true);
      expect(state.termination).not.toBeNull();
      expect(state.termination?.source).toBe("condition");
      expect(settled).toEqual(before);
    });
  }

  it("已终止世界不再判定（幂等），applyTermination 原样返回", () => {
    const state = markTerminated(makeActive(), {
      reason: "已结束", worldTime: 0, turnIndex: 0, source: "player",
    });
    const cond = condition("objective", { params: { conditions: [flagCond("mainGoal", true)] } });
    const before = structuredClone(state);
    const { state: out, decision } = applyTermination(state, [cond], AT_BOUNDARY, makeCtx(state));
    expect(decision).toBeNull();
    expect(out).toBe(state);
    expect(state).toEqual(before);
  });
});

describe("T4-01 · P9 任意战斗结算后玩家生命不低于 1", () => {
  it("战败结算（checkBattleEnd / finishBattle 回写）后 hp >= 1 且模拟继续", () => {
    const template = makeBattleTemplate();
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "t", playerName: "测试者", seed: 42 }, template, "w-p9");
    state.battle = createBattle("ev-ambush", { enemies: [{ ref: "enemy-x", levelScale: 1 }], canFlee: false }, state, lookup);
    state.battle.enemies[0].hp = 500;
    state.battle.enemies[0].maxHp = 500;
    while (!state.battle.over) {
      performBattleAction(state, { type: "skill", skillId: "sk-strike" }, lookup, () => 0.01);
    }
    expect(state.battle.over).toBe("defeat");
    finishBattle(state, lookup);
    expect(state.player.hp).toBeGreaterThanOrEqual(1);
    // 结算后世界仍可继续（termination 仍为 null）
    expect(state.termination).toBeNull();
  });
});

// ---------- T4-02 · 结局决胜 / 隐藏 / fallback / 死亡路径 ----------

describe("T4-02 · resolveEnding 决胜", () => {
  it("三结局同满足时命中 priority 最高者，且同输入重复执行结果稳定", () => {
    const state = makeActive();
    state.history.push({ id: "h1", turnIndex: 0, worldTime: 0, formattedTime: "", type: "event", summary: "s" });
    const templates = [
      endingTemplate("end-low", { priority: 1, triggerConditions: [flagCond("ready", true)] }),
      endingTemplate("end-high", { priority: 20, triggerConditions: [flagCond("ready", true)] }),
      endingTemplate("end-mid", { priority: 10, triggerConditions: [flagCond("ready", true)] }),
    ];
    state.flags.ready = true;
    const ctx = makeCtx(state);
    const a = resolveEnding(state, templates, ctx);
    const b = resolveEnding(state, templates, makeCtx(state));
    expect(a.endingId).toBe("end-high");
    expect(a).toEqual(b);
    expect(a.narrativeSource).toBe("template");
  });

  it("无专属命中走 fallback（按 fallbackId 或 fallback 标记）", () => {
    const state = makeActive();
    const templates = [
      endingTemplate("end-special", { priority: 10, triggerConditions: [flagCond("never", true)] }),
      endingTemplate("end-ordinary", { fallback: true, narrativeConfig: { source: "template", summary: "平凡一生" } }),
    ];
    expect(resolveEnding(state, templates, makeCtx(state), { fallbackId: "end-ordinary" }).endingId).toBe("end-ordinary");
    expect(resolveEnding(state, templates, makeCtx(state)).endingId).toBe("end-ordinary");
  });

  it("隐藏结局未解锁不进候选集，解锁后按 priority 命中", () => {
    const state = makeActive();
    const templates = [
      endingTemplate("end-public", { priority: 5 }),
      endingTemplate("end-secret", {
        priority: 50, unlockConditions: [flagCond("secretUnlocked", true)],
      }),
    ];
    expect(selectEndingTemplates(state, templates, makeCtx(state)).map((t) => t.endingId)).toEqual(["end-public"]);
    state.flags.secretUnlocked = true;
    expect(resolveEnding(state, templates, makeCtx(state)).endingId).toBe("end-secret");
  });

  it("exclusiveGroup：同组只保留优先级最高者", () => {
    const state = makeActive();
    const templates = [
      endingTemplate("end-g1-low", { priority: 5, exclusiveGroup: "g" }),
      endingTemplate("end-g1-high", { priority: 30, exclusiveGroup: "g" }),
      endingTemplate("end-free", { priority: 20 }),
    ];
    expect(selectEndingTemplates(state, templates, makeCtx(state)).map((t) => t.endingId)).toEqual([
      "end-g1-high", "end-free",
    ]);
  });
});

describe("T4-02 · resolveDeathRoute / applyDeathRoute 两条路径", () => {
  it("deathMode=event：死亡事件进历史 + 结局 + 终止，且不改写生命值", () => {
    const state = makeActive();
    state.flags.fatalWound = true;
    const before = structuredClone(state);
    const hp = state.player.hp;
    const route = deathRoute("event", [flagCond("fatalWound", true)], "ev-death-funeral");
    const templates = [endingTemplate("end-fallen", { priority: 10 })];
    const result = applyDeathRoute(state, route, { battleDefeat: true }, templates, makeCtx(state));
    expect(result.outcome.kind).toBe("event");
    expect(result.state.history.some((h) => h.id.includes("ev-death-funeral"))).toBe(true);
    expect(result.state.firedEvents["ev-death-funeral"]).toBeDefined();
    expect(result.ending?.endingId).toBe("end-fallen");
    expect(result.termination).not.toBeNull();
    expect(result.termination?.source).toBe("battleDefeat");
    expect(result.state.player.hp).toBe(hp);
    expect(result.state.player.hp).toBeGreaterThanOrEqual(1);
    expect(state).toEqual(before);
  });

  it("deathMode=direct：无死亡事件实例，直接结局 + 终止，且不改写生命值", () => {
    const state = makeActive();
    state.flags.fatalWound = true;
    const hp = state.player.hp;
    const route = deathRoute("direct", [flagCond("fatalWound", true)]);
    const templates = [endingTemplate("end-fallen", { priority: 10 })];
    const result = applyDeathRoute(state, route, { battleDefeat: true }, templates, makeCtx(state));
    expect(result.outcome.kind).toBe("direct");
    expect(result.state.history.some((h) => h.id.includes("death"))).toBe(false);
    expect(result.ending).not.toBeNull();
    expect(result.termination).not.toBeNull();
    expect(result.state.player.hp).toBe(hp);
    expect(result.state.player.hp).toBeGreaterThanOrEqual(1);
  });

  it("战败但条件不满足：termination===null、hp>=1、世界逐字段不变（模拟继续）", () => {
    const state = makeActive();
    const before = structuredClone(state);
    const route = deathRoute("direct", [flagCond("fatalWound", true)]);
    const templates = [endingTemplate("end-fallen")];
    const outcome = resolveDeathRoute(state, route, { battleDefeat: true }, makeCtx(state));
    const result = applyDeathRoute(state, route, { battleDefeat: true }, templates, makeCtx(state));
    expect(outcome.kind).toBe("none");
    expect(result.ending).toBeNull();
    expect(result.termination).toBeNull();
    expect(result.state.player.hp).toBeGreaterThanOrEqual(1);
    expect(result.state).toBe(state);
    expect(state).toEqual(before);
    // 仍可通过门禁继续模拟
    expect(() => assertActive(state)).not.toThrow();
  });

  it("未战败（signal 为 false）一律不触发死亡路径", () => {
    const state = makeActive();
    state.flags.fatalWound = true;
    const route = deathRoute("direct", [flagCond("fatalWound", true)]);
    expect(resolveDeathRoute(state, route, { battleDefeat: false }, makeCtx(state)).kind).toBe("none");
  });
});

// ---------- 统一门禁：四入口（含 T2-02 遗留） ----------

describe("统一门禁 · 已终止 / 已归档世界经四入口都拒绝写入", () => {
  const inputs: Array<{ label: string; fn: (s: WorldStateV2, t: WorldTemplateV2) => void }> = [
    { label: "advanceTurnV2", fn: (s, t) => { advanceTurnV2(s, { action: { type: "rest" } }, t, createLookup(t)); } },
    { label: "chooseOptionV2", fn: (s, t) => { chooseOptionV2(s, { optionId: "opt" }, t, createLookup(t)); } },
    { label: "battleActionV2", fn: (s, t) => { battleActionV2(s, { type: "flee" }, t, createLookup(t)); } },
    { label: "useItemV2", fn: (s, t) => { useItemV2(s, { itemId: "item" }, t, createLookup(t)); } },
  ];

  for (const { label, fn } of inputs) {
    it(`${label}：已终止被拒且逐字段不变`, () => {
      const template = makeTemplate();
      const state = markTerminated(makeActive(), {
        reason: "终止", worldTime: 0, turnIndex: 0, source: "condition",
      });
      // 预置会导致后续业务检查抛错的状态，证明门禁在其它检查之前
      state.pendingEvents = [{ eventId: "ev-x" }];
      const before = structuredClone(state);
      expect(guardCode(() => fn(state, template))).toBe("TERMINATED");
      expect(state).toEqual(before);
    });

    it(`${label}：已归档被拒且逐字段不变`, () => {
      const template = makeTemplate();
      const state = makeActive();
      state.archived = true;
      state.pendingEvents = [{ eventId: "ev-x" }];
      const before = structuredClone(state);
      expect(guardCode(() => fn(state, template))).toBe("TERMINATED");
      expect(state).toEqual(before);
    });
  }
});
