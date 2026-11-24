/**
 * 本地引擎错误：形状与 `api.ts` 的 `ApiError` 对齐（`message` 是「请求失败：code」，
 * `status` 区分 400/409），这样 UI 里既有的 `translateError` 与 409 静默刷新**零改动**生效。
 */
export class EngineError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, detail?: string) {
    super(detail === undefined ? `请求失败：${code}` : `请求失败：${code} ｜ ${detail}`);
    this.name = "EngineError";
    this.status = status;
    this.code = code;
  }
}

/** 服务端 `handleEngineError` 的同一张表（ADR-0034 §5）：状态冲突是 409，其余 400。 */
const INTERACTION_ERRORS = new Set([
  "pending_event_required",
  "battle_in_progress",
  "battle_not_active",
  "no_pending_event",
  "event_premise_invalidated",
]);

/** 把 core 抛出的裸 Error 收敛成带状态码的人话错误（与服务端逐条同义）。 */
export function engineErrorOf(error: unknown): EngineError {
  if (error instanceof EngineError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (INTERACTION_ERRORS.has(message)) return new EngineError(409, message);
  if (message.startsWith("[TERMINATED]")) return new EngineError(409, "terminated", message);
  if (message.startsWith("[ARCHIVED]")) return new EngineError(409, "archived", message);
  return new EngineError(400, message);
}
