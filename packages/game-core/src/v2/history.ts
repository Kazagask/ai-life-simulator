import type { HistoryEntryV2, HistoryVisibility, WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
import { isPlayerVisible } from "@life-sim/shared";
import { createTimeAdapter } from "./time.js";
import type { ArchiveRecord } from "./archive.js";

/**
 * 历史可见性读取侧（R-VS-02 / design §2.3）：三个玩家端出口统一走这里，
 * 读取侧不得各自写 `=== "public"`——唯一判定入口是 shared 的 isPlayerVisible。
 */

/** 过滤出玩家可见条目（hidden / unknown 一律不进；缺字段视为 public 的旧数据兼容）。 */
export function playerVisibleEntries(entries: readonly HistoryEntryV2[]): HistoryEntryV2[] {
  return entries.filter(isPlayerVisible);
}

/** 玩家可见历史窗口：**先过滤再截断**（先 slice 后滤可能让 20 条里全是 hidden，玩家看到空列表）。 */
export function playerVisibleHistory(state: WorldStateV2, limit: number): HistoryEntryV2[] {
  return state.history.filter(isPlayerVisible).slice(-limit);
}

/**
 * 归档响应的玩家投影（R-VS-04 / design §2.4）：public 记录 + hiddenHistoryCount 计数。
 * ArchiveRecord 本体（服务端存档事实）仍保留全量，不受本函数影响。
 */
export function projectArchiveForPlayer(
  record: ArchiveRecord,
): ArchiveRecord & { hiddenHistoryCount: number } {
  const visible = record.history.filter(isPlayerVisible);
  return {
    ...record,
    history: visible,
    hiddenHistoryCount: record.history.length - visible.length,
  };
}

/**
 * 历史写入工具（T5-01 从 turn.ts 提取，供多个编排模块复用）：
 * visibility 由签名强制提供（协议 §21.1），补齐 turnIndex / worldTime / formattedTime。
 */
export function pushHistory(
  state: WorldStateV2,
  template: WorldTemplateV2,
  entry: Omit<HistoryEntryV2, "turnIndex" | "worldTime" | "formattedTime"> & {
    visibility: HistoryVisibility;
  },
): void {
  state.history.push({
    ...entry,
    turnIndex: state.turnIndex,
    worldTime: state.worldTime,
    formattedTime: createTimeAdapter(template).format(state.worldTime),
  });
}
