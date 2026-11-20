import type { WorldStateV2 } from "@life-sim/shared";

/**
 * 世界内加点的可用性判定（2026-11-21 用户裁定）。
 *
 * 为什么战斗里要拒绝：战斗单位在开打那一刻就把属性快照进 `Combatant`
 * （`buildUnit` → `effectiveAttributesOfActor`），之后改基础属性**不会**影响这一场。
 * 界面上会出现「体质 +2 / 血条不动」的假象，比直接说「打完再分」更糟。
 * 与「战斗中不能换装」同一条纪律：这些都是战后的动作。
 *
 * 判据只看 `battle.over === null`：`over` 非空表示已判定胜负、尚未清场，
 * 那种状态允许加点（战斗已经结束，只是快照还没被下一轮清掉）。
 */
export function allocationBlockedReason(world: WorldStateV2): "battle" | null {
  const battle = world.battle;
  if (battle === null || battle === undefined) return null;
  return battle.over === null ? "battle" : null;
}
