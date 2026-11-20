import type { StatusTotalVM, StatusVM } from "@life-sim/shared";
import { StatusChip } from "./StatusChip.js";

/**
 * 状态面板（ADR-018 D8）：**天赋一栏、状态一栏、状态一块**。
 *
 * 三档的意义只在生命周期，但玩家读面板时关心的是另外三件事：
 * 「我天生是什么」（天赋，不变化）／「我现在背着什么」（状态，会掉）／
 * 「这些加起来是多少」（状态合计，此前没有任何地方能看见）。
 *
 * 所以不分三栏，只分两栏 + 一块：`battle` 与 `modifier` 共用「状态」栏，
 * 靠时长单位区分（`还剩 2 回合` / `还剩 3 天`）。
 */
export interface StatusBoardProps {
  statuses: readonly StatusVM[];
  /** 状态合计（投影期算好，前端不求和）。 */
  totals?: readonly StatusTotalVM[];
  /**
   * 是否展示「合计」那一块。
   *
   * 首页只要**知道身上有什么**（天赋 / 修正的名字与层数），
   * 「一共加了多少」是打开个人页才需要做的判断 —— 数字堆在首页会把故事挤下去。
   */
  showLedger?: boolean;
  onSelectStatus?: (status: StatusVM) => void;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

function formatValue(format: StatusTotalVM["format"], value: number): string {
  if (format === "percent") return `${value > 0 ? "+" : ""}${Math.round(value * 100)}%`;
  if (format === "attr") return signed(value);
  return `${value}`;
}

function formatTotal(channel: StatusTotalVM): string {
  if (channel.format === "control") return channel.sources.map((s) => s.name).join(" · ");
  return formatValue(channel.format, channel.total);
}

function StatusGroup({
  title,
  statuses,
  onSelectStatus,
}: {
  title: string;
  statuses: readonly StatusVM[];
  onSelectStatus?: (status: StatusVM) => void;
}) {
  if (statuses.length === 0) return null;
  return (
    <div className="status-group">
      <div className="status-group__title">{title}</div>
      <div className="status-chips">
        {statuses.map((status) => (
          <StatusChip key={status.id} status={status} {...(onSelectStatus !== undefined ? { onSelect: onSelectStatus } : {})} />
        ))}
      </div>
    </div>
  );
}

/**
 * 状态合计：一行一条通道，点开是每一笔的来源。
 *
 * 「详情展示来源」是这一块存在的理由 —— 只给总数等于换个地方藏信息：
 * 玩家看见「咒力 +3」却不知道是六眼还是装备，就没法做取舍。
 */
function StatusTotals({ channels }: { channels: readonly StatusTotalVM[] }) {
  if (channels.length === 0) return null;
  return (
    <div className="ledger">
      <div className="status-group__title">合计</div>
      {channels.map((channel) => (
        <details key={channel.id} className="ledger-row">
          <summary className="ledger-row__head">
            <span className="ledger-row__label">{channel.label}</span>
            <span className="ledger-row__total">{formatTotal(channel)}</span>
          </summary>
          <ul className="ledger-sources">
            {channel.sources.map((source, i) => (
              <li key={`${source.name}-${i}`}>
                <span>
                  {source.name}
                  {source.stacks !== undefined ? ` ×${source.stacks}` : ""}
                </span>
                {channel.format === "control" ? null : (
                  <span className="muted">{formatValue(channel.format, source.value)}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

export function StatusBoard({ statuses, totals = [], showLedger = true, onSelectStatus }: StatusBoardProps) {
  const talents = statuses.filter((s) => s.kind === "talent");
  const states = statuses.filter((s) => s.kind !== "talent");
  if (statuses.length === 0 && totals.length === 0) return null;
  return (
    <div className="status-board">
      <StatusGroup title="天赋" statuses={talents} onSelectStatus={onSelectStatus} />
      <StatusGroup title="修正" statuses={states} onSelectStatus={onSelectStatus} />
      {showLedger ? <StatusTotals channels={totals} /> : null}
    </div>
  );
}
