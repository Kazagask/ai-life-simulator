import { describe, expect, it } from "vitest";
import type { EventV2, WorldTemplateV2 } from "@life-sim/shared";
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
