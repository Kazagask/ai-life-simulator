import type { ActionVM, BattleVM } from "@life-sim/shared";
import type { ActHandler } from "./act.js";

export interface ActionBarProps {
  actions: ActionVM[];
  /** 统一提交回调：与叙事流里的选项块共用同一个（不设第二条提交路径）。 */
  onAct: ActHandler;
  /**
   * 战斗镜像。**非 null 时整条动作栏禁用**：战斗中的行动必须走战斗命令，
   * 自由行动的 id 对引擎无意义（服务端会以交互顺序冲突拒绝）。
   */
  battle?: BattleVM | null;
  /** 请求进行中：与战斗禁用一起生效，避免连点。 */
  busy?: boolean;
  /**
   * 「自由行动…」入口的点击回调（投影裁决 #3：打字输入折叠到这个入口后面）。
   * 缺省时该入口仍然渲染（点击无副作用），保证空态不会是一片空白。
   */
  onFreeAction?: () => void;
  /** 自由行动入口的文案，缺省「自由行动…」。 */
  freeActionLabel?: string;
}

/**
 * 行动栏：默认前端的**主点击面**（点击为主，打字为辅）。
 *
 * 版式规则：
 *  - ≤ 4 个动作 ⇒ 单列卡片（label + 一行说明），拇指区更容易点中；
 *  - 更多动作 ⇒ 两列网格（仍保证单卡 ≥ 48px 高）；
 *  - `availableActions` 为空 ⇒ 只渲染「自由行动…」入口，而不是一块空白或禁用容器。
 */
export function ActionBar({
  actions,
  onAct,
  battle = null,
  busy = false,
  onFreeAction,
  freeActionLabel = "自由行动…",
}: ActionBarProps) {
  const disabled = busy || battle !== null;
  const layout = actions.length <= 4 ? "stack" : "grid";

  return (
    <div className="ls-actionbar" role="group" aria-label="可选行动">
      {actions.length > 0 && (
        <div className="ls-actionbar__list" data-layout={layout}>
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="ls-action"
              disabled={disabled}
              aria-disabled={disabled}
              onClick={() => onAct({ id: action.id, text: action.label, source: "action" })}
            >
              <strong className="ls-action__label">{action.label}</strong>
              {action.description !== "" && <span className="ls-action__desc">{action.description}</span>}
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
        {freeActionLabel}
      </button>
    </div>
  );
}
