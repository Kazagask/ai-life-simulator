import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ContentBlockVM, MediaVM } from "@life-sim/shared";
import type { ActHandler } from "./act.js";
import { firstInlineCgBlock } from "./adapter.js";
import { CgStage } from "./CgStage.js";

/** 单个内容块的渲染函数：返回 `null` 表示这一块不占位。 */
export type BlockRenderer = (block: ContentBlockVM) => ReactNode;

export interface NarrativeStreamProps {
  /** 按时间顺序排列的内容块（AI 叙事正文的唯一展示面；`option` 块会被过滤掉，归事件区）。 */
  content: ContentBlockVM[];
  /**
   * @deprecated 叙事区**不再渲染任何可点块**（选项统一归 `OptionDeck` / 事件区）。
   * 保留这个 prop 只是为了不打断已有的自定义前端调用点；传了也不会有按钮。
   */
  onAct?: ActHandler;
  /** 媒体列表（`kind === "asset"` 的内联块按 `assetId` 在这里解析）。 */
  media?: MediaVM[];
  /**
   * 按 `kind` 覆盖渲染器。默认覆盖 narrative / flavor / asset，
   * 未注册的 kind 一律按正文渲染 —— 服务端新增内容块类型时不需要改本组件。
   *
   * 覆盖 `asset` 时**不受**「每轮至多一张」限制（那条规则只在默认渲染器里），
   * 自定义前端可以自己决定把哪些资源内联进来。
   */
  renderers?: Partial<Record<string, BlockRenderer>>;
  /**
   * 逐字动画开关（默认开）。**流式叙事的那一轮必须传 `false`**：
   * 正文已经在 SSE 草稿里逐字出现过，正式块再打一遍等于让玩家看两遍。
   */
  typewriter?: boolean;
  /**
   * @deprecated 与 `onAct` 同因：叙事区已无可点块，忙态由事件区 / 行动坞表达。
   * 保留只为兼容既有调用点。
   */
  disabled?: boolean;
}

/**
 * 选项块渲染（单独导出，便于自定义前端复用同一套阈值与可访问性）。
 *
 * `onAct` 缺省 ⇒ 渲染成「引述」样式：保留在正文里（玩家刚读过的选择就是叙事的一部分），
 * 但视觉弱化且不可点；`disabled` ⇒ 按钮置灰，且点击被显式拦下（不依赖浏览器 disabled 语义）。
 */
export function renderOptionBlock(
  block: ContentBlockVM,
  options: { onAct?: ActHandler; disabled?: boolean } = {},
): ReactNode {
  const text = block.text ?? "";
  const { onAct, disabled = false } = options;
  if (onAct === undefined) {
    return (
      <span className="ls-choice ls-choice--static" data-kind={block.kind}>
        {text}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="ls-choice"
      data-kind={block.kind}
      disabled={disabled}
      aria-disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onAct({ text, source: "option" });
      }}
    >
      {text}
    </button>
  );
}

/** 打字机节奏（按**字数**算时长，不按块等比例拉长）。 */
export interface TypewriterOptions {
  /** 每秒揭示的字数：默认 36（≈ 每字 28ms）。 */
  charsPerSecond?: number;
  /** 单块总时长上限（毫秒）：默认 650。长段落宁可一步多字，也不拖成几秒。 */
  maxDurationMs?: number;
  /**
   * 是否启用逐字动画。**流式叙事必须传 `false`**：
   * 正文在 SSE 草稿里已经一个字一个字给玩家看过了，收尾后再用正式块打一遍字 =
   * 「都生成完了还要重新打一遍」。关掉动画不是"少个特效"，是避免重复呈现同一段文字。
   */
  enabled?: boolean;
}

/** 打字机的一帧：只描述「当前该被揭示的那一块」现在该显示的前缀。 */
export interface TypewriterFrame {
  blockId: string;
  visible: string;
}

const TYPE_TICK_MS = 16;
const TYPE_DEFAULT_CPS = 36;
const TYPE_DEFAULT_MAX_MS = 650;

/** 最后一个**有正文**的 narrative 块下标（选项 / 旁注块不参与打字机）；没有则 -1。 */
export function typingIndex(content: ContentBlockVM[]): number {
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i];
    if (block === undefined || block.kind !== "narrative") continue;
    if ((block.text ?? "").length > 0) return i;
  }
  return -1;
}

/**
 * 是否要求减少动效。**没有 `window`（SSR / node 测试）一律按 reduce 处理**：
 * 服务端渲染不出动画，首屏 HTML 必须是全文，否则静态快照里就是半句话。
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  return query?.matches === true;
}

/** 单块时长：按字数算并封顶，至少一个 tick。 */
export function durationFor(chars: number, charsPerSecond: number, maxDurationMs: number): number {
  const cps = Math.max(1, charsPerSecond);
  return Math.min(maxDurationMs, Math.max(TYPE_TICK_MS, (chars / cps) * 1000));
}

/**
 * 每个 tick 揭示多少字（至少 1）。
 *
 * 由「按字数算的时长」反推步长：长段落被 `maxDurationMs` 封顶后一步多字，
 * 保证 `step * ticks >= textLength`（一定收敛，不会永远差几个字）。
 */
export function revealStep(textLength: number, charsPerSecond: number, maxDurationMs: number, tickMs = TYPE_TICK_MS): number {
  if (textLength <= 0) return 1;
  const duration = durationFor(textLength, charsPerSecond, maxDurationMs);
  return Math.max(1, Math.ceil((textLength * tickMs) / duration));
}

/**
 * 逐字揭示「最后一块 narrative」的正文；其余块永远完整渲染。
 *
 * 判据（都是产品要求，改之前先想清楚为什么）：
 *  - **首帧不逐字**：刷新 / 重进 / 首屏时最后一块早已存在，`useState` 初值直接给全文；
 *    只有「挂载之后新到的块」才从前缀 0 开始播 —— 否则每次刷新都重放一遍动画。
 *  - **只截一块**：`frame.blockId` 之外的内容一律原样渲染，所以块被顶掉 / 卸载 / 内容清空时，
 *    旧块**自动**恢复全文，不存在停在半句的中间态。
 *  - **增长即全文**：同一块在动画期间字数变化（上游流式追加）⇒ 立刻跳全文，不排队、
 *    不重置进度；新块到达 ⇒ 旧块立刻全文、新块从 0 开始（同样不排队）。
 *  - `prefers-reduced-motion: reduce`（含 SSR / 无 `window`）⇒ 全程全文，不启动定时器。
 */
export function useTypewriter(content: ContentBlockVM[], options: TypewriterOptions = {}): TypewriterFrame | null {
  const { charsPerSecond = TYPE_DEFAULT_CPS, maxDurationMs = TYPE_DEFAULT_MAX_MS, enabled = true } = options;
  const index = typingIndex(content);
  const target = index >= 0 ? content[index] : undefined;
  const blockId = target?.blockId;
  const text = target?.text ?? "";

  // 初值即全文：首帧（含 SSR / 刷新）不播动画。
  const [frame, setFrame] = useState<TypewriterFrame | null>(
    blockId === undefined ? null : { blockId, visible: text },
  );
  // 已挂载时读一次即可：中途改系统设置不实时生效，下次进页面才变（不值得为它挂监听）。
  const [reduced] = useState(prefersReducedMotion);
  const firstPass = useRef(true);
  /**
   * 正在打字的块的**目标文本**。
   *
   * 为什么不能拿 `frame` 判断「上游是否追加了字数」：定时器每 tick 都 `setFrame`，
   * 若 effect 依赖 `frame`，它就会被自己推进的那一格重新唤醒，闯进「字数变了 ⇒ 跳全文」
   * 那一支，动画在第一 tick 就结束（这条曾在未提交版本里真发生过）。
   * 用 ref 记住目标文本，effect 只在「块 / 目标文本 / 动效偏好」变化时才跑。
   */
  const startedRef = useRef<{ blockId: string; text: string } | null>(null);

  useEffect(() => {
    if (firstPass.current) {
      // 挂载这一趟什么都不做：首帧已经从 `useState` 初值拿到全文了。
      firstPass.current = false;
      startedRef.current = blockId === undefined ? null : { blockId, text };
      return;
    }
    if (blockId === undefined) {
      setFrame(null);
      startedRef.current = null;
      return;
    }
    if (startedRef.current?.blockId === blockId) {
      // 同一块：只有上游真的改写 / 追加了字数才跳全文；定时器自己推的那一格不算变化。
      if (startedRef.current.text !== text) {
        startedRef.current.text = text;
        setFrame({ blockId, visible: text });
      }
      return;
    }
    // 新块（含首块晚到）：旧块立刻恢复全文，新块从头播。
    startedRef.current = { blockId, text };
    if (!enabled || reduced || text.length === 0) {
      setFrame({ blockId, visible: text });
      return;
    }
    setFrame({ blockId, visible: "" });
    const step = revealStep(text.length, charsPerSecond, maxDurationMs);
    const timer = setInterval(() => {
      setFrame((prev) => {
        // 已经被别的块接管（块切换）⇒ 这个定时器只负责退出，不写状态。
        if (prev === null || prev.blockId !== blockId) return prev;
        const next = Math.min(text.length, prev.visible.length + step);
        if (next >= text.length) {
          clearInterval(timer);
          return { blockId, visible: text };
        }
        return { blockId, visible: text.slice(0, next) };
      });
    }, TYPE_TICK_MS);
    return () => clearInterval(timer);
  }, [blockId, text, reduced, enabled, charsPerSecond, maxDurationMs]);

  return frame;
}

/**
 * 叙事流：本作的主文本面，同时是**第二个点击面**（选项块即按钮）。
 *
 * 观感约定（不是聊天窗口）：
 *  - 每个内容块是轻小说式正文，行高 / 版心宽松，逐块柔和淡入；
 *  - `option` 渲染成整行可点的选项胶囊（移动端 ≥44px 触控高度），点击走 `onAct`；
 *  - `flavor` 是小号斜体旁注；`asset` 内联一张媒体资源（每轮至多一张）；
 *  - 新块到达时自动滚到最新一块。
 *
 * 状态条 / 战斗面板**不在这里**：它们是常驻 HUD，绝不插进叙事流中间。
 */
export function NarrativeStream({ content, onAct, media = [], renderers, typewriter = true, disabled = false }: NarrativeStreamProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // hooks 必须在任何 early return 之前调用（空叙事那一支也要走到这里）。
  const frame = useTypewriter(content, { enabled: typewriter });

  /**
   * 叙事区只放 narrative / flavor / asset：**选项是「要点」，不是散文**。
   *
   * 必须在 map 之前过滤掉 `option` —— 不能靠「删掉 `defaults.option`」来达到同样效果：
   * 渲染回退是 `renderers[kind] ?? defaults[kind] ?? defaults.narrative`，删掉注册项只会让
   * 选项文案以正文段落的形式印出来，比原来更糟。选项归事件区（`OptionDeck`），
   * 与引擎事件面板的 `optionId` 选项在同一块地方，玩家不用分辨两个点击面。
   */
  const blocks = content.filter((block) => block.kind !== "option");

  const lastBlock = blocks.length > 0 ? blocks[blocks.length - 1] : undefined;
  const lastBlockId = lastBlock?.blockId;
  const tailLength = (lastBlock?.text ?? "").length;
  const typedLength = frame?.visible.length ?? 0;

  useEffect(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    // 只滚到最新一行；jsdom / SSR 下 scrollHeight 为 0，赋值无副作用。
    //
    // 依赖里必须带上「末尾**可见**字数」：逐字揭示 / 上游流式追加时块数与 blockId 都不变，
    // 只靠块数会让粘底失效（文字长到可视区外面还在原处）。
    el.scrollTop = el.scrollHeight;
  }, [blocks.length, lastBlockId, tailLength, typedLength]);

  // 一句正文都没有（开局前）才是「故事尚未开始」；局中这一轮只写了选项块时，上面的历史正文
  // 还在，照常渲染 —— 绝不能在这时候把开局文案印到屏幕上。
  if (content.length === 0) {
    return <p className="ls-narrative__empty">故事尚未开始。</p>;
  }
  // 过滤后一块都不剩（例如本轮只产出 option 块）：不占位，也不留空容器。
  if (blocks.length === 0) return null;

  /**
   * 每轮至多内联一张资源，且只有画面槽（`cg*` / `scene*`）允许内联
   * （立绘归立绘排、图标归别处）。判据与宿主抑制顶部横幅完全同源
   * （`firstInlineCgBlock`），不允许这里再写一套。
   */
  const inlineCg = firstInlineCgBlock({ content, media });

  const defaults: Record<string, BlockRenderer> = {
    narrative: (block) => (
      <p className="ls-narrative__block ls-narrative__block--prose" data-kind={block.kind}>
        {block.text ?? ""}
      </p>
    ),
    flavor: (block) => (
      <p className="ls-narrative__block ls-narrative__block--flavor" data-kind={block.kind}>
        {block.text ?? ""}
      </p>
    ),
    asset: (block) => {
      // 每轮至多内联一张：只有解析器选中的那块出图。放在**默认渲染器内部**，
      // 是为了让 `renderers.asset` 覆盖仍然能收到全部 asset 块（自定义前端可能
      // 想把道具图标内联进正文，那是它的自由，不该被默认规则吞掉）。
      if (block.blockId !== inlineCg?.blockId) return null;
      if (block.assetId === undefined) return null;
      const found = media.find((item) => item.assetId === block.assetId && item.url !== "");
      if (found === undefined) return null;
      return <CgStage media={[found]} inline />;
    },
  };

  return (
    <div className="ls-narrative" ref={scrollerRef} role="log" aria-label="叙事">
      {blocks.map((block) => {
        // 只给「正在揭示的那一块」换上前缀正文，其余块原样 —— 自定义 `renderers` 也因此
        // 自动享受逐字，不需要各自再实现一遍。`typingIndex` 只挑 narrative，故其余块
        // （flavor / asset）的文本永远不会被截断。
        const shown = frame !== null && frame.blockId === block.blockId ? { ...block, text: frame.visible } : block;
        const render = renderers?.[block.kind] ?? defaults[block.kind] ?? defaults.narrative;
        // `blockId` 是内容块在 trace 里的稳定标识（agent-runtime 契约：optionId 不落块）。
        return <Fragment key={block.blockId}>{render?.(shown)}</Fragment>;
      })}
    </div>
  );
}
