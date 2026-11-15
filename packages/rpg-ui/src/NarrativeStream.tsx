import { useEffect, useRef } from "react";
import type { ContentBlockVM } from "@life-sim/shared";

export interface NarrativeStreamProps {
  /** 按时间顺序排列的内容块（AI 叙事正文的唯一展示面）。 */
  content: ContentBlockVM[];
}

/** 已知的内容块类型 → 展示形态；未知类型按正文处理（服务端新增 kind 不会让前端崩）。 */
type BlockShape = "prose" | "choice" | "flavor";

function shapeOf(kind: string): BlockShape {
  if (kind === "option") return "choice";
  if (kind === "flavor") return "flavor";
  return "prose";
}

/**
 * 叙事流：本作的主文本面（交互优先、AI 叙事为骨）。
 *
 * 观感约定（不是聊天窗口）：
 *  - 每个内容块是一段轻小说式正文，行高 / 版心宽松，逐块柔和淡入；
 *  - `option` 渲染成选项徽记（说明「这里曾有过选择」），`flavor` 渲染成小号斜体旁注；
 *  - 新块到达时自动滚到最新一块，玩家不需要手动往下拖。
 */
export function NarrativeStream({ content }: NarrativeStreamProps) {
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

  return (
    <div className="ls-narrative" ref={scrollerRef} role="log" aria-label="叙事">
      {content.map((block, index) => {
        const shape = shapeOf(block.kind);
        const text = block.text ?? "";
        const key = `${block.blockId}#${index}`;
        if (shape === "choice") {
          return (
            <span key={key} className="ls-narrative__choice" data-kind={block.kind}>
              {text}
            </span>
          );
        }
        if (shape === "flavor") {
          return (
            <p key={key} className="ls-narrative__block ls-narrative__block--flavor" data-kind={block.kind}>
              {text}
            </p>
          );
        }
        return (
          <p key={key} className="ls-narrative__block ls-narrative__block--prose" data-kind={block.kind}>
            {text}
          </p>
        );
      })}
    </div>
  );
}
