import { useEffect, useState } from "react";

export interface GmWorkingStripProps {
  /** 回结算请求是否在飞（由宿主提供，组件自己不发请求）。 */
  busy: boolean;
}

/**
 * 「GM 推演中」计时条：请求在飞时显示，并按等待时长分档给一句进度提示。
 *
 * 计时器只在本组件内跑：挂载到 `busy` 变真的那一刻开始，`busy` 变假立即归零。
 * 文案分档（6s / 20s）只是给等待一个说法，不参与任何超时或重试判定。
 */
export function GmWorkingStrip({ busy }: GmWorkingStripProps) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [busy]);
  if (!busy) return null;
  const hint = elapsed < 6 ? "正在读取世界" : elapsed < 20 ? "正在编排这一幕" : "正在收尾";
  return (
    <div className="gm-working" role="status" aria-live="polite">
      <span className="gm-working__dot" aria-hidden="true" />
      <span className="gm-working__text">GM 推演中 · {hint}</span>
      <span className="gm-working__elapsed">{elapsed}s</span>
    </div>
  );
}
