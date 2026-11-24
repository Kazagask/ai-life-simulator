import { useEffect, useRef } from "react";
import type { BattleFxVM } from "@life-sim/shared";
import { playCast, type FxContext, type FxSettings } from "./fx/engine.js";

export interface BattleFxLayerProps {
  /** 投影期解析好的四层结果（`battle.fx`）。 */
  fx?: BattleFxVM | undefined;
  /** 棋盘容器：锚点靠它做坐标换算。 */
  boardRef: { current: HTMLElement | null };
  /** P6 播放器设置；缺省只按 `prefers-reduced-motion` 猜。 */
  settings?: Partial<FxSettings> | undefined;
}

/**
 * 战斗表现层容器（ADR-076 §10）。
 *
 * React 只负责挂一个空容器，真正的绘制与排队在 `fx/engine.ts` 里用命令式完成 ——
 * 一次施放要连出几十个节点、按毫秒排队，交给 React 反复 diff 只会掉帧。
 *
 * **游标语义**：只播 `cast.seq > 游标` 的段。首次挂载时把游标推到 `fx.seq`，
 * 所以读档 / 刷新不会重放历史特效 —— 这是「一进战斗就炸一屏数字」的唯一防线。
 */
export function BattleFxLayer({ fx, boardRef, settings }: BattleFxLayerProps): React.JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const cursorRef = useRef<number | null>(null);
  const tokenRef = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    if (fx === undefined) return;
    const layer = layerRef.current;
    const svg = svgRef.current;
    const board = boardRef.current;
    if (!layer || !svg || !board) return;

    // 首次挂载：把游标推到当前最大值，不重放历史
    if (cursorRef.current === null) {
      cursorRef.current = fx.seq;
      return;
    }

    const pending = fx.casts.filter((c) => c.seq > (cursorRef.current ?? 0));
    if (pending.length === 0) {
      cursorRef.current = fx.seq;
      return;
    }

    // 游标立刻推进：下一帧的新快照不该把这一批再取一次（否则会重复播放）
    cursorRef.current = fx.seq;
    const token = ++tokenRef.current;
    const reduceMotion =
      settingsRef.current?.reduce ??
      (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const ctx: FxContext = {
      svg,
      layer,
      board,
      settings: {
        reduce: reduceMotion,
        fast: settingsRef.current?.fast ?? false,
        noFlash: settingsRef.current?.noFlash ?? false,
      },
      aborted: () => token !== tokenRef.current,
    };

    svg.innerHTML = "";
    layer.querySelectorAll(".fx-num, .fx-label, .fx-spark, .fx-ring, .fx-flash").forEach((n) => n.remove());

    void (async () => {
      for (const cast of pending) {
        if (ctx.aborted()) return;
        await playCast(ctx, cast);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只看序号：casts 数组每次快照都是新引用
  }, [fx?.seq]);

  useEffect(() => {
    return () => {
      tokenRef.current += 1; // 卸载时让在播的段自己停下
    };
  }, []);

  return (
    <div className="battle-fx" ref={layerRef} aria-hidden="true">
      <svg ref={svgRef} />
    </div>
  );
}
