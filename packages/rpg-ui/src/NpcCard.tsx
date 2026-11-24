import type { ComponentType } from "react";
import { CharacterAvatar } from "./CharacterAvatar";
import type { MediaVM, NpcVM, StatusVM } from "@life-sim/shared";
import { NpcDetails, type NpcDetailsProps } from "./NpcDetails.js";

export interface NpcCardProps {
  /**
   * 头像（2026-11-24 · 角色媒体）：由投影按皮肤解析，宿主只负责传。
   * **不传也有头像位**（名字首字 + 主题底色）—— 有图没图布局必须一样。
   */
  avatar?: MediaVM;
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
 * NPC 卡（世界页「人物」子页签）。
 *
 * 版式（2026-11-24 · UI Polish 1.0）：
 * - **左对齐标题区**：头像 + 姓名 + 次要信息（年龄 · 性别 · 人生阶段）竖排，关系档位靠右；
 * - 关系档位**只出现一次**（右上标签），不再重复一颗「关系 深厚」的胶囊；
 * - 已知目标从行内文字换成**轻量强调块**（左侧细条 + 淡底），扫读时能一眼分开「性格」与「目标」；
 * - 头像位恒定 56px ⇒ 有图 / 无图 / 加载失败三态高度一致，列表不会跳。
 *
 * 所有数值与文案都来自投影：好感条长只是视觉辅助（-100..100 映射到 0..100%），
 * 属性值原样展示（0 也是有效值），关系句由 `RelationList` 统一拼。
 */
export function NpcCard({ npc, avatar, Details = NpcDetails, onSelectStatus }: NpcCardProps) {
  return (
    <section className={`card npc-card${npc.alive ? "" : " npc-card-inactive"}`}>
      <header className="npc-head">
        <CharacterAvatar media={avatar} name={npc.name} size="sm" tone={npc.alive ? "muted" : "muted"} />
        <div className="npc-head__text">
          <h2 className="npc-head__name">{npc.name}</h2>
          <p className="npc-head__meta">
            {npc.age} 岁 · {npc.genderLabel} · {npc.lifeStageLabel}
            {!npc.alive && <span className="npc-head__dead"> · {npc.lifeText}</span>}
          </p>
        </div>
        <span className="npc-head__rel" title={`关系值 ${npc.relationship}`}>
          {npc.relationshipLabel}
        </span>
      </header>

      <p className="npc-persona">{npc.personality}</p>

      <div className="attr npc-affinity">
        <span className="attr-name">好感</span>
        <div className="bar">
          <div className="bar-fill relation" style={{ width: `${((npc.relationship + 100) / 200) * 100}%` }} />
        </div>
        <span className="attr-value" title={`关系值 ${npc.relationship}`}>
          {npc.relationshipLabel}
        </span>
      </div>

      {npc.knownGoals.length > 0 && (
        <div className="npc-goal">
          <span className="npc-goal__label">已知目标</span>
          <span className="npc-goal__text">{npc.knownGoals.join("；")}</span>
        </div>
      )}

      <Details npc={npc} {...(onSelectStatus !== undefined ? { onSelectStatus } : {})} />
    </section>
  );
}
