export interface WorldClockProps {
  /** 历法显示文本（模板时间适配器生成，原样展示，不在前端做日期运算）。 */
  formattedTime: string;
  /** 人生阶段显示名。 */
  lifeStageLabel: string;
  /** 章节进度；缺省时不渲染章节指示（模板未使用章节机）。 */
  storyChapter?: number;
}

/** 世界时钟：时间 + 人生阶段（+ 可选章节），横排一行，不占视觉重心。 */
export function WorldClock({ formattedTime, lifeStageLabel, storyChapter }: WorldClockProps) {
  return (
    <div className="ls-clock">
      <span className="ls-clock__time">{formattedTime}</span>
      <span className="ls-clock__stage">{lifeStageLabel}</span>
      {storyChapter !== undefined && <span className="ls-clock__chapter">第 {storyChapter} 章</span>}
    </div>
  );
}
