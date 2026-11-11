import type {
  EndingRecord,
  EvaluationRecord,
  HistoryEntryV2,
  TerminationRecord,
  V2Snapshot,
  WorldStateV2,
  WorldTemplateV2,
} from "@life-sim/shared";
import { projectSnapshotV2 } from "./projection.js";
import type { TemplateLookup } from "./lookup.js";

/**
 * 阶段 4 · 归档（design §4 / §5、R-AR-01..03）。
 * 组装五类数据并置 archived=true；沿用现有 worldStore 机制，不新增独立存档子系统、
 * 不建阶段状态机。ArchiveRecord 是独立类型，由纯函数产出、交由调用方持有。
 */

/** 归档记录：最终快照 / 事件历史 / 结局 / 评价 / 终止记录。 */
export interface ArchiveRecord {
  snapshot: V2Snapshot;
  history: HistoryEntryV2[];
  ending: EndingRecord;
  evaluation: EvaluationRecord;
  termination: TerminationRecord;
}

/** 归档只读判定（design §3.3）：已归档世界拒绝任何状态写入。 */
export function assertWritable(state: WorldStateV2): void {
  if (state.archived === true) {
    throw new Error("[ARCHIVED] 本局已归档，只读，拒绝写入状态");
  }
}

/** 幂等置归档标记；纯函数返回新状态，不改入参。 */
export function markArchived(state: WorldStateV2): WorldStateV2 {
  if (state.archived === true) return state;
  return { ...state, archived: true };
}

export interface ArchiveResult {
  state: WorldStateV2;
  record: ArchiveRecord;
}

/** 组装五类数据并置 archived=true（R-AR-01 / R-AR-02）。 */
export function assembleArchive(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  ending: EndingRecord,
  evaluation: EvaluationRecord,
): ArchiveResult {
  if (state.termination === null) {
    throw new Error("[archive_requires_termination] 尚未终止，拒绝归档");
  }
  const termination = state.termination;
  const record: ArchiveRecord = {
    snapshot: projectSnapshotV2(state, template, lookup, evaluation),
    history: state.history.map((h) => ({ ...h })),
    ending,
    evaluation,
    termination,
  };
  return { state: markArchived(state), record };
}
