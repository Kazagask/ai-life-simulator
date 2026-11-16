import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "yaml";
import { WorldTemplateV2Schema, type WorldStateV2, type WorldTemplateV2 } from "@life-sim/shared";

import { createActiveWorldV2 } from "./v2/test-utils.js";
import { createLookup } from "./v2/lookup.js";
import { RpgEngineAPI } from "./api/engine-api.js";
import { checkEventPremise, enqueueScheduled, scanDelayQueue } from "./v2/scheduler.js";
import { createConditionRegistry } from "./v2/condition-evaluator.js";
import { createRng } from "./rng.js";

/**
 * 诈尸的**结构防线**：`actors` 声明 + 呈现前活性复核。
 *
 * 背景（2026-11-16 用户验收时发现）：`story.submitBranch` 的入参里有 `actors`，
 * 但编译时**根本没被读** ⇒ 判活是空的。设计文档里写了、实现里没有，属于"承诺了没做"。
 *
 * 这条防线为什么不能交给作者写 `missWhen`：
 * 生成分支写这一幕时 NPC 还活着，几轮之后可能已经死了，作者根本不知道未来会死谁。
 * 所以判据必须是引擎在**出队那一刻**按权威状态复核。
 */

const VERSION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../specs/data/templates/demo-agentic/1.0.0",
);

const MERGE_FILES = [
  "world.yaml",
  "characters.yaml",
  "skills.yaml",
  "items.yaml",
  "statuses.yaml",
  "events.yaml",
  "equipment.yaml",
  "combat-ai.yaml",
] as const;

function loadDemoTemplate(): WorldTemplateV2 {
  const merged: Record<string, unknown> = {};
  for (const file of MERGE_FILES) {
    const abs = path.join(VERSION_DIR, file);
    if (!existsSync(abs)) continue;
    const doc = parse(readFileSync(abs, "utf8")) as Record<string, unknown> | null;
    if (doc === null || typeof doc !== "object") continue;
    for (const [key, value] of Object.entries(doc)) {
      if (key === "meta") merged.meta = value;
      else if (merged[key] === undefined) merged[key] = value;
      else if (Array.isArray(merged[key]) && Array.isArray(value)) {
        merged[key] = [...(merged[key] as unknown[]), ...value];
      }
    }
  }
  return WorldTemplateV2Schema.parse(merged);
}

function freshWorld(seed = 7) {
  const template = loadDemoTemplate();
  const lookup = createLookup(template);
  const state = createActiveWorldV2(
    { templateId: "demo-agentic", playerName: "判活", seed },
    template,
    `al-${seed}`,
  );
  state.worldTime = 1440;
  return { template, lookup, state };
}

/** 通过真工具提交一条声明了 actors 的分支（验编译，不是手搓事件）。 */
function submitBranchWithActors(state: WorldStateV2, actors: string[]) {
  const api = new RpgEngineAPI({
    state,
    perspective: "world",
    targetPerspective: "player",
    lookupRefs: new Set(["evt:awaken"]),
    conditionRegistry: createConditionRegistry(),
  });
  return api.dispatch(
    [
      {
        callId: "c-1",
        tool: "story.submitBranch",
        args: {
          trigger: { mode: "certain" },
          branch: [
            {
              node: "s1",
              title: "桥影",
              text: "桥下的水声盖住了脚步。",
              actors,
              options: [{ text: "继续走" }],
            },
          ],
        },
      },
    ],
    {
      turnIndex: state.turnIndex,
      worldTime: state.worldTime,
      invocationId: "inv-actors",
      perspective: "world",
      targetPerspective: "player",
    },
  );
}

describe("actors 判活（诈尸的结构防线）", () => {
  it("编译：submitBranch 的 actors 逐字落进事件定义", () => {
    const { state } = freshWorld();
    const result = submitBranchWithActors(state, ["npc-mentor"]);
    expect(result.receipts[0]!.outcome).toBe("accepted");
    const event = state.generatedEvents?.[0];
    expect(event?.actors).toEqual(["npc-mentor"]);
    // 入口节点按 certain 编译成 schedule，参与调度
    expect(event?.trigger.source).toBe("schedule");
  });

  it("判活：角色还活着 ⇒ 前提成立", () => {
    const { lookup, state } = freshWorld();
    const mentor = state.npcs.find((n) => n.id === "npc-mentor");
    expect(mentor).toBeDefined();
    mentor!.lifecycle = { ...mentor!.lifecycle, state: "alive" };

    const def = {
      id: "gen:test:alive",
      title: "在场",
      narrative: "他站在门口。",
      kind: "normal" as const,
      actors: ["npc-mentor"],
      trigger: { source: "schedule" as const, window: { start: { value: 1, unit: "minute" as const } } },
      settle: { normal: { options: [{ id: "o1", text: "上前" }] } },
    };
    const verdict = checkEventPremise(def, {
      state,
      lookup: lookup.withGenerated([def]),
      rng: createRng(1),
    });
    expect(verdict.ok).toBe(true);
  });

  it("判活：角色已死 ⇒ 前提不成立且标 missWhen（留痕，不静默丢弃）", () => {
    const { lookup, state } = freshWorld();
    const mentor = state.npcs.find((n) => n.id === "npc-mentor")!;
    mentor.lifecycle = { ...mentor.lifecycle, state: "dead" };

    const def = {
      id: "gen:test:dead",
      title: "不在场",
      narrative: "他站在门口。",
      kind: "normal" as const,
      actors: ["npc-mentor"],
      trigger: { source: "schedule" as const, window: { start: { value: 1, unit: "minute" as const } } },
      settle: { normal: { options: [{ id: "o1", text: "上前" }] } },
    };
    const verdict = checkEventPremise(def, {
      state,
      lookup: lookup.withGenerated([def]),
      rng: createRng(1),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false ? verdict.missWhen : undefined).toBe(true);
    expect(verdict.ok === false ? verdict.label : "").toContain("npc-mentor");
  });

  it("判活：未知角色 id ⇒ 视为不在场（宁可不演，也不让不存在的人进正文）", () => {
    const { lookup, state } = freshWorld();
    const def = {
      id: "gen:test:ghost",
      title: "幽灵",
      narrative: "空气里有人笑了一声。",
      kind: "normal" as const,
      actors: ["npc-does-not-exist"],
      trigger: { source: "schedule" as const, window: { start: { value: 1, unit: "minute" as const } } },
      settle: { normal: { options: [{ id: "o1", text: "看过去" }] } },
    };
    const verdict = checkEventPremise(def, {
      state,
      lookup: lookup.withGenerated([def]),
      rng: createRng(1),
    });
    expect(verdict.ok).toBe(false);
  });

  it("集成：出队时角色已死 ⇒ 进 missedEvents、不占槽", () => {
    const { lookup, state } = freshWorld();
    const result = submitBranchWithActors(state, ["npc-mentor"]);
    expect(result.receipts[0]!.outcome).toBe("accepted");
    const generatedId = state.generatedEvents![0]!.id;
    const lookupWithGen = lookup.withGenerated(state.generatedEvents);

    // 角色在"被写进这一场"之后死了 —— 正是诈尸的形状。
    const mentor = state.npcs.find((n) => n.id === "npc-mentor")!;
    mentor.lifecycle = { ...mentor.lifecycle, state: "dead" };

    enqueueScheduled({
      state,
      definitionId: generatedId,
      origin: { kind: "generated", id: generatedId },
      absoluteStart: state.worldTime,
    });

    const scanned = scanDelayQueue(state, lookupWithGen, createRng(3));
    expect(state.slot).toBeNull();
    expect(scanned.activated ?? []).toHaveLength(0);
    const missed = state.missedEvents.filter((m) => m.eventId === generatedId);
    expect(missed.length).toBeGreaterThanOrEqual(1);
    expect(missed[0]!.reason).toBe("miss_when");
  });

  it("回归：不声明 actors 的事件不受影响（模板事件零变化）", () => {
    const { lookup, state } = freshWorld();
    const def = lookup.event("evt:awaken");
    expect(def).toBeDefined();
    expect(def!.actors).toBeUndefined();
    const verdict = checkEventPremise(def!, { state, lookup, rng: createRng(5) });
    expect(verdict.ok).toBe(true);
  });
});
