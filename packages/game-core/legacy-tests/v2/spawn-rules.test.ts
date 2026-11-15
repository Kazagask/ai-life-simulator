import { describe, expect, it } from "vitest";
import type { WorldTemplateV2 } from "@life-sim/shared";
import { WorldTemplateV2Schema } from "@life-sim/shared";
import { applyEffectsV2, checkCondition } from "./engine.js";
import { createLookup } from "./lookup.js";
import { projectSnapshotV2 } from "./projection.js";
import { createRng } from "../rng.js";
import { createActiveWorldV2, makeTestTemplate } from "./test-utils.js";

/**
 * ADR-0010 决策 4 / R-LM-04 / ADR-0022：NPC 刷新机制。
 * 配置层（npcSpawnRules）→ 实例层（SpawnRuleInstance 队列）→ 事实层（spawnLog 只追加）。
 */
function build(ruleAge?: number) {
  const template = makeTestTemplate();
  template.characters.push({
    id: "npc-born",
    isEnemy: false,
    visibility: "public",
    identity: { name: "待出生者", age: 17, gender: "f" },
    mood: { value: 60 },
    attributes: { cursedEnergy: 5, agility: 3, luck: 3 },
    skills: ["sk-strike"],
    public: { personality: "测试用" },
    private: { combatHints: { skillWeights: { "sk-strike": 1 } } },
    relationship: 0,
  } as WorldTemplateV2["characters"][number]);
  template.npcSpawnRules = [
    { id: "rule-birth", characterRef: "npc-born", ...(ruleAge !== undefined ? { age: ruleAge } : {}) },
  ];
  const state = createActiveWorldV2({ templateId: "test", playerName: "测试者", seed: 7 }, template, "w-spawn");
  const lookup = createLookup(template);
  return { template, state, lookup };
}

describe("V2 NPC 刷新机制（ADR-0022）", () => {
  it("世界创建把配置规则实例化为队列，角色处于 unspawned 且不进投影", () => {
    const { template, state, lookup } = build();
    expect(state.spawnRules).toEqual([
      { ruleId: "rule-birth", characterRef: "npc-born", status: "pending", spawnedTurn: 0, spawnedWorldTime: 0 },
    ]);
    expect(state.spawnLog).toEqual([]);

    const npc = state.npcs.find((n) => n.id === "npc-born")!;
    expect(npc.lifecycle.state).toBe("unspawned");
    expect(npc.spawnRuleId).toBe("rule-birth");

    const view = projectSnapshotV2(state, template, lookup);
    expect(view.npcs.some((n) => n.id === "npc-born")).toBe(false);
    // 模板逐字段不变（配置域只读）
    expect(template.npcSpawnRules?.[0].characterRef).toBe("npc-born");
  });

  it("spawnNpc 按规则出生：转 alive、进投影、年龄取规则值、追加一条事实", () => {
    const { template, state, lookup } = build(0); // 0 岁 = 新生儿
    const rng = createRng(1);
    state.turnIndex = 3;
    state.worldTime = 3 * 1440;

    applyEffectsV2({ state, lookup, rng, logs: [] }, [{ type: "spawnNpc", ruleId: "rule-birth" }]);

    const npc = state.npcs.find((n) => n.id === "npc-born")!;
    expect(npc.lifecycle.state).toBe("alive");
    expect(npc.lifecycle.sinceTurn).toBe(3);
    expect(state.spawnRules[0].status).toBe("spawned");
    expect(state.spawnRules[0].spawnedTurn).toBe(3);
    expect(state.spawnLog).toHaveLength(1);
    expect(state.spawnLog[0]).toMatchObject({ npcId: "npc-born", ruleId: "rule-birth", turnIndex: 3 });

    const view = projectSnapshotV2(state, template, lookup);
    const shown = view.npcs.find((n) => n.id === "npc-born")!;
    expect(shown).toBeDefined();
    expect(shown.age).toBe(0); // 出生时刻 = 世界时间，年龄 0
  });

  it("重复 spawnNpc 幂等：不重复追加事实、不改 since", () => {
    const { state, lookup } = build();
    const rng = createRng(1);
    applyEffectsV2({ state, lookup, rng, logs: [] }, [{ type: "spawnNpc", ruleId: "rule-birth" }]);
    const firstSince = state.npcs.find((n) => n.id === "npc-born")!.lifecycle.sinceTurn;

    state.turnIndex = 9;
    applyEffectsV2({ state, lookup, rng, logs: [] }, [{ type: "spawnNpc", ruleId: "rule-birth" }]);

    expect(state.spawnLog).toHaveLength(1);
    expect(state.npcs.find((n) => n.id === "npc-born")!.lifecycle.sinceTurn).toBe(firstSince);
  });

  it("spawn 不由事实自动触发：推进多轮仍 pending", () => {
    const { state } = build();
    state.turnIndex = 40;
    state.worldTime = 40 * 1440;
    expect(state.spawnRules[0].status).toBe("pending");
    expect(state.npcs.find((n) => n.id === "npc-born")!.lifecycle.state).toBe("unspawned");
  });

  it("未知 ruleId 抛可诊断错误", () => {
    const { state, lookup } = build();
    expect(() =>
      applyEffectsV2({ state, lookup, rng: createRng(1), logs: [] }, [
        { type: "spawnNpc", ruleId: "rule-nope" },
      ]),
    ).toThrow(/未知刷新规则/);
  });

  it("npcState 条件可判「尚未出生」（实例存在但 unspawned）", () => {
    const { state, lookup } = build();
    const ctx = { state, lookup, rng: createRng(1) };
    expect(checkCondition({ npcState: { npcId: "npc-born", state: "unspawned" } }, ctx)).toBe(true);
    applyEffectsV2({ state, lookup, rng: createRng(1), logs: [] }, [{ type: "spawnNpc", ruleId: "rule-birth" }]);
    expect(checkCondition({ npcState: { npcId: "npc-born", state: "unspawned" } }, ctx)).toBe(false);
    expect(checkCondition({ npcState: { npcId: "npc-born", state: "alive" } }, ctx)).toBe(true);
  });

  it("加载期校验：未知角色 / 指向敌人 / 重复规则 id 均拒载（断言 issue path）", () => {
    // 只看 npcSpawnRules 相关的 issue：基线夹具 makeTestTemplate 本身有一处
    // 非法引用（事件的 requiresSkill: "sk-none"），不过滤会把"因别的原因失败"误当通过。
    // 这正是 ADR-0023 施工时发现的问题——上一版这三条断言是假绿。
    const spawnIssues = (input: unknown): string[] => {
      const res = WorldTemplateV2Schema.safeParse(input);
      if (res.success) return [];
      return res.error.issues
        .filter((i) => i.path[0] === "npcSpawnRules")
        .map((i) => i.path.join("."));
    };
    const base = () => {
      const t = JSON.parse(JSON.stringify(makeTestTemplate())) as WorldTemplateV2;
      t.characters.push({
        id: "npc-ok",
        isEnemy: false,
        visibility: "public",
        identity: { name: "合法角色", age: 17, gender: "f" },
        mood: { value: 60 },
        attributes: { cursedEnergy: 5, agility: 3, luck: 3 },
        skills: ["sk-strike"],
        public: { personality: "测试用" },
        private: { combatHints: { skillWeights: { "sk-strike": 1 } } },
        relationship: 0,
      } as WorldTemplateV2["characters"][number]);
      return t;
    };

    const unknown = base();
    unknown.npcSpawnRules = [{ id: "r1", characterRef: "npc-ghost" }];
    expect(spawnIssues(unknown)).toEqual(["npcSpawnRules.0.characterRef"]);

    const enemy = base();
    enemy.npcSpawnRules = [{ id: "r1", characterRef: "enemy-x" }];
    expect(spawnIssues(enemy)).toEqual(["npcSpawnRules.0.characterRef"]);

    const dup = base();
    dup.npcSpawnRules = [
      { id: "r1", characterRef: "npc-ok" },
      { id: "r1", characterRef: "npc-ok" },
    ];
    expect(spawnIssues(dup)).toEqual(["npcSpawnRules.1"]);

    // 正例：合法规则不产生任何 npcSpawnRules issue（保证不是"永远报错"）
    const ok = base();
    ok.npcSpawnRules = [{ id: "r1", characterRef: "npc-ok" }];
    expect(spawnIssues(ok)).toEqual([]);
  });
});
