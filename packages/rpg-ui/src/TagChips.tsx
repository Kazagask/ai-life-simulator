import type { ResolvedTag } from "@life-sim/shared";
import { StyledName, styleBoxClassName, styleBoxInline } from "./StyledName.js";

/**
 * 标签行（ADR-002 D2b）。
 *
 * 标签是**模板自己的词**（神话 / 增益 / 减益），不是引擎的样式名（rainbow / green）。
 * 每个标签带自己的样式，所以同一行里可以既有金色的品级、又有绿色的增益。
 *
 * 为什么单独成组件：状态浮层、装备详情、收获卡都要同一套观感；各写一遍必然漂移。
 */
export interface TagChipsProps {
  tags?: ResolvedTag[];
  /** 额外的容器类名（例如放进已有的 tag-row）。 */
  className?: string;
}

export function TagChips({ tags, className }: TagChipsProps) {
  if (tags === undefined || tags.length === 0) return null;
  const cls = ["ls-tagchips", className].filter((c): c is string => c !== undefined && c !== "").join(" ");
  return (
    <div className={cls}>
      {tags.map((tag) => {
        const box = styleBoxClassName(tag.style);
        return (
          <span
            key={tag.id}
            className={`ls-tag${box === undefined ? "" : ` ${box}`}`}
            style={styleBoxInline(tag.style)}
          >
            <StyledName name={tag.name} style={tag.style} />
          </span>
        );
      })}
    </div>
  );
}
