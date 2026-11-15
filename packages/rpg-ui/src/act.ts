/**
 * 点击为主的**统一提交类型**。
 *
 * 产品裁决「点击为主，打字输入为辅」：场景选项（叙事流里的 `option` 块）、
 * 行动栏按钮、手打自由行动三者共用一个回调，不设第二条提交路径。
 *
 * 载荷语义：
 *  - `source: "action"` —— 模板下发的行动，`id` 是引擎认识的动作 id；
 *  - `source: "option"` —— 叙事流里的选项块，只有 `text`（`ContentBlock` 不携带 optionId，
 *    引擎侧按自由行动语义受理）；
 *  - `source: "free"` —— 玩家手打的自由行动，只有 `text`。
 */
export interface Act {
  /** 模板动作 id；仅 `source: "action"` 时存在。 */
  id?: string;
  /** 展示文案：动作名 / 选项文案 / 手打正文。 */
  text: string;
  source: "action" | "option" | "free";
}

export type ActHandler = (act: Act) => void;
