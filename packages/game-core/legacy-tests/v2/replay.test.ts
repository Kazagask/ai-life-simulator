import { describe, expect, it } from "vitest";
import type { WorldTemplateV2 } from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { advanceTurnV2, createWorldV2 } from "./turn.js";
import { createRunnerContext } from "./runner-context.js";
import { replay, type ReplayCommand, type ReplaySpec } from "./replay.js";
import { createActiveWorldV2 } from "./test-utils.js";
import { EndingGuardError } from "./ending.js";

/**
 * 回放用模板：无 NPC、无战斗、无选项事件，advanceTurnV2 可连续推进而不卡
 * pending_event_required；带一个 pool 转盘事件，使 rng 真实参与结算，
 * 让「同 seed ⇒ 逐字段相等」覆盖随机路径。
 */
function makeReplayTemplate(): WorldTemplateV2 {
  return {
    meta: { id: "replay", name: "回放测试", description: "d", startYear: 2000, engineProtocol: "v2" },
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
    resources: {
      hp: { base: 100, perLevel: 0 },
      mp: { base: 50, perLevel: 0 },
    },
    regen: { perTurn: { hp: 0, mp: 0 } },
    characters: [],
    skills: [],
    items: [],
    statuses: [],
    events: [
      {
        id: "ev-wheel",
        title: "抽签",
        narrative: "命运转盘。",
        trigger: { source: "pool", probability: 1 },
        kind: "random",
        settle: {
          random: {
            wheel: {
              segments: [
                { weight: 1, label: "大吉", effects: [{ type: "adjustMood", value: 10 }] },
                { weight: 1, label: "凶", effects: [{ type: "adjustMood", value: -5 }] },
              ],
            },
          },
        },
      },
    ],
  };
}

const REST: ReplayCommand = { action: { type: "rest", description: "休息" } };
const PATROL: ReplayCommand = { action: { type: "patrol", description: "巡逻" } };

function makeSpec(overrides: Partial<ReplaySpec> = {}): ReplaySpec {
  return {
    seed: 7,
    playerName: "回放者",
    worldId: "w-replay",
    template: makeReplayTemplate(),
    commands: [REST, PATROL, REST, REST, PATROL],
    ...overrides,
  };
}

describe("T2-04 · RunnerContext 注入确定性（rng / now / idFactory）", () => {
  it("同 seed 的两个独立上下文产生逐项相等的 rng / now / idFactory 序列", () => {
    const a = createRunnerContext(1234);
    const b = createRunnerContext(1234);
    for (let i = 0; i < 8; i++) expect(a.rng()).toBe(b.rng());
    expect(a.now()).toBe(b.now());
    expect(a.idFactory("e")).toBe(b.idFactory("e"));
    expect(a.idFactory("e")).toBe(b.idFactory("e"));
  });

  it("不同 seed 的 rng 首值不同（seed 生效，不依赖真实随机）", () => {
    expect(createRunnerContext(1).rng()).not.toBe(createRunnerContext(2).rng());
  });

  it("idFactory 单调递增且由实例独立持有", () => {
    const a = createRunnerContext(9);
    expect(a.idFactory("x")).toBe("x-0");
    expect(a.idFactory("x")).toBe("x-1");
    expect(a.idFactory("y")).toBe("y-2");
    expect(createRunnerContext(9).idFactory("x")).toBe("x-0");
  });
});

describe("T2-04 · P1 同 seed 完整回放逐字段相等（不含阶段序列）", () => {
  it("组 A：seed=7，多轮指令序列 → 两次回放最终状态逐字段相等", () => {
    const spec = makeSpec({ seed: 7, worldId: "w-a", commands: [REST, PATROL, REST, REST, PATROL] });
    const first = replay(spec);
    const second = replay(spec);
    expect(second).toEqual(first);
    // 回放确实推进了世界，避免「比较的是两份空状态」的假阳性
    expect(first.turnIndex).toBe(spec.commands.length);
    expect(first.worldTime).toBeGreaterThan(0);
    expect(first.history.length).toBeGreaterThan(0);
  });

  it("组 B：seed=20261111，另一指令序列 → 两次回放最终状态逐字段相等", () => {
    const spec = makeSpec({
      seed: 20261111,
      playerName: "另一个人",
      worldId: "w-b",
      commands: [PATROL, REST, PATROL, PATROL, REST, PATROL, REST],
    });
    const first = replay(spec);
    const second = replay(spec);
    expect(second).toEqual(first);
    expect(first.turnIndex).toBe(spec.commands.length);
  });
});

describe("T2-04 · 边界与无隐藏全局状态", () => {
  it("空指令序列：两次回放均为初始状态且逐字段相等", () => {
    const spec = makeSpec({ commands: [] });
    const a = replay(spec);
    const b = replay(spec);
    expect(a).toEqual(b);
    expect(a.turnIndex).toBe(0);
    expect(a.worldTime).toBe(0);
    expect(a.history).toEqual([]);
  });

  it("重复调用 replay(spec) 不污染传入的 template，且不共享状态", () => {
    const template = makeReplayTemplate();
    const before = structuredClone(template);
    const spec = makeSpec({ template, commands: [REST, PATROL, REST] });
    const a = replay(spec);
    const b = replay(spec);
    expect(a).toEqual(b);
    expect(template).toEqual(before);
  });
});

describe("T2-04 · 现有公开签名兼容（advanceTurnV2 入口已接 assertActive）", () => {
  it("openingCompleted=false 被 NOT_ACTIVE 拒绝，且 state 逐字段不变", () => {
    const template = makeReplayTemplate();
    const lookup = createLookup(template);
    const state = createWorldV2({ templateId: "replay", playerName: "兼容", seed: 5 }, template, "w-compat");
    expect(state.openingCompleted).toBe(false);
    const before = structuredClone(state);
    try {
      advanceTurnV2(state, { action: { type: "rest" } }, template, lookup);
      throw new Error("应当被门禁拒绝");
    } catch (err) {
      expect(err).toBeInstanceOf(EndingGuardError);
      expect((err as EndingGuardError).code).toBe("NOT_ACTIVE");
    }
    expect(state).toEqual(before);
  });

  it("状态已激活时，三参数 / 四参数调用仍可推进", () => {
    const template = makeReplayTemplate();
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "replay", playerName: "兼容", seed: 5 }, template, "w-compat-active");
    expect(state.openingCompleted).toBe(true);
    const res = advanceTurnV2(state, { action: { type: "rest" } }, template, lookup);
    expect(res.state.turnIndex).toBe(1);
  });
});
