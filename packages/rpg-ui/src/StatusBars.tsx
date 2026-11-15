import type { StatusBarVM } from "@life-sim/shared";

export interface StatusBarsProps {
  bars: StatusBarVM[];
}

function pct(b: StatusBarVM): number {
  const max = Math.max(1, b.max);
  return Math.min(100, Math.max(0, (b.value / max) * 100));
}

/**
 * 资源条（HP / MP）：标签来自模板（`labels.resources`），样式按 `key` 上钩子。
 * 数值超界（>max / <0）一律夹到 0-100%，不让模板数值把进度条画到容器外。
 */
export function StatusBars({ bars }: StatusBarsProps) {
  if (bars.length === 0) return null;
  return (
    <div className="ls-bars">
      {bars.map((bar) => (
        <div key={bar.key} className="ls-bar" data-key={bar.key}>
          <span className="ls-bar__label">{bar.label}</span>
          <div className="ls-bar__track">
            <div className="ls-bar__fill" style={{ width: `${pct(bar)}%` }} />
          </div>
          <span className="ls-bar__value">
            {bar.value}/{bar.max}
          </span>
        </div>
      ))}
    </div>
  );
}
