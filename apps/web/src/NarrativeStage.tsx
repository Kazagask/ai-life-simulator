import { useEffect, useRef, useState } from "react";
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
 * 布局顺序即阅读顺序：全屏 CG → 立绘一排 → 叙事流（**只有散文**）。
 * 选项块不在这里：`NarrativeStream` 会滤掉 `kind === "option"`，它们统一归事件区
 * （`OptionDeck`），与引擎事件面板的选项同处一块地方，玩家不用分辨两个点击面。
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
  draft,
}: {
  view: ViewModel;
  /** 已无实际用途（叙事区没有可点块）；保留只为不打断既有自定义前端的调用点。 */
  onAct?: ActHandler;
  /**
   * 回结算中（请求在飞）：头部显示「AI 书写中…」。
   *
   * 这是进行中提示的**主信号**：服务端三条写路径都在回合事务里同步 `await` 完 LLM 才
   * `projectWorld`，所以响应投影里的 `llmPending` 恒为缺省 —— 只有「请求在飞」能代表在写。
   */
  busy?: boolean;
  /**
   * SSE 草稿（服务端已剥标签，只含玩家可见正文）。
   * 收尾后由正式 trace 块替换。独立于 `view.content`：不参与任何投影 / 交互判定。
   */
  draft?: string;
}) {
  /**
   * 流式那一轮不要再打字（用户 2026-11-17 反馈）：正文已经通过 SSE 草稿逐字给玩家看过了，
   * 收尾后正式块再逐字打一遍 = 「都生成完了还要重新打一遍」。
   *
   * 判据是**跨渲染的两步**，不能只看当前 props：
   * 草稿是在上一轮渲染里到的（那时 `view.turnIndex` 还是旧值），正式块要等这次响应回来才出现。
   * 所以用 ref 记「这一趟来过草稿」，在 turnIndex 前进的那一刻把它记成「该轮跳过动画」。
   */
  const sawDraftRef = useRef(false);
  const [instantTurn, setInstantTurn] = useState<number | null>(null);
  useEffect(() => {
    if (draft !== undefined && draft.length > 0) sawDraftRef.current = true;
  }, [draft]);
  useEffect(() => {
    if (!sawDraftRef.current) return;
    sawDraftRef.current = false;
    setInstantTurn(view.turnIndex);
  }, [view.turnIndex]);

  const portraits = portraitsOf(view.media);
  const inlineCg = firstInlineCgBlock(view);
  const bannerMedia = inlineCg === undefined ? view.media : [];
  /**
   * 「AI 书写中…」只在**真的有正文在流**时出现：
   * 模板 / mock 回合没有 SSE 草稿，标签一闪而过反而像「AI 刚写了一句又不算数」。
   * 长时间无输出的等待反馈由 `GmWorkingStrip` 承担（它说的是阶段，不是内容）。
   */
  const writing = (draft?.length ?? 0) > 0 || view.llmPending === true;

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
        <NarrativeStream
          content={view.content}
          media={view.media}
          onAct={onAct}
          disabled={busy}
          typewriter={instantTurn !== view.turnIndex}
        />
        {draft !== undefined && draft.length > 0 && (
          <p
            className="narrative-draft"
            aria-live="polite"
            style={{ opacity: 0.72, whiteSpace: "pre-wrap", margin: "8px 0 0" }}
          >
            {draft}
          </p>
        )}
      </div>
    </section>
  );
}
