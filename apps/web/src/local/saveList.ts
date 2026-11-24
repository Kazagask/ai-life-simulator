import type { WorldStateV2 } from "@life-sim/shared";

/**
 * 存档列表的合并与冲突判据（纯函数，UI 与单测共用）。
 *
 * 三条口径（用户 2026-11-22 裁决）：
 * 1. **本地为准**：两边都有时，显示用的轮次/名字取本地。
 * 2. **只比一等字段**：冲突判据是 `turnIndex`（数据库列），不解 payload、不算哈希。
 * 3. **不替用户裁决**：轮次不同就报冲突，选哪边由玩家点。
 */

export type SaveStatus = "running" | "terminated" | "archived";

/** 本地 / 云端共用的最小展示形状（都来自已投影的元数据，不含正文）。 */
export interface SaveSummary {
  worldId: string;
  playerName: string;
  worldName: string;
  turnIndex: number;
  savedAt: string;
  status: SaveStatus;
}

export interface CloudSaveSummary extends SaveSummary {
  templateId: string;
  templateVersion: string;
  fingerprint: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface SaveEntry extends SaveSummary {
  local: SaveSummary | null;
  cloud: CloudSaveSummary | null;
}

/** 世界状态 → 存档状态（与服务端 `WorldSummary.status` 同口径）。 */
export function statusOf(state: WorldStateV2): SaveStatus {
  if (state.archived === true) return "archived";
  return state.termination !== null ? "terminated" : "running";
}

function byId<T extends SaveSummary>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.worldId, row]));
}

/**
 * 合并本地与云端的存档索引。
 *
 * 只做并集与排序，**不做任何"该用哪边"的判断** —— 那是 `saveConflict` 与玩家的活。
 * 排序用两边的较晚时间：云上更新的档不该沉到底部。
 */
export function mergeSaves(
  local: readonly SaveSummary[],
  cloud: readonly CloudSaveSummary[],
): SaveEntry[] {
  const localById = byId(local);
  const cloudById = byId(cloud);
  const ids = new Set([...localById.keys(), ...cloudById.keys()]);
  const entries: SaveEntry[] = [];

  for (const worldId of ids) {
    const l = localById.get(worldId) ?? null;
    const c = cloudById.get(worldId) ?? null;
    const primary = l ?? c;
    if (primary === null) continue;
    const savedAt = l !== null && c !== null && c.savedAt > l.savedAt ? c.savedAt : primary.savedAt;
    entries.push({
      worldId,
      playerName: l?.playerName ?? c?.playerName ?? "",
      worldName: l?.worldName ?? c?.worldName ?? "",
      turnIndex: l?.turnIndex ?? c?.turnIndex ?? 0,
      savedAt,
      status: l?.status ?? c?.status ?? "running",
      local: l,
      cloud: c,
    });
  }

  return entries.sort((a, b) =>
    a.savedAt === b.savedAt ? a.worldId.localeCompare(b.worldId) : a.savedAt < b.savedAt ? 1 : -1,
  );
}

/**
 * 冲突：两边都有、且轮次不同。
 *
 * 相同轮次视为已同步 —— 即使用户在本地改过别的字段，也不拿哈希去逼他选：
 * 轮次是用户能理解、数据库能直接比的唯一口径。
 */
export function saveConflict(entry: SaveEntry): { localTurn: number; cloudTurn: number } | null {
  if (entry.local === null || entry.cloud === null) return null;
  if (entry.local.turnIndex === entry.cloud.turnIndex) return null;
  return { localTurn: entry.local.turnIndex, cloudTurn: entry.cloud.turnIndex };
}

/** 冲突提示文案：唯一实现，避免 UI 各处自己拼数字。 */
export function conflictText(conflict: { localTurn: number; cloudTurn: number }): string {
  return `本地与云存档不一致，本地 ${conflict.localTurn} 轮，云 ${conflict.cloudTurn} 轮。`;
}
