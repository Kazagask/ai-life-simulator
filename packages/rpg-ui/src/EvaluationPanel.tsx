import type { EvaluationDimensionVM, EvaluationVM } from "@life-sim/shared";

export interface EvaluationPanelProps {
  evaluation: EvaluationVM;
}

/** 条长只是视觉辅助：分数原样来自服务端，不重算、不参与判定。 */
function scoreWidth(score: number): number {
  return Math.min(100, Math.max(0, score));
}

/** 单维一行：名称 + 等级 + 数值（服务端原值），条为视觉辅助；解释默认收起避免撑高面板。 */
function EvaluationDimensionRow({ dim }: { dim: EvaluationDimensionVM }) {
  return (
    <details className="eval-dim">
      <summary>
        <span className="eval-dim-name">{dim.label ?? dim.id}</span>
        <span className="eval-dim-level">{dim.level}</span>
        <span className="eval-dim-score">{String(dim.score)}</span>
        <span className="eval-dim-bar" aria-hidden="true">
          <span className="eval-dim-bar-fill" style={{ width: `${scoreWidth(dim.score)}%` }} />
        </span>
      </summary>
      {dim.explanation && <p className="eval-dim-expl">{dim.explanation}</p>}
    </details>
  );
}

/**
 * 五维人生评价（R2.6 / ADR-0016）。数据全部来自投影：前端不重算分数、不推导等级、
 * 不自备 id→中文映射（`label` 缺失时回退 id）。
 *
 * **只在已结束 / 已归档时展示（D-10，用户 2026-11-12 裁决走 B）**：评价是「盖棺定论」，
 * 跑动中整块不渲染 —— 不是折叠、也不是隐藏高度，是 DOM 里不出现。理由是实测该块净高
 * 379px，挂在玩家卡下方会把本回合的动作区 / 转盘「继续」整块顶出首屏（docH 1594 vs 1190），
 * 而「这一回合要做什么」的信息优先级高于过程评述。
 *
 * 「是否盖棺」由适配器算成 `evaluation.ended`，本组件不读状态枚举。
 * `dimensions` / `overall` 在评价尚未生成时缺省 —— 此时也不渲染，不出现空白块或 `undefined`。
 */
export function EvaluationPanel({ evaluation }: EvaluationPanelProps) {
  const dims = evaluation.dimensions ?? [];
  if (evaluation.ended !== true || dims.length === 0) return null;
  return (
    <div className="eval-dims">
      <p className="eval-dims-title">评价分项</p>
      {dims.map((dim) => (
        <EvaluationDimensionRow key={dim.id} dim={dim} />
      ))}
      {typeof evaluation.overall === "number" && (
        // 总分与分项同时给出，不取代分项（协议 V2.1 §18）
        <div className="eval-dim eval-dim-total">
          <span className="eval-dim-name">综合</span>
          <span className="eval-dim-level">总评</span>
          <span className="eval-dim-score">{String(evaluation.overall)}</span>
          <span className="eval-dim-bar" aria-hidden="true">
            <span className="eval-dim-bar-fill" style={{ width: `${scoreWidth(evaluation.overall)}%` }} />
          </span>
        </div>
      )}
      <p className="eval-dims-hint">点分项可展开该维度的评分说明</p>
    </div>
  );
}
