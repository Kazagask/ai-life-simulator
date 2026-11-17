import type { NpcRelationVM } from "@life-sim/shared";

export interface RelationListProps {
  /** 关系出边（调用方已按 `direction === "out"` 过滤；组件不猜语义）。 */
  relations: NpcRelationVM[];
  /** 主体名（拼「A 视 B 为…」用）。 */
  subjectName: string;
}

/**
 * 关系行列表：一句话 + 亲缘称谓 + 可见性 + 数值。
 *
 * 关系是**独立事实**：对方可能没有 NPC 卡（敌人 / 尚未登场 / 隐藏），名字照给，
 * 但明确标「无档案」，不假装能点开一个人。
 *
 * 只渲染出边（「这个人怎么看别人」）：同一条边两个方向是同一件事实，两边都画等于把
 * 同一句话写两遍，而且「A 视 B 为远亲 ≠ B 视 A 为远亲」的不对称语义会互相打架。
 * 过滤在适配器完成，这里拿到什么就画什么。
 */
export function RelationList({ relations, subjectName }: RelationListProps) {
  if (relations.length === 0) return <p className="muted">尚无已知的人际关系。</p>;
  return (
    <ul className="rel-list">
      {relations.map((rel, i) => (
        <li key={`${rel.withId}-${rel.kind}-${i}`} className="rel-row">
          <span className="rel-text">
            {subjectName}视{rel.withName ?? rel.withId}为{rel.kindLabel}
          </span>
          {/* 派生行的行首标签已经是主称谓（适配器把 `kinshipTerm` 提到 `kindLabel`），
              这里只画与行首不同的那一档，避免同一句话里出现两遍「外婆」。 */}
          {rel.kinshipTerm && rel.kinshipTerm !== rel.kindLabel && (
            <span className="rel-term">{rel.kinshipTerm}</span>
          )}
          {/* 同一段亲缘的另一个读法（「女儿」之外的「外孙女」）—— 扩展只并列血亲读法。 */}
          {rel.kinshipTerms?.map((term) => (
            <span key={term} className="rel-term rel-term-extra">
              {term}
            </span>
          ))}
          {rel.counterpartVisible === false && <span className="rel-nocard">无档案</span>}
          <span className={`rel-vis rel-vis-${rel.visibility}`}>{rel.visibilityLabel}</span>
          {typeof rel.value === "number" && <span className="rel-value">{rel.value}</span>}
        </li>
      ))}
    </ul>
  );
}
