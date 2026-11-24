import { StyledName } from "./StyledName.js";
import type { EvaluationVM, PlayerVM, StatusVM } from "@life-sim/shared";
import { EvaluationPanel } from "./EvaluationPanel.js";
import { StatusBoard } from "./StatusBoard.js";
import { AttributeValue } from "./AttributeList.js";

export interface CharacterSheetProps {
  /** 玩家卡投影（属性条已按模板顺序排好、`proficiency*` 已剔除）。 */
  player: PlayerVM;
  /**
   * 人生评价；**收束后由结局卡统一展示**（2026-11-21），这里默认不传。
   *
   * 为什么从卡面搬走：结局卡就在同一屏下方，卡面再画一遍五维分项 + 总评，
   * 等于同一份数据上下各出现一次（实机截图上相隔不到 100px）。传了仍然渲染，
   * 供没有结局卡的宿主复用。
   */
  evaluation?: EvaluationVM;
  /**
   * @deprecated 2026-11-18：卡面**不再显示**总结行（「本局共记录 N 条经历，M 项维度已评分」
   * 占位太多且信息密度低，用户要求移除）。字段保留只为兼容宿主调用方，传了也不渲染。
   */
  summary?: string;
  /** @deprecated 同上：总结行已移除，AI 标记无处可挂。 */
  summaryFromAi?: boolean;
  /**
   * 点击状态芯片（R-DETAIL-05）：宿主据此打开毛玻璃详情。
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

/** 刻度资源（ADR-003 D10）：max 个格子、填充 value 个；数值仍以文字给出。 */
function PipBar({ label, value, max }: { label: string; value: number; max: number }) {
  const count = Math.max(1, Math.round(max));
  const filled = Math.min(count, Math.max(0, Math.round(value)));
  return (
    <div className="attr">
      <span className="attr-name">{label}</span>
      <div className="ls-bar__pips" role="img" aria-label={`${label} ${value}/${max}`}>
        {Array.from({ length: count }, (_, i) => (
          <span key={i} className={`ls-pip${i < filled ? " is-filled" : ""}`} />
        ))}
      </div>
      <span className="attr-value">
        {value}/{max}
      </span>
    </div>
  );
}

/**
 * 玩家状态卡（人生页顶部的常驻面板）：身份行 + 属性胶囊 + 资源条 + 状态芯片 +（结局后）五维分项。
 *
 * 2026-11-18 用户精简（竖屏里叙事区被挤得太小、出事件不好操作）：六条**数值属性条**整块移除，
 * 需要时去个人页看；总结行也移除（过程指标，不是玩家要读的内容）。
 * 2026-11-19 用户补充：文本属性（等级 / 身份 / 名誉）必须回到人生页——它们是身份的一部分，
 * 藏进个人页等于「这一世是什么等级」看不见。因此改为**一行可换行的胶囊**（`ls-sheet-attrs`），
 * 比原来的六条进度条矮得多，且直接吃投影下发的 label / display / style。
 *
 * 资源条（生命 / 法力 / 心情）与状态芯片保留——那是每回合都要扫一眼的东西。
 * 所有数值都来自 `ViewModel`：等级、分数、档位文案都是服务端原值，这里只负责排布。
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
      {player.cardAttributes.length > 0 && (
        <div className="ls-sheet-attrs">
          {/* 按 `ui.yaml playerCard.attributes` 的顺序渲染：
              数值 / 枚举 / 复合 = 三列一格；`ladder` = 整行一条（带进度条）。
              不做胶囊 —— 会和下面的状态芯片撞样式（用户 2026-11-19 反馈）。 */}
          {player.cardAttributes.map((attr) => {
            if (attr.kind !== "ladder") {
              return (
                <div key={attr.key} className="ls-sheet-attr">
                  <span className="ls-sheet-attr__label">{attr.label}</span>
                  <span className="ls-sheet-attr__value">
                    <AttributeValue attr={attr} />
                  </span>
                </div>
              );
            }
            const pct =
              attr.progress === undefined
                ? 0
                : Math.min(100, Math.max(0, (attr.progress.value / Math.max(1, attr.progress.max)) * 100));
            return (
              <div key={attr.key} className="ls-sheet-attr ls-sheet-attr--row">
                <span className="ls-sheet-attr__label">{attr.label}</span>
                <span className="ls-sheet-attr__value">
                  <StyledName
                    name={attr.tier?.label ?? attr.display}
                    style={attr.tier?.style ?? attr.style}
                  />
                </span>
                <span className="bar ls-sheet-attr__track">
                  <span className="bar-fill ladder" style={{ width: `${pct}%` }} />
                </span>
                {attr.progress !== undefined && (
                  <span className="ls-sheet-attr__num">
                    {attr.progress.value}/{attr.progress.max}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="attrs">
        {/* ADR-003：资源条 = 模板 statusBar 声明的资源（含自定义），顺序原样；心情固定殿后。 */}
        {player.resources.map((r) =>
          r.display === "pips" && r.max <= 12 ? (
            <PipBar key={r.key} label={r.label} value={r.value} max={r.max} />
          ) : (
            <ResourceBar
              key={r.key}
              label={r.label}
              value={r.value}
              max={Math.max(1, r.max)}
              cls={r.key === "hp" ? "hp" : r.key === "mp" ? "mp" : "res"}
            />
          ),
        )}
        <ResourceBar label={`${player.labels.mood} · ${player.moodBandLabel}`} value={player.mood} max={100} cls="mood" />
      </div>
      {/* 首页只列「有什么」：天赋与修正的名片，不摊合计数字（那属于个人页）。 */}
      <StatusBoard
        statuses={player.statuses}
        showLedger={false}
        showDuration={false}
        onSelectStatus={onSelectStatus}
      />
      {/* 评价默认不传：收束后由结局卡统一展示（见 props 注释）。 */}
      {evaluation && <EvaluationPanel evaluation={evaluation} />}
    </section>
  );
}
