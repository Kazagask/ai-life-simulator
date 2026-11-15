import type { ViewModel } from "@life-sim/shared";

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

// ---------- 提交边界（与服务端 zod 契约对齐） ----------

/**
 * `POST /api/worlds/:id/turns` 的 `description: z.string().max(200)`。
 *
 * 上限是**服务端契约**，不是某个组件的排版偏好，所以只在这里定义一次：
 * 所有点击面在构造请求体时统一按它截断。LLM 写出的选项块可能超长，不截断会让整轮 400。
 */
export const MAX_ACT_TEXT = 200;

/** 同一 schema 里 `type: z.string().min(1).max(40)`。 */
export const MAX_ACTION_TYPE = 40;

/** 自由行动的固定 type 值（与 `apps/web` 侧 `advanceTurn({ type: "free" })` 一致）。 */
export const FREE_ACTION_TYPE = "free";

/**
 * 文案归一：先 trim（服务端 min(1) 不接受纯空白），再硬截断。
 *
 * 刻意不加省略号：`…` 本身要占一个字符，反而会挤掉一个真字，视觉上也像"被截断了"。
 */
export function clampActText(text: string, max: number = MAX_ACT_TEXT): string {
  return text.trim().slice(0, max);
}

/** `/turns` 请求体的 action 部分。 */
export interface ActRequest {
  type: string;
  description: string;
}

/**
 * `Act` → `/turns` 请求体的**唯一**转换点（ActionBar / 选项块 / 自由输入三条路径共用）。
 *
 * - 动作 id 合法（非空且 ≤40）⇒ `{ type: id, description: "" }`；
 * - id 超长 / 为空 ⇒ 退回自由行动：把文案当 description 发出去。
 *   截断超长 id 会变成引擎不认识的另一个动作，只会换来另一种 400，不如按自由行动受理；
 * - 非动作来源 ⇒ `{ type: "free", description: clampActText(text) }`。
 */
export function toActPayload(act: Act): ActRequest {
  if (act.id !== undefined) {
    const id = act.id.trim();
    if (id !== "" && id.length <= MAX_ACTION_TYPE) return { type: id, description: "" };
  }
  return { type: FREE_ACTION_TYPE, description: clampActText(act.text) };
}

// ---------- 交互模式 ----------

/**
 * 交互模式：**同一时刻只能有一个点击面**。
 *
 * 引擎规则（`packages/game-core/src/v2/turn.ts` `pending_event_required`）：
 * 呈现槽非空时，任何 `/turns` 提交都会被拒 —— 只有 `/events/choose { optionId }` 合法。
 * 所以「自由行动按钮 / 选项块 / 手打输入」在同态下必须整体让位给事件面板。
 */
export type InteractionMode = "event" | "battle" | "free";

/**
 * 从视图模型推导交互模式。
 *
 * 顺序很重要：战斗时快照同时带 `battle` 与 `slotEvent(kind: "combat")`，
 * 先判 `battle` 才不会把战斗误判成可选项事件。
 */
export function interactionMode(view: Pick<ViewModel, "slot" | "battle">): InteractionMode {
  if (view.battle !== null) return "battle";
  if (view.slot !== null) return "event";
  return "free";
}