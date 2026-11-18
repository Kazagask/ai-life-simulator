import type { V2TurnResult, WorldStateV2 } from "@life-sim/shared";
import type { ReadyTemplateEntry } from "../templates.js";
import { readNarrativeBlocks } from "./read.js";
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

/** 一回合最多写这么多字，避免模板式罗列把叙事区撑爆（超长由玩家自己读 history）。 */
const MAX_TEMPLATE_CHARS = 400;

/** 从本回合历史 + 转盘结果合成一段叙事文本；无内容时返回空串（不写空段）。 */
export function composeTurnNarrative(
  state: WorldStateV2,
  turnIndex: number,
  wheel: V2TurnResult["wheelResult"],
): string {
  const parts: string[] = [];

  if (wheel !== null && wheel !== undefined) {
    parts.push(`⚄ ${wheel.title ?? "随机事件"}：${wheel.label}`);
  }

  /**
   * 只取**主角自己的**经历。
   *
   * `npc_action` 是世界的背景动态（「某 NPC 找同伴闲聊」「某 NPC 独自打熬咒力」），
   * 拼进叙事区就变成了「世界状态清单」——用户 2026-11-18 实测反馈正是这个。
   * 它们该留在历史 / 世界页，不该冒充玩家刚经历的一幕。
   */
  const entries = state.history.filter((h) => h.turnIndex === turnIndex && h.type !== "npc_action");

  for (const h of entries) {
    const text = h.summary.trim();
    if (text !== "") parts.push(text);
  }

  const text = parts.join("\n\n").trim();
  return text.length > MAX_TEMPLATE_CHARS ? `${text.slice(0, MAX_TEMPLATE_CHARS - 1)}…` : text;
}

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

  const text = composeTurnNarrative(state, turnIndex, wheel);
  if (text === "") return false;

  recordNarrative(state, entry, {
    reason: "turn.template",
    blocks: [{ blockId: `turn-${turnIndex}-template`, kind: "narrative", text }],
  });
  return true;
}
