/**
 * 「AI 叙事」小标记：提醒玩家这段文字是模型补写的，不是模板原文。
 * 只出现在标题/总结行尾，尺寸由 `.tag.ai-narrative-tag` 决定。
 */
export function AiNarrativeTag() {
  return <span className="tag ai-narrative-tag">AI 叙事</span>;
}
