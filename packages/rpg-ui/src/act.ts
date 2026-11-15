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

/**
 * 点击提交文案的长度上限（与 `POST /turns` 的 `description: z.string().max(200)` 对齐）。
 *
 * 上限是**服务端契约**，不是某个组件的排版偏好，所以只在这里定义一次：
 * 宿主在把 `Act.text` 转成请求体时按它截断；组件不做长度判断、也不各自定长。
 * LLM 写出的选项块理论上可能超长，不截断会让整轮 400。
 */
export const MAX_ACT_TEXT = 200;
