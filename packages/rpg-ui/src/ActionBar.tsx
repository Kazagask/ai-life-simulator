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
}

/** 非自由行动阶段，动作卡上的一句解释（只挂在第一张，避免刷屏）。 */
const MODE_HINT: Record<Exclude<InteractionMode, "free">, string> = {
  event: "先处理眼前的事",
  battle: "战斗中使用战斗指令",
};

/**
 * 行动栏：默认前端的**主点击面**（点击为主，打字为辅）。
 *
 * 版式规则：
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
}: ActionBarProps) {
  const disabled = busy || mode !== "free";
  const layout = actions.length <= 4 ? "stack" : "grid";

  return (
    <div className="ls-actionbar" role="group" aria-label="可选行动" data-mode={mode}>
      {actions.length > 0 && (
        <div className="ls-actionbar__list" data-layout={layout}>
          {actions.map((action, index) => (
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
      <button
        type="button"
        className="ls-actionbar__free"
        disabled={disabled}
        onClick={() => onFreeAction?.()}
      >
        {mode === "free" ? freeActionLabel : "当前只能处理眼前的事"}
      </button>
    </div>
  );
}
