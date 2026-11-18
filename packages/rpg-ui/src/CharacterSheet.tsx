import type { EvaluationVM, PlayerVM, StatusVM } from "@life-sim/shared";
import { AiNarrativeTag } from "./AiNarrativeTag.js";
import { EvaluationPanel } from "./EvaluationPanel.js";
import { StyledName, styleBoxClassName, styleBoxInline } from "./StyledName.js";

export interface CharacterSheetProps {
  /** 玩家卡投影（属性条已按模板顺序排好、`proficiency*` 已剔除）。 */
  player: PlayerVM;
  /** 人生评价；总结行与分项都从这里取。 */
  evaluation: EvaluationVM;
  /**
   * 卡内那行总结的正文。缺省用 `evaluation.summary`；宿主若有更好的来源
   * （例如平台补写的人生总结）从外面传进来，组件不自己请求。
   */
  summary?: string;
  /** 这行总结是否由 AI 补写（true ⇒ 行尾带「AI 叙事」小标记）。 */
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
 * 玩家状态卡（人生页顶部的常驻面板）：身份行 + 三条资源条 + 属性条 + 状态芯片 +
 * 一行人生总结 + 五维评价分项。
 *
 * 所有数值都来自 `ViewModel`：等级、分数、档位文案都是服务端原值，这里只负责排布。
 * 评价分项是否出现由 `evaluation.ended` 决定（跑动中整块不渲染，见 `EvaluationPanel`）。
 */
export function CharacterSheet({
  player,
  evaluation,
  summary,
  summaryFromAi = false,
  onSelectStatus,
}: CharacterSheetProps) {
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
      <div className="attrs">
        {player.attributes.map((attr) => (
          <div key={attr.key} className="attr">
            <span className="attr-name">{attr.label}</span>
            <div className="bar">
              <div className="bar-fill" style={{ width: `${Math.min(100, Math.max(4, attr.value))}%` }} />
            </div>
            <span className="attr-value">{String(attr.value)}</span>
          </div>
        ))}
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
      <p className="eval-line">
        {summary ?? evaluation.summary}
        {summaryFromAi && <AiNarrativeTag />}
      </p>
      <EvaluationPanel evaluation={evaluation} />
    </section>
  );
}
