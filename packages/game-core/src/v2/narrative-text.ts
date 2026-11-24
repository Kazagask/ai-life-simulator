import type { V2TurnResult, WorldStateV2 } from "@life-sim/shared";

/**
 * 回合叙事的**模板兜底**（ADR-002 D5 / R-NAR-01）。
 *
 * 有 LLM 时正文走 trace 通道；没有 LLM（或本地局未接网关）时，叙事区不能是空的 ——
 * 这里把本回合的 history 摘要拼成一条平实叙述，作为"下限"而不是"AI 的替代品"。
 *
 * 放在 game-core 而不是服务端：浏览器里的本地局也要这段兜底，
 * 两边各写一份迟早漂成两种口吻。
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
   * `npc_action` 是世界的背景动态（「某 NPC 找同伴闲聊」「某 NPC 独自修炼」），
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
