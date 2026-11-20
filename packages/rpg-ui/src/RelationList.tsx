import type { NpcRelationVM } from "@life-sim/shared";

export interface RelationListProps {
  /** 关系出边（调用方已按 `direction === "out"` 过滤；组件不猜语义）。 */
  relations: NpcRelationVM[];
  /** 主体名（拼「A 视 B 为…」用）。 */
  subjectName: string;
}

/**
 * 关系行列表：一句话 + 亲缘称谓 + 知情人范围 + 关系档位。
 *
 * 关系是**独立事实**：对方可能没有 NPC 卡（尚未登场 / 不上面板 / 不是人）。名字照给，
 * 但要说清"为什么点不开"——旧文案统一写「无档案」，读起来像系统缺数据，其实
 * 「他还没出场」和「他不是人」是两件事（2026-11-19 用户裁决）。
 *
 * 档位代替裸数值：`+32` 没有参照系，玩家要判断的是"这一档算亲近还是疏远"。
 * 数值留在 `title` 里，鼠标悬停 / 读屏仍拿得到原值。
 *
 * 知情人范围只画非公开档：`公开` 是默认，逐行标「公开」等于噪音；
 * 「仅当事人知道」才是玩家该留意的东西（说出去会改变别人对这段关系的认知）。
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
          {rel.counterpartVisible === false && (
            <span
              className="rel-nocard"
              data-state={rel.counterpartState ?? "unspawned"}
              title="你知道这段关系，但打不开这个人的档案"
            >
              {rel.counterpartStateLabel ?? "尚未登场"}
            </span>
          )}
          {/* 知情人范围（ADR-007 D3）：`公开` 是默认值，不占位；
              只有「部分人知道 / 仅当事人知道」才值得提醒玩家 —— 这条不是人人都知道的。 */}
          {rel.scope !== "public" && (
            <span
              className={`rel-vis rel-vis-${rel.scope}`}
              title="这段关系有多少人知道（不是「你有多确信」）"
            >
              {rel.scopeLabel}
            </span>
          )}
          {rel.valueLabel !== undefined && (
            <span
              className="rel-value"
              title={typeof rel.value === "number" ? `关系值 ${rel.value}` : undefined}
            >
              {rel.valueLabel}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
