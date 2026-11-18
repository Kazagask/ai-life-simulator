import type { EvaluationVM, PlayerVM, StatusVM } from "@life-sim/shared";
import { EvaluationPanel } from "./EvaluationPanel.js";
import { StyledName, styleBoxClassName, styleBoxInline } from "./StyledName.js";

export interface CharacterSheetProps {
  /** 玩家卡投影（属性条已按模板顺序排好、`proficiency*` 已剔除）。 */
  player: PlayerVM;
  /** 人生评价；总结行与分项都从这里取。 */
  evaluation: EvaluationVM;
  /**
   * @deprecated 2026-11-18：卡面**不再显示**总结行（「本局共记录 N 条经历，M 项维度已评分」
   * 占位太多且信息密度低，用户要求移除）。字段保留只为兼容宿主调用方，传了也不渲染。
   */
  summary?: string;
  /** @deprecated 同上：总结行已移除，AI 标记无处可挂。 */
  summaryFromAi?: boolean;
  /**
   * 点击补正芯片（R-DETAIL-05）：宿主据此打开毛玻璃详情。
   * 不传 ⇒ 芯片保持只读（自定义前端没有浮层时也不出现「点了没反应」）。
   */
  onSelectStatus?: (status: StatusVM) => void;
}

/** 卡头一条资源条：条长只是视觉辅助，数值原样展示。 */
function ResourceBar({ label, value, max, cls }: { label: string; value: number; max: number; cls: string }) {
  const pct = Math.min(100, Math.max(0, (value / Math.max(1, max)) * 100));
  return (
    <div className="attr">
      <span className="attr-name">{label}</span>
      <div className="bar">
        <div className={`bar-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="attr-value">{value}/{max}</span>
    </div>
  );
}

/**
 * 玩家状态卡（人生页顶部的常驻面板）：身份行 + 三条资源条 + 状态芯片 +（结局后）五维分项。
 *
 * 2026-11-18 用户精简（竖屏里叙事区被挤得太小、出事件不好操作）：
 * - **属性条整块移除**：六条属性常驻占掉约 1/6 屏，信息密度却低于「需要时去个人页看」；
 * - **总结行移除**：`本局共记录 19 条经历，5 项维度已评分` 是过程指标，不是玩家要读的内容。
 * 资源条（生命 / 咒力 / 心情）与补正芯片保留——那是每回合都要扫一眼的东西。
 *
 * 所有数值都来自 `ViewModel`：等级、分数、档位文案都是服务端原值，这里只负责排布。
 * 评价分项是否出现由 `evaluation.ended` 决定（跑动中整块不渲染，见 `EvaluationPanel`）。
 */
export function CharacterSheet({ player, evaluation, onSelectStatus }: CharacterSheetProps) {
  return (
    <section className="card player-card">
      <div className="row">
        <h2>{player.name}</h2>
        <span className="tag">
          {player.age} 岁 · {player.genderLabel}
        </span>
      </div>
      <div className="attrs">
        <ResourceBar label={player.labels.hp} value={player.hp} max={player.maxHp} cls="hp" />
        <ResourceBar label={player.labels.mp} value={player.mp} max={player.maxMp} cls="mp" />
        <ResourceBar label={`${player.labels.mood} · ${player.moodBandLabel}`} value={player.mood} max={100} cls="mood" />
      </div>
      {player.statuses.length > 0 && (
        <div className="status-chips">
          {player.statuses.map((s) => {
            const label = (
              <>
                <StyledName name={s.name} style={s.style} />
                {s.stacks > 1 ? `×${s.stacks}` : ""}
              </>
            );
            const box = [styleBoxClassName(s.style)].filter(Boolean).join(" ");
            const boxStyle = styleBoxInline(s.style);
            return onSelectStatus === undefined ? (
              <span key={s.id} className={`chip status-chip${box === "" ? "" : ` ${box}`}`} style={boxStyle}>
                {label}
              </span>
            ) : (
              <button
                key={s.id}
                type="button"
                className={`chip status-chip status-chip--action${box === "" ? "" : ` ${box}`}`}
                style={boxStyle}
                onClick={() => onSelectStatus(s)}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      <EvaluationPanel evaluation={evaluation} />
    </section>
  );
}
