import type { NpcVM, StatusVM } from "@life-sim/shared";
import { RelationList } from "./RelationList.js";
import { StyledName, styleBoxClassName, styleBoxInline } from "./StyledName.js";

export interface NpcDetailsProps {
  /** NPC 卡投影（关系已只留出边、属性已带标签、生命周期文案已翻译）。 */
  npc: NpcVM;
  /** 点开补正详情（ADR-002 / R-DETAIL-05）：NPC 身上的补正同样能点。 */
  onSelectStatus?: (status: StatusVM) => void;
}

/**
 * NPC 卡里可折叠的详情展开区：关系 / 状态 / 属性 / 生命周期四块。
 *
 * 从 `NpcCard` 拆出来的理由：它是宿主可覆盖的独立 UI 槽（`HOST_UI_SLOTS.npcDetails`）。
 * 扩展替换这一块时拿到的 props 与默认实现完全相同，不需要认识宿主里的其他状态。
 *
 * 所有数值与文案都来自投影；好感条只画在卡面上，这里不重复。
 */
export function NpcDetails({ npc, onSelectStatus }: NpcDetailsProps) {
  return (
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
            {npc.statuses.map((s) => {
              const box = [styleBoxClassName(s.style)].filter(Boolean).join(" ");
              const boxStyle = styleBoxInline(s.style);
              const label = (
                <>
                  <StyledName name={s.name} style={s.style} />
                  {s.stacks > 1 ? ` ×${s.stacks}` : ""}
                </>
              );
              return onSelectStatus === undefined ? (
                <span key={s.id} className={`chip${box === "" ? "" : ` ${box}`}`} style={boxStyle}>
                  {label}
                </span>
              ) : (
                <button
                  key={s.id}
                  type="button"
                  className={`chip status-chip--action${box === "" ? "" : ` ${box}`}`}
                  style={boxStyle}
                  onClick={() => onSelectStatus(s)}
                >
                  {label}
                </button>
              );
            })}
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
  );
}
