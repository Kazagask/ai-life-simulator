import { describe, expect, it } from "vitest";
import {
  createWorldV2,
  presentNewlyGeneratedV2,
  RpgEngineAPI,
  type WorldStateV2,
} from "@life-sim/game-core";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function newWorld(seed = 31) {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  const state = createWorldV2(
    { templateId: "jjk-2006", playerName: "测试", seed },
    entry.template,
    `w-branch-${seed}`,
  );
  state.openingCompleted = true;
  state.slot = null;
  return { state, entry };
}

function submit(state: WorldStateV2, entry: ReturnType<typeof newWorld>["entry"], args: unknown) {
  const api = new RpgEngineAPI({ state, lookup: entry.lookup.withGenerated(state.generatedEvents) });
  return api.dispatch([{ callId: "c-branch", tool: "story.submitBranch", args: args as never }], {
    turnIndex: state.turnIndex,
    worldTime: state.worldTime,
    perspective: "player",
    targetPerspective: "player",
    // 事件 id 前缀用的是 invocationId（生产路径由 gateway 注入）。
    invocationId: "c-branch",
  });
}

const branchOf = (effects: unknown[] | undefined, after?: { value: number; unit: string }) => ({
  trigger: { mode: "certain", ...(after !== undefined ? { after } : {}) },
  branch: [
    {
      node: "n1",
      title: "门口的人",
      text: "门口站着一个人，他没有敲门。",
      options: [
        { text: "开门", ...(effects !== undefined ? { effects } : {}) },
        { text: "不理他", effects: [{ mood: -1 }] },
      ],
    },
  ],
});

describe("LLM 提交的分支：选项效果与上桌时机（2026-11-21）", () => {
  it("选项写了空 effects ⇒ 整条被拒（玩家点下去不能什么都不发生）", () => {
    const { state, entry } = newWorld();
    const result = submit(state, entry, branchOf([]));
    expect(result.receipts[0]?.outcome).toBe("rejected");
    expect(result.receipts[0]?.code).toBe("invalid_arguments");
    expect(state.generatedEvents ?? []).toHaveLength(0);
  });

  it("省略 after ⇒ 编译成「没有窗口」，而不是 1 分钟", () => {
    const { state, entry } = newWorld();
    const result = submit(state, entry, branchOf([{ mood: 1 }]));
    expect(result.receipts[0]?.outcome).toBe("accepted");
    const def = state.generatedEvents![0]!;
    expect(def.trigger.source).toBe("schedule");
    expect(def.trigger.window?.start).toBeUndefined();
  });

  it("提交完当轮就能上桌（槽空）：presentNewlyGeneratedV2 把它摆进 slot", () => {
    const { state, entry } = newWorld();
    const result = submit(state, entry, branchOf([{ mood: 1 }]));
    expect(result.receipts[0]?.outcome).toBe("accepted");

    const presented = presentNewlyGeneratedV2(
      state,
      entry.template,
      entry.lookup.withGenerated(state.generatedEvents),
    );
    expect(state.slot?.eventId).toBe("gen:c-branch:n1");
    expect(presented.triggered.map((t) => t.id)).toEqual(["gen:c-branch:n1"]);
  });

  it("槽已被占 ⇒ 不抢位，留在队列里等下一位", () => {
    const { state, entry } = newWorld();
    state.slot = { eventId: "ev-open-01", from: "queueTake", instanceId: "evi-0" };
    const result = submit(state, entry, branchOf([{ mood: 1 }]));
    expect(result.receipts[0]?.outcome).toBe("accepted");

    presentNewlyGeneratedV2(state, entry.template, entry.lookup.withGenerated(state.generatedEvents));
    expect(state.slot?.eventId).toBe("ev-open-01");
    expect(state.delayQueue.some((item) => item.definitionId === "gen:c-branch:n1")).toBe(true);
  });
});
