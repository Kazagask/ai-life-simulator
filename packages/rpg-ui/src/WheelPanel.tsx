import { useCallback, useEffect, useRef, useState } from "react";
import type { WheelVM } from "@life-sim/shared";

// ---------- 随机事件转盘（咒术式圆盘：扇区按权重切分，指针固定，转子先快后慢停住） ----------

/** 扇区几何：0° 在正上方、顺时针为正；极坐标换算与 SVG 的 y 轴向下对齐。 */
const WHEEL_SIZE = 232;
const WHEEL_C = WHEEL_SIZE / 2;
const WHEEL_R = WHEEL_C - 12;

function polar(r: number, deg: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: WHEEL_C + r * Math.cos(rad), y: WHEEL_C + r * Math.sin(rad) };
}

function sectorPath(a0: number, a1: number): string {
  const p0 = polar(WHEEL_R, a0);
  const p1 = polar(WHEEL_R, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${WHEEL_C} ${WHEEL_C} L ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${WHEEL_R} ${WHEEL_R} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} Z`;
}

// ---------- 扇区标签排版（SVG `<text>` 不折行，只能自己切行 + 居中） ----------

/** 文本最多 20 字：超出截成「前 19 字 + …」，避免长标题塞爆扇区。 */
const WHEEL_LABEL_MAX = 20;
/** 基准字号（单/双行）；三行档降到 9.5px（见 style.css 的 `.wheel-label--dense`）。 */
const WHEEL_LABEL_FONT = 11;
/** 文本中心半径：沿用原布局（只改排版，不动扇区几何与落点角度）。 */
const WHEEL_LABEL_R = WHEEL_R * 0.64;
/** 行高 = 字号 × 该系数（紧凑但仍不叠字）。 */
const WHEEL_LABEL_LINE_GAP = 1.18;
/** 可用宽度再收 5%：让标签与扇区分界线之间留一条缝（几何上刚好贴边=视觉上算溢出）。 */
const WHEEL_LABEL_SAFE = 0.95;
/** 单字宽度估算（em）：全角/CJK 记 1em，其余（字母、数字、空格、·）记 0.55em。 */
function charEm(ch: string): number {
  return /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 1 : 0.55;
}

/** 贪心逐字切行：`budgetEm` 是每行可用的 em 预算（含 letter-spacing）。CJK 无词间空格，逐字切最稳。 */
function wrapByEm(chars: string[], budgetEm: number, letterSpacingEm: number): string[] {
  const lines: string[] = [];
  let cur: string[] = [];
  let curEm = 0;
  for (const ch of chars) {
    const w = charEm(ch) + letterSpacingEm;
    if (curEm + w > budgetEm && cur.length > 0) {
      lines.push(cur.join(""));
      cur = [];
      curEm = 0;
      if (ch === " ") continue; // 空格不带行的开头（「二级咒灵 · / 从排水口」而不是「 · /  从排水口」）
    }
    cur.push(ch);
    curEm += w;
  }
  if (cur.length > 0) lines.push(cur.join(""));
  return lines;
}

/** 行块的径向半高（px）：lineCount 行、每行 fontSize（含字形上下伸部）。 */
function blockHalfHeight(lineCount: number, fontSize: number): number {
  return ((lineCount - 1) / 2) * fontSize * WHEEL_LABEL_LINE_GAP + fontSize * 0.62;
}

/**
 * 标签折行：行数越少字号越大（1–2 行 11px、3 行 9.5px），三行仍放不下就截断补「…」。
 *
 * 每行可用宽度按**几何反解**得到，而不是直接拿弧长/弦长当宽度：
 * 行块是有厚度的矩形，最靠近圆心那一行在窄扇区里最先被挤出去，所以约束是
 *   halfWidth ≤ (标签半径 − 行块径向半高) × tan(扇区半角) × 0.95
 * 这样「标签不压到相邻扇区」是算出来的，不是估出来的。
 *
 * 扇区越窄能放的字越少——这是几何宿命，硬塞只会压到隔壁扇区上。截断只影响扇区里的视觉：
 * 落定后的 `.wheel-result` 与 `aria-label` 仍是完整标签。
 */
function layoutWheelLabel(label: string, sweep: number): { lines: string[]; fontSize: number } {
  const chars = [...label.replace(/\s+/g, " ").trim()];
  const capped = chars.length > WHEEL_LABEL_MAX ? [...chars.slice(0, WHEEL_LABEL_MAX - 1), "…"] : chars;
  const halfRad = (Math.min(Math.max(sweep, 1), 180) * Math.PI) / 360;
  const tanHalf = Math.tan(halfRad);

  // 候选：先用大字号少行数，放不下再逐档降到 3 行 9.5px
  const candidates = [
    { lineCount: 1, fontSize: WHEEL_LABEL_FONT },
    { lineCount: 2, fontSize: WHEEL_LABEL_FONT },
    { lineCount: 2, fontSize: 9.5 },
    { lineCount: 3, fontSize: 9.5 },
  ] as const;

  let fallback: { lines: string[]; fontSize: number } | null = null;
  for (const cand of candidates) {
    const letterSpacingEm = cand.fontSize <= 10 ? 0.02 : 0.04;
    const halfWidth = Math.max(
      cand.fontSize * 0.5, // 窄到连一个字都放不下时别再缩预算（再缩就切不出字了）
      (WHEEL_LABEL_R - blockHalfHeight(cand.lineCount, cand.fontSize)) * tanHalf * WHEEL_LABEL_SAFE,
    );
    const lines = wrapByEm(capped, (halfWidth * 2) / cand.fontSize, letterSpacingEm);
    fallback = { lines, fontSize: cand.fontSize };
    if (lines.length <= cand.lineCount) return fallback;
  }

  // 3 行 9.5px 仍放不下 ⇒ 几何上装不下：留前 3 行，末行末尾换成省略号
  const kept = (fallback?.lines ?? []).slice(0, 3);
  const lastLine = [...(kept[2] ?? "")];
  if (lastLine.length > 0) lastLine[lastLine.length - 1] = "…";
  kept[2] = lastLine.join("");
  return { lines: kept, fontSize: 9.5 };
}

// ---------- 落针动画：圈数 / 时长 / 缓动只影响手感，落点角度仍由服务端给定的 target 决定 ----------

/** 圈数：够多才看得出「越转越慢」（5–7 圈）。 */
const WHEEL_SPIN_TURNS = 6;
/** 旋转总时长（3.6–4.5s）。 */
const WHEEL_SPIN_MS = 4000;
/** 强衰减缓动：前 20% 时间走掉约 70% 行程，剩下 3s 是缓慢的落针。 */
const WHEEL_SPIN_EASING = "cubic-bezier(.16,.8,.12,1)";
/** 落点极小幅回弹（度）：只做「顿一下」的质感，绝不允许跨到别的扇区。 */
const WHEEL_REBOUND_DEG = 2;
const WHEEL_REBOUND_MS = 220;
const WHEEL_REBOUND_EASING = "cubic-bezier(.32,.78,.4,1)";
/** 兜底余量：动画/回调全部失效时，最多再等这么久就必须让「继续」可点（宁可少看动画，不能少出口）。 */
const WHEEL_SETTLE_SLACK_MS = 1200;
/** 起转兜底：rAF 迟迟不来（后台标签、被节流的渲染）时，直接起转，不再等那一帧。 */
const WHEEL_KICKOFF_SLACK_MS = 1500;

/**
 * 随机事件揭示：服务端已用 RNG 结算（`wheelResult` / `lastWheels`），前端只做视觉呈现，
 * 不参与抽取。扇区面积按权重等比——玩家看到的概率就是真实概率，不另做「假均匀」美化。
 * 旋转量 = 整圈数 + 把命中扇区中心转到指针（12 点）所需的补角；动画结束后回调 `onSettled`，
 * 「继续」按钮由外层 `WheelPanel` 统一提供（一轮可能有多枚转盘）。
 */
function WheelReveal({
  wheel,
  title,
  animate,
  onSettled,
}: {
  wheel: WheelVM;
  title: string;
  /** true = 播放旋转动画；false = 直接落在命中扇区（刷新恢复时不重播） */
  animate: boolean;
  onSettled: () => void;
}) {
  const segs = wheel.segments;
  const total = segs.reduce((sum, s) => sum + Math.max(0, s.weight), 0) || segs.length;
  let cursor = 0;
  const sectors = segs.map((seg, i) => {
    const weight = Math.max(0, seg.weight);
    // 末扇区吸收浮点余量，保证 360° 闭合（否则指针可能落在缝隙上）
    const sweep = i === segs.length - 1 ? 360 - cursor : (weight / total) * 360;
    const start = cursor;
    cursor += sweep;
    return { label: seg.label, weight, start, sweep, center: start + sweep / 2 };
  });
  const hit = sectors.find((s) => s.label === wheel.label) ?? sectors[0];
  // 落点角度数学未变：整圈数 + 把命中扇区中心转到指针（12 点）所需的补角。
  // 圈数只加 360 的整数倍 ⇒ 最终角度 mod 360 与改前逐个相同（6 圈 vs 原 4 圈，落点不变）。
  const target = 360 * WHEEL_SPIN_TURNS + (360 - (hit?.center ?? 0));
  // 回弹幅度再按命中扇区的圆心角夹一道：最窄的扇区里也不许跨出半个扇区。
  const overshoot = Math.min(WHEEL_REBOUND_DEG, Math.max(0, hit?.sweep ?? 0) * 0.1);

  type SpinPhase = "idle" | "spin" | "rebound" | "done";
  // 存档恢复（animate=false）时转盘直接就位：既没有起点动画，也没有「转动中」中间态。
  const [phase, setPhase] = useState<SpinPhase>(animate ? "idle" : "done");
  const settled = phase === "done";

  useEffect(() => {
    if (!animate) {
      setPhase("done");
      return;
    }
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    if (reduce) {
      // 减动偏好：不加圈、不等时长，直接落在终点角度（角度本身与服务端给定的一致）
      setPhase("done");
      return;
    }
    // 先渲染 0° 再翻到目标角，浏览器才有过渡起点（同帧切换会被合并成瞬移）。
    // 只在仍是 idle 时推进：若兜底已经把状态推到后面，别把它拽回来重放一次。
    const raf = requestAnimationFrame(() => setPhase((p) => (p === "idle" ? "spin" : p)));
    return () => cancelAnimationFrame(raf);
  }, [animate]);

  // 起转兜底（验收项「动画失败不能让人卡死」）：`requestAnimationFrame` 在后台标签里可能一直不来，
  // 那样转子会永远停在 0°、`settled` 永远 false、「继续」永远不可点。到点主动起转。
  useEffect(() => {
    if (phase !== "idle") return;
    const id = window.setTimeout(() => setPhase((p) => (p === "idle" ? "spin" : p)), WHEEL_KICKOFF_SLACK_MS);
    return () => window.clearTimeout(id);
  }, [phase]);

  // 兜底推进：transitionend 在某些环境（后台标签页、被浏览器合并）可能不来，
  // 那时转盘会永远停在「转动中」。用超时把状态机推下去，正常路径下是空转。
  useEffect(() => {
    if (phase !== "spin" && phase !== "rebound") return;
    const ms = phase === "spin" ? WHEEL_SPIN_MS + 600 : WHEEL_REBOUND_MS + 600;
    const id = window.setTimeout(() => setPhase(phase === "spin" ? "rebound" : "done"), ms);
    return () => window.clearTimeout(id);
  }, [phase]);

  useEffect(() => {
    if (settled) onSettled();
  }, [settled, onSettled]);

  // 转子角度：0° → 超调一点点 → 精确落点。不播动画时直接停在命中角度：
  // 指针压住的就是服务端结算出的扇区。
  const rotorDeg = phase === "spin" ? target + overshoot : phase === "rebound" || phase === "done" ? target : 0;
  /**
   * 落定后转子会再转 `360 - 命中扇区中心` 度 ⇒ 每个扇区在屏幕上的角度是
   * `中心角 - 命中中心角`（mod 360），**不是**它自己的中心角。
   *
   * 标签的「不然就倒着」补偿必须按**屏幕上**的角度判断：早先按原始中心角判断，
   * 结果只有靠近指针的那一两个扇区正着，其余全倒过来（RPA 截图 `ui-4-wheel.png`）。
   * 转动过程中沿用起始朝向（0°），高速旋转时看不出差别。
   */
  const rotorOffset = phase === "rebound" || phase === "done" ? 360 - (hit?.center ?? 0) : 0;
  const rotorTransition =
    phase === "spin"
      ? `transform ${WHEEL_SPIN_MS}ms ${WHEEL_SPIN_EASING}`
      : phase === "rebound"
        ? `transform ${WHEEL_REBOUND_MS}ms ${WHEEL_REBOUND_EASING}`
        : "none";

  return (
    <div className="wheel">
      <div className="wheel-head">
        <span className="wheel-kicker">命运之轮</span>
        <strong className="wheel-title">{title}</strong>
      </div>

      <div className="wheel-stage">
        <div className="wheel-pointer" aria-hidden="true" />
        <svg
          className="wheel-dial"
          viewBox={`0 0 ${WHEEL_SIZE} ${WHEEL_SIZE}`}
          role="img"
          aria-label={`转盘：${sectors.map((s) => s.label).join("、")}`}
        >
          <defs>
            <radialGradient id="wheel-hub" cx="50%" cy="42%" r="70%">
              <stop offset="0%" stopColor="#2b3550" />
              <stop offset="100%" stopColor="#121724" />
            </radialGradient>
          </defs>
          {/* 外圈：双环 + 刻度，咒术式朱金配色 */}
          <circle cx={WHEEL_C} cy={WHEEL_C} r={WHEEL_R + 6} className="wheel-ring-outer" />
          <circle cx={WHEEL_C} cy={WHEEL_C} r={WHEEL_R + 2} className="wheel-ring-inner" />
          <g
            className="wheel-rotor"
            style={{
              transform: `rotate(${rotorDeg}deg)`,
              transformOrigin: `${WHEEL_C}px ${WHEEL_C}px`,
              transition: rotorTransition,
            }}
            onTransitionEnd={() => {
              if (phase === "spin") setPhase("rebound");
              else if (phase === "rebound") setPhase("done");
            }}
          >
            {sectors.map((s, i) => {
              const isHit = s.label === wheel.label;
              const layout = layoutWheelLabel(s.label, s.sweep);
              const at = polar(WHEEL_LABEL_R, s.center);
              const lineHeight = layout.fontSize * WHEEL_LABEL_LINE_GAP;
              const visualAngle = (((s.center + rotorOffset) % 360) + 360) % 360;
              const flip = visualAngle > 90 && visualAngle < 270;
              return (
                <g key={`${s.label}-${i}`}>
                  <path
                    d={sectorPath(s.start, s.start + s.sweep)}
                    className={`wheel-sector ${i % 2 === 0 ? "even" : "odd"} ${settled && isHit ? "hit" : ""}`}
                  />
                  {/* 多行：首行用 y 定位，其余用 dy 续行；整块按行数垂直居中于标签半径上 */}
                  <text
                    className={`wheel-label ${layout.fontSize < WHEEL_LABEL_FONT ? "wheel-label--dense" : ""} ${settled && isHit ? "hit" : ""}`}
                    transform={`rotate(${s.center} ${at.x} ${at.y}) rotate(${flip ? 180 : 0} ${at.x} ${at.y})`}
                  >
                    {layout.lines.map((line, li) => (
                      <tspan
                        key={`${line}-${li}`}
                        x={at.x}
                        {...(li === 0
                          ? { y: at.y - ((layout.lines.length - 1) / 2) * lineHeight }
                          : { dy: lineHeight })}
                      >
                        {line}
                      </tspan>
                    ))}
                  </text>
                </g>
              );
            })}
          </g>
          <circle cx={WHEEL_C} cy={WHEEL_C} r={26} fill="url(#wheel-hub)" className="wheel-hub-ring" />
          <text className="wheel-hub-text" x={WHEEL_C} y={WHEEL_C + 1}>
            命
          </text>
        </svg>
      </div>

      <div className="wheel-foot" aria-live="polite">
        {settled ? <p className="wheel-result">{hit?.label ?? wheel.label}</p> : <p className="wheel-spinning-text">轮盘转动中…</p>}
      </div>
    </div>
  );
}

export interface WheelPanelProps {
  /** 本轮的全部转盘结果（第一枚播动画，其余在落定后以紧凑卡片列出）。 */
  items: Array<{ wheel: WheelVM; title: string }>;
  /** 是否播放旋转动画（存档恢复的场景不播，见 D-09）。 */
  animate: boolean;
  /** 确认请求在途：按钮要一起禁用（引擎无状态区分「确认」和「行动」，双击会变成一次自由行动）。 */
  busy: boolean;
  /** 确认这一格（组件内部不发请求）。 */
  onContinue: () => void;
}

/**
 * 转盘揭晓（槽内这一枚）。
 *
 * ADR-0034 之后槽是单槽：一次只有一个 `random` 事件在演，所以 panel 通常只有一枚。
 * `items > 1` 的紧凑卡片分支保留下来是为了兼容旧快照/回放，不再主动使用。
 *
 * **不变量（验收项）**：「继续」永远存在。它是这一格唯一的推进出口 —— 动画哪怕一格没转
 * （rAF 没跑、transitionend 没来、后台标签被节流），按钮也必须在那儿、并且到点变得可点，
 * 否则玩家会被永久卡在「轮盘转动中…」。所以：
 *  - 按钮**首帧就渲染**，动画期间只是 `disabled`；
 *  - 除动画完成回调外，另有一条与动画无关的**超时兜底**把按钮解锁。
 */
export function WheelPanel({ items, animate, busy, onContinue }: WheelPanelProps) {
  const [firstSettled, setFirstSettled] = useState(!animate);
  const handleFirstSettled = useCallback(() => setFirstSettled(true), []);
  const continueRef = useRef<HTMLButtonElement | null>(null);
  const first = items[0];
  const rest = items.slice(1);

  /**
   * 动画失败的兜底解锁：与 `onSettled` 回调完全独立。
   * 只要 `animate`（首帧就禁用）而动画到头来没跑起来，超时后照样把「继续」点亮 ——
   * 最坏情况是玩家少看一次动画，绝不会少一个出口。
   */
  useEffect(() => {
    if (firstSettled) return;
    const id = window.setTimeout(() => setFirstSettled(true), WHEEL_SPIN_MS + WHEEL_REBOUND_MS + WHEEL_SETTLE_SLACK_MS);
    return () => window.clearTimeout(id);
  }, [firstSettled]);

  /**
   * D-05：转盘落定时「继续」会出现在事件区底部，430×932 竖屏下常被固定底栏（tabbar +
   * 交互浮标 `.interact-hint`）压住，玩家得先自己猜着往上滑。
   *
   * 取舍：选「内容出现时自动滚入视野」，而不是「容器底部按 --tabbar-h 留 padding」——
   * padding 只能保证「滚到底时不重叠」，按钮仍可能落在首屏之外，玩家还是要先滑一次；
   * 而这个按钮是本轮唯一的推进出口，落定即把它带进视野最省一次交互。
   *
   * 实现要点（首版踩过的坑）：
   * 1. 遮挡线取「tabbar 上沿」与「交互浮标上沿」的较小值——浮标本身也是 fixed 浮在内容上，
   *    只按 tabbar 算会把按钮留在浮标下面。
   * 2. 只滚动**最小必要距离**（不 `block:"center"`）：按钮靠近页面底部时居中目标会被
   *    maxScroll 截断，居中请求反而没把按钮带出来。
   * 3. 落定后 700ms 再校验一次（即时滚动兜底）：本轮多枚转盘的紧凑卡片是随后插入的，
   *    文档高度会在揭示过程中增长，首次滚动目标可能已过期。
   *
   * 这两选择器是宿主页面的约定（`.tabbar` / `.interact-hint`）；查不到时按 `innerHeight`
   * 兜底，所以自定义前端不实现这两个类也只是「不自动滚动」，不会坏。
   */
  useEffect(() => {
    if (!firstSettled) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

    const ensureVisible = (behavior: ScrollBehavior) => {
      const el = continueRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const tabbarTop = document.querySelector(".tabbar")?.getBoundingClientRect().top ?? window.innerHeight;
      const hintTop = document.querySelector(".interact-hint")?.getBoundingClientRect().top ?? window.innerHeight;
      const limit = Math.min(tabbarTop, hintTop) - 12;
      const delta = rect.bottom - limit; // > 0：按钮底部在遮挡线以下
      if (rect.top >= 0 && delta <= 0) return; // 已经在可视且未被遮挡
      const doc = document.scrollingElement ?? document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      window.scrollTo({ top: Math.max(0, Math.min(max, window.scrollY + delta)), behavior });
    };

    ensureVisible(reduce ? "auto" : "smooth");
    const timer = window.setTimeout(() => ensureVisible("auto"), 700);
    return () => window.clearTimeout(timer);
  }, [firstSettled]);

  if (!first) return null;

  return (
    <div className="wheel-deck">
      <WheelReveal wheel={first.wheel} title={first.title} animate={animate} onSettled={handleFirstSettled} />

      {firstSettled && rest.length > 0 && (
        <div className="wheel-rest" aria-live="polite">
          <p className="wheel-rest-title">同一轮另有 {rest.length} 次命运抉择</p>
          {rest.map((item, i) => (
            <div key={`${item.wheel.eventId}-${i}`} className="wheel-rest-item" style={{ animationDelay: `${i * 90}ms` }}>
              <span className="wheel-rest-name">{item.title}</span>
              <strong className="wheel-rest-hit">{item.wheel.label}</strong>
            </div>
          ))}
        </div>
      )}

      <div className="wheel-foot">
        {/* 常驻：动画期间禁用而非缺席（缺了它就没有推进出口） */}
        <button ref={continueRef} className="primary wheel-continue" disabled={!firstSettled || busy} onClick={onContinue}>
          继续
        </button>
      </div>
    </div>
  );
}
