import type { EquipmentSlotVM, EquipmentVM, InventoryItemVM } from "@life-sim/shared";
import type { PersonalSelection } from "./personal.js";
import { EffectList } from "./EffectList.js";
import { TagChips } from "./TagChips.js";
import { StyledName } from "./StyledName.js";

/** 层数 / 耐久只在投影确实下发时展示，缺失即不渲染（不推算默认值）。 */
function EquipMeta({ equipment }: { equipment: EquipmentVM }) {
  const stacks = equipment.stacks;
  const durability = equipment.durability;
  const hasStacks = typeof stacks === "number" && stacks > 1;
  const hasDurability = typeof durability === "number";
  if (!hasStacks && !hasDurability) return null;
  return (
    <div className="tag-row equip-meta">
      {hasStacks && <span className="tag">×{stacks}</span>}
      {hasDurability && <span className="tag">耐久 {durability}</span>}
    </div>
  );
}

const ITEM_TYPE_LABEL: Record<InventoryItemVM["type"], string> = {
  equipment: "装备",
  consumable: "消耗品",
  material: "材料",
  key: "关键物品",
};

export interface AssetDetailProps {
  /** 宿主持有的选中项（受控）。 */
  selection: PersonalSelection;
  equipment: EquipmentVM[];
  inventory: InventoryItemVM[];
  slots: EquipmentSlotVM[];
  busy?: boolean;
  onEquip?: (itemId: string) => void;
  onUnequip?: (instanceId: string) => void;
  onUseItem?: (itemId: string) => void;
}

/**
 * 详情区：唯一操作入口。
 * - 已装备：展示说明 + 卸下；
 * - 空槽：展示槽位允许类别 + 背包内可装备物品（就地装备）；
 * - 背包物品：展示说明 + 使用 / 装备（装备件按定义槽位落位）。
 *
 * 所有动作都经 props 回给宿主，组件自己不发请求；`busy` 只负责置灰。
 */
export function AssetDetail({
  selection,
  equipment,
  inventory,
  slots,
  busy = false,
  onEquip,
  onUnequip,
  onUseItem,
}: AssetDetailProps) {
  if (!selection) {
    return (
      <section className="card detail-card">
        <p className="muted">选中上方任意格子查看详情。</p>
      </section>
    );
  }

  if (selection.kind === "slot") {
    const slot = slots.find((s) => s.id === selection.slotId);
    const worn = selection.instanceId ? equipment.find((e) => e.instanceId === selection.instanceId) : undefined;
    if (worn) {
      return (
        <section className="card detail-card">
          <div className="row">
            <h3>
              <StyledName name={worn.name ?? worn.itemId} style={worn.style} />
            </h3>
            <span className="tag">{worn.slotLabel ?? worn.slot}</span>
          </div>
          <TagChips tags={worn.tags} className="tag-row" />
          <div className="tag-row">
            <span className="tag">已装备</span>
            {worn.category && <span className="tag">类别 {worn.categoryLabel ?? worn.category}</span>}
          </div>
          {worn.description && <p className="item-desc">{worn.description}</p>}
          <EquipMeta equipment={worn} />
          <EffectList effects={worn.effects} dense />
          <div className="detail-actions">
            <button className="ghost" disabled={busy} onClick={() => onUnequip?.(worn.instanceId)}>
              卸下
            </button>
          </div>
        </section>
      );
    }
    const allowed = slot?.allowedCategories ?? [];
    // 显示名与 id 同序下发；旧投影没有这一列时回退 id（不猜词表）。
    const allowedLabels =
      slot?.allowedCategoryLabels !== undefined && slot.allowedCategoryLabels.length === allowed.length
        ? slot.allowedCategoryLabels
        : allowed;
    const candidates = inventory.filter((i) => i.type === "equipment" && allowed.includes(i.category ?? ""));
    return (
      <section className="card detail-card">
        <div className="row">
          <h3>{selection.slotLabel} · 空</h3>
          <span className="tag">可装备 {candidates.length}</span>
        </div>
        <p className="muted">
          {allowed.length > 0 ? `此槽位接受类别：${allowedLabels.join(" / ")}` : "槽位未声明允许类别。"}
        </p>
        {candidates.length === 0 ? (
          <p className="muted">背包里没有可放进这个槽位的装备。</p>
        ) : (
          <div className="stack-sm">
            {candidates.map((item) => (
              <div key={item.itemId} className="detail-row">
                <div>
                  <strong>
                    <StyledName name={item.name} style={item.style} />
                  </strong>
                  {/* 品级不再印 `quality` 原文（那是引擎词）；改由标签行承担（ADR-002 D2b/D2c）。 */}
                  <TagChips tags={item.tags} className="tag-row" />
                  <p className="muted">
                    {item.categoryLabel ?? item.category ?? "无类别"}
                    {item.count > 1 ? ` · 备用 ${item.count}` : ""}
                  </p>
                </div>
                <button className="primary" disabled={busy} onClick={() => onEquip?.(item.itemId)}>
                  装备
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  const item = inventory.find((i) => i.itemId === selection.itemId);
  if (!item) {
    return (
      <section className="card detail-card">
        <p className="muted">选中上方任意格子查看详情。</p>
      </section>
    );
  }
  const isEquipment = item.type === "equipment";
  return (
    <section className="card detail-card">
      <div className="row">
        <h3>
          <StyledName name={item.name} style={item.style} />
          {item.count > 1 ? ` ×${item.count}` : ""}
        </h3>
        <span className="tag">{ITEM_TYPE_LABEL[item.type]}</span>
      </div>
      <TagChips tags={item.tags} className="tag-row" />
      <div className="tag-row">
        {item.slotLabel && <span className="tag">槽位 {item.slotLabel}</span>}
        {item.category && <span className="tag">类别 {item.categoryLabel ?? item.category}</span>}
        {item.usableInBattle && <span className="tag">战斗可用</span>}
      </div>
      {item.description && <p className="item-desc">{item.description}</p>}
      <EffectList effects={item.effects} dense />
      <div className="detail-actions">
        {isEquipment && (
          <button className="primary" disabled={busy} onClick={() => onEquip?.(item.itemId)}>
            装备
          </button>
        )}
        {item.usableOutsideBattle && (
          <button className="primary" disabled={busy} onClick={() => onUseItem?.(item.itemId)}>
            使用
          </button>
        )}
        {!isEquipment && !item.usableOutsideBattle && !item.usableInBattle && (
          <p className="muted">这件物品无法直接使用，会在剧情里派上用场。</p>
        )}
      </div>
    </section>
  );
}
