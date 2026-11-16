import { Fragment } from "react";
import type { ContentBlockVM } from "@life-sim/shared";
import type { ActHandler } from "./act.js";
import { renderOptionBlock } from "./NarrativeStream.js";

export interface OptionDeckProps {
  /**
   * **只传 `kind === "option"` 的块**（调用方过滤，组件不猜）。
   * 传空数组 ⇒ 返回 `null`：不占位、不出空标题。
   */
  blocks: ContentBlockVM[];
  /**
   * 缺省 ⇒ 渲染成静态引述（槽非空 / 战斗中时不可点）。
   * 有 ⇒ 走与行动坞同一条 `Act` 提交路径（`source: "option"`）。
   */
  onAct?: ActHandler;
  /** 请求在飞：按钮置灰并带 `aria-disabled`（与 `ActionBar` 同一忙态口径）。 */
  disabled?: boolean;
}

/**
 * 事件区的 AI 选项面：把 LLM 写的 `option` 块铺在事件区里（`ActionPanel` 上方）。
 *
 * 为什么单独一个组件，而不是留在叙事流里：
 *  - 选项是「要点」，不是散文 —— 叙事区只放 narrative / flavor / asset；
 *  - 引擎事件面板的选项（`slotEvent.options`，提交 `optionId`）与 AI 选项（提交文本）
 *    在同一个区域，玩家不用分辨自己点的是哪一个点击面。
 *
 * 点击行为**完全复用** `renderOptionBlock`（同 44px 触控高度、同 `aria-disabled`、
 * 同 `{ text, source: "option" }` 载荷），这里只负责排版，不另写一套判定。
 */
export function OptionDeck({ blocks, onAct, disabled = false }: OptionDeckProps) {
  if (blocks.length === 0) return null;
  return (
    <div className="ls-option-deck" role="group" aria-label="本轮选项">
      {blocks.map((block) => (
        <Fragment key={block.blockId}>{renderOptionBlock(block, { onAct, disabled })}</Fragment>
      ))}
    </div>
  );
}
