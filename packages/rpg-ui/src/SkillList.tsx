import type { SkillVM } from "@life-sim/shared";

export interface SkillListProps {
  skills: SkillVM[];
}

/** 已习得技能列表：只有名字 + 说明，不展示数值（数值属内核现算，不下发也不该猜）。 */
export function SkillList({ skills }: SkillListProps) {
  if (skills.length === 0) {
    return (
      <section className="card">
        <p className="muted">尚未习得技能。</p>
      </section>
    );
  }
  return (
    <section className="card">
      <div className="stack-sm">
        {skills.map((skill) => (
          <div key={skill.id} className="event-card">
            <strong>{skill.name}</strong>
            <p className="muted">{skill.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
