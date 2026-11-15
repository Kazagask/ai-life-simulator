import type { StatusBarVM } from "@life-sim/shared";

export interface StatusBarsProps {
  bars: StatusBarVM[];
}

function pct(b: StatusBarVM): number {
  const max = Math.max(1, b.max);
  return Math.min(100, Math.max(0, (b.value / max) * 100));
}

/**
 * 资源条（HP / MP）：常驻 HUD，**不参与叙事流排版**。
 *
 * 分工：阈值判定（danger）由适配器算在 `tone` 上，本组件只按 `tone` 上色，
 * 不写任何 `value <= 25 ? …` 规则；空集合是**一等状态**（渲染一条占位提示），
 * 直接 `return null` 会让 HUD 无声消失，玩家以为界面坏了。
 */
export function StatusBars({ bars }: StatusBarsProps) {
  if (bars.length === 0) {
    return <p className="ls-bars__empty">暂无资源条</p>;
  }
  return (
    <div className="ls-bars">
      {bars.map((bar) => (
        <div key={bar.key} className="ls-bar" data-key={bar.key} data-tone={bar.tone}>
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
