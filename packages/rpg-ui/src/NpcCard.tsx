import type { NpcVM } from "@life-sim/shared";
import { RelationList } from "./RelationList.js";

export interface NpcCardProps {
  /** NPC 卡投影（属性已带标签、关系已只留出边、生命周期文案已翻译）。 */
  npc: NpcVM;
}

/**
 * NPC 卡（世界页「人物」子页签）。默认收起详情：卡面只给身份 + 好感 + 已知目标，
 * 展开后是关系 / 状态 / 属性 / 生命周期四块。
 *
 * 所有数值与文案都来自投影：好感条长只是视觉辅助（-100..100 映射到 0..100%），
 * 属性值原样展示（0 也是有效值），关系句由 `RelationList` 统一拼。
 */
export function NpcCard({ npc }: NpcCardProps) {
  return (
    <section className={`card npc-card${npc.alive ? "" : " npc-card-inactive"}`}>
      <div className="row">
        <h2>{npc.name}</h2>
        <span className="tag">
          {npc.age} 岁 · {npc.genderLabel}
        </span>
      </div>
      <div className="chip-row npc-meta">
        <span className="chip">{npc.lifeStageLabel}</span>
        <span className="chip">关系 {npc.relationship}</span>
        {!npc.alive && <span className="chip npc-life-chip">{npc.lifeText}</span>}
      </div>
      <p className="muted">{npc.personality}</p>
      <div className="attr">
        <span className="attr-name">好感</span>
        <div className="bar">
          <div className="bar-fill relation" style={{ width: `${((npc.relationship + 100) / 200) * 100}%` }} />
        </div>
        <span className="attr-value">{npc.relationship}</span>
      </div>
      {npc.knownGoals.length > 0 && <p className="known-goals">已知目标：{npc.knownGoals.join("；")}</p>}
      <details className="npc-details">
        <summary>
          关系 {npc.relations.length} · 状态 {npc.statuses.length} · 属性 {npc.attributes.length}
        </summary>

        <div className="npc-block">
          <h3>关系</h3>
          <RelationList relations={npc.relations} subjectName={npc.name} />
        </div>

        <div className="npc-block">
          <h3>状态</h3>
          {npc.statuses.length === 0 ? (
            <p className="muted">无异常状态。</p>
          ) : (
            <div className="chip-row">
              {npc.statuses.map((s) => (
                <span key={s.id} className="chip">
                  {s.name}
                  {s.stacks > 1 ? ` ×${s.stacks}` : ""}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="npc-block">
          <h3>属性</h3>
          {npc.attributes.length === 0 ? (
            <p className="muted">暂无属性数据</p>
          ) : (
            <div className="npc-attrs">
              {npc.attributes.map((attr) => (
                <div key={attr.key} className="npc-attr">
                  <span className="npc-attr-name">{attr.label}</span>
                  <span className="npc-attr-value">{attr.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="npc-block">
          <h3>生命周期</h3>
          <p className="muted">
            <span className={`npc-life npc-life-${npc.lifeState}`}>{npc.lifeText}</span>
            {" · "}
            {npc.lifeStageLabel} · {npc.age} 岁
          </p>
        </div>
      </details>
    </section>
  );
}
