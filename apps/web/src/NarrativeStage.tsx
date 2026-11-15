import { CgStage, NarrativeStream, Portrait, isCgSlot } from "@life-sim/rpg-ui";
import type { ActHandler, MediaVM, ViewModel } from "@life-sim/rpg-ui";

/** 立绘槽命名约定与 `CgStage` 的 `cg` 前缀对称：`portrait` / `portrait.xxx` / `portrait-xxx`。 */
const PORTRAIT_SLOT = /^portrait(?![a-z0-9])/i;

function portraitsOf(media: MediaVM[]): MediaVM[] {
  const seen = new Set<string>();
  const out: MediaVM[] = [];
  for (const item of media) {
    if (!PORTRAIT_SLOT.test(item.slot)) continue;
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
 * 同一幕不重复上屏：若本轮叙事流里有内联 `asset` 块引用了一张 CG，顶部横幅让位给它，
 * 由叙事流在对应位置渲染（内容块是这一轮更精确的场景信号）。
 */
export function NarrativeStage({ view, onAct }: { view: ViewModel; onAct?: ActHandler }) {
  const portraits = portraitsOf(view.media);
  const hasInlineCg = view.content.some(
    (block) =>
      block.kind === "asset" &&
      block.assetId !== undefined &&
      view.media.some((item) => item.assetId === block.assetId && isCgSlot(item.slot)),
  );
  const bannerMedia = hasInlineCg ? view.media.filter((item) => !isCgSlot(item.slot)) : view.media;

  return (
    <section className="card narrative-card">
      <header className="narrative-card__head">
        <span className="slot-label">叙事</span>
        {view.llmPending === true && <span className="tag ai-narrative-tag">AI 书写中…</span>}
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
        <NarrativeStream content={view.content} media={view.media} onAct={onAct} />
      </div>
    </section>
  );
}
