import type { EventOptionVM } from "@life-sim/shared";

export interface EventPanelProps {
  title: string;
  /** 场景正文；缺省时按空串渲染（不回填标题）。 */
  narrative?: string;
  /** 选项（服务端已按 `visibleWhen` 过滤；`id` 是引擎分配的真 optionId）。 */
  options: EventOptionVM[];
  /** 请求在飞：选项置灰（引擎同样会拒）。 */
  busy?: boolean;
  /** 选择回调：原样回传 optionId，组件内部不发请求。 */
  onChoose?: (optionId: string) => void;
}

/**
 * 待决事件面板（事件区的 normal 分支）：标题 + 正文 + 可点选项。
 *
 * 这里**只有**引擎给出的 `optionId` 选项：它们是唯一合法的提交（走 `/events/choose`）。
 * LLM 写的文本块不再渲染成按钮（那批只能按自由行动受理，与真选项是两套东西）。
 * 投影字段缺失时按空数组处理并显示「没有可选项」，不要整页崩在 `undefined.map`。
 */
export function EventPanel({ title, narrative, options, busy = false, onChoose }: EventPanelProps) {
  return (
    <div className="event-body">
      <h2>{title}</h2>
      <p>{narrative}</p>
      <div className="option-list">
        {options.map((opt) => (
          <button key={opt.id} className="option" disabled={busy} onClick={() => onChoose?.(opt.id)}>
            {opt.text}
          </button>
        ))}
      </div>
      {options.length === 0 && <p className="muted">（没有可选项……）</p>}
    </div>
  );
}
