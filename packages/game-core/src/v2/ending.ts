import type { TerminationRecord, WorldStateV2 } from "@life-sim/shared";

/** 门禁拒绝码：可诊断、可据以分支处理。 */
export type EndingGuardCode = "NOT_ACTIVE" | "TERMINATED";

export class EndingGuardError extends Error {
  readonly code: EndingGuardCode;

  constructor(code: EndingGuardCode, detail: string) {
    super(`[${code}] ${detail}`);
    this.name = "EndingGuardError";
    this.code = code;
  }
}

/**
 * 轮次 / 写入门禁（供 advanceTurnV2 入口调用，接线属 T2-02）。
 * 只读检查：任何拒绝路径都不改变 state 的任一字段。
 */
export function assertActive(state: WorldStateV2): void {
  if (state.openingCompleted === false) {
    throw new EndingGuardError(
      "NOT_ACTIVE",
      "开局尚未交接（openingCompleted=false），拒绝普通轮次推进",
    );
  }
  if (state.termination !== null || state.archived === true) {
    throw new EndingGuardError(
      "TERMINATED",
      "本局已终止或已归档，拒绝继续写入状态",
    );
  }
}

/**
 * 终止写入唯一入口。纯函数：不修改入参 state，返回携带 termination 的新状态。
 * 幂等且不可逆：已有 termination 时原样返回入参 state（逐字段不变），
 * 其中携带的即为同一 TerminationRecord，不追加记录、不追加历史。
 * worldTime / turnIndex 一律取自传入 state，不读取真实时间、不使用随机数。
 */
export function markTerminated(
  state: WorldStateV2,
  rec: TerminationRecord,
): WorldStateV2 {
  if (state.termination !== null) {
    return state;
  }
  const record: TerminationRecord = {
    reason: rec.reason,
    worldTime: state.worldTime,
    turnIndex: state.turnIndex,
    source: rec.source,
    ...(rec.endingId !== undefined ? { endingId: rec.endingId } : {}),
  };
  return { ...state, termination: record };
}
