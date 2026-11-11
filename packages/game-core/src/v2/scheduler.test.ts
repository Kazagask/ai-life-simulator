import { describe, expect, it } from "vitest";
import {
  WorldTemplateV2Schema,
  type EventInstanceOrigin,
  type EventV2,
  type ScheduledEventInstance,
  type WorldStateV2,
  type WorldTemplateV2,
} from "@life-sim/shared";
import { createRng } from "../rng.js";
import { createLookup } from "./lookup.js";
import { createWorldV2 } from "./turn.js";
import { createTimeAdapter } from "./time.js";
import {
  alignChainStep,
  drainScheduledEvents,
  enqueueCandidate,
  enqueueScheduled,
  evaluateChain,
  evaluateDue,
  hasFired,
  onCooldown,
  recordFire,
  resolveTimeSpec,
  sortScheduled,
  specToMinutes,
} from "./scheduler.js";

/**
 * R2.5 / T1-03 调度器单测：排序三键、出队终判、确定性、错失、#36 hold、
 * 入队门控、pool+combat、事实只追加、链与队列对账。
 */

function normal(id: string, trigger: EventV2["trigger"]): EventV2 {
  return {
    id,
    title: `事件 ${id}`,
    narrative: "调度器单测事件。",
    trigger,
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  } as EventV2;
}

function makeTemplate(events: EventV2[], chains?: WorldTemplateV2["chains"]): WorldTemplateV2 {
  return {
    meta: { id: "t", name: "调度测试", description: "d", startYear: 2000, engineProtocol: "v2" },
    time: { defaultStep: { value: 1, unit: "day" } },
    genders: [{ id: "f", label: "女" }],
    mood: { min: 0, max: 100, defaultValue: 60, bands: [{ id: "n", label: "平", min: 0, max: 100, attributeModifiers: {} }] },
    statusBar: [{ id: "sb", label: "基本", source: "identity" }],
    attributes: { order: ["str"], defaults: { str: 5 } },
    resources: { hp: { base: 100, perLevel: 0 }, mp: { base: 50, perLevel: 0 } },
    regen: { perTurn: { hp: 0, mp: 0 } },
    characters: [],
    skills: [],
    items: [],
    statuses: [],
    events,
    chains,
  } as unknown as WorldTemplateV2;
}

/**
 * 单测夹具：createWorldV2 现在会按 R-EV-08 为全部 source: schedule 定义自动入队，
 * 而本文件的用例需要自己精确控制实例（start/end/seq），故清空初始化实例后再用。
 * 「初始化即入队」本身由下方 T1-04 专项用例验证。
 */
function makeState(template: WorldTemplateV2): WorldStateV2 {
  const state = createWorldV2({ templateId: "t", playerName: "测试者", seed: 1 }, template, "w-sched");
  state.scheduledEvents = [];
  state.enqueueSeqCounter = 0;
  return state;
}

const origin: EventInstanceOrigin = { kind: "effect", id: "test" };

function drain(state: WorldStateV2, template: WorldTemplateV2, ids: string[] = []): string[] {
  const fired = [...ids];
  drainScheduledEvents(state, createLookup(template), createRng(7), (inst) => fired.push(inst.definitionId));
  return fired;
}

describe("T1-03 · TimeSpec 换算与三键排序（R-EV-04/05）", () => {
  it("resolveTimeSpec 默认相对入队时刻；specToMinutes 取基准 0", () => {
    expect(resolveTimeSpec({ value: 3, unit: "day" }, 1000)).toBe(1000 + 4320);
    expect(resolveTimeSpec({ value: 2, unit: "hour" }, 0)).toBe(120);
    expect(specToMinutes({ value: 1, unit: "week" })).toBe(10080);
  });

  it("三键：start asc → hasEnd(false=+∞，排后) → end asc → enqueueSeq asc", () => {
    const template = makeTemplate([]);
    const state = makeState(template);
    // 故意乱序入队：seq 由计数器决定，排序不得依赖插入顺序
    const late = enqueueScheduled({ state, definitionId: "e-late", origin, start: { value: 2, unit: "day" } });
    const noEnd = enqueueScheduled({ state, definitionId: "e-noend", origin, start: { value: 1, unit: "day" } });
    const short = enqueueScheduled({
      state, definitionId: "e-short", origin,
      start: { value: 1, unit: "day" }, end: { value: 2, unit: "day" },
    });
    const long = enqueueScheduled({
      state, definitionId: "e-long", origin,
      start: { value: 1, unit: "day" }, end: { value: 5, unit: "day" },
    });
    const first = enqueueScheduled({ state, definitionId: "e-first", origin, start: { value: 1, unit: "day" }, end: { value: 2, unit: "day" } });

    expect(state.scheduledEvents.map((i) => i.definitionId)).toEqual([
      "e-short", "e-first", "e-long", "e-noend", "e-late",
    ]);
    // 幂等：重复排序结果一致
    expect(sortScheduled(state.scheduledEvents)).toEqual(state.scheduledEvents);
    expect(noEnd.hasEnd).toBe(false);
    expect(short.hasEnd).toBe(true);
    expect(late.window.end).toBeUndefined();
    expect(first.enqueueSeq).toBeGreaterThan(short.enqueueSeq);
    expectNoConfigSnapshot(state.scheduledEvents);
  });
});

describe("T1-03 · 出队终判与错失（R-EV-06/07/12、#36）", () => {
  it("conditions 在出队时刻终判：入队时不满足、出队时满足 ⇒ 触发（反之不触发）", () => {
    const template = makeTemplate([
      normal("ev-cond", { source: "schedule", window: { start: { value: 1, unit: "day" } }, conditions: [{ flag: "ready", eq: true }] }),
    ]);
    const state = makeState(template);
    enqueueScheduled({ state, definitionId: "ev-cond", origin, start: { value: 1, unit: "day" } });
    state.worldTime = 1440;
    // 入队/到期时条件均不满足 ⇒ hold，零错失
    expect(drain(state, template)).toEqual([]);
    expect(state.missedEvents).toHaveLength(0);
    expect(state.scheduledEvents[0].status).toBe("waiting");

    state.flags.ready = true;
    expect(drain(state, template)).toEqual(["ev-cond"]);
    expect(state.scheduledEvents[0].status).toBe("fired");

    // 反向：定义现值改了，已 fired 实例不会被重复出队
    state.flags.ready = false;
    expect(drain(state, template)).toEqual([]);
  });

  it("missWhen 命中即出队，落 reason=miss_when 且透传 label；无 end 也不僵尸留队", () => {
    const template = makeTemplate([
      normal("ev-miss", {
        source: "schedule", window: { start: { value: 1, unit: "day" } },
        missWhen: [{ flag: "gone", eq: true }], missLabel: "前提已失效",
      }),
    ]);
    const state = makeState(template);
    enqueueScheduled({ state, definitionId: "ev-miss", origin, start: { value: 1, unit: "day" } });
    state.worldTime = 99999999; // 无 end：不因时间过期
    state.flags.gone = true;
    expect(drain(state, template)).toEqual([]);
    expect(state.scheduledEvents[0].status).toBe("expired");
    expect(state.missedEvents).toEqual([
      {
        eventId: "ev-miss",
        instanceId: state.scheduledEvents[0].instanceId,
        turnIndex: 0,
        worldTime: 99999999,
        reason: "miss_when",
        label: "前提已失效",
      },
    ]);
  });

  it("无 window.end 且未声明 missWhen：永不因时间过期出队，零错失记录", () => {
    const template = makeTemplate([
      normal("ev-forever", { source: "schedule", window: { start: { value: 1, unit: "day" } }, conditions: [{ flag: "never", eq: true }] }),
    ]);
    const state = makeState(template);
    enqueueScheduled({ state, definitionId: "ev-forever", origin, start: { value: 1, unit: "day" } });
    state.worldTime = 10 ** 9;
    expect(drain(state, template)).toEqual([]);
    expect(state.scheduledEvents[0].status).toBe("waiting");
    expect(state.missedEvents).toHaveLength(0);
  });

  it("#36：窗口内 conditions / cooldown 不满足 ⇒ hold 留队、每轮重估、零错失；now > end 才过期", () => {
    const template = makeTemplate([
      normal("ev-window", {
        source: "schedule",
        window: { start: { value: 1, unit: "day" }, end: { value: 2, unit: "day" } },
        conditions: [{ flag: "ready", eq: true }],
      }),
    ]);
    const state = makeState(template);
    enqueueScheduled({
      state, definitionId: "ev-window", origin,
      start: { value: 1, unit: "day" }, end: { value: 2, unit: "day" },
    });
    state.worldTime = 1440;
    for (let i = 0; i < 3; i++) expect(drain(state, template)).toEqual([]);
    expect(state.scheduledEvents[0].status).toBe("waiting");
    expect(state.missedEvents).toHaveLength(0);

    state.worldTime = 2880; // == end：仍不过期
    expect(drain(state, template)).toEqual([]);
    expect(state.missedEvents).toHaveLength(0);

    state.worldTime = 2881; // > end
    expect(drain(state, template)).toEqual([]);
    expect(state.scheduledEvents[0].status).toBe("expired");
    expect(state.missedEvents).toEqual([
      {
        eventId: "ev-window",
        instanceId: state.scheduledEvents[0].instanceId,
        turnIndex: 0,
        worldTime: 2881,
        reason: "window_expired",
      },
    ]);
  });

  it("冷却未过 ⇒ hold；worldTime 达冷却时长后触发", () => {
    const template = makeTemplate([
      normal("ev-cd", { source: "schedule", window: { start: { value: 1, unit: "day" } }, cooldown: { value: 2, unit: "hour" } }),
    ]);
    const state = makeState(template);
    enqueueScheduled({ state, definitionId: "ev-cd", origin, start: { value: 1, unit: "day" } });
    state.worldTime = 1440;
    state.lastFiredIndex["ev-cd"] = { turnIndex: 0, worldTime: 1400 };
    expect(onCooldown(state, "ev-cd", { value: 2, unit: "hour" })).toBe(true);
    expect(drain(state, template)).toEqual([]);
    expect(state.missedEvents).toHaveLength(0);
    state.worldTime = 1520;
    expect(onCooldown(state, "ev-cd", { value: 2, unit: "hour" })).toBe(false);
    expect(drain(state, template)).toEqual(["ev-cd"]);
  });

  it("evaluateDue 判定顺序固定：missWhen 优先于 conditions 与 cooldown", () => {
    const template = makeTemplate([
      normal("ev-order", {
        source: "schedule", window: { start: { value: 1, unit: "day" } },
        conditions: [{ flag: "ready", eq: false }],
        cooldown: { value: 99, unit: "day" },
        missWhen: [{ flag: "ready", eq: false }],
        missLabel: "顺序优先",
      }),
    ]);
    const state = makeState(template);
    const inst = enqueueScheduled({ state, definitionId: "ev-order", origin, start: { value: 1, unit: "day" } });
    state.flags.ready = false; // conditions 满足；无 missWhen 时会走到 cooldown ⇒ hold
    recordFire(state, "ev-order");
    const decision = evaluateDue({ instance: inst, state, lookup: createLookup(template), rng: createRng(1) });
    expect(decision).toEqual({ kind: "drop", reason: "miss_when", label: "顺序优先" });
  });
});

describe("T1-03 · 确定性、门控与事实层（R-EV-05/07/15、R-LM-03）", () => {
  function buildScenario(): WorldTemplateV2 {
    return makeTemplate([
      normal("ev-a", { source: "schedule", window: { start: { value: 1, unit: "day" } } }),
      normal("ev-b", { source: "schedule", window: { start: { value: 1, unit: "day" } } }),
      normal("ev-expired", {
        source: "schedule", window: { start: { value: 1, unit: "day" }, end: { value: 2, unit: "day" } },
        conditions: [{ flag: "never", eq: true }],
      }),
    ]);
  }

  it("同输入两次运行：出队序列、实例状态、事实记录逐字段一致", () => {
    const run = (): { state: WorldStateV2; fired: string[] } => {
      const template = buildScenario();
      const state = makeState(template);
      for (const id of ["ev-a", "ev-b", "ev-expired"]) {
        enqueueScheduled({
          state, definitionId: id, origin,
          start: { value: 1, unit: "day" },
          ...(id === "ev-expired" ? { end: { value: 2, unit: "day" } } : {}),
        });
      }
      state.worldTime = 2881;
      const fired = drain(state, template);
      // 再推进一次 drain，确认无重复出队
      drain(state, template, fired);
      return { state, fired };
    };
    const first = run();
    const second = run();
    expect(second.fired).toEqual(first.fired);
    expect(second.state.scheduledEvents).toEqual(first.state.scheduledEvents);
    expect(second.state.missedEvents).toEqual(first.state.missedEvents);
    expect(first.fired).toEqual(["ev-a", "ev-b"]);
  });

  it("门控失败（once / probability / pool conditions）不产生实例、不记错失", () => {
    const template = makeTemplate([
      normal("ev-once", { source: "schedule", window: { start: { value: 1, unit: "day" } }, once: true }),
      normal("ev-prob", { source: "schedule", window: { start: { value: 1, unit: "day" } }, probability: 0.2 }),
      normal("ev-pool-cond", { source: "pool", probability: 1, conditions: [{ flag: "ready", eq: true }] }),
    ]);
    const state = makeState(template);
    const lookup = createLookup(template);
    recordFire(state, "ev-once");
    expect(hasFired(state, "ev-once")).toBe(true);

    const rngNever = () => 0.99;
    expect(enqueueCandidate({
      state, definition: lookup.event("ev-once")!, origin, lookup, rng: rngNever,
    })).toBeUndefined();
    expect(enqueueCandidate({
      state, definition: lookup.event("ev-prob")!, origin, lookup, rng: rngNever,
    })).toBeUndefined();
    expect(enqueueCandidate({
      state, definition: lookup.event("ev-pool-cond")!, origin: { kind: "pool", id: "ev-pool-cond" }, lookup, rng: rngNever,
    })).toBeUndefined();
    expect(state.scheduledEvents).toHaveLength(0);
    expect(state.missedEvents).toHaveLength(0);
    expect(state.enqueueSeqCounter).toBe(0);
  });

  it("pool 无窗口默认相对 0 分钟；preGated 不重复扣减 probability 骰", () => {
    const template = makeTemplate([
      normal("ev-pool", { source: "pool", probability: 0.01 }),
    ]);
    const state = makeState(template);
    const lookup = createLookup(template);
    let rolls = 0;
    const rng = () => { rolls += 1; return 0.99; };
    const inst = enqueueCandidate({
      state, definition: lookup.event("ev-pool")!, origin: { kind: "pool", id: "ev-pool" },
      lookup, rng, preGated: true,
    });
    expect(inst?.window.start).toBe(state.worldTime);
    expect(inst?.hasEnd).toBe(false);
    expect(rolls).toBe(0);
    expect(state.scheduledEvents).toHaveLength(1);
  });

  it("pool + combat：加载期拒绝（含替代写法）；抽取期防御不产生实例", () => {
    const template = makeTemplate([]);
    const raw = {
      ...template,
      events: [
        {
          id: "ev-pool-combat", title: "池战斗", narrative: "非法。",
          trigger: { source: "pool", probability: 1 }, kind: "combat",
          settle: { combat: { enemies: [{ ref: "enemy-x" }] } },
        },
      ],
    } as unknown as Record<string, unknown>;
    const parsed = WorldTemplateV2Schema.safeParse(raw);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.message.includes("触发战斗"))).toBe(true);
    }

    const state = makeState(template);
    const def = {
      id: "ev-pool-combat", title: "池战斗", narrative: "非法。",
      trigger: { source: "pool", probability: 1 }, kind: "combat",
      settle: { combat: { enemies: [{ ref: "enemy-x" }] } },
    } as unknown as EventV2;
    expect(enqueueCandidate({
      state, definition: def, origin: { kind: "pool", id: def.id },
      lookup: createLookup(template), rng: () => 0, preGated: true,
    })).toBeUndefined();
    expect(state.scheduledEvents).toHaveLength(0);
  });

  it("recordFire 是唯一写入口：三处索引/日志一次写齐，事实只追加", () => {
    const state = makeState(makeTemplate([]));
    recordFire(state, "ev-x");
    const first = structuredClone(state.eventFires[0]);
    recordFire(state, "ev-x");
    expect(state.eventFires).toHaveLength(2);
    expect(state.eventFires[0]).toEqual(first); // 已写入条目逐字段不变
    expect(state.eventFires[1]).toEqual({ eventId: "ev-x", turnIndex: 0, worldTime: 0 });
    expect(state.lastFiredIndex["ev-x"]).toEqual({ turnIndex: 0, worldTime: 0 });
    expect(state.firedEvents["ev-x"]).toBe(0);
  });
});

describe("T1-03 · 链与延时队列对账（R-EV-10）", () => {
  const chainDef = {
    id: "chain-delay-test",
    startEventId: "ev-step-0",
    steps: [
      { eventId: "ev-step-0", advanceWhen: "onSettle" },
      { eventId: "ev-step-1", advanceWhen: "onSettle", delay: { value: 3, unit: "day" } },
    ],
  } as const;

  it("队列仍有该链 waiting 实例时不得判断链；实例终局且无后续步才 completed", () => {
    const template = makeTemplate(
      [normal("ev-step-0", { source: "chain" }), normal("ev-step-1", { source: "chain" })],
      [chainDef] as unknown as WorldTemplateV2["chains"],
    );
    const state = makeState(template);
    state.chains.push({ id: "chain-delay-test", stepIndex: 0, status: "active", startedTurn: 0 });
    const inst = enqueueScheduled({
      state, definitionId: "ev-step-1", origin, chainId: "chain-delay-test", start: { value: 3, unit: "day" },
    });
    expect(evaluateChain(state, createLookup(template), "chain-delay-test")).toBe("active");
    inst.status = "fired";
    state.chains[0].stepIndex = 2; // 越界且无队列条目
    expect(evaluateChain(state, createLookup(template), "chain-delay-test")).toBe("completed");
  });

  it("alignChainStep 单一规则：advanceChain 与 settle 同时发生不产生 stepIndex 漂移", () => {
    const template = makeTemplate(
      [normal("ev-step-0", { source: "chain" }), normal("ev-step-1", { source: "chain" })],
      [chainDef] as unknown as WorldTemplateV2["chains"],
    );
    const state = makeState(template);
    const lookup = createLookup(template);
    state.chains.push({ id: "chain-delay-test", stepIndex: 0, status: "active", startedTurn: 0 });
    // 效果 advanceChain 无 nextEventId：链内无 nextTurn 步 ⇒ 不动（不盲目 +1）
    alignChainStep(state, "chain-delay-test", lookup);
    expect(state.chains[0].stepIndex).toBe(0);
    // 结算按 nextEventId 对齐，重复调用幂等
    alignChainStep(state, "chain-delay-test", lookup, "ev-step-1");
    alignChainStep(state, "chain-delay-test", lookup, "ev-step-1");
    expect(state.chains[0].stepIndex).toBe(1);
    expect(state.chains[0].status).toBe("active");
    alignChainStep(state, "chain-delay-test", lookup, "ev-unknown");
    expect(state.chains[0].status).toBe("completed");
  });
});

describe("T1-04 · 世界初始化即入队（R-EV-08）", () => {
  it("所有 source: schedule 定义按 window.start 一次性换算为绝对分钟实例", () => {
    const template = makeTemplate([
      normal("ev-day1", { source: "schedule", window: { start: { value: 1, unit: "day" } } }),
      normal("ev-day2", {
        source: "schedule",
        window: { start: { value: 2, unit: "day" }, end: { value: 3, unit: "day" } },
      }),
      normal("ev-pool", { source: "pool", probability: 1 }),
    ]);
    const state = createWorldV2({ templateId: "t", playerName: "测试者", seed: 1 }, template, "w-init");
    expect(state.scheduledEvents).toHaveLength(2);
    expect(state.scheduledEvents.map((i) => i.definitionId)).toEqual(["ev-day1", "ev-day2"]);
    expect(state.scheduledEvents.map((i) => i.origin.kind)).toEqual(["schedule-init", "schedule-init"]);
    expect(state.scheduledEvents[0].window).toEqual({ start: 1440 });
    expect(state.scheduledEvents[0].hasEnd).toBe(false);
    expect(state.scheduledEvents[1].window).toEqual({ start: 2880, end: 4320 });
    expect(state.scheduledEvents[1].hasEnd).toBe(true);
    expect(state.enqueueSeqCounter).toBe(2);
    expectNoConfigSnapshot(state.scheduledEvents);
  });
});

/** 供其它测试复用的断言辅助：确认实例里没有配置域字段副本。 */
export function expectNoConfigSnapshot(instances: readonly ScheduledEventInstance[]): void {
  const forbidden = ["probability", "weight", "once", "priority", "conditions", "onActionId"];
  for (const inst of instances) {
    for (const key of forbidden) expect(Object.keys(inst)).not.toContain(key);
  }
}

describe("R2.6 · TimeSpec 字面量与历法换算（ADR-0013）", () => {
  it("字符串字面量无适配器抛错；有适配器时复合时长按入队时刻顺延", () => {
    expect(() => resolveTimeSpec("2h30m", 100)).toThrow(/历法适配器/);
    const approx = createTimeAdapter(makeTemplate([]));
    expect(resolveTimeSpec("2h30m", 100, approx)).toBe(250);
    expect(resolveTimeSpec("3d", 1000, approx)).toBe(1000 + 4320);
  });

  it("year/month 经适配器换算：gregorian 1 月 = 31 天 ≠ approx 30 天兜底", () => {
    const tpl = makeTemplate([]);
    tpl.time = { ...tpl.time, calendar: { preset: "gregorian" } };
    const greg = createTimeAdapter(tpl);
    expect(resolveTimeSpec({ value: 1, unit: "month" }, 0, greg)).toBe(31 * 1440);
    expect(resolveTimeSpec({ value: 1, unit: "month" }, 0)).toBe(30 * 1440); // 无适配器 = approx
    // 日历无关单位不经过月长
    expect(resolveTimeSpec({ value: 1, unit: "day" }, 100, greg)).toBe(100 + 1440);
  });

  it("历法日期字面量解析为绝对世界分钟，与 now 无关；越界日期抛错", () => {
    const tpl = makeTemplate([]);
    tpl.time = { ...tpl.time, calendar: { preset: "gregorian" } };
    const greg = createTimeAdapter(tpl);
    expect(resolveTimeSpec("2000-01-02", 999999, greg)).toBe(1440);
    expect(resolveTimeSpec("2000-03-02", 0, greg)).toBe(61 * 1440); // 31+29+1
    expect(() => resolveTimeSpec("2000-13-01", 0, greg)).toThrow(/越界/);
  });

  it("specToMinutes / enqueueScheduled 支持字符串 spec（冷却、延时、窗口）", () => {
    const approx = createTimeAdapter(makeTemplate([]));
    expect(specToMinutes("1d", approx)).toBe(1440);
    expect(specToMinutes("90m", approx)).toBe(90);
    const state = makeState(makeTemplate([]));
    const inst = enqueueScheduled({
      state,
      definitionId: "e-lit",
      origin,
      start: "3d",
      end: "1w",
      calendar: approx,
    });
    expect(inst.window).toEqual({ start: 3 * 1440, end: 10080 });
    expect(inst.hasEnd).toBe(true);
  });

  it("onCooldown 支持字符串冷却字面量（经适配器换算）", () => {
    const approx = createTimeAdapter(makeTemplate([]));
    const state = makeState(makeTemplate([]));
    recordFire(state, "ev-cd");
    state.eventFires[0].worldTime = state.worldTime;
    expect(onCooldown(state, "ev-cd", "2d", approx)).toBe(true); // 刚触发过
    state.worldTime = 2 * 1440 + 1;
    expect(onCooldown(state, "ev-cd", "2d", approx)).toBe(false); // 冷却已过
  });
});
