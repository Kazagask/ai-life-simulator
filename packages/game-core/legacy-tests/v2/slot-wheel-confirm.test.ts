import { describe, expect, it } from "vitest";
import type { EventV2, WorldTemplateV2 } from "@life-sim/shared";
import { projectSnapshotV2 } from "./projection.js";
import { createLookup, type TemplateLookup } from "./lookup.js";
import { createActiveWorldV2, makeTestTemplate } from "./test-utils.js";
import { advanceTurnV2, slotEventView } from "./turn.js";
import { enqueueScheduled } from "./scheduler.js";

/**
 * ADR-0034 §8-⑩：`random` 槽的**呈现 / 确认分离**。
 *
 * 三个必须钉住的性质（架构侧 P0 复核发现过第一条的实现缺陷）：
 * 1. **确认按"呈现的那一格"结算**，不是恒取 `segments[0]`；
 * 2. **幂等**：同一个 random 槽重复提交只结算一次（第二次走"槽空"分支，不重复掷骰/落账）；
 * 3. **投影可区分**：`slotEvent.kind === "random"` 且带 `wheel`，前端据此把"继续"解释为确认。
 */

/** 两段权重悬殊的转盘：99 : 1 ⇒ 几乎必然命中第二段（用来证明"不是恒取 segments[0]"）。 */
function makeWheelTemplate(): WorldTemplateV2 {
  const template = makeTestTemplate();
  template.events = template.events.filter((e) => e.trigger.source !== "pool");
  template.events.push({
    id: "ev-wheel-x",
    title: "抽签",
    narrative: "命运转盘。",
    trigger: { source: "chain" },
    kind: "random",
    settle: {
      random: {
        wheel: {
          segments: [
            { weight: 1, label: "上签", effects: [{ type: "setFlag", id: "wheelPick", value: "上" }] },
            { weight: 99, label: "下签", effects: [{ type: "setFlag", id: "wheelPick", value: "下" }] },
          ],
        },
      },
    },
  } as EventV2);
  return template;
}

function setup(worldId: string): { template: WorldTemplateV2; lookup: TemplateLookup; state: any } {
  const template = makeWheelTemplate();
  const lookup = createLookup(template);
  const state = createActiveWorldV2({ templateId: "test", playerName: "测试者", seed: 3 }, template, worldId);
  // 按真实路径造场景：把转盘以 delay 0 入队，交给第一次 `advanceTurnV2` 的 `nextTurn` 取出呈现。
  // （直接写 `state.slot` 会跳过"呈现"这一步，第一次调用就变成"确认"——那就测不到呈现/确认分离了。）
  enqueueScheduled({
    state,
    definitionId: "ev-wheel-x",
    origin: { kind: "pool", id: "ev-wheel-x" },
    start: { value: 0, unit: "minute" },
  });
  return { template, lookup, state };
}

describe("ADR-0034 §8-⑪ · 槽实例 id 与失效留痕", () => {
  /** 带条件的事件：条件是 `flag allow=true`，便于把前提弄假。 */
  function makeConditional(): WorldTemplateV2 {
    const template = makeWheelTemplate();
    template.events.push({
      id: "ev-cond",
      title: "条件事件",
      narrative: "有条件。",
      trigger: { source: "chain", conditions: [{ flag: "allow", eq: true }] },
      kind: "normal",
      settle: { normal: { options: [{ id: "opt-cond", text: "继续" }] } },
    } as EventV2);
    return template;
  }

  function atSlot(worldId: string) {
    const template = makeConditional();
    const lookup = createLookup(template);
    const state = createActiveWorldV2({ templateId: "test", playerName: "测试者", seed: 5 }, template, worldId);
    state.flags.allow = true;
    enqueueScheduled({
      state,
      definitionId: "ev-cond",
      origin: { kind: "pool", id: "ev-cond" },
      start: { value: 0, unit: "minute" },
    });
    advanceTurnV2(state, { action: { type: "rest" } }, template, lookup); // 取出 → 占槽
    return { template, lookup, state };
  }

  it("queueTake 占槽时带上实例 id；successor/hook 等来源不造 id", () => {
    const { state } = atSlot("w-instance-queue-take");
    expect(state.slot?.from).toBe("queueTake");
    expect(typeof state.slot?.instanceId).toBe("string");
  });

  it("实例 id 不进投影（§8-⑥ 反作弊）：snapshot 序列化后不含该值", () => {
    const { template, lookup, state } = atSlot("w-instance-projection");
    const instId = state.slot?.instanceId;
    expect(typeof instId).toBe("string");
    const snapshot = projectSnapshotV2(state, template, lookup);
    expect(snapshot.slotEvent?.eventId).toBe("ev-cond");
    expect(JSON.stringify(snapshot)).not.toContain(instId as string);
  });

  it("槽前提失效且带实例 id ⇒ 写 missedEvents（复用既有 miss_when）；清槽后可自由行动", () => {
    const { template, lookup, state } = atSlot("w-instance-missed");
    const instId = state.slot?.instanceId;
    state.flags.allow = false; // 前提失效
    const t0 = state.turnIndex;
    expect(() => advanceTurnV2(state, { action: { type: "rest" } }, template, lookup)).not.toThrow();
    expect(state.slot).toBeNull();
    expect(state.turnIndex).toBe(t0 + 1);
    const miss = state.missedEvents.find((m: any) => m.eventId === "ev-cond");
    expect(miss?.instanceId).toBe(instId);
    expect(miss?.reason).toBe("miss_when");
  });

  it("槽前提失效但没有实例 id（successor 来源）⇒ 不写 missedEvents、不造 id", () => {
    const { template, lookup, state } = atSlot("w-instance-no-id");
    // 改造成 successor 来源（模拟"上一步的后继"）：去掉实例 id
    state.slot = { eventId: "ev-cond", from: "successor", fromEventId: "ev-prev" };
    state.flags.allow = false;
    const before = state.missedEvents.length;
    expect(() => advanceTurnV2(state, { action: { type: "rest" } }, template, lookup)).not.toThrow();
    expect(state.slot).toBeNull();
    expect(state.missedEvents.length).toBe(before); // 退化进非持久化 droppedPending，属预期
  });
});

describe("ADR-0034 §8-⑩ · random 槽：呈现 / 确认分离", () => {
  it("投影给出 kind=random + 已掷出的那一格（前端据此把「继续」解释为确认）", () => {
    const { lookup, state } = setup("w-wheel-present");
    advanceTurnV2(state, { action: { type: "rest" } }, makeWheelTemplate(), lookup); // 先让 nextTurn 呈现一次
    const view = slotEventView(state, lookup);
    expect(view?.kind).toBe("random");
    expect(view?.eventId).toBe("ev-wheel-x");
    expect(view?.wheel).toBeDefined();
    expect(view?.options).toBeUndefined();
  });

  it("确认按「呈现的那一格」结算：权重 99 的第二段命中时写 wheelPick=下（不是 segments[0] 的上）", () => {
    const { template, lookup, state } = setup("w-wheel-confirm");
    advanceTurnV2(state, { action: { type: "rest" } }, template, lookup); // 呈现（掷骰、未结算）
    const shownLabel = state.lastWheel?.label;
    expect(shownLabel).toBeDefined();
    expect(state.flags.wheelPick).toBeUndefined(); // 呈现不等于结算
    const t0 = state.turnIndex;

    const res = advanceTurnV2(state, { action: { type: "rest" } }, template, lookup); // 确认
    expect(state.turnIndex).toBe(t0 + 1); // 确认算一轮
    const expected = shownLabel === "下签" ? "下" : "上";
    expect(state.flags.wheelPick).toBe(expected);
    // 确认轮要把"这一格是什么"回填给前端
    expect(res.wheelResult?.eventId).toBe("ev-wheel-x");
  });

  it("找不到「呈现的那一格」时抛可诊断错误，不退化成 segments[0]", () => {
    const { template, lookup, state } = setup("w-wheel-no-present");
    // 人为破坏呈现态：槽里是 random，但既无 lastWheels 也无 lastWheel
    state.slot = { eventId: "ev-wheel-x", from: "successor", fromEventId: "ev-x" };
    state.lastWheels = [];
    state.lastWheel = null;
    expect(() => advanceTurnV2(state, { action: { type: "rest" } }, template, lookup)).toThrow(
      /wheel_confirm_without_presentation/,
    );
  });

  it("幂等：同一 random 槽第二次提交不再结算（走槽空分支，不重复记火/重复落账）", () => {
    const { template, lookup, state } = setup("w-wheel-idempotent");
    advanceTurnV2(state, { action: { type: "rest" } }, template, lookup); // 呈现
    advanceTurnV2(state, { action: { type: "rest" } }, template, lookup); // 确认
    const firesAfterConfirm = state.eventFires.filter((f: any) => f.eventId === "ev-wheel-x").length;
    expect(firesAfterConfirm).toBe(1);
    expect(state.slot?.eventId).not.toBe("ev-wheel-x"); // 槽已让出

    const t1 = state.turnIndex;
    advanceTurnV2(state, { action: { type: "rest" } }, template, lookup); // 第三次：普通自由行动
    expect(state.turnIndex).toBe(t1 + 1);
    // 不得重复掷骰 / 重复记火
    expect(state.eventFires.filter((f: any) => f.eventId === "ev-wheel-x").length).toBe(1);
  });
});
