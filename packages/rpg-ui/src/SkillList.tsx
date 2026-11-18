import { useState } from "react";
import type { EffectSummaryVM, SkillVM } from "@life-sim/shared";
import { EffectList } from "./EffectList.js";
import { StyledName } from "./StyledName.js";

export interface SkillListProps {
  skills: SkillVM[];
  /** 点开技能里引用的补正（「施加 力竭」）：宿主决定用浮层还是跳转。 */
  onOpenStatus?: (effect: EffectSummaryVM) => void;
}

/** 卡片上的一行摘要：优先消耗 / 冷却，没有就退回「通用 / 战斗」。 */
function skillMeta(skill: SkillVM): string {
  const cost = skill.effects?.find((e) => e.kind === "cost" && e.text.startsWith("消耗"));
  const cooldown = skill.effects?.find((e) => e.kind === "cost" && e.text.startsWith("冷却"));
  const parts = [cost?.text, cooldown?.text].filter((t): t is string => t !== undefined);
  if (parts.length > 0) return parts.join(" · ");
  return skill.kind === "combat" ? "战斗技能" : "通用技能";
}

/**
 * 技能面板（用户 2026-11-18 裁决）：**一行两个**技能卡，点开在下方看详情。
 *
 * 为什么不复用通用毛玻璃浮层：技能是**常驻**能力，玩家会反复对照（耗多少、冷却几回合），
 * 浮层每次都要点开 / 关闭反而更慢；就地展开能一边看列表一边看细节。
 *
 * 卡片只放「选哪个」需要的信息（名字 + 消耗 / 冷却），完整效果留给下方详情。
 */
export function SkillList({ skills, onOpenStatus }: SkillListProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = skills.find((s) => s.id === selectedId) ?? null;

  if (skills.length === 0) {
    return (
      <section className="card">
        <p className="muted">尚未习得技能。</p>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="ls-skill-grid">
        {skills.map((skill) => (
          <button
            key={skill.id}
            type="button"
            className={`ls-skill-card${skill.id === selectedId ? " is-active" : ""}`}
            onClick={() => setSelectedId((prev) => (prev === skill.id ? null : skill.id))}
            aria-pressed={skill.id === selectedId}
          >
            <StyledName name={skill.name} style={skill.style} className="ls-skill-card__name" />
            <span className="ls-skill-card__meta">{skillMeta(skill)}</span>
          </button>
        ))}
      </div>

      {selected !== null && (
        <div className="ls-skill-detail">
          <div className="ls-skill-detail__head">
            <h3>
              <StyledName name={selected.name} style={selected.style} />
            </h3>
            <button
              type="button"
              className="ls-skill-detail__close"
              onClick={() => setSelectedId(null)}
              aria-label="收起"
            >
              ✕
            </button>
          </div>
          {selected.description !== undefined && selected.description !== "" && (
            <p className="ls-skill-detail__desc">{selected.description}</p>
          )}
          <EffectList
            effects={selected.effects}
            {...(onOpenStatus !== undefined ? { onOpenRef: onOpenStatus } : {})}
          />
          {selected.effects === undefined || selected.effects.length === 0 ? (
            <p className="muted">这个技能没有可直接展示的效果。</p>
          ) : null}
        </div>
      )}
    </section>
  );
}
