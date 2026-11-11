import type { V2Snapshot, WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
import type { TemplateLookup } from "./lookup.js";
import { assertActive } from "./ending.js";
import { equipItem, unequipItem } from "./equipment.js";
import { projectSnapshotV2 } from "./projection.js";
import { pushHistory } from "./history.js";
import { evaluateLifeV2 } from "./life-evaluation.js";

/**
 * 装备穿脱编排（T5-01 / R-EQ-07 / R-EQ-08 / design §5.1 / ADR-0008）：
 * 与其它四个行动入口同构——assertActive 门禁 → 纯函数穿脱 → 写回 → public 历史 → 投影。
 * 穿脱在**背包与装备栏之间移动物品**：穿上 背包 -1、卸下 背包 +1（R-EQ-11）。
 * **不推进 worldTime、不递增 turnIndex**（穿脱不消耗时间，因此也不需要终止边界判定）。
 * 失败抛 `[equip] <code>` / `[unequip] <code>`，不写状态；server 按码映射
 * 409（slot_full / slot_category_mismatch）或 400（其余五种）。
 */

export interface EquipCommandV2 {
  itemId: string;
}

export interface UnequipCommandV2 {
  instanceId: string;
}

/** 错误码 → 前缀（供 server 解析 `[equip] slot_full` 这类消息）。 */
export function equipErrorCodeOf(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^\[(equip|unequip)\] (\w+)$/.exec(message);
  return match ? match[2] : null;
}

function fail(code: string, op: "equip" | "unequip"): never {
  throw new Error(`[${op}] ${code}`);
}

function projectWithEvaluation(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
): V2Snapshot {
  return projectSnapshotV2(state, template, lookup, evaluateLifeV2(state));
}

export function equipV2(
  state: WorldStateV2,
  command: EquipCommandV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
): { state: WorldStateV2; snapshot: V2Snapshot } {
  assertActive(state);
  const result = equipItem(
    { equipment: state.player.equipment ?? [], inventory: state.player.inventory },
    command.itemId,
    lookup,
  );
  if (!result.ok) fail(result.code, "equip");
  const next = structuredClone(state);
  next.player.equipment = result.equipment;
  next.player.inventory = result.inventory;
  const item = lookup.item(command.itemId);
  pushHistory(next, template, {
    id: `t${next.turnIndex}-eq-${command.itemId}`,
    type: "player_action",
    summary: `装备了「${item?.name ?? command.itemId}」`,
    visibility: "public",
  });
  return { state: next, snapshot: projectWithEvaluation(next, template, lookup) };
}

export function unequipV2(
  state: WorldStateV2,
  command: UnequipCommandV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
): { state: WorldStateV2; snapshot: V2Snapshot } {
  assertActive(state);
  const result = unequipItem(
    { equipment: state.player.equipment ?? [], inventory: state.player.inventory },
    command.instanceId,
    lookup,
  );
  if (!result.ok) fail(result.code, "unequip");
  const next = structuredClone(state);
  next.player.equipment = result.equipment;
  next.player.inventory = result.inventory;
  const removed = (state.player.equipment ?? []).find((e) => e.instanceId === command.instanceId);
  const item = removed ? lookup.item(removed.itemId) : undefined;
  pushHistory(next, template, {
    id: `t${next.turnIndex}-ueq-${command.instanceId}`,
    type: "player_action",
    summary: `卸下了「${item?.name ?? command.instanceId}」`,
    visibility: "public",
  });
  return { state: next, snapshot: projectWithEvaluation(next, template, lookup) };
}
