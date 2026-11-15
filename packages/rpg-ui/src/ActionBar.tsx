import { useState } from "react";
import type { ActionVM } from "@life-sim/shared";
import type { ActHandler, InteractionMode } from "./act.js";

export interface ActionBarProps {
  actions: ActionVM[];
  /** 统一提交回调：与叙事流里的选项块共用同一个（不设第二条提交路径）。 */
  onAct: ActHandler;
  /**
   * 交互模式（`interactionMode(view)`）：**同一时刻只能有一个点击面**。
   * 非 `"free"` 时整条动作栏不可提交 —— 槽内有待决事件时 `/turns` 必被引擎拒绝
   * （`pending_event_required`），战斗中的行动也必须走战斗命令。
   */
  mode?: InteractionMode;
  /** 请求进行中：与模式禁用一起生效，避免连点。 */
  busy?: boolean;
  /**
   * 「自由行动…」入口的点击回调（打字输入折叠到这个入口后面）。
   * 缺省时该入口仍然渲染（点击无副作用），保证空态不会是一片空白。
   */
  onFreeAction?: () => void;
  /** 自由行动入口的文案，缺省「自由行动…」。 */
  freeActionLabel?: string;
  /** 初始是否展开全部动作（默认收起，只露前 2 个）。仅供宿主预展开 / 测试使用。 */
  initialExpanded?: boolean;
}

/** 非自由行动阶段，动作卡上的一句解释（只挂在第一张，避免刷屏）。 */
const MODE_HINT: Record<Exclude<InteractionMode, "free">, string> = {
  event: "先处理眼前的事",
  battle: "战斗中使用战斗指令",
};

/**
 * 收起态露出的动作数。
 *
 * 为什么是 2：首个动作是「情境主行动」，必须一直在首屏；第二个让玩家看到"还有选择"。
 * 再往上堆，行动坞就会吃掉半个屏幕，把叙事流里的选项块（第二点击面）挤到折叠线以下 ——
 * 412×890 实测 4 个动作约 400px，叙事区只剩 ~300px。
 */
const COLLAPSED_COUNT = 2;

/**
 * 行动栏：默认前端的**主点击面**（点击为主，打字为辅）。
 *
 * 版式规则：
 *  - 收起态只露前 `COLLAPSED_COUNT` 个动作，其余收进「更多动作」；
 *  - 展开后列表**自身**滚动且限高（`40dvh`），行动坞永远不超过半屏；
 *  - ≤ 4 个动作 ⇒ 单列卡片（label + 一行说明），拇指区更容易点中；
 *  - 更多动作 ⇒ 两列网格（仍保证单卡 ≥ 48px 高）；
 *  - `availableActions` 为空 ⇒ 只渲染「自由行动…」入口，而不是一块空白或禁用容器。
 *
 * 模式规则：`mode === "free"` 才可提交；`"event"` / `"battle"` 一律置灰并在首卡给出原因 ——
 * 这两个状态下唯一合法输入分别是事件面板的 `optionId` 和战斗指令。
 */
export function ActionBar({
  actions,
  onAct,
  mode = "free",
  busy = false,
  onFreeAction,
  freeActionLabel = "自由行动…",
  initialExpanded = false,
}: ActionBarProps) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const disabled = busy || mode !== "free";
  const layout = actions.length <= 4 ? "stack" : "grid";
  const collapsible = actions.length > COLLAPSED_COUNT;
  const visible = expanded || !collapsible ? actions : actions.slice(0, COLLAPSED_COUNT);
  const hiddenCount = actions.length - visible.length;

  return (
    <div
      className="ls-actionbar"
      role="group"
      aria-label="可选行动"
      data-mode={mode}
      data-expanded={collapsible ? String(expanded) : undefined}
    >
      {actions.length > 0 && (
        <div className="ls-actionbar__list" data-layout={layout}>
          {visible.map((action, index) => (
            <button
              key={action.id}
              type="button"
              className="ls-action"
              disabled={disabled}
              aria-disabled={disabled}
              onClick={() => {
                if (disabled) return;
                onAct({ id: action.id, text: action.label, source: "action" });
              }}
            >
              <strong className="ls-action__label">{action.label}</strong>
              {action.description !== "" && <span className="ls-action__desc">{action.description}</span>}
              {index === 0 && mode !== "free" && (
                <span className="ls-action__hint">{MODE_HINT[mode]}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {collapsible && (
        <div className="ls-actionbar__row">
          <button
            type="button"
            className="ls-actionbar__more"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "收起动作" : `更多动作（${hiddenCount}）`}
          </button>
          <button
            type="button"
            className="ls-actionbar__free"
            disabled={disabled}
            onClick={() => onFreeAction?.()}
          >
            {mode === "free" ? freeActionLabel : "当前只能处理眼前的事"}
          </button>
        </div>
      )}
      {!collapsible && (
        <button
          type="button"
          className="ls-actionbar__free"
          disabled={disabled}
          onClick={() => onFreeAction?.()}
        >
          {mode === "free" ? freeActionLabel : "当前只能处理眼前的事"}
        </button>
      )}
    </div>
  );
}
