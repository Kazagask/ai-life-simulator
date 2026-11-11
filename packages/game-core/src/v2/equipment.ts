import type { Condition, DynamicModifierSpec, EquipmentInstance, StatusInstance } from "@life-sim/shared";
import type { TemplateLookup } from "./lookup.js";

/**
 * 装备运行时求值与穿脱操作（协议 V2.1 §19 / R-EQ-03..06）。
 *
 * - evaluateDynamicModifier：按 preset 白名单 + 当前状态/层数/条件求值，纯函数、无副作用。
 *   固定值即「无条件、无层数」的退化 preset，走同一管线（R-EQ-04）。
 * - 结果只进 effectiveAttributes 的运行时累加链，严禁写回 state.player.attributes
 *   或 EquipmentInstance（P8）。
 * - equipItem / unequipItem：纯函数，返回新实例数组；失败时返回可诊断错误码，
 *   调用方据此决定是否写回（失败时状态不变）。
 * - 无自由表达式求值器、无 eval / new Function、无世界观专名（R-EQ-03 / R-NFR-05）。
 */

// ---------- 动态补正求值 ----------

/** 条件求值入口：由调用方注入（引擎侧包装 checkCondition，避免本模块与引擎互相依赖）。 */
export type ModifierConditionGate = (cond: Condition) => boolean;

export interface ModifierContext {
  /** 当前累加到装备步骤为止的有效属性（scaled preset 的 scaleBy 从这里取值） */
  effAttrs: Record<string, number>;
  /** 状态实例（stack-scaled preset 的层数来源） */
  statuses: StatusInstance[];
  /** 条件求值入口；未提供时视为「无条件生效」（供无状态调用方退化使用） */
  condCtx?: ModifierConditionGate;
}

/**
 * 求值单个动态补正 spec，返回 `属性 id → 修正值`（条件不命中返回空对象）。
 * 数值语义与协议 §10 公式 preset 完全一致：
 * fixed = value；scaled = base + scaleBy × multiplier；stack-scaled = base + stacks(status) × perStack。
 */
export function evaluateDynamicModifier(spec: DynamicModifierSpec, ctx: ModifierContext): Record<string, number> {
  if (spec.conditions?.length && ctx.condCtx) {
    for (const cond of spec.conditions) {
      if (!ctx.condCtx(cond)) return {};
    }
  }
  let value = 0;
  switch (spec.preset) {
    case "fixed":
      value = spec.params.value;
      break;
    case "scaled":
      value = spec.params.base + (ctx.effAttrs[spec.params.scaleBy] ?? 0) * spec.params.multiplier;
      break;
    case "stack-scaled": {
      const stacks = ctx.statuses.find((s) => s.statusId === spec.params.status)?.stacks ?? 0;
      value = spec.params.base + stacks * spec.params.perStack;
      break;
    }
  }
  return { [spec.attribute]: value };
}

// ---------- 穿脱 / 替换（纯函数） ----------

export type EquipErrorCode =
  | "item_not_found"
  | "item_not_equipment"
  | "not_owned"
  | "slot_not_found"
  | "slot_category_mismatch"
  | "slot_full"
  | "instance_not_found";

export type EquipResult =
  | { ok: true; equipment: EquipmentInstance[] }
  | { ok: false; code: EquipErrorCode; message: string };

export interface EquipmentOwnerInput {
  /** 当前装备实例数组（不被修改） */
  equipment: EquipmentInstance[];
  /** 库存（装备前提是持有该物品；穿脱不改变库存计数） */
  inventory: Record<string, number>;
}

const fail = (code: EquipErrorCode, message: string): EquipResult => ({ ok: false, code, message });

/** 生成确定性 instanceId：`equip-<itemId>-<n>`，n 为不与现存冲突的最小正整数（同 seed 回放可复现）。 */
export function nextInstanceId(equipment: EquipmentInstance[], itemId: string): string {
  const used = new Set(
    equipment.filter((e) => e.itemId === itemId).map((e) => e.instanceId),
  );
  let n = 1;
  while (used.has(`equip-${itemId}-${n}`)) n += 1;
  return `equip-${itemId}-${n}`;
}

export function equipItem(
  input: EquipmentOwnerInput,
  itemId: string,
  lookup: TemplateLookup,
): EquipResult {
  const item = lookup.item(itemId);
  if (!item) return fail("item_not_found", `物品不存在：${itemId}`);
  if (item.type !== "equipment") return fail("item_not_equipment", `物品不是装备：${itemId}`);
  if ((input.inventory[itemId] ?? 0) < 1) {
    return fail("not_owned", `未持有物品：${itemId}`);
  }
  const slotId = item.slot ?? "";
  const slot = lookup.template.equipment?.slots?.find((s) => s.id === slotId);
  if (!slot) return fail("slot_not_found", `槽位未声明：${slotId}`);
  if (!slot.allowedCategories.includes(item.category ?? "")) {
    return fail("slot_category_mismatch", `槽位 ${slotId} 不允许类别：${item.category ?? "(缺失)"}`);
  }
  const occupied = input.equipment.filter((e) => e.slot === slotId).length;
  if (occupied >= slot.maxCount) {
    return fail("slot_full", `槽位 ${slotId} 已满（maxCount=${slot.maxCount}）`);
  }
  const instance: EquipmentInstance = {
    instanceId: nextInstanceId(input.equipment, itemId),
    itemId,
    ownerId: "player",
    slot: slotId,
  };
  return { ok: true, equipment: [...input.equipment, instance] };
}

export function unequipItem(
  input: EquipmentOwnerInput,
  instanceId: string,
  _lookup: TemplateLookup,
): EquipResult {
  const target = input.equipment.find((e) => e.instanceId === instanceId);
  if (!target) return fail("instance_not_found", `装备实例不存在：${instanceId}`);
  return { ok: true, equipment: input.equipment.filter((e) => e.instanceId !== instanceId) };
}
