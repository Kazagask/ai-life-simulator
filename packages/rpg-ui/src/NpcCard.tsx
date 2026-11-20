import type { ComponentType } from "react";
import type { NpcVM, StatusVM } from "@life-sim/shared";
import { NpcDetails, type NpcDetailsProps } from "./NpcDetails.js";

export interface NpcCardProps {
  /** NPC 卡投影（属性已带标签、关系已只留出边、生命周期文案已翻译）。 */
  npc: NpcVM;
  /**
   * 详情展开区实现。默认 `NpcDetails`；宿主可用 `resolveUiOverride(HOST_UI_SLOTS.npcDetails)` 注入
   * 扩展版本。覆盖整张卡时这个 prop 可以不用 —— 替换卡片的扩展自己决定详情怎么画。
   */
  Details?: ComponentType<NpcDetailsProps>;
  /** 点开状态详情：透传给详情区（卡面本身不列状态）。 */
  onSelectStatus?: (status: StatusVM) => void;
}

/**
 * NPC 卡（世界页「人物」子页签）。默认收起详情：卡面只给身份 + 好感 + 已知目标，
 * 展开后是关系 / 状态 / 属性 / 生命周期四块（拆分到 `NpcDetails`，可独立覆盖）。
 *
 * 所有数值与文案都来自投影：好感条长只是视觉辅助（-100..100 映射到 0..100%），
 * 属性值原样展示（0 也是有效值），关系句由 `RelationList` 统一拼。
 */
export function NpcCard({ npc, Details = NpcDetails, onSelectStatus }: NpcCardProps) {
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
        {/* 档位而不是裸数值（2026-11-19）：`关系 10` 没有参照系，玩家要的是"这一档算近还是远"。 */}
        <span className="chip" title={`关系值 ${npc.relationship}`}>
          关系 {npc.relationshipLabel}
        </span>
        {!npc.alive && <span className="chip npc-life-chip">{npc.lifeText}</span>}
      </div>
      <p className="muted">{npc.personality}</p>
      <div className="attr">
        <span className="attr-name">好感</span>
        <div className="bar">
          <div className="bar-fill relation" style={{ width: `${((npc.relationship + 100) / 200) * 100}%` }} />
        </div>
        <span className="attr-value" title={`关系值 ${npc.relationship}`}>
          {npc.relationshipLabel}
        </span>
      </div>
      {npc.knownGoals.length > 0 && <p className="known-goals">已知目标：{npc.knownGoals.join("；")}</p>}
      <Details npc={npc} {...(onSelectStatus !== undefined ? { onSelectStatus } : {})} />
    </section>
  );
}
