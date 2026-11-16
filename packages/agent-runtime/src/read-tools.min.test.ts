import { describe, expect, it } from "vitest";
import type { V2Snapshot, WorldStateV2 } from "@life-sim/shared";

import { runReadTool } from "./read-tools.js";

/**
 * 只读工具的**视角分流**（2026-11-16 用户裁决：GM 是全知的，视角通过传参实现）。
 *
 * 规则：
 * - 视角来自 `invocation.perspective`（模板 `invoke.perspective` 声明），
 *   **不是工具参数** —— 模型看不见这个字段，也就无法自己提权。
 * - `player` ⇒ 只读投影后的快照（看不见 hidden）；
 * - `world`  ⇒ 直读权威状态（含 NPC 隐秘 id、hidden 章节节点）。
 */

const npc = (over: Record<string, unknown>) => ({
  id: "npc-mentor",
  name: "引路人",
  lifecycle: { state: "alive" },
  secrets: ["secret:mentor-plan"],
  goals: ["带主角入门"],
  ...over,
});

const state = {
  history: [
    { turnIndex: 1, formattedTime: "第1天", type: "event", summary: "苏醒" },
    { turnIndex: 2, formattedTime: "第2天", type: "event", summary: "初次试炼" },
  ],
  npcs: [npc({}), npc({ id: "npc-hidden", name: "未登场者", lifecycle: { state: "unspawned" } })],
  taskDag: {
    nodes: [
      { id: "n1", title: "苏醒", status: "completed", visibility: "public" },
      { id: "n3", title: "未公开的线索", status: "draft", visibility: "hidden" },
    ],
  },
} as unknown as WorldStateV2;

/** player 窗口快照：只含已登场 NPC 与 public 节点 —— 与真实投影同口径。 */
const snapshot = {
  turnIndex: 3,
  worldTime: 30,
  formattedTime: "第3天",
  status: "running",
  lifeStageLabel: "青年",
  storyChapter: 1,
  slotEvent: null,
  npcs: [
    {
      id: "npc-mentor",
      name: "引路人",
      lifecycle: { state: "alive" },
      relationship: 8,
      knownGoals: ["带主角入门"],
      statuses: [],
    },
  ],
  player: {
    name: "悟",
    age: 18,
    hp: 100,
    maxHp: 100,
    mp: 50,
    maxMp: 50,
    mood: 50,
    attributes: { body: 5 },
    statuses: [],
    skills: [],
    inventory: [],
    equipment: [],
  },
} as unknown as V2Snapshot;

describe("只读工具：视角由 invocation 决定，不由参数决定", () => {
  it("player 视角：clues 只出 public 节点", () => {
    const out = runReadTool("world.clues", {}, { snapshot, state, perspective: "player" }) as {
      nodes: Array<{ id: string }>;
    };
    expect(out.nodes.map((n) => n.id)).toEqual(["n1"]);
  });

  it("world 视角：clues 出 hidden 节点并带 visibility", () => {
    const out = runReadTool("world.clues", {}, { snapshot, state, perspective: "world" }) as {
      nodes: Array<{ id: string; visibility?: string }>;
    };
    expect(out.nodes.map((n) => n.id)).toEqual(["n1", "n3"]);
    expect(out.nodes.find((n) => n.id === "n3")?.visibility).toBe("hidden");
  });

  it("player 视角：present 只出快照里已登场的 NPC", () => {
    const out = runReadTool("world.present", {}, { snapshot, state, perspective: "player" }) as {
      npcs: Array<{ id: string }>;
    };
    expect(out.npcs.map((n) => n.id)).toEqual(["npc-mentor"]);
  });

  it("world 视角：present 出全量（含未登场）+ 隐秘 id", () => {
    const out = runReadTool("world.present", {}, { snapshot, state, perspective: "world" }) as {
      npcs: Array<{ id: string; lifecycle?: string; secrets?: string[] }>;
    };
    expect(out.npcs.map((n) => n.id)).toEqual(["npc-mentor", "npc-hidden"]);
    expect(out.npcs[0]!.secrets).toEqual(["secret:mentor-plan"]);
    expect(out.npcs[1]!.lifecycle).toBe("unspawned");
  });

  it("视角不随参数变化：传一个假的 perspective 参数也无效", () => {
    // 模型可能胡乱塞一个 perspective 字段；工具应当无视它（视角是唤起时固定的）。
    const out = runReadTool(
      "world.clues",
      { perspective: "world" },
      { snapshot, state, perspective: "player" },
    ) as { nodes: Array<{ id: string }> };
    expect(out.nodes.map((n) => n.id)).toEqual(["n1"]);
  });

  it("history：两个视角一致（历史本身不是隐秘信息）", () => {
    const a = runReadTool("world.history", { limit: 1 }, { snapshot, state, perspective: "player" });
    const b = runReadTool("world.history", { limit: 1 }, { snapshot, state, perspective: "world" });
    expect(a).toEqual(b);
  });
});
