import { describe, expect, it } from "vitest";
import type { WorldStateV2 } from "@life-sim/shared";
import {
  conflictText,
  mergeSaves,
  saveConflict,
  statusOf,
  type CloudSaveSummary,
  type SaveSummary,
} from "../../apps/web/src/local/saveList.ts";

/**
 * 存档列表合并 / 冲突判据（2026-11-22 用户裁决）。
 *
 * 这里守的是**口径**，不是 UI：
 * - 本地为准；
 * - 只比 `turnIndex`（数据库一等字段），不解 payload；
 * - 两边都有且轮次不同才算冲突。
 */

const local = (worldId: string, turnIndex: number, savedAt = "2026-11-22T10:00:00.000Z"): SaveSummary => ({
  worldId,
  playerName: "七海",
  worldName: "咒术回战",
  turnIndex,
  savedAt,
  status: "running",
});

const cloud = (worldId: string, turnIndex: number, savedAt = "2026-11-22T11:00:00.000Z"): CloudSaveSummary => ({
  ...local(worldId, turnIndex, savedAt),
  templateId: "jjk-2006",
  templateVersion: "3.0.0",
  fingerprint: "sha256:x",
  sizeBytes: 2048,
  updatedAt: savedAt,
});

describe("存档列表 · 合并", () => {
  it("本地独有 / 云端独有 / 两边都有都出现一次", () => {
    const entries = mergeSaves([local("a", 3), local("b", 5)], [cloud("b", 5), cloud("c", 9)]);
    expect(entries.map((e) => e.worldId).sort()).toEqual(["a", "b", "c"]);
    expect(entries.find((e) => e.worldId === "a")?.cloud).toBeNull();
    expect(entries.find((e) => e.worldId === "c")?.local).toBeNull();
  });

  it("两边都有时以本地为准（名字 / 轮次 / 状态）", () => {
    const entries = mergeSaves([local("b", 5)], [cloud("b", 7)]);
    const entry = entries[0]!;
    expect(entry.turnIndex).toBe(5);
    expect(entry.playerName).toBe("七海");
    expect(entry.local?.turnIndex).toBe(5);
    expect(entry.cloud?.turnIndex).toBe(7);
  });

  it("按较晚的 savedAt 倒序（云上更新的档不该沉底）", () => {
    const entries = mergeSaves(
      [local("old", 1, "2026-11-20T00:00:00.000Z")],
      [cloud("new", 2, "2026-11-22T00:00:00.000Z")],
    );
    expect(entries.map((e) => e.worldId)).toEqual(["new", "old"]);
  });
});

describe("存档列表 · 冲突", () => {
  it("两边都有且轮次不同 ⇒ 冲突，带两个数字", () => {
    const entry = mergeSaves([local("b", 5)], [cloud("b", 7)])[0]!;
    expect(saveConflict(entry)).toEqual({ localTurn: 5, cloudTurn: 7 });
  });

  it("轮次相同 ⇒ 视为已同步（不拿哈希逼用户选）", () => {
    const entry = mergeSaves([local("b", 5)], [cloud("b", 5)])[0]!;
    expect(saveConflict(entry)).toBeNull();
  });

  it("只有一边 ⇒ 不是冲突", () => {
    expect(saveConflict(mergeSaves([local("a", 1)], [])[0]!)).toBeNull();
    expect(saveConflict(mergeSaves([], [cloud("c", 9)])[0]!)).toBeNull();
  });

  it("提示文案是唯一实现（数字来自数据库列）", () => {
    expect(conflictText({ localTurn: 3, cloudTurn: 8 })).toBe(
      "本地与云存档不一致，本地 3 轮，云 8 轮。",
    );
  });
});

describe("存档状态", () => {
  it("archived 优先，其次是 termination", () => {
    expect(statusOf({ archived: true, termination: { id: "x" } } as unknown as WorldStateV2)).toBe("archived");
    expect(statusOf({ archived: false, termination: { id: "x" } } as unknown as WorldStateV2)).toBe("terminated");
    expect(statusOf({ archived: false, termination: null } as unknown as WorldStateV2)).toBe("running");
  });
});
