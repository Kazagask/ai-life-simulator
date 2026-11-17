import type { EquipmentSlotVM, EquipmentVM } from "@life-sim/shared";

/**
 * 选中项：装备槽（含空槽）/ 背包物品。详情区是唯一的操作入口 ——
 * 装备在「角色」页穿脱，物品在「背包」页使用（ADR-0008 / ADR-0009）。
 *
 * 类型定在 rpg-ui，**状态归宿主**：选中态是跨组件协调（选中格 → 详情区显示什么），
 * 还会和「刷新后选中项失效」这类业务判断绑在一起，放进组件等于让组件互相知道对方存在。
 * 组件受控用法传 `selection` + `onSelect`；纯展示场景可以不传，自己内部管。
 */
export type PersonalSelection =
  | { kind: "slot"; instanceId: string | null; slotId: string; slotLabel: string; capacity: number }
  | { kind: "item"; itemId: string }
  | null;

/** 一个装备格子（槽位全集 × maxCount 展开后的产物；纯排版用，不进展示契约）。 */
export interface SlotCell {
  key: string;
  slotId: string;
  slotLabel: string;
  index: number;
  capacity: number;
  /** 人物面板摆位（ADR-0009）：left / right 左右两列，bottom 底部方块区 */
  side: EquipmentSlotVM["panelSide"];
  instance: EquipmentVM | null;
}

/**
 * 槽位定义 → 格子：**槽位全集、格数与摆位全部由模板投影下发**（R-EQ-11 / R-EQ-15），
 * 前端不猜槽位名、不猜件数、也不从「已装备实例」反推槽位（否则空槽会消失）。
 * 同一槽位内按投影顺序落格，多余实例（理论上不会出现）舍弃不渲染。
 */
export function buildSlotCells(slots: EquipmentSlotVM[], equipment: EquipmentVM[]): SlotCell[] {
  return slots.flatMap((slot) => {
    const worn = equipment.filter((e) => e.slot === slot.id);
    return Array.from({ length: slot.maxCount }, (_, i) => ({
      key: `${slot.id}-${i}`,
      slotId: slot.id,
      slotLabel: slot.label,
      index: i,
      capacity: slot.maxCount,
      side: slot.panelSide,
      instance: worn[i] ?? null,
    }));
  });
}

/** 某格是否处于选中态：有实例按实例 id 比，空槽按「同一槽位的空选择」比。 */
export function isSlotSelected(selection: PersonalSelection, cell: SlotCell): boolean {
  if (selection?.kind !== "slot") return false;
  return cell.instance
    ? selection.instanceId === cell.instance.instanceId
    : selection.instanceId === null && selection.slotId === cell.slotId;
}
