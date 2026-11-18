import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
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

/** 贴底判定的容差：小于这个距离就算「已经在底部」。 */
const STICK_PX = 48;

export interface StoryStageProps {
  view: ViewModel;
  /** 已无实际用途（叙事区没有可点块）；保留只为不打断既有调用点。 */
  onAct?: ActHandler;
  /** 结算中（请求在飞）。 */
  busy?: boolean;
  /** SSE 草稿（服务端已剥标签，只含玩家可见正文）。收尾后由正式 trace 块替换。 */
  draft?: string;
  /** 右上角小徽标（「待你决定」/「随机事件」/「战斗」）；缺省不显示。 */
  badge?: { label: string; tone: "event" | "wheel" | "battle" };
  /** 头部的次要信息（如「过去半小时」），muted 小字。 */
  note?: string;
  /**
   * 占满故事区的内容（转盘 / 战斗）。
   *
   * 给了它就**换掉整个卡体**：不再渲染叙事，也不再有滚动容器 —— 这两种面板按自己的
   * 高度铺开、由页面整体滚动（用户 2026-11-19：上一版把它们塞进 50vh 的滚动区，
   * 满屏滚动条、战斗区挤成一坨，不如原来那版）。外层标题行「故事 / 过去 N 天 / 战斗」
   * 保持与阅读形态同一套 `.story-head`，两块正好对齐。
   */
  takeover?: ReactNode;
  /**
   * 盒中盒（普通事件）：内联在叙事**结尾**，流式输出 / 逐字揭示结束后才出现
   * （用户 2026-11-19）。这一轮没有 LLM 参与时等同零延迟，直接出现。
   */
  inset?: ReactNode;
  /**
   * 盒中盒的身份（如 `slot.eventId`）：**换一个事件就要重新滚一次**。
   *
   * 只靠「inset 是不是 null」判重会漏掉最常见的一种：玩家选完 A，同一回合立刻
   * 弹出 B —— inset 一直是「有」，于是不会滚，新事件的标题恰好落在折叠线以下。
   */
  insetKey?: string;
  /** 故事结束后的安静入口（自由行动阶段的物品 / 结束这一生）。 */
  footer?: ReactNode;
}

/**
 * 「故事」区：叙事与事件合并后的**唯一主文本面**（用户 2026-11-19）。
 *
 * 三种形态：
 * - 普通事件 ⇒ 叙事 + 结尾的**盒中盒**（流式结束后长出来）；
 * - 随机事件（转盘）/ 战斗 ⇒ **换掉卡体**，铺满这一区；结算（槽位清空）后自动回到叙事；
 * - 自由行动 ⇒ 只有叙事，输入归底部行动坞。
 *
 * 阅读形态只有一个滚动容器（本组件 `.story-body`）：`.ls-narrative` 在里面的内部滚动被关掉，
 * 否则会出现「双层滚动」——玩家滑一下，外层和内层各滚一半。粘底逻辑也在这里统一做，
 * 所以「回到底部」按钮只有一处实现。占满形态**没有**内部滚动（页面自己滚）。
 */
export function StoryStage({
  view,
  onAct,
  busy = false,
  draft,
  badge,
  note,
  takeover,
  inset,
  insetKey,
  footer,
}: StoryStageProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const insetRef = useRef<HTMLDivElement | null>(null);
  /** 玩家是否贴着底部（贴底 ⇒ 新内容自动跟随；滑上去看历史 ⇒ 不打扰）。 */
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [scrollable, setScrollable] = useState(false);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = bodyRef.current;
    if (el === null) return;
    stickRef.current = true;
    setAtBottom(true);
    if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior });
    else el.scrollTop = el.scrollHeight;
  }, []);

  const syncScrollState = useCallback(() => {
    const el = bodyRef.current;
    if (el === null) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const bottom = gap <= STICK_PX;
    stickRef.current = bottom;
    setAtBottom(bottom);
    setScrollable(el.scrollHeight > el.clientHeight + 4);
  }, []);

  /**
   * 流式那一轮不要再打字（用户 2026-11-17 反馈）：正文已经在 SSE 草稿里逐字给玩家看过，
   * 收尾后正式块再逐字打一遍 = 「都生成完了还要重新打一遍」。
   *
   * 判据是**跨渲染的两步**：草稿是在上一轮渲染里到的（那时 `view.turnIndex` 还是旧值），
   * 正式块要等这次响应回来才出现。所以用 ref 记「这一趟来过草稿」，
   * 在 turnIndex 前进的那一刻把它记成「该轮跳过动画」。
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

  /**
   * 逐字揭示是否还在进行（按回合记：回调只有一个「打完」信号，不带轮次）。
   * `typedTurn !== view.turnIndex` ⇒ 这一轮还没打完。
   */
  const [typedTurn, setTypedTurn] = useState<number | null>(null);
  const turnRef = useRef(view.turnIndex);
  useEffect(() => {
    turnRef.current = view.turnIndex;
  }, [view.turnIndex]);
  const onTypewriterDone = useCallback(() => setTypedTurn(turnRef.current), []);

  const streaming = (draft?.length ?? 0) > 0;
  /**
   * 这一轮有盒中盒等在那儿（普通事件）且没有流式在跑 ⇒ **不打字**：
   * 玩家要的是「事件长什么样」，而不是再看一遍模板摘要逐字浮现（用户 2026-11-19：
   * 「本轮根本没有 LLM 参与就别等，直接渲染盒中盒」）。
   * 有 LLM 正文的回合本来就因为 `instantTurn` 关掉了打字，这里只影响模板回合。
   */
  const skipTypingForInset = inset !== undefined && inset !== null && !streaming;
  const typing = typedTurn !== view.turnIndex;
  /** 盒中盒要等「流式 + 逐字」都结束；两者都没有时立刻为真（无 LLM 回合不空等）。 */
  const insetReady = !streaming && !typing;

  const portraits = portraitsOf(view.media);
  const inlineCg = firstInlineCgBlock(view);
  const bannerMedia = inlineCg === undefined ? view.media : [];
  const writing = streaming || view.llmPending === true;

  const takeoverOn = takeover !== undefined && takeover !== null;

  // 新内容到来：贴底就跟着走（滑上去看历史时不打扰）。
  useLayoutEffect(() => {
    if (takeoverOn) return;
    if (!stickRef.current) return;
    const el = bodyRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  }, [view.turnIndex, draft, takeoverOn, insetReady]);

  /**
   * 盒中盒出现时**强制**把它推到可视区：玩家要看的是它，不是刚才那半页历史。
   *
   * 滚到**它的顶端**而不是容器底：事件标题 + 前两个选项是玩家下一步要读的，
   * 滚到底反而会把标题推到屏幕外（事件卡通常比可视区还高）。
   */
  const insetSeenRef = useRef<string | null>(null);
  useEffect(() => {
    if (inset === undefined || inset === null) {
      insetSeenRef.current = null;
      return;
    }
    if (!insetReady) return;
    const key = insetKey ?? "inset";
    if (insetSeenRef.current === key) return;
    const el = bodyRef.current;
    const target = insetRef.current;
    if (el === null || target === null) return;
    insetSeenRef.current = key;
    stickRef.current = el.scrollHeight - (target.offsetTop + target.offsetHeight) <= STICK_PX;
    el.scrollTo({ top: Math.max(0, target.offsetTop - 8), behavior: "smooth" });
  }, [inset, insetReady, insetKey]);

  // 尺寸变化（横竖屏切换 / 图片加载 / 字体回填）后重算「是否可滚 / 是否在底部」。
  useEffect(() => {
    const el = bodyRef.current;
    if (el === null) return;
    syncScrollState();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => syncScrollState());
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncScrollState]);

  /**
   * 「回到底部」只在**阅读形态**出现。占满形态没有内部滚动（页面自己滚），
   * 挂在这里只会压住战斗面板右下角的技能（2026-11-19 走查实拍）。
   */
  const showJump = !takeoverOn && scrollable && !atBottom;

  return (
    <section
      className={`card story-card${takeoverOn ? " story-card--takeover" : ""}`}
      {...(takeoverOn && badge !== undefined ? { "data-tone": badge.tone } : {})}
    >
      <header className="story-head">
        <span className="slot-label">故事</span>
        <span className="story-head__right">
          {note !== undefined && note !== "" && <span className="story-elapsed">{note}</span>}
          {writing && <span className="tag ai-narrative-tag">AI 书写中…</span>}
          {badge !== undefined && <span className={`story-badge badge-${badge.tone}`}>{badge.label}</span>}
        </span>
      </header>

      {takeoverOn ? (
        <div className="story-takeover">{takeover}</div>
      ) : (
        <>
          <div className="story-body" ref={bodyRef} onScroll={syncScrollState}>
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
              draft={draft}
              onAct={onAct}
              disabled={busy}
              typewriter={instantTurn !== view.turnIndex && !skipTypingForInset}
              onTypewriterDone={onTypewriterDone}
              typewriterKey={view.turnIndex}
            />
            {/* 盒中盒：等流式 + 逐字结束才出现；出现时容器给一段 0.18s 的展开动画。 */}
            {inset !== undefined && inset !== null && insetReady && (
              <div className="story-inset" ref={insetRef}>
                {inset}
              </div>
            )}
            {footer !== undefined && footer !== null && <div className="story-foot">{footer}</div>}
          </div>

          {showJump && (
            <button type="button" className="story-jump" onClick={() => scrollToBottom("smooth")}>
              回到底部
              <span aria-hidden="true">↓</span>
            </button>
          )}
        </>
      )}
    </section>
  );
}
