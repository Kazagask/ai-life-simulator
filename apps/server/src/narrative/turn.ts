import type { V2TurnResult, WorldStateV2 } from "@life-sim/shared";
import type { ReadyTemplateEntry } from "../templates.js";
import { readNarrativeBlocks } from "./read.js";
import { composeTurnNarrative } from "@life-sim/game-core";
import { recordNarrative } from "./trace.js";

/**
 * 回合叙事兜底（ADR-002 D5 / R-NAR-01）。
 *
 * 现状：叙事正文只走 LLM trace 通道；模板 / mock 回合 `generate.ts` 直接短路，
 * 什么都不写 ⇒ 没有 LLM 时叙事区永远是空的（实测 `blocks: 0`）。
 *
 * 这里补的是**下限**而不是「AI 的替代品」：
 * - 该回合已有叙事块（LLM 写过）⇒ 直接跳过，绝不覆盖 LLM 的版本；
 * - 否则把本回合的 history 摘要拼成一条平实叙事（事件正文 / 行动结果 / 转盘结果）。
 *
 * 为什么不做得更"文学"：没有 LLM 时宁可平实，也不要假装是 AI 写的。
 */

export { composeTurnNarrative } from "@life-sim/game-core";

/**
 * 写回合叙事（幂等：同回合已有块就不写）。
 *
 * 返回是否真的写了，便于调用方记录诊断 / 单测断言。
 */
export function recordTurnNarrative(
  worldId: string,
  state: WorldStateV2,
  entry: ReadyTemplateEntry,
  turnIndex: number,
  wheel: V2TurnResult["wheelResult"],
): boolean {
  // 该回合已有块（LLM / 结局 / 人生总结）⇒ 保留原样。
  if (readNarrativeBlocks(worldId, state, turnIndex).length > 0) return false;

  /**
   * 转盘只在**确认后**才写进叙事（用户 2026-11-18 实测「一件事重复叙述了」）。
   *
   * 一次「巡逻」会先掷出转盘（槽仍是该事件、只呈现不结算），再等玩家确认。两趟的
   * `wheelResult` 是同一格，无脑拼进去就是同一句 `⚄ 巡逻 · 命数：X` 写两遍。
   * 判据用 `state.slot.eventId === wheel.eventId`：槽还停在这个转盘上 ⇒ 尚未结算。
   */
  const settledWheel = wheel !== null && wheel !== undefined && state.slot?.eventId !== wheel.eventId ? wheel : null;
  const text = composeTurnNarrative(state, turnIndex, settledWheel);
  if (text === "") return false;

  recordNarrative(state, entry, {
    reason: "turn.template",
    blocks: [{ blockId: `turn-${turnIndex}-template`, kind: "narrative", text }],
  });
  return true;
}
