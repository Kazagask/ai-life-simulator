import { Fragment, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { ContentBlockVM, MediaVM } from "@life-sim/shared";
import type { ActHandler } from "./act.js";
import { CgStage } from "./CgStage.js";

/** 单个内容块的渲染函数：返回 `null` 表示这一块不占位。 */
export type BlockRenderer = (block: ContentBlockVM) => ReactNode;

export interface NarrativeStreamProps {
  /** 按时间顺序排列的内容块（AI 叙事正文的唯一展示面）。 */
  content: ContentBlockVM[];
  /**
   * 统一提交回调：叙事流里的 `option` 块点击后走这里，与 `ActionBar` 是同一条路径。
   * 缺省时选项只作展示（不可点），用于只读回放场景。
   */
  onAct?: ActHandler;
  /** 媒体列表（`kind === "asset"` 的内联块按 `assetId` 在这里解析）。 */
  media?: MediaVM[];
  /**
   * 按 `kind` 覆盖渲染器。默认覆盖 narrative / option / flavor / asset，
   * 未注册的 kind 一律按正文渲染 —— 服务端新增内容块类型时不需要改本组件。
   */
  renderers?: Partial<Record<string, BlockRenderer>>;
  /**
   * 请求进行中：选项按钮置灰并带 `aria-disabled`。
   * 引擎侧有 busy 锁兜底（不会双发），但玩家连点无反馈会以为卡死，所以视觉也要同步。
   */
  disabled?: boolean;
}

/**
 * 叙事流：本作的主文本面，同时是**第二个点击面**（选项块即按钮）。
 *
 * 观感约定（不是聊天窗口）：
 *  - 每个内容块是轻小说式正文，行高 / 版心宽松，逐块柔和淡入；
 *  - `option` 渲染成整行可点的选项胶囊（移动端 ≥44px 触控高度），点击走 `onAct`；
 *  - `flavor` 是小号斜体旁注；`asset` 内联一张媒体资源（每轮至多一张）；
 *  - 新块到达时自动滚到最新一块。
 *
 * 状态条 / 战斗面板**不在这里**：它们是常驻 HUD，绝不插进叙事流中间。
 */
export function NarrativeStream({ content, onAct, media = [], renderers, disabled = false }: NarrativeStreamProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const lastBlockId = content.length > 0 ? content[content.length - 1]?.blockId : undefined;

  useEffect(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    // 只滚到最新一行；jsdom / SSR 下 scrollHeight 为 0，赋值无副作用。
    el.scrollTop = el.scrollHeight;
  }, [content.length, lastBlockId]);

  if (content.length === 0) {
    return <p className="ls-narrative__empty">故事尚未开始。</p>;
  }

  /**
   * 每轮至多内联一张资源。
   *
   * 判据必须与 `NarrativeStage` 抑制顶部横幅的判据一致：取**第一个能解析到媒体**的
   * asset 块。若只看「第一个 asset 块」，而它的 assetId 在本轮 media 里缺失、
   * 后面某块又能解析 —— 横幅已被抑制、流里又被整体跳过，这一幕就成黑场。
   */
  const firstAssetIndex = content.findIndex(
    (block) =>
      block.kind === "asset" &&
      block.assetId !== undefined &&
      media.some((item) => item.assetId === block.assetId),
  );

  const defaults: Record<string, BlockRenderer> = {
    narrative: (block) => (
      <p className="ls-narrative__block ls-narrative__block--prose" data-kind={block.kind}>
        {block.text ?? ""}
      </p>
    ),
    flavor: (block) => (
      <p className="ls-narrative__block ls-narrative__block--flavor" data-kind={block.kind}>
        {block.text ?? ""}
      </p>
    ),
    option: (block) => {
      const text = block.text ?? "";
      if (onAct === undefined) {
        return (
          <span className="ls-choice ls-choice--static" data-kind={block.kind}>
            {text}
          </span>
        );
      }
      return (
        <button
          type="button"
          className="ls-choice"
          data-kind={block.kind}
          disabled={disabled}
          aria-disabled={disabled}
          onClick={() => onAct({ text, source: "option" })}
        >
          {text}
        </button>
      );
    },
    asset: (block) => {
      if (block.assetId === undefined) return null;
      const found = media.find((item) => item.assetId === block.assetId);
      if (found === undefined) return null;
      return <CgStage media={[found]} inline />;
    },
  };

  return (
    <div className="ls-narrative" ref={scrollerRef} role="log" aria-label="叙事">
      {content.map((block, index) => {
        if (block.kind === "asset" && index !== firstAssetIndex) return null;
        const render = renderers?.[block.kind] ?? defaults[block.kind] ?? defaults.narrative;
        // `blockId` 是内容块在 trace 里的稳定标识（agent-runtime 契约：optionId 不落块）。
        return <Fragment key={block.blockId}>{render?.(block)}</Fragment>;
      })}
    </div>
  );
}
