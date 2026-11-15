import type { ActionVM, BattleVM } from "@life-sim/shared";

export interface ActionBarProps {
  actions: ActionVM[];
  onAction: (id: string) => void;
  /**
   * 战斗镜像。**非 null 时整条动作栏禁用**：战斗中的行动必须走战斗命令，
   * 自由行动的 id 对引擎无意义（服务端会以交互顺序冲突拒绝）。
   */
  battle?: BattleVM | null;
  /** 请求进行中：与战斗禁用一起生效，避免连点。 */
  busy?: boolean;
}

/**
 * 行动栏：把 `availableActions` 渲染成按钮，锚定在阅读区底部（交互优先）。
 * 无动作时给一行中性提示，而不是渲染空容器（空槽 + 无动作 = 模板没给动作表）。
 */
export function ActionBar({ actions, onAction, battle = null, busy = false }: ActionBarProps) {
  const disabled = busy || battle !== null;
  if (actions.length === 0) {
    return <p className="ls-actions__empty">此刻没有可选的行动。</p>;
  }
  return (
    <div className="ls-actions" role="group" aria-label="可选行动">
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className="ls-action"
          disabled={disabled}
          aria-disabled={disabled}
          title={action.description}
          onClick={() => onAction(action.id)}
        >
          <strong className="ls-action__label">{action.label}</strong>
          {action.description !== "" && <span className="ls-action__desc">{action.description}</span>}
        </button>
      ))}
    </div>
  );
}
