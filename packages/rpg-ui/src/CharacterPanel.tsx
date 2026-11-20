import type { EquipmentSlotVM, PlayerVM } from "@life-sim/shared";
import { StyledName } from "./StyledName.js";
import { isSlotSelected } from "./personal.js";
import type { PersonalSelection, SlotCell } from "./personal.js";
import { buildSlotCells } from "./personal.js";

export interface SlotTileProps {
  cell: SlotCell;
  selected: boolean;
  onSelect: () => void;
}

/** 装备格子（左右两列共用）。空槽也可选中 —— 详情区会列出可装备物品。 */
export function SlotTile({ cell, selected, onSelect }: SlotTileProps) {
  return (
    <button
      className={`cell slot-tile ${selected ? "selected" : ""} ${cell.instance ? "" : "empty"}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="cell-slot">
        {cell.slotLabel}
        {cell.capacity > 1 ? ` ${cell.index + 1}` : ""}
      </span>
      <span className="cell-glyph">{cell.instance ? "◈" : "＋"}</span>
      <span className={`cell-name ${cell.instance ? "" : "muted"}`}>
        {/* 装备格也要吃样式：品级色是玩家认装备的第一眼信息（2026-11-19）。 */}
        {cell.instance === null ? (
          "空"
        ) : (
          <StyledName name={cell.instance.name ?? cell.instance.itemId} style={cell.instance.style} />
        )}
      </span>
    </button>
  );
}

/** 人物面板里的一条迷你资源条。 */
function MiniBar({ label, value, max, cls }: { label: string; value: number; max: number; cls: string }) {
  const pct = Math.min(100, Math.max(0, (value / Math.max(1, max)) * 100));
  return (
    <div className="mini-bar">
      <div className="mini-top">
        <span>{label}</span>
        <span>
          {value}/{max}
        </span>
      </div>
      <div className="bar">
        <div className={`bar-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export interface CharacterPanelProps {
  player: PlayerVM;
  /** 槽位定义（模板投影）；空数组 ⇒ 面板给「没有配置装备槽位」。 */
  slots: EquipmentSlotVM[];
  /** 受控选中态；不传则视为「未选中」（纯展示）。 */
  selection?: PersonalSelection;
  onSelect?: (next: PersonalSelection) => void;
}

/**
 * 人物面板（DNF M 面板思路）：左列 / 中央人物 / 右列，槽位由模板 `panelSide` 决定摆位，
 * 底部锚定的槽位排在面板下方。**格子数 = 槽位 maxCount，全部来自模板**，
 * 前端不猜槽位、不猜件数（R-EQ-15）。
 *
 * 选中态由宿主持有（跨组件协调），这里只负责「高亮哪一格」与把点击回传上去；
 * `onSelect` 缺省时格子仍可点，但不会有人接收 —— 纯展示前端传 `undefined` 即可。
 */
export function CharacterPanel({ player, slots, selection = null, onSelect }: CharacterPanelProps) {
  const cells = buildSlotCells(slots, player.equipment);
  const sideOf = (side: SlotCell["side"]) => cells.filter((c) => c.side === side);
  const left = sideOf("left");
  const right = sideOf("right");
  const bottom = sideOf("bottom");

  const selectCell = (cell: SlotCell) =>
    onSelect?.({
      kind: "slot",
      instanceId: cell.instance?.instanceId ?? null,
      slotId: cell.slotId,
      slotLabel: cell.slotLabel,
      capacity: cell.capacity,
    });

  return (
    <section className="card">
      <div className="row">
        <h3 className="panel-title">角色</h3>
        <span className="muted equip-count">{player.equipment.length} 件在身</span>
      </div>

      {cells.length === 0 ? (
        <p className="muted">这个世界没有配置装备槽位。</p>
      ) : (
        <>
          <div className="paperdoll">
            <div className="paperdoll-col">
              {left.map((cell) => (
                <SlotTile
                  key={cell.key}
                  cell={cell}
                  selected={isSlotSelected(selection, cell)}
                  onSelect={() => selectCell(cell)}
                />
              ))}
            </div>

            <div className="paperdoll-figure">
              <div className="figure-avatar" aria-hidden="true">
                ◈
              </div>
              <strong className="figure-name">{player.name}</strong>
              <span className="figure-sub">
                {player.age} 岁 · {player.genderLabel}
              </span>
              <div className="figure-bars">
                {/* ADR-003：模板声明的资源（hp/mp + 自定义）都要在人物图上可见。 */}
                {player.resources.map((r) => (
                  <MiniBar
                    key={r.key}
                    label={r.label}
                    value={r.value}
                    max={Math.max(1, r.max)}
                    cls={r.key === "hp" ? "hp" : r.key === "mp" ? "mp" : "res"}
                  />
                ))}
              </div>
              {/* 模板没给阶段文案时适配器给空串 ⇒ 不渲染，绝不把 `adulthood` 这种 id 印出来。 */}
              {player.lifeStageLabel !== "" && <span className="figure-sub">{player.lifeStageLabel}</span>}
            </div>

            <div className="paperdoll-col right">
              {right.map((cell) => (
                <SlotTile
                  key={cell.key}
                  cell={cell}
                  selected={isSlotSelected(selection, cell)}
                  onSelect={() => selectCell(cell)}
                />
              ))}
            </div>
          </div>

          {bottom.length > 0 && (
            <div className="cell-grid paperdoll-bottom">
              {bottom.map((cell) => (
                <SlotTile
                  key={cell.key}
                  cell={cell}
                  selected={isSlotSelected(selection, cell)}
                  onSelect={() => selectCell(cell)}
                />
              ))}
            </div>
          )}
        </>
      )}
      <p className="muted cell-hint">点格子查看详情；装备 / 卸下都在下方详情区完成。</p>
    </section>
  );
}
