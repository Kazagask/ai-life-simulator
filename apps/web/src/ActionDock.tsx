import { useEffect, useRef, useState } from "react";
import { ActionBar } from "@life-sim/rpg-ui";
import type { ActHandler, ViewModel } from "@life-sim/rpg-ui";

/**
 * 底部行动坞（产品裁决：点击为主，打字为辅）。
 *
 * - 常驻固定贴在底部 tabbar 之上（拇指区），不随长叙事被推走；
 * - 动作按钮由 `ActionBar` 渲染，点击走统一的 `onAct`；
 * - 「自由行动…」入口把原来的裸输入框折叠起来，点开才展开 ——
 *   打字功能一字未减，只是不再和按钮抢视觉重心。
 */
export function ActionDock({
  view,
  busy,
  onAct,
}: {
  view: ViewModel;
  busy: boolean;
  onAct: ActHandler;
}) {
  const [freeOpen, setFreeOpen] = useState(false);
  const [freeText, setFreeText] = useState("");
  const dockRef = useRef<HTMLDivElement | null>(null);

  /**
   * 把行动坞的实测高度写进 `--dock-h`：正文区的底部留白据此精确避让，
   * 既不会被坞盖住最后一张卡片，也不会在动作少时留一大片空白。
   * 展开自由输入时高度会变，ResizeObserver 跟着更新。
   */
  useEffect(() => {
    const el = dockRef.current;
    if (el === null) return;
    const root = document.documentElement;
    const sync = () => root.style.setProperty("--dock-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    sync();
    if (typeof ResizeObserver === "undefined") {
      return () => root.style.removeProperty("--dock-h");
    }
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--dock-h");
    };
  }, []);

  const submit = () => {
    const text = freeText.trim();
    if (text === "") return;
    onAct({ text, source: "free" });
    setFreeText("");
    setFreeOpen(false);
  };

  return (
    <div className="action-dock" ref={dockRef}>
      <div className="action-dock__inner">
        <ActionBar
          actions={view.availableActions}
          onAct={onAct}
          battle={view.battle}
          busy={busy}
          freeActionLabel={freeOpen ? "收起自由行动" : "自由行动…"}
          onFreeAction={() => setFreeOpen((open) => !open)}
        />
        {freeOpen && (
          <div className="free-input free-input--dock">
            <input
              autoFocus
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              placeholder="或自由描述你的行动…"
              maxLength={100}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
            <button className="primary" disabled={busy || freeText.trim() === ""} onClick={submit}>
              执行
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
