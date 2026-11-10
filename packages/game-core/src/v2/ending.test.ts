import { describe, expect, it } from "vitest";
import {
  TerminationRecordSchema,
  type TerminationRecord,
  type WorldStateV2,
  type WorldTemplateV2,
} from "@life-sim/shared";
import { createWorldV2 } from "./turn.js";
import { createActiveWorldV2 } from "./test-utils.js";
import { assertActive, EndingGuardError, markTerminated, type EndingGuardCode } from "./ending.js";

/** 最小可运行模板（与 npc / time 测试同构，不经 YAML）。 */
function makeTemplate(): WorldTemplateV2 {
  return {
    meta: { id: "t", name: "终止测试", description: "d", startYear: 2000, engineProtocol: "v2" },
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
    checks: {},
    characters: [],
    skills: [],
    items: [],
    statuses: [],
    events: [],
  };
}

function makeActiveState(): WorldStateV2 {
  // 与轮次测试一样走真实的 runOpening + handoff 交接，不再手工置位。
  const state = createActiveWorldV2(
    { templateId: "t", playerName: "测试者", seed: 1 },
    makeTemplate(),
    "w1",
  );
  state.worldTime = 525600;
  state.turnIndex = 7;
  return state;
}

function makeRec(overrides?: Partial<TerminationRecord>): TerminationRecord {
  return {
    reason: "主目标完成",
    worldTime: 0, // 故意与 state 不一致，验证权威值取自 state
    turnIndex: 0,
    source: "condition",
    ...overrides,
  };
}

function guardOf(state: WorldStateV2): EndingGuardCode {
  try {
    assertActive(state);
  } catch (err) {
    if (err instanceof EndingGuardError) return err.code;
    throw err;
  }
  throw new Error("assertActive 未拒绝，门禁失效");
}

describe("T2-01 · 三字段初始化", () => {
  it("createWorldV2 把 openingCompleted/termination/archived 初始化为 false/null/false", () => {
    const state = createWorldV2({ templateId: "t", playerName: "测试者", seed: 1 }, makeTemplate(), "w0");
    expect(state.openingCompleted).toBe(false);
    expect(state.termination).toBeNull();
    expect(state.archived).toBe(false);
  });
});

describe("T2-01 · 正常终止", () => {
  it("markTerminated 固化记录、worldTime/turnIndex 取自 state，且不改写 hp 与入参", () => {
    const state = makeActiveState();
    const before = structuredClone(state);
    const hp = state.player.hp;

    const result = markTerminated(state, makeRec());

    expect(result.termination).not.toBeNull();
    expect(result.termination).toMatchObject({
      reason: "主目标完成",
      worldTime: 525600,
      turnIndex: 7,
      source: "condition",
    });
    expect(result.termination?.endingId).toBeUndefined();

    // 纯函数：入参逐字段不变
    expect(state).toEqual(before);
    expect(state.termination).toBeNull();
    // 不改写 HP、不追加历史
    expect(result.player.hp).toBe(hp);
    expect(state.player.hp).toBe(hp);
    expect(result.history).toBe(state.history);
    expect(result.history).toHaveLength(0);
    expect(result.openingCompleted).toBe(true);
    expect(result.archived).toBe(false);
  });
});

describe("T2-01 · 重复终止（P2 幂等且不可逆）", () => {
  it("再次调用返回同一 TerminationRecord，不追加记录、不改写世界状态", () => {
    const first = markTerminated(makeActiveState(), makeRec({ reason: "第一次", source: "event" }));
    const before = structuredClone(first);
    const hp = first.player.hp;

    const again = markTerminated(
      first,
      makeRec({ reason: "第二次", source: "player", endingId: "end-x" }),
    );

    expect(again).toBe(first); // 同一状态引用 ⇒ 逐字段不变
    expect(again.termination).toBe(first.termination); // 同一 TerminationRecord
    expect(again.termination?.reason).toBe("第一次");
    expect(again.termination?.source).toBe("event");
    expect(again.termination?.endingId).toBeUndefined(); // 未被第二次入参改写
    expect(again.history).toHaveLength(first.history.length);
    expect(again.player.hp).toBe(hp);
    expect(first).toEqual(before);
  });
});

describe("T2-01 · 终止后写状态被拒（门禁）", () => {
  it("开局未完成 ⇒ NOT_ACTIVE，且逐字段不变", () => {
    const state = makeActiveState();
    state.openingCompleted = false;
    const before = structuredClone(state);
    expect(guardOf(state)).toBe("NOT_ACTIVE");
    expect(state).toEqual(before);
  });

  it("已终止 ⇒ TERMINATED，且逐字段不变", () => {
    const state = markTerminated(makeActiveState(), makeRec());
    const before = structuredClone(state);
    expect(guardOf(state)).toBe("TERMINATED");
    expect(state).toEqual(before);
  });

  it("已归档但 termination 仍为 null ⇒ TERMINATED，且逐字段不变", () => {
    const state = makeActiveState();
    state.archived = true;
    const before = structuredClone(state);
    expect(guardOf(state)).toBe("TERMINATED");
    expect(state).toEqual(before);
  });

  it("活跃状态不拒绝；错误信息含可诊断的拒绝码", () => {
    expect(() => assertActive(makeActiveState())).not.toThrow();
    const terminated = markTerminated(makeActiveState(), makeRec());
    expect(() => assertActive(terminated)).toThrowError(/TERMINATED/);
  });
});

describe("T2-01 · Schema 无效输入（失败 / 边界）", () => {
  it("拒绝非法 source 与未知字段（strict），接受合法记录", () => {
    expect(
      TerminationRecordSchema.safeParse({
        reason: "x", worldTime: 0, turnIndex: 0, source: "unknown",
      }).success,
    ).toBe(false);
    expect(
      TerminationRecordSchema.safeParse({
        reason: "x", worldTime: 0, turnIndex: 0, source: "condition", extra: 1,
      }).success,
    ).toBe(false);
    expect(
      TerminationRecordSchema.safeParse({
        reason: "x", worldTime: 10, turnIndex: 3, endingId: "end-a", source: "battleDefeat",
      }).success,
    ).toBe(true);
  });
});
