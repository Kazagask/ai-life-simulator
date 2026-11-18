import type { InventoryItemVM } from "@life-sim/shared";
import { StyledName } from "./StyledName.js";
import type { PersonalSelection } from "./personal.js";

/** 背包分区（用户裁决：装备与物品在背包里分区，DNF 式）。按物品类型分栏，不混排。 */
export type BagPartition = "equipment" | "consumable" | "material" | "key";

const BAG_PARTITIONS: Array<{ key: BagPartition; label: string; types: InventoryItemVM["type"][] }> = [
  { key: "equipment", label: "装备", types: ["equipment"] },
  { key: "consumable", label: "消耗品", types: ["consumable"] },
  { key: "material", label: "材料", types: ["material"] },
  { key: "key", label: "其他", types: ["key"] },
];

/** 方格内的类别字形（纯文字符号，不引入图标库）。 */
export function itemGlyph(type: InventoryItemVM["type"]): string {
  switch (type) {
    case "equipment":
      return "◈";
    case "consumable":
      return "✚";
    case "material":
      return "❖";
    default:
      return "▣";
  }
}

export interface BagPanelProps {
  inventory: InventoryItemVM[];
  /** 受控分区；缺省 "equipment"。 */
  partition?: BagPartition;
  onPartition?: (next: BagPartition) => void;
  selection?: PersonalSelection;
  onSelect?: (next: PersonalSelection) => void;
}

/** 背包：按类型分区（装备 / 消耗品 / 材料 / 其他），每区独立方格 + 数量角标。 */
export function BagPanel({ inventory, partition = "equipment", onPartition, selection = null, onSelect }: BagPanelProps) {
  const current = BAG_PARTITIONS.find((p) => p.key === partition) ?? BAG_PARTITIONS[0];
  const items = inventory.filter((item) => current.types.includes(item.type));
  const countOf = (types: InventoryItemVM["type"][]) => inventory.filter((i) => types.includes(i.type)).length;

  return (
    <section className="card">
      <div className="row">
        <h3 className="panel-title">背包</h3>
        <span className="muted equip-count">{inventory.length} 种</span>
      </div>

      <div className="partitionbar" role="tablist" aria-label="背包分区">
        {BAG_PARTITIONS.map((entry) => (
          <button
            key={entry.key}
            role="tab"
            aria-selected={partition === entry.key}
            className={`partition ${partition === entry.key ? "active" : ""}`}
            onClick={() => onPartition?.(entry.key)}
          >
            {entry.label}
            <em>{countOf(entry.types)}</em>
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="muted">这一格还没有东西。</p>
      ) : (
        <div className="cell-grid">
          {items.map((item) => {
            const selected = selection?.kind === "item" && selection.itemId === item.itemId;
            return (
              <button
                key={item.itemId}
                className={`cell bag-cell ${selected ? "selected" : ""}`}
                aria-pressed={selected}
                onClick={() => onSelect?.({ kind: "item", itemId: item.itemId })}
              >
                <span className="cell-glyph">{itemGlyph(item.type)}</span>
                <span className="cell-name">
                  <StyledName name={item.name} style={item.style} />
                </span>
                {item.count > 1 && <span className="cell-count">×{item.count}</span>}
              </button>
            );
          })}
        </div>
      )}
      <p className="muted cell-hint">穿在身上的装备不在背包里，去「角色」页卸下。</p>
    </section>
  );
}
