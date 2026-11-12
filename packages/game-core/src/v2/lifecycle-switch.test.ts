import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { WorldTemplateV2Schema, type Effect, type WorldStateV2, type WorldTemplateV2 } from "@life-sim/shared";
import { applyEffectsV2, checkCondition, type ConditionContext } from "./engine.js";
import { createLookup, type TemplateLookup } from "./lookup.js";
import { runNpcActionsV2 } from "./npc.js";
import { projectSnapshotV2 } from "./projection.js";
import { createBattle, resolveCombatRefs } from "./battle.js";
import { chooseOptionV2, triggerEventV2, type TriggerResult } from "./turn.js";
import { createRng } from "../rng.js";
import { createActiveWorldV2, makeTestTemplate } from "./test-utils.js";

/**
 * 生命周期切换 + 刷新（spawn）联动的**机制**验证（ADR-0012 / ADR-0020 / ADR-0022）。
 *
 * 与 `lifecycle.test.ts`（三态与投影契约）、`spawn-rules.test.ts`（配置层 → 实例层 → 事实层）
 * 的分工：本文件只回答一件事——**同一套引擎能力接进模板后，身体争夺/spawn 这类玩法切换是否
 * 真的按语义工作**：双向切换（占据 / 归还）、占据期间的条件判定与自主行动、战斗 ref 判活、
 * 刷新角色的「未登场 → 登场并可参战」，以及 `reasonCode` 只是字符串（引擎不得对它分支）。
 *
 * 全部用合成夹具，不依赖 jjk-2006 的任何内容；模板级断言单独放文件末尾。
 */

// ---------- 合成夹具 ----------

function npc(id: string, name: string): Record<string, unknown> {
  return {
    id,
    isEnemy: false,
    visibility: "public",
    identity: { name, age: 17, gender: "f" },
    mood: { value: 60 },
    attributes: { cursedEnergy: 5 },
    skills: ["sk-strike"],
    public: { personality: "测试用" },
    private: {},
    relationship: 10,
  };
}

function makeSwitchTemplate(): WorldTemplateV2 {
  const template = makeTestTemplate();
  const characters = template.characters as unknown as Record<string, unknown>[];
  characters.push(npc("npc-a", "测试甲"), npc("npc-b", "测试乙"), npc("npc-arrival", "迟到者"));
  // 配置层刷新规则：被管辖的角色在世界创建时 unspawned（ADR-0022）
  template.npcSpawnRules = [{ id: "rule-arrival", characterRef: "npc-arrival", age: 16 }];
  // 模板零书写判活：NPC 自主行动只对 alive 的 NPC 生效
  template.npcActions = [
    { id: "act-roam", summary: "{name} 四处走动。", trigger: { probability: 1 }, utility: { base: 1 }, effects: [] },
  ] as WorldTemplateV2["npcActions"];
  return template;
}

function setup(worldId: string) {
  const template = makeSwitchTemplate();
  const lookup = createLookup(template);
  const state = createActiveWorldV2({ templateId: "test", playerName: "测试者", seed: 11 }, template, worldId);
  return { template, lookup, state };
}

const lifeOf = (state: WorldStateV2, npcId: string) => state.npcs.find((n) => n.id === npcId)!.lifecycle;

const setLifecycle = (
  state: WorldStateV2,
  lookup: TemplateLookup,
  npcId: string,
  next: { state: "alive" | "inactive" | "unspawned"; reasonCode?: string },
) => {
  const effect: Effect = { type: "setNpcLifecycle", npcId, ...next };
  applyEffectsV2({ state, lookup, rng: createRng(1), logs: [] }, [effect]);
};

// ---------- 1. 双向切换 ----------

describe("生命周期双向切换（占据 → 归还）", () => {
  it("alive → inactive(cause) → alive：每次刷新 sinceTurn/sinceWorldTime，回 alive 时 reasonCode 被清掉", () => {
    const { state, lookup } = setup("w-switch-1");
    expect(lifeOf(state, "npc-a")).toEqual({ state: "alive", sinceTurn: 0, sinceWorldTime: 0 });

    // 被占据：inactive + 模板自由字符串 cause
    state.turnIndex = 4;
    state.worldTime = 240;
    setLifecycle(state, lookup, "npc-a", { state: "inactive", reasonCode: "宿傩受肉" });
    expect(lifeOf(state, "npc-a")).toEqual({
      state: "inactive",
      reasonCode: "宿傩受肉",
      sinceTurn: 4,
      sinceWorldTime: 240,
    });

    // 归还身体：走同一个入口回到 alive，时间戳再次刷新、cause 不留残值
    state.turnIndex = 9;
    state.worldTime = 540;
    setLifecycle(state, lookup, "npc-a", { state: "alive" });
    expect(lifeOf(state, "npc-a")).toEqual({ state: "alive", sinceTurn: 9, sinceWorldTime: 540 });
    expect("reasonCode" in lifeOf(state, "npc-a"), "回 alive 必须清掉 reasonCode").toBe(false);
  });

  it("同一轮内反复切换也各自刷新时间戳（幂等只在「值相同」时体现，不做去重）", () => {
    const { state, lookup } = setup("w-switch-2");
    state.turnIndex = 3;
    state.worldTime = 180;
    setLifecycle(state, lookup, "npc-a", { state: "inactive", reasonCode: "被宿傩夺舍" });
    state.turnIndex = 5;
    state.worldTime = 300;
    setLifecycle(state, lookup, "npc-a", { state: "inactive", reasonCode: "被宿傩夺舍" });
    expect(lifeOf(state, "npc-a").sinceTurn).toBe(5);
    expect(lifeOf(state, "npc-a").sinceWorldTime).toBe(300);
  });
});

// ---------- 2. 占据语义 ----------

describe("占据语义（A inactive + B alive 并存）", () => {
  it("npcState 条件能分别判到两边", () => {
    const { state, lookup } = setup("w-switch-3");
    setLifecycle(state, lookup, "npc-a", { state: "inactive", reasonCode: "宿傩受肉" });
    const ctx: ConditionContext = { state, lookup, rng: createRng(1) };

    expect(checkCondition({ npcState: { npcId: "npc-a", state: "inactive" } }, ctx)).toBe(true);
    expect(checkCondition({ npcState: { npcId: "npc-a", state: "alive" } }, ctx)).toBe(false);
    expect(checkCondition({ npcState: { npcId: "npc-b", state: "alive" } }, ctx)).toBe(true);
    expect(checkCondition({ npcState: { npcId: "npc-b", state: "inactive" } }, ctx)).toBe(false);
    // 归还身体后同一条件的判定翻转（条件读的是状态，不是历史）
    setLifecycle(state, lookup, "npc-a", { state: "alive" });
    expect(checkCondition({ npcState: { npcId: "npc-a", state: "alive" } }, ctx)).toBe(true);
  });

  it("被占据的一方不进入自主行动，另一方照常行动", () => {
    const { state, lookup } = setup("w-switch-4");
    state.turnIndex = 2;
    const both = runNpcActionsV2(state, lookup, createRng(3));
    // npc-a / npc-b / npc-arrival —— 刷新角色还没登场，本来就不该行动
    expect(both.summaries).toEqual(["测试甲 四处走动。", "测试乙 四处走动。"]);

    state.turnIndex = 4;
    setLifecycle(state, lookup, "npc-a", { state: "inactive", reasonCode: "宿傩受肉" });
    const one = runNpcActionsV2(state, lookup, createRng(3));
    expect(one.summaries).toEqual(["测试乙 四处走动。"]);
  });
});

// ---------- 3. 战斗联动 ----------

describe("战斗联动（判活复用单一入口，不重复书写）", () => {
  const settle = { enemies: [{ ref: "enemy-x" }], allies: [{ ref: "npc-a" }] };

  it("A 被置 inactive 后以 A 为 allies 的 ref 被过滤，战斗仍成立", () => {
    const { state, lookup } = setup("w-switch-5");
    // 前置：alive 时确实参战（否则「被过滤」可能只是因为夹具本身没接上）
    expect(resolveCombatRefs(settle, state, lookup).allies.map((r) => r.ref)).toEqual(["npc-a"]);

    setLifecycle(state, lookup, "npc-a", { state: "inactive", reasonCode: "宿傩受肉" });
    const resolved = resolveCombatRefs(settle, state, lookup);
    expect(resolved.allies).toEqual([]);
    expect(resolved.enemies.map((r) => r.ref)).toEqual(["enemy-x"]);
    expect(resolved.enemiesExhausted).toBe(false);
    expect(resolved.inactiveNpcIds).toEqual(["npc-a"]);

    // 建场侧同口径：友军为空也照常开打，不会因为「友军死光」而整场跳过
    const battle = createBattle("ev-switch", settle, state, lookup);
    expect(battle.allies).toEqual([]);
    expect(battle.enemies.map((e) => e.characterId)).toEqual(["enemy-x"]);
  });

  it("A 归还身体后同一场战斗重新带上他（判活是纯读，不改模板定义）", () => {
    const { state, lookup } = setup("w-switch-6");
    setLifecycle(state, lookup, "npc-a", { state: "inactive", reasonCode: "宿傩受肉" });
    expect(createBattle("ev-switch", settle, state, lookup).allies).toEqual([]);

    setLifecycle(state, lookup, "npc-a", { state: "alive" });
    const battle = createBattle("ev-switch", settle, state, lookup);
    expect(battle.allies.map((a) => a.characterId)).toEqual(["npc-a"]);
  });
});

// ---------- 4. 刷新（spawn）联动 ----------

describe("刷新联动（未登场 → 登场 → 可参战）", () => {
  it("规则角色初始 unspawned 且不上屏；spawnNpc 后 alive、上屏、spawnLog 追加一条", () => {
    const { state, lookup } = setup("w-switch-7");
    expect(lifeOf(state, "npc-arrival").state).toBe("unspawned");
    expect(state.spawnRules).toEqual([
      {
        ruleId: "rule-arrival",
        characterRef: "npc-arrival",
        status: "pending",
        spawnedTurn: 0,
        spawnedWorldTime: 0,
      },
    ]);
    expect(projectSnapshotV2(state, lookup.template, lookup).npcs.some((n) => n.id === "npc-arrival")).toBe(false);

    state.turnIndex = 6;
    state.worldTime = 360;
    applyEffectsV2({ state, lookup, rng: createRng(1), logs: [] }, [{ type: "spawnNpc", ruleId: "rule-arrival" }]);

    expect(lifeOf(state, "npc-arrival")).toEqual({ state: "alive", sinceTurn: 6, sinceWorldTime: 360 });
    expect(state.spawnRules[0].status).toBe("spawned");
    expect(state.spawnRules[0].spawnedTurn).toBe(6);
    expect(state.spawnLog).toEqual([{ npcId: "npc-arrival", ruleId: "rule-arrival", turnIndex: 6, worldTime: 360 }]);
    expect(projectSnapshotV2(state, lookup.template, lookup).npcs.some((n) => n.id === "npc-arrival")).toBe(true);
  });

  it("登场前不能当友军参战，登场后不被过滤（unspawned 与 inactive 同属「确知非在世」）", () => {
    const { state, lookup } = setup("w-switch-8");
    const settle = { enemies: [{ ref: "enemy-x" }], allies: [{ ref: "npc-arrival" }] };
    expect(resolveCombatRefs(settle, state, lookup).allies).toEqual([]);

    applyEffectsV2({ state, lookup, rng: createRng(1), logs: [] }, [{ type: "spawnNpc", ruleId: "rule-arrival" }]);
    const battle = createBattle("ev-arrive", settle, state, lookup);
    expect(battle.allies.map((a) => a.characterId)).toEqual(["npc-arrival"]);
  });

  it("重复 spawnNpc 幂等：不重复追加事实（模板可能重复触发同一效果）", () => {
    const { state, lookup } = setup("w-switch-9");
    const ctx = { state, lookup, rng: createRng(1), logs: [] };
    applyEffectsV2(ctx, [{ type: "spawnNpc", ruleId: "rule-arrival" }]);
    applyEffectsV2(ctx, [{ type: "spawnNpc", ruleId: "rule-arrival" }]);
    expect(state.spawnLog).toHaveLength(1);
  });
});

// ---------- 5. reasonCode 只是字符串 ----------

describe("cause 只是字符串（引擎不得对 reasonCode 分支）", () => {
  /** 同一状态、不同 cause ⇒ 行为完全一致；只有投影里的字符串不同。 */
  function behaviorSignature(reasonCode: string) {
    const { state, lookup } = setup(`w-cause-${reasonCode}`);
    state.turnIndex = 4;
    state.worldTime = 240;
    state.relations = [
      { from: "npc-a", to: "player", kind: "friend", source: "template", visibility: "known", value: 10 },
    ];
    setLifecycle(state, lookup, "npc-a", { state: "inactive", reasonCode });

    const ctx: ConditionContext = { state, lookup, rng: createRng(2) };
    const view = projectSnapshotV2(state, lookup.template, lookup);
    const npcView = view.npcs.find((n) => n.id === "npc-a")!;
    return {
      state: lifeOf(state, "npc-a").state,
      since: [lifeOf(state, "npc-a").sinceTurn, lifeOf(state, "npc-a").sinceWorldTime],
      // 关系边被冻结（单向棘轮）
      frozen: state.relations.map((e) => e.frozen ?? false),
      // 不进自主行动候选
      summaries: runNpcActionsV2(state, lookup, createRng(3)).summaries,
      // 参战 ref 被过滤
      allies: resolveCombatRefs({ enemies: [{ ref: "enemy-x" }], allies: [{ ref: "npc-a" }] }, state, lookup).allies,
      // npcState 条件只匹配状态
      aliveCond: checkCondition({ npcState: { npcId: "npc-a", state: "alive" } }, ctx),
      inactiveCond: checkCondition({ npcState: { npcId: "npc-a", state: "inactive" } }, ctx),
      // 投影上屏照旧（不因 cause 不同而被藏起来）
      onScreen: npcView.lifecycle.state,
    };
  }

  it("阵亡 / 宿傩受肉 / 被宿傩夺舍 三种 cause 引擎行为完全一致", () => {
    const dead = behaviorSignature("阵亡");
    const possessed = behaviorSignature("宿傩受肉");
    const usurped = behaviorSignature("被宿傩夺舍");
    expect(possessed).toEqual(dead);
    expect(usurped).toEqual(dead);
  });

  it("差异只出现在投影的 reasonCode 字段（玩家可读的「为什么不在世」）", () => {
    for (const cause of ["阵亡", "宿傩受肉", "被宿傩夺舍"]) {
      const { state, lookup } = setup(`w-cause-view-${cause}`);
      setLifecycle(state, lookup, "npc-a", { state: "inactive", reasonCode: cause });
      const view = projectSnapshotV2(state, lookup.template, lookup);
      expect(view.npcs.find((n) => n.id === "npc-a")!.lifecycle.reasonCode).toBe(cause);
    }
  });
});

// ---------- 模板级断言：jjk-2006 真的接上了这两个机制 ----------

const jjkDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../specs/data/templates/jjk-2006");

function loadJjkTemplate(): WorldTemplateV2 {
  const merged: Record<string, unknown> = {};
  for (const file of ["world.yaml", "characters.yaml", "skills.yaml", "items.yaml", "statuses.yaml", "events.yaml"]) {
    const doc = parse(readFileSync(path.join(jjkDir, file), "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(doc)) {
      if (key === "meta") merged.meta = value;
      else if (merged[key] === undefined) merged[key] = value;
      else if (Array.isArray(merged[key]) && Array.isArray(value)) merged[key] = (merged[key] as unknown[]).concat(value);
    }
  }
  return WorldTemplateV2Schema.parse(merged);
}

describe("模板级断言（jjk-2006）· 刷新规则与身体争夺接线", () => {
  const template = loadJjkTemplate();
  const world = () =>
    createActiveWorldV2({ templateId: "jjk-2006", playerName: "测试者", seed: 7 }, template, "w-jjk-lifecycle");

  it("state.spawnRules 恰好含 rule-yuta-arrival，npc-yuta 初始为 unspawned 且不上屏", () => {
    const state = world();
    expect(state.spawnRules).toEqual([
      {
        ruleId: "rule-yuta-arrival",
        characterRef: "npc-yuta",
        status: "pending",
        spawnedTurn: 0,
        spawnedWorldTime: 0,
      },
    ]);
    expect(template.npcSpawnRules?.map((r) => r.id)).toEqual(["rule-yuta-arrival"]);
    expect(lifeOf(state, "npc-yuta").state).toBe("unspawned");
    const view = projectSnapshotV2(state, template, createLookup(template));
    expect(view.npcs.some((n) => n.id === "npc-yuta")).toBe(false);
    // 其他 2006 阵容照常在世（刷新机制只接管被规则管辖的那一个）
    expect(lifeOf(state, "npc-gojo").state).toBe("alive");
  });

  it("模板里每个 spawnNpc 效果的 ruleId 都指向已声明的规则（引用完整性）", () => {
    const declared = new Set((template.npcSpawnRules ?? []).map((r) => r.id));
    const used: string[] = [];
    for (const event of template.events) {
      const groups =
        event.kind === "combat"
          ? [event.settle.combat.onVictory?.effects, event.settle.combat.onDefeat?.effects, event.settle.combat.onFlee?.effects]
          : event.kind === "normal"
            ? event.settle.normal.options.map((o) => o.effects)
            : event.settle.random.wheel.segments.map((s) => s.effects);
      for (const effects of groups) {
        for (const effect of effects ?? []) {
          if (effect.type === "spawnNpc") used.push(effect.ruleId);
        }
      }
    }
    expect(used).toEqual(["rule-yuta-arrival", "rule-yuta-arrival"]);
    for (const ruleId of used) expect(declared.has(ruleId)).toBe(true);
  });

  it("乙骨在百鬼夜行后登场：spawnNpc 后 alive，且能作为 ev-np-02a 的友军参战", () => {
    const state = world();
    const lookup = createLookup(template);
    const event = template.events.find((e) => e.id === "ev-np-02a");
    if (event?.kind !== "combat") throw new Error("fixture: ev-np-02a 不再是 combat");

    // 未登场：以他为友军的 ref 被过滤
    expect(resolveCombatRefs(event.settle.combat, state, lookup).allies.map((r) => r.ref)).toEqual([]);

    applyEffectsV2({ state, lookup, rng: createRng(1), logs: [] }, [{ type: "spawnNpc", ruleId: "rule-yuta-arrival" }]);
    expect(lifeOf(state, "npc-yuta").state).toBe("alive");
    expect(resolveCombatRefs(event.settle.combat, state, lookup).allies.map((r) => r.ref)).toEqual(["npc-yuta"]);
  });

  it("身体争夺：虎杖/伏黑各自的 reasonCode 字符串，且两处都只是「inactive」", () => {
    const state = world();
    const lookup = createLookup(template);
    const causes = new Map<string, string>();
    for (const event of template.events) {
      const groups =
        event.kind === "combat"
          ? [event.settle.combat.onVictory?.effects, event.settle.combat.onDefeat?.effects, event.settle.combat.onFlee?.effects]
          : event.kind === "normal"
            ? event.settle.normal.options.map((o) => o.effects)
            : event.settle.random.wheel.segments.map((s) => s.effects);
      for (const effects of groups) {
        for (const effect of effects ?? []) {
          if (effect.type === "setNpcLifecycle" && effect.reasonCode !== undefined && effect.state === "inactive") {
            causes.set(effect.npcId, effect.reasonCode);
          }
        }
      }
    }
    expect(causes.get("npc-yuji")).toBe("宿傩受肉");
    expect(causes.get("npc-megumi")).toBe("被宿傩夺舍");
    // 灰原的阵亡语义保持（上一轮落地，不得回退）
    expect(causes.get("npc-haibara")).toBe("阵亡");

    // 三种 cause 在引擎里同构：都只是 inactive
    for (const npcId of ["npc-yuji", "npc-megumi", "npc-haibara"]) {
      setLifecycle(state, lookup, npcId, { state: "inactive", reasonCode: causes.get(npcId) });
      expect(lifeOf(state, npcId).state).toBe("inactive");
    }
  });

  it("决战两阶段是两个独立角色卡，二阶段显著强于一阶段（也强于涩谷形态）", () => {
    const byId = new Map(template.characters.map((c) => [c.id, c]));
    const shibuya = byId.get("enemy-sukuna");
    const phase1 = byId.get("enemy-sukuna-megumi");
    const phase2 = byId.get("enemy-sukuna-incarnate");
    for (const [name, c] of [["enemy-sukuna", shibuya], ["phase1", phase1], ["phase2", phase2]] as const) {
      expect(c, `${name} 必须存在`).toBeDefined();
      expect(c!.isEnemy, `${name} 必须是纯敌人定义`).toBe(true);
      expect(c!.skills ?? [], `${name} 必须带领域技能`).toContain("sk-domain-malevolent");
    }
    expect(phase1!.attributes.cursedEnergy).toBeGreaterThan(shibuya!.attributes.cursedEnergy);
    expect(phase2!.attributes.cursedEnergy).toBeGreaterThan(phase1!.attributes.cursedEnergy);
    expect(phase2!.attributes.physique).toBeGreaterThan(phase1!.attributes.physique);

    // 结构断言：一阶段敌人 = 借伏黑之身，二番战敌人 = 受肉真身
    const phase1Event = template.events.find((e) => e.id === "ev-sj-02");
    const phase2Event = template.events.find((e) => e.id === "ev-sj-02b");
    if (phase1Event?.kind !== "combat" || phase2Event?.kind !== "combat") throw new Error("fixture: 决战不再是 combat");
    expect(phase1Event.settle.combat.enemies.map((r) => r.ref)).toEqual(["enemy-sukuna-megumi"]);
    expect(phase2Event.settle.combat.enemies.map((r) => r.ref)).toEqual(["enemy-sukuna-incarnate"]);
    expect(phase1Event.settle.combat.onVictory?.nextEventId).toBe("ev-sj-02b");
    // 二番战胜利后不再直接进命运轮：先打羂索（ev-sj-02c），再由它接 ev-sj-03 终局链。
    expect(phase2Event.settle.combat.onVictory?.nextEventId).toBe("ev-sj-02c");
    const kenjakuEvent = template.events.find((e) => e.id === "ev-sj-02c");
    if (kenjakuEvent?.kind !== "combat") throw new Error("fixture: ev-sj-02c 不是 combat");
    expect(kenjakuEvent.settle.combat.onVictory?.nextEventId).toBe("ev-sj-03");
    expect(kenjakuEvent.settle.combat.onDefeat?.nextEventId).toBe("ev-sj-03");
    // 羂索那一场不判死：只有宿傩两阶段战败才写 hero-death（避免「被残党打倒 = 战殁」）
    const kenjakuDeath = (kenjakuEvent.settle.combat.onDefeat?.effects ?? []).some(
      (e) => e.type === "setFlag" && e.id === "finalEnd" && e.value === "hero-death",
    );
    expect(kenjakuDeath).toBe(false);
    // P0 修复：两阶段战败都不得回日常（不写 nextEventId），交给终止条件收束
    expect(phase1Event.settle.combat.onDefeat?.nextEventId).toBeUndefined();
    expect(phase2Event.settle.combat.onDefeat?.nextEventId).toBeUndefined();
  });
});

describe("模板级断言（jjk-2006）· 涩谷身体争夺的玩家选择判定", () => {
  const template = loadJjkTemplate();

  /** 直接把 ev-sh-03b 送进待决队列（链事件由 nextEventId 串起来，此处只验结算语义）。 */
  function atBodyContest(worldId: string) {
    const state = createActiveWorldV2(
      { templateId: "jjk-2006", playerName: "测试者", seed: 7 },
      template,
      worldId,
    );
    const lookup = createLookup(template);
    const event = template.events.find((e) => e.id === "ev-sh-03b");
    if (event?.kind !== "normal") throw new Error("fixture: ev-sh-03b 不存在或不再是 normal");
    const result: TriggerResult = { triggered: [], wheelResult: null };
    triggerEventV2(state, event, lookup, createRng(5), 0, result);
    expect(state.pendingEvents.map((p) => p.eventId)).toContain("ev-sh-03b");
    return { state, lookup };
  }

  it("放任 ⇒ 虎杖 inactive(宿傩受肉)，并立刻进入「借虎杖之身」的那场战斗（enemy-sukuna）", () => {
    const { state, lookup } = atBodyContest("w-jjk-sh-let");
    chooseOptionV2(state, { optionId: "opt-sh3b-let" }, template, lookup);

    expect(lifeOf(state, "npc-yuji")).toMatchObject({ state: "inactive", reasonCode: "宿傩受肉" });
    expect(state.flags.sukunaTookOver).toBe(true);
    expect(state.battle, "放任必须触发战斗").not.toBeNull();
    expect(state.battle!.eventId).toBe("ev-sh-04");
    expect(state.battle!.enemies.map((e) => e.characterId)).toEqual(["enemy-sukuna"]);
    // 被占据的一方不进这场战斗（该场无友军）
    expect(state.battle!.allies).toEqual([]);
  });

  it("压制 ⇒ 虎杖保持 alive、没有那场战斗，但不是白给（心情/关系/力竭三重代价）", () => {
    const { state, lookup } = atBodyContest("w-jjk-sh-hold");
    const yuji = () => state.npcs.find((n) => n.id === "npc-yuji")!;
    const beforeMood = state.player.mood;
    const beforeRelation = yuji().relationship;

    chooseOptionV2(state, { optionId: "opt-sh3b-hold" }, template, lookup);

    expect(lifeOf(state, "npc-yuji").state).toBe("alive");
    expect(state.battle, "压制不该触发战斗").toBeNull();
    expect(state.flags.sukunaTookOver).toBe(false);
    expect(state.player.mood).toBeLessThan(beforeMood);
    expect(yuji().relationship).toBeLessThan(beforeRelation);
    expect(state.player.statuses.map((s) => s.statusId)).toContain("exhausted");
    // 没有这场战斗的唯一入口：ev-sh-04 只能由 opt-sh3b-let 的 nextEventId 到达
    const bodyContest = template.events.find((e) => e.id === "ev-sh-03b");
    if (bodyContest?.kind !== "normal") throw new Error("fixture: ev-sh-03b 不再是 normal");
    const pointing = bodyContest.settle.normal.options
      .filter((o) => o.nextEventId === "ev-sh-04")
      .map((o) => o.id);
    expect(pointing).toEqual(["opt-sh3b-let"]);
  });

  it("ev-sh-05 是「宿傩归还身体」的唯一入口：被占据后在此回到 alive，reasonCode 清掉", () => {
    const { state, lookup } = atBodyContest("w-jjk-sh-restore");
    setLifecycle(state, lookup, "npc-yuji", { state: "inactive", reasonCode: "宿傩受肉" });
    // 放任路线打完那场战斗后进入 ev-sh-05；这里直接送进待决队列验结算语义
    const event = template.events.find((e) => e.id === "ev-sh-05");
    if (event?.kind !== "normal") throw new Error("fixture: ev-sh-05 不存在或不再是 normal");
    triggerEventV2(state, event, lookup, createRng(5), 0, { triggered: [], wheelResult: null });
    state.pendingEvents = state.pendingEvents.filter((p) => p.eventId === "ev-sh-05");

    chooseOptionV2(state, { optionId: "opt-sh5-go" }, template, lookup);
    expect(lifeOf(state, "npc-yuji")).toMatchObject({ state: "alive" });
    expect("reasonCode" in lifeOf(state, "npc-yuji")).toBe(false);
    // 还原后他能重新作为友军参战（决战 ev-sj-02 的 allies 不再被过滤）
    const sj = template.events.find((e) => e.id === "ev-sj-02");
    if (sj?.kind !== "combat") throw new Error("fixture: ev-sj-02 不再是 combat");
    expect(resolveCombatRefs(sj.settle.combat, state, lookup).allies.map((r) => r.ref)).toContain("npc-yuji");
  });
});
