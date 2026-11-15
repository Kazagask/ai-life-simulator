import type { WorldStateV2 } from "@life-sim/shared";

/**
 * ADR-0035 D2：**回合事务边界**（per-world 串行锁 + 结构写入保存点）。
 *
 * 为什么需要锁：`fact.enqueueEvent` / `fact.advanceDag` 是**结构写入**，内容基于
 * 「创作这一轮」的状态快照。invocation 是异步的，如果允许世界在它落账前推进，
 * 就会出现主理人给出的两个反例：
 *   A. 已死 npc 作为"活着"登场（诈尸）
 *   B. 加 missWhen 后，本该在 A+1 发生的事件被判定成"过期"（静默的错误错过）
 * 二者在**触发时刻的状态上完全一样**，任何基于触发时刻的判据都分不开 —— 只能让
 * "落账"这件事发生在"世界推进"之前，即把 invocation 纳入回合的事务边界。
 *
 * 为什么需要保存点：`await` 之后拿到的 outcome 可能不是 `committed`（fallback /
 * 重试耗尽 / 超时），此时模型可能**已经写过一部分结构字段**。ADR-0035 §5 的口径是
 * 「宁可不发生，也不许晚到」—— 部分提交也必须整体撤销。
 */

/** worldId → 该世界的排队尾 Promise。值本身是"前一个任务完成"的信号。 */
const tails = new Map<string, Promise<unknown>>();

/**
 * 同一 worldId 的调用串行执行；不同 world 互不阻塞。
 *
 * `finally` 里解链，且只在「队尾仍然是自己」时才删除 —— 否则并发排队时
 * 先完成的那个会把后来者的链删掉，导致下一个请求直接插队。
 */
export async function withWorldLock<T>(worldId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(worldId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  // 链尾吞掉异常：某一个请求失败不应把整条世界队列变成 rejected，
  // 否则后续所有请求都会跳过 fn 直接拿到同一个错误。
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(worldId, tail);
  try {
    return await run;
  } finally {
    if (tails.get(worldId) === tail) tails.delete(worldId);
  }
}

/**
 * 结构保存点：**只快照 LLM 能写的四个字段**。
 *
 * 刻意不含 `turnIndex` / `worldTime` / `slot` / `history` / `eventFires`：
 * 那些不是 LLM 的写入面，把它们也快照会掩盖真 bug。`slot` 尤其重要 ——
 * `fact.enqueueEvent` 按 ADR-0034 就不许占槽，若它变了说明有人破了不变量，
 * 应当暴露而不是被回滚掩盖。
 */
export interface StructuralSavepoint {
  delayQueue: WorldStateV2["delayQueue"];
  enqueueSeqCounter: WorldStateV2["enqueueSeqCounter"];
  observationLedger: WorldStateV2["observationLedger"];
  taskDag: WorldStateV2["taskDag"];
}

/**
 * 捕获时机有硬要求：**必须在 `advanceTurnV2(...)` 返回之后、`gateway.invoke` 之前**。
 *
 * 因为 `res.state` 是同一个活对象（`advanceTurnV2` 原地改它）。捕获早了会把结算本身的
 * 合法写入（`recordFire` / `history` / `turnIndex`）也一起回滚掉。
 */
export function captureStructuralSavepoint(state: WorldStateV2): StructuralSavepoint {
  return structuredClone({
    delayQueue: state.delayQueue,
    enqueueSeqCounter: state.enqueueSeqCounter,
    observationLedger: state.observationLedger,
    taskDag: state.taskDag,
  });
}

/** 整体撤销到保存点（字段级赋值，保持 state 引用不变）。 */
export function restoreStructuralSavepoint(
  state: WorldStateV2,
  savepoint: StructuralSavepoint,
): void {
  state.delayQueue = savepoint.delayQueue;
  state.enqueueSeqCounter = savepoint.enqueueSeqCounter;
  state.observationLedger = savepoint.observationLedger;
  state.taskDag = savepoint.taskDag;
}
