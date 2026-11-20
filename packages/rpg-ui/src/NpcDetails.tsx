import type { NpcVM, StatusVM } from "@life-sim/shared";
import { AttributeGrid, LadderList } from "./AttributeList.js";
import { RelationList } from "./RelationList.js";
import { StatusChip } from "./StatusChip.js";

export interface NpcDetailsProps {
  /** NPC 卡投影（关系已只留出边、属性已带标签、生命周期文案已翻译）。 */
  npc: NpcVM;
  /** 点开状态详情（ADR-002 / R-DETAIL-05）：NPC 身上的状态同样能点。 */
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
            {/* 与个人面板同一个组件：虚线框（修正 / 战斗状态）与「×N 跟名字同色」在这里才一致。 */}
            {npc.statuses.map((s) => (
              <StatusChip
                key={s.id}
                status={s}
                {...(onSelectStatus !== undefined ? { onSelect: onSelectStatus } : {})}
              />
            ))}
          </div>
        )}
      </div>

      <div className="npc-block">
        <h3>属性</h3>
        {npc.attributes.length === 0 ? (
          <p className="muted">暂无属性数据</p>
        ) : (
          <>
            <AttributeGrid attributes={npc.attributes} />
            <LadderList attributes={npc.attributes} />
          </>
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
