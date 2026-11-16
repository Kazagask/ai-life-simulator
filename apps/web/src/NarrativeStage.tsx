import { CgStage, NarrativeStream, Portrait, firstInlineCgBlock, isPortraitSlot } from "@life-sim/rpg-ui";
import type { ActHandler, MediaVM, ViewModel } from "@life-sim/rpg-ui";

function portraitsOf(media: MediaVM[]): MediaVM[] {
  const seen = new Set<string>();
  const out: MediaVM[] = [];
  for (const item of media) {
    if (!isPortraitSlot(item.slot)) continue;
    if (seen.has(item.assetId)) continue;
    seen.add(item.assetId);
    out.push(item);
  }
  return out;
}

/**
 * 默认前端的叙事区：只吃 `ViewModel`（不碰引擎快照），组件全部来自 `@life-sim/rpg-ui`。
 *
 * 布局顺序即阅读顺序：全屏 CG → 立绘一排 → 叙事流（含可点的选项块）。
 * 叙事正文来自服务端 trace 读回（刷新后仍在），媒体来自快照的媒体投影。
 *
 * **同一幕只出一张图**：本轮只要存在能内联上屏的 CG 块，顶部横幅就让位，
 * 由叙事流在对应位置渲染。判据与流内一致 —— 都用 `firstInlineCgBlock`，
 * 不允许这里再写一套「有没有内联资源」的判断（曾因两套判据不一致出过两次黑场）。
 */
export function NarrativeStage({
  view,
  onAct,
  busy = false,
}: {
  view: ViewModel;
  onAct?: ActHandler;
  /**
   * 回结算中（请求在飞）：叙事流选项同步置灰（引擎侧 busy 锁兜底，视觉也要一致），
   * 头部同时显示「AI 书写中…」。
   *
   * 这是进行中提示的**主信号**：服务端三条写路径都在回合事务里同步 `await` 完 LLM 才
   * `projectWorld`，所以响应投影里的 `llmPending` 恒为缺省 —— 只有「请求在飞」能代表在写。
   */
  busy?: boolean;
}) {
  const portraits = portraitsOf(view.media);
  const inlineCg = firstInlineCgBlock(view);
  const bannerMedia = inlineCg === undefined ? view.media : [];
  const writing = busy || view.llmPending === true;

  return (
    <section className="card narrative-card">
      <header className="narrative-card__head">
        <span className="slot-label">叙事</span>
        {writing && <span className="tag ai-narrative-tag">AI 书写中…</span>}
      </header>
      <div className="narrative-card__body">
        <CgStage media={bannerMedia} />
        {portraits.length > 0 && (
          <div className="ls-portrait-row">
            {portraits.map((media) => (
              <Portrait key={media.assetId} media={media} />
            ))}
          </div>
        )}
        <NarrativeStream content={view.content} media={view.media} onAct={onAct} disabled={busy} />
      </div>
    </section>
  );
}
