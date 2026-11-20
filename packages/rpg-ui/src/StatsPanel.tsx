import { StatusBoard } from "./StatusBoard.js";
import type { EvaluationVM, PlayerVM, StatusVM } from "@life-sim/shared";
import { AiNarrativeTag } from "./AiNarrativeTag.js";
import { AttributeGrid, LadderList } from "./AttributeList.js";
import { EvaluationPanel } from "./EvaluationPanel.js";

export interface StatsPanelProps {
  player: PlayerVM;
  evaluation: EvaluationVM;
  /** 历法显示文本（模板时间适配器生成，原样展示）。 */
  formattedTime: string;
  /** 章节进度：缺省 ⇒ 该世界没有章节机，不渲染章节芯片。 */
  storyChapter?: number;
  /** 当前轮次（0 起）。 */
  turnIndex: number;
  /** 属性页那行人生总结；缺省用 `evaluation.summary`。 */
  summary?: string;
  /** 这行总结是否由 AI 补写（true ⇒ 带「AI 叙事」小标记）。 */
  summaryFromAi?: boolean;
  /**
   * 点击状态芯片 → 打开详情。
   *
   * 个人页此前是**唯一**漏掉样式的状态入口：这里直接写 `<span>{s.name}</span>`，
   * 既没有颜色也没挂点击（用户 2026-11-18：「个人页面的状态没有下发 style」）。
   */
  onSelectStatus?: (status: StatusVM) => void;
}

/**
 * 章节进度（D-07）。
 *
 * 只渲染服务端下发的数字：`storyChapter` 缺省 ⇒ 该世界没有章节机，整块**不渲染**
 * （不能出现「第 0 章」这种凭空造的进度）；引擎不编造章节名，这里也不自造，
 * 只写「第 N 章」。合法性判断留在服务端，前端仅拒绝 0 / 负数这类非法值兜底。
 */
function StoryChapterChip({ chapter }: { chapter: number | undefined }) {
  if (typeof chapter !== "number" || !Number.isFinite(chapter) || chapter < 1) return null;
  return (
    <span className="chip chapter-chip" title="主线章节进度">
      第 {chapter} 章
    </span>
  );
}

/** 属性面板：只复述投影已有字段，不做任何前端推算（与 DNF 的 M 面板信息区对应）。 */
export function StatsPanel({
  player,
  evaluation,
  formattedTime,
  storyChapter,
  turnIndex,
  summary,
  summaryFromAi = false,
  onSelectStatus,
}: StatsPanelProps) {
  return (
    <section className="card">
      <div className="row">
        <h3 className="panel-title">属性</h3>
        <span className="muted equip-count">第 {turnIndex} 轮</span>
      </div>
      <AttributeGrid
        attributes={player.attributes}
        trailing={
          <div className="stat">
            <span>{player.labels.mood}</span>
            <strong>{player.moodBandLabel}</strong>
          </div>
        }
      />
      <LadderList attributes={player.attributes} />
      <StatusBoard statuses={player.statuses} totals={player.statusTotals} onSelectStatus={onSelectStatus} />
      <div className="meta-row">
        {typeof evaluation.canonDeviation === "number" && (
          <span className="chip">命运偏离度 {evaluation.canonDeviation}</span>
        )}
        <span className="chip">{formattedTime}</span>
        <StoryChapterChip chapter={storyChapter} />
      </div>
      <p className="eval-line">
        {summary ?? evaluation.summary}
        {summaryFromAi && <AiNarrativeTag />}
      </p>
      <EvaluationPanel evaluation={evaluation} />
    </section>
  );
}
