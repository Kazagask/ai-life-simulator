import { describe, expect, it } from "vitest";
import {
  WorldStateV2Schema,
  WorldTemplateV2Schema,
  type WorldStateV2,
  type WorldTemplateV2,
} from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { createActiveWorldV2 } from "./test-utils.js";
import { advanceTurnV2 } from "./turn.js";
import { projectSnapshotV2 } from "./projection.js";
import { birthTimeFromAge, createTimeAdapter, UNIT_MINUTES } from "./time.js";

/**
 * NPC birthTime 与年龄派生（ADR-0021 决策 4）。
 *
 * 钉住三件事：
 * 1. 年龄在**投影期**由 `ageAt(birthTime, worldTime)` 现算（跨年界即 +1），不回写 `state.npcs[].age`；
 * 2. 旧档缺 `birthTime` 时不拒载（不升 schemaVersion），读侧反推后投影年龄与原来一致、此后随世界时间增长；
 * 3. 玩家侧本轮不动（`playerAgeAtStart + elapsedYears`），两条路径在同一时刻不冲突。
 */

const RAW_TEMPLATE: Record<string, unknown> = {
  meta: { id: "t-age", name: "年龄测试", description: "d", startYear: 2001, engineProtocol: "v2" },
  // 2001 为平年 ⇒ 1 年恰好 525600 分钟，跨年界与「推进整年」重合，断言可读
  time: { defaultStep: { value: 1, unit: "year" }, calendar: { preset: "gregorian" } },
  genders: [{ id: "f", label: "女" }],
  mood: {
    min: 0,
    max: 100,
    defaultValue: 60,
    bands: [{ id: "n", label: "平静", min: 0, max: 100, attributeModifiers: {} }],
  },
  statusBar: [{ id: "sb1", label: "基本", source: "identity" }],
  attributes: { order: ["power"], defaults: { power: 5 } },
  resources: { hp: { base: 100, perLevel: 0 }, mp: { base: 50, perLevel: 0 } },
  regen: { perTurn: { hp: 0, mp: 0 } },
  characters: [
    {
      id: "npc-young",
      isEnemy: false,
      identity: { name: "少年", age: 17, gender: "f" },
      visibility: "public",
      mood: { value: 60 },
      attributes: { power: 4 },
      public: {},
      private: {},
      relationship: 10,
    },
    {
      id: "npc-old",
      isEnemy: false,
      identity: { name: "长者", age: 30, gender: "f" },
      visibility: "public",
      mood: { value: 60 },
      attributes: { power: 4 },
      public: {},
      private: {},
      relationship: 10,
    },
    {
      // 缺省阶段阈值 20 岁的边界角色：用于验证 lifeStage 走**派生**年龄而不是静态 age
      id: "npc-edge",
      isEnemy: false,
      identity: { name: "临界", age: 19, gender: "f" },
      visibility: "public",
      mood: { value: 60 },
      attributes: { power: 4 },
      public: {},
      private: {},
      relationship: 10,
    },
  ],
  playerTemplate: { identity: { gender: "f", age: 16 }, attributes: { power: 10 } },
  actions: [{ id: "idle", label: "过日子", duration: { value: 1, unit: "year" } }],
  skills: [],
  items: [],
  statuses: [],
  events: [],
};

function makeTemplate(): WorldTemplateV2 {
  return WorldTemplateV2Schema.parse(structuredClone(RAW_TEMPLATE));
}

function setup(worldId: string) {
  const template = makeTemplate();
  const lookup = createLookup(template);
  const state = createActiveWorldV2({ templateId: template.meta.id, playerName: "测试者", seed: 11 }, template, worldId);
  return { template, lookup, state };
}

const npcAge = (view: ReturnType<typeof projectSnapshotV2>, id: string) => view.npcs.find((n) => n.id === id)!.age;

describe("NPC birthTime 写入与年龄派生（ADR-0021 决策 4.1/4.2）", () => {
  it("建世界期写入 birthTime（负分钟），且 ageAt(birthTime, 0) === identity.age", () => {
    const { state, template } = setup("w-age-1");
    const adapter = createTimeAdapter(template);
    const young = state.npcs.find((n) => n.id === "npc-young")!;
    expect(typeof young.birthTime).toBe("number");
    expect(young.birthTime!).toBeLessThan(0); // 15/17 岁角色在世界起点前出生
    expect(young.birthTime).toBe(birthTimeFromAge(17, adapter));
    expect(adapter.ageAt(young.birthTime!, 0)).toBe(17);
    expect(adapter.ageAt(state.npcs.find((n) => n.id === "npc-old")!.birthTime!, 0)).toBe(30);
    // age 保留为起始年龄快照（旧档字节兼容），不因投影而变
    expect(young.age).toBe(17);
  });

  it("同建世界时刻年龄不变（投影 age 与 identity.age 一致）", () => {
    const { state, template, lookup } = setup("w-age-2");
    const view = projectSnapshotV2(state, template, lookup);
    expect(state.worldTime).toBe(0);
    expect(npcAge(view, "npc-young")).toBe(17);
    expect(npcAge(view, "npc-old")).toBe(30);
  });

  it("跨年界即 +1（前后各差 1 分钟，年龄差恰为 1），且不写回 state.npcs[].age", () => {
    const { state, template, lookup } = setup("w-age-3");
    const boundary = UNIT_MINUTES.year; // 2002-01-01 00:00（2001 平年）

    state.worldTime = boundary - 1;
    expect(npcAge(projectSnapshotV2(state, template, lookup), "npc-young")).toBe(17);
    state.worldTime = boundary;
    expect(npcAge(projectSnapshotV2(state, template, lookup), "npc-young")).toBe(18);
    // 推进是投影期计算：状态里的 age 仍是起始快照
    expect(state.npcs.find((n) => n.id === "npc-young")!.age).toBe(17);
  });

  it("推进整年（行动 duration 1 年）后投影年龄 +1，lifeStage 随派生年龄重算", () => {
    const { state, template, lookup } = setup("w-age-4");
    const res = advanceTurnV2(state, { action: { type: "idle", description: "" } }, template, lookup);
    expect(state.worldTime).toBe(UNIT_MINUTES.year);
    expect(npcAge(res.snapshot, "npc-young")).toBe(18);
    expect(npcAge(res.snapshot, "npc-old")).toBe(31);
    expect(state.npcs.find((n) => n.id === "npc-young")!.age).toBe(17);
    // lifeStage 由**派生**年龄推导：缺省阈值 20 岁，19 → 20 跨过去即 adulthood
    expect(res.snapshot.npcs.find((n) => n.id === "npc-edge")!.lifeStage).toBe("adulthood");
    expect(state.npcs.find((n) => n.id === "npc-edge")!.age).toBe(19); // 静态快照仍是 19
  });

  it("NPC 与玩家同一时刻口径不冲突：世界推进整年后两者同时 +1", () => {
    const { state, template, lookup } = setup("w-age-5");
    const res = advanceTurnV2(state, { action: { type: "idle", description: "" } }, template, lookup);
    expect(res.snapshot.player.age).toBe(17); // playerAgeAtStart 16 + elapsedYears(1 年) = 1
    expect(npcAge(res.snapshot, "npc-young")).toBe(18); // 17 + 年差 1
    // 玩家侧字段本轮不动：playerAgeAtStart 仍是 16
    expect(state.playerAgeAtStart).toBe(16);
  });
});

describe("旧档兼容：缺 birthTime 时不拒载、读侧反推（ADR-0021 决策 4.1）", () => {
  /** 模拟「ADR-0021 之前落盘的存档」：删掉 birthTime 后按 strict schema 载入。 */
  function asLegacySave(state: WorldStateV2): WorldStateV2 {
    const raw = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    const npcs = raw.npcs as Array<Record<string, unknown>>;
    for (const npc of npcs) delete npc.birthTime;
    return WorldStateV2Schema.parse(raw) as WorldStateV2;
  }

  it("缺 birthTime 的存档仍可加载（不升 schemaVersion、不拒载）", () => {
    const { state } = setup("w-age-6");
    expect(state.npcs.every((n) => n.birthTime !== undefined)).toBe(true);
    const legacy = asLegacySave(state);
    expect(legacy.npcs.every((n) => n.birthTime === undefined)).toBe(true);
  });

  it("旧档加载后投影年龄与原来一致，且此后随世界时间增长", () => {
    const { state, template, lookup } = setup("w-age-7");
    const before = projectSnapshotV2(state, template, lookup);
    const legacy = asLegacySave(state);

    const loaded = projectSnapshotV2(legacy, template, lookup);
    expect(npcAge(loaded, "npc-young")).toBe(npcAge(before, "npc-young"));
    expect(npcAge(loaded, "npc-old")).toBe(npcAge(before, "npc-old"));

    // 反推正确 ⇒ 跨年界同样 +1（不是「永远停在静态 age」）
    legacy.worldTime = UNIT_MINUTES.year;
    const later = projectSnapshotV2(legacy, template, lookup);
    expect(npcAge(later, "npc-young")).toBe(18);
    expect(npcAge(later, "npc-old")).toBe(31);
  });

  // ---------- P1-2 任务 C：已故者年龄冻结（ADR-0024 补遗） ----------

  it("已故（inactive）者的年龄冻结在死亡时刻：推进一年后年龄与阶段都不变", () => {
    const { state, template, lookup } = setup("w-age-frozen-1");
    const adapter = createTimeAdapter(template);
    const young = state.npcs.find((n) => n.id === "npc-young")!;

    // 先推进一年，让世界时间与「死亡时刻」拉开
    state.worldTime = UNIT_MINUTES.year;
    expect(npcAge(projectSnapshotV2(state, template, lookup), "npc-young")).toBe(18);

    // 在 t=1 年处死亡 ⇒ sinceWorldTime = 1 年，此后年龄应钉在 18
    young.lifecycle = { state: "inactive", reasonCode: "阵亡", sinceTurn: 3, sinceWorldTime: state.worldTime };
    expect(adapter.ageAt(young.birthTime!, state.worldTime)).toBe(18);

    // 再推进五年（远超过出生月日边界），年龄必须仍是 18
    state.worldTime = 6 * UNIT_MINUTES.year;
    const view = projectSnapshotV2(state, template, lookup);
    expect(npcAge(view, "npc-young")).toBe(18);
    const frozen = view.npcs.find((n) => n.id === "npc-young")!;
    // 阶段由同一个冻结年龄派生，不会跟着漂
    expect(frozen.lifeStage).toBe(adapter.resolveLifeStage(18));
    expect(frozen.lifeStageLabel).toBe(adapter.lifeStageLabel(adapter.resolveLifeStage(18)));
    // 状态里的 age 仍是起始快照（不被投影回写）
    expect(young.age).toBe(17);
  });

  it("同局未死的 NPC 照常随世界时间增长（冻结只对非 alive 生效）", () => {
    const { state, template, lookup } = setup("w-age-frozen-2");
    const young = state.npcs.find((n) => n.id === "npc-young")!;
    young.lifecycle = { state: "inactive", reasonCode: "阵亡", sinceTurn: 0, sinceWorldTime: 0 };
    state.worldTime = 3 * UNIT_MINUTES.year;
    const view = projectSnapshotV2(state, template, lookup);
    expect(npcAge(view, "npc-young")).toBe(17); // 钉在 t=0 的 17 岁
    expect(npcAge(view, "npc-old")).toBe(33); // 活着的：30 + 3
  });

  it("复活（回 alive）后按 worldTime 恢复增长 —— 与状态机语义一致", () => {
    const { state, template, lookup } = setup("w-age-frozen-3");
    const young = state.npcs.find((n) => n.id === "npc-young")!;
    young.lifecycle = { state: "inactive", reasonCode: "被同化", sinceTurn: 0, sinceWorldTime: 0 };
    state.worldTime = 6 * UNIT_MINUTES.year;
    expect(npcAge(projectSnapshotV2(state, template, lookup), "npc-young")).toBe(17);

    // 复活：sinceWorldTime 刷新到当下，此后重新随世界时间走
    young.lifecycle = { state: "alive", sinceTurn: 9, sinceWorldTime: state.worldTime };
    const adapter = createTimeAdapter(template);
    const atRevive = adapter.ageAt(young.birthTime!, state.worldTime);
    expect(atRevive).toBeGreaterThan(17); // 已经比死亡时刻老
    expect(npcAge(projectSnapshotV2(state, template, lookup), "npc-young")).toBe(atRevive);
    state.worldTime = 7 * UNIT_MINUTES.year;
    expect(npcAge(projectSnapshotV2(state, template, lookup), "npc-young")).toBe(
      adapter.ageAt(young.birthTime!, state.worldTime),
    );
  });

  it("unspawned（尚未登场）同样按 sinceWorldTime 计龄，不会凭空长大", () => {
    const { state, template, lookup } = setup("w-age-frozen-4");
    const young = state.npcs.find((n) => n.id === "npc-young")!;
    young.lifecycle = { state: "unspawned", sinceTurn: 0, sinceWorldTime: 0 };
    state.worldTime = 4 * UNIT_MINUTES.year;
    // unspawned 不上屏（ADR-0022），故此处只验证「若上屏，年龄口径一致」
    const view = projectSnapshotV2(state, template, lookup);
    expect(view.npcs.some((n) => n.id === "npc-young")).toBe(false);
    young.lifecycle = { state: "alive", sinceTurn: 4, sinceWorldTime: 4 * UNIT_MINUTES.year };
    const adapter = createTimeAdapter(template);
    // 登场时按当下世界时间计龄（不是从 0 开始凭空长大）
    expect(projectSnapshotV2(state, template, lookup).npcs.find((n) => n.id === "npc-young")!.age).toBe(
      adapter.ageAt(young.birthTime!, state.worldTime),
    );
  });

  it("approx 模板（缺省历法）反推严格等于 -age × UNIT_MINUTES.year", () => {
    const template = makeTemplate();
    template.time = { defaultStep: { value: 1, unit: "year" } };
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: template.meta.id, playerName: "测试者", seed: 11 }, template, "w-age-8");
    const adapter = createTimeAdapter(template);
    for (const npc of state.npcs) {
      expect(npc.birthTime).toBe(-npc.age * UNIT_MINUTES.year);
      expect(adapter.ageAt(npc.birthTime!, 0)).toBe(npc.age);
    }
    // 推进 1 年（approx 整年整除）后同样 +1
    state.worldTime = UNIT_MINUTES.year;
    const view = projectSnapshotV2(state, template, lookup);
    expect(npcAge(view, "npc-young")).toBe(18);
  });
});
