import type { BattleFxCastVM, BattleFxHitVM, FxAnchorName, FxEffect, FxPrimitive } from "@life-sim/shared";

/**
 * 战斗特效绘制引擎（ADR-076 §3/§4）。
 *
 * 这一层**只画**：所有合并、覆盖、取值都已在投影期（`resolveBattleFx`）做完，
 * 这里拿到的是终值。任何「如果配了 A 就用 B」的判断都不该出现在这个文件里。
 *
 * 为什么不放进 React 树里：一次施放要连出几十个 SVG 节点、还要按毫秒排队，
 * 交给 React 反复 diff 只会让动画掉帧。React 只负责挂一个空容器。
 */

const NS = "http://www.w3.org/2000/svg";

export interface FxSettings {
  /** 减少动画（含 prefers-reduced-motion） */
  reduce: boolean;
  /** 快速战斗：所有时长压到 40% */
  fast: boolean;
  /** 关闭闪光：只关闪屏与发光 */
  noFlash: boolean;
}

export interface FxAnchor {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FxContext {
  svg: SVGSVGElement;
  layer: HTMLElement;
  board: HTMLElement;
  settings: FxSettings;
  /** 换段 / 卸载时置 true，绘制函数在每个 await 点检查 */
  aborted: () => boolean;
}

const attr = (el: Element, attrs: Record<string, string | number>): void => {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
};

const node = <K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] => {
  const el = document.createElementNS(NS, tag);
  attr(el, attrs);
  return el;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const scale = (s: FxSettings): number => (s.fast ? 0.4 : 1);

/** 单位锚点：卡片的矩形（找不到就退化为棋盘中心） */
export function anchorOf(board: HTMLElement, unitId: string): FxAnchor {
  const target = board.querySelector<HTMLElement>(`[data-unit-id="${unitId}"]`);
  const b = board.getBoundingClientRect();
  if (!target) return { x: b.width / 2, y: b.height / 2, w: 0, h: 0 };
  const r = target.getBoundingClientRect();
  return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height };
}

const centerOf = (a: FxAnchor) => ({ x: a.x + a.w / 2, y: a.y + a.h / 2 });

/**
 * 施法点：**卡片右下角内侧**。
 *
 * 不放在正中间 —— 玩家那一块在全宽布局里是一条状态栏，取 62%/45% 会正好压在血条中间，
 * 轨迹像是从血条里钻出来的。贴右下角起手，线从面板下缘划出去，也不遮挡数值。
 */
const handOf = (a: FxAnchor) => ({
  /**
   * 手边 = 卡片右下角，但**要让开右上角的数值**。
   *
   * 数字是右对齐的，0.86 的宽度在手机上正好压在「238/240」上（图片验收被判 FAIL）。
   * 宽屏上按比例算会更靠右，所以取「86%」与「右缘 -150px」的较小值。
   */
  x: a.x + a.w * 0.68,
  y: a.y + a.h - 6,
});

/**
 * 地面锚点：卡片的**正下方一点**。
 *
 * 法阵（召唤 / 奥义）画在地上，不是画在手上。放在卡片下缘外侧有两个好处：
 * 不压资源条上的数字，而且「站在地上」的语义成立（从地面升起的东西都该画在脚下）。
 */
const groundOf = (a: FxAnchor) => ({ x: a.x + a.w * 0.5, y: a.y + a.h + 10 });

// ---------------------------------------------------------------- 基础图元

function probe(ctx: FxContext, d: string): SVGPathElement {
  const p = node("path", { d, fill: "none", stroke: "none" });
  ctx.svg.appendChild(p);
  return p;
}

function defsOf(svg: SVGSVGElement): SVGDefsElement {
  let defs = svg.querySelector<SVGDefsElement>("defs");
  if (!defs) {
    defs = node("defs");
    svg.appendChild(defs);
  }
  return defs;
}

let uid = 0;

/** 掩码显影：填充带也能逐段长出来（描边 dash 做不到） */
function reveal(
  ctx: FxContext,
  d: string,
  width: number,
  durationMs: number,
  delayMs = 0,
): string {
  const id = `fx-rv-${++uid}`;
  const b = ctx.board.getBoundingClientRect();
  const mask = node("mask", {
    id,
    maskUnits: "userSpaceOnUse",
    x: -100,
    y: -100,
    width: b.width + 200,
    height: b.height + 200,
  });
  const len = probe(ctx, d).getTotalLength();
  const p = node("path", {
    d,
    fill: "none",
    stroke: "#fff",
    "stroke-width": width + 14,
    "stroke-linecap": "round",
    "stroke-dasharray": len,
    "stroke-dashoffset": len,
  });
  mask.appendChild(p);
  defsOf(ctx.svg).appendChild(mask);
  setTimeout(() => {
    p.style.transition = `stroke-dashoffset ${durationMs}ms cubic-bezier(.22,.62,.24,1)`;
    p.style.strokeDashoffset = "0";
  }, delayMs);
  return `url(#${id})`;
}

function gradient(
  ctx: FxContext,
  a: { x: number; y: number },
  b: { x: number; y: number },
  color: string,
  colorFrom?: string,
): string {
  const id = `fx-gr-${++uid}`;
  const g = node("linearGradient", {
    id,
    gradientUnits: "userSpaceOnUse",
    x1: a.x,
    y1: a.y,
    x2: b.x,
    y2: b.y,
  });
  if (colorFrom !== undefined) {
    g.appendChild(node("stop", { offset: "0%", "stop-color": colorFrom, "stop-opacity": "0.05" }));
    g.appendChild(node("stop", { offset: "48%", "stop-color": colorFrom, "stop-opacity": "0.92" }));
    g.appendChild(node("stop", { offset: "100%", "stop-color": color, "stop-opacity": "1" }));
  } else {
    g.appendChild(node("stop", { offset: "0%", "stop-color": color, "stop-opacity": "0" }));
    g.appendChild(node("stop", { offset: "38%", "stop-color": color, "stop-opacity": "0.5" }));
    g.appendChild(node("stop", { offset: "100%", "stop-color": color, "stop-opacity": "1" }));
  }
  defsOf(ctx.svg).appendChild(g);
  return `url(#${id})`;
}

const PROFILE = {
  comet: (t: number) => Math.pow(Math.sin(Math.PI * t), 0.55) * (0.3 + 0.7 * t),
  blade: (t: number) => Math.pow(Math.sin(Math.PI * t), 0.42),
  fan: (t: number) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.9)), 0.7) * (0.2 + 0.8 * t),
};

/** 锥形带：沿路径采样后按剖面收放宽度，起点细、终点收尖 */
function ribbonOf(p: SVGPathElement, maxW: number, prof: (t: number) => number): string {
  const len = p.getTotalLength();
  const n = 48;
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const cur = p.getPointAtLength(len * t);
    const a = p.getPointAtLength(Math.min(len, len * t + 0.6));
    const b = p.getPointAtLength(Math.max(0, len * t - 0.6));
    const ang = Math.atan2(a.y - b.y, a.x - b.x);
    const nx = -Math.sin(ang);
    const ny = Math.cos(ang);
    const w = Math.max(0.3, (maxW * prof(t)) / 2);
    left.push(`${(cur.x + nx * w).toFixed(1)},${(cur.y + ny * w).toFixed(1)}`);
    right.push(`${(cur.x - nx * w).toFixed(1)},${(cur.y - ny * w).toFixed(1)}`);
  }
  return `M ${left.join(" L ")} L ${right.reverse().join(" L ")} Z`;
}

interface TrailOpts {
  color: string;
  colorFrom?: string;
  width: number;
  durationMs: number;
  delayMs?: number;
  profile?: keyof typeof PROFILE;
  glow?: boolean;
  core?: boolean;
  coreColor?: string;
}

function trail(
  ctx: FxContext,
  d: string,
  o: TrailOpts,
): { end: { x: number; y: number }; angle: number; group: SVGGElement } {
  const p = probe(ctx, d);
  const len = p.getTotalLength();
  const end = p.getPointAtLength(len);
  const prev = p.getPointAtLength(Math.max(0, len - 3));
  const start = p.getPointAtLength(0);
  const mask = reveal(ctx, d, o.width, o.durationMs, o.delayMs ?? 0);
  const fill = gradient(ctx, start, end, o.color, o.colorFrom);

  /**
   * 整段轨迹进一个 `<g>`：**演完必须淡出**。
   *
   * 以前只画不收，轨迹会一直挂到下一次施法（用户的话：「1 秒后屏上还插着一支箭」）。
   * 淡出用 240ms，比动画本身短 —— 拖尾退得太慢会糊住下一个目标。
   */
  const group = node("g");
  ctx.svg.appendChild(group);
  /**
   * 头点：沿路径真的走一遍。
   *
   * 以前只有「路径逐渐显影」，球本身不动 —— 看图的人会说「飞行帧一像素没动」。
   * 一颗跟着前缘走的小亮点，是「有东西飞过去」最便宜的写法。
   */
  if (!ctx.settings.reduce) {
    const samples = Array.from({ length: 33 }, (_, i) => p.getPointAtLength((len * i) / 32));
    const dot = node("circle", { r: Math.max(1.6, Math.min(4.2, o.width * 0.32)), fill: "#fff", opacity: 0.95 });
    group.appendChild(dot);
    const startAt = performance.now() + (o.delayMs ?? 0);
    const step = (): void => {
      if (ctx.aborted() || !dot.isConnected) return;
      const t = Math.min(1, Math.max(0, (performance.now() - startAt) / o.durationMs));
      const idx = Math.min(32, Math.round(t * 32));
      const pt = samples[idx]!;
      dot.setAttribute("cx", pt.x.toFixed(1));
      dot.setAttribute("cy", pt.y.toFixed(1));
      if (t < 1) requestAnimationFrame(step);
      else dot.setAttribute("opacity", "0");
    };
    requestAnimationFrame(step);
  }
  if (o.glow !== false && !ctx.settings.noFlash) {
    group.appendChild(
      node("path", {
        d,
        fill: "none",
        stroke: o.color,
        "stroke-width": o.width * 2.1,
        "stroke-linecap": "round",
        opacity: 0.2,
        filter: "blur(6px)",
        mask,
      }),
    );
  }
  group.appendChild(node("path", { d: ribbonOf(p, o.width, PROFILE[o.profile ?? "comet"]), fill, opacity: 0.96, mask }));
  if (o.core !== false) {
    group.appendChild(
      node("path", {
        d,
        fill: "none",
        stroke: o.coreColor ?? "#fff",
        "stroke-width": Math.max(0.9, o.width * 0.13),
        "stroke-linecap": "round",
        opacity: 0.4,
        mask,
      }),
    );
  }
  setTimeout(() => {
    group.style.transition = "opacity 240ms ease-out";
    group.style.opacity = "0";
  }, (o.delayMs ?? 0) + o.durationMs + 160);
  p.remove();
  return { end, angle: Math.atan2(end.y - prev.y, end.x - prev.x), group };
}

function hairline(
  ctx: FxContext,
  d: string,
  o: { color: string; width: number; durationMs: number; delayMs?: number; dash?: string },
): { end: { x: number; y: number }; angle: number; length: number } {
  const p = probe(ctx, d);
  const len = p.getTotalLength();
  const start = p.getPointAtLength(0);
  const end = p.getPointAtLength(len);
  const mask = reveal(ctx, d, o.width, o.durationMs, o.delayMs ?? 0);
  const path = node("path", {
    d,
    fill: "none",
    stroke: gradient(ctx, start, end, o.color),
    "stroke-width": o.width,
    "stroke-linecap": "round",
    mask,
  });
  if (o.dash !== undefined) path.setAttribute("stroke-dasharray", o.dash);
  const group = node("g");
  group.appendChild(path);
  ctx.svg.appendChild(group);
  setTimeout(() => {
    group.style.transition = "opacity 220ms ease-out";
    group.style.opacity = "0";
  }, (o.delayMs ?? 0) + o.durationMs + 160);
  p.remove();
  return { end, angle: Math.atan2(end.y - start.y, end.x - start.x), length: len };
}

function chevron(
  ctx: FxContext,
  p: { x: number; y: number },
  angle: number,
  color: string,
  size = 7,
  host?: SVGElement,
): void {
  const a1 = angle + Math.PI * 0.78;
  const a2 = angle - Math.PI * 0.78;
  (host ?? ctx.svg).appendChild(
    node("path", {
      d: `M ${(p.x + Math.cos(a1) * size).toFixed(1)} ${(p.y + Math.sin(a1) * size).toFixed(1)} L ${p.x.toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + Math.cos(a2) * size).toFixed(1)} ${(p.y + Math.sin(a2) * size).toFixed(1)}`,
      fill: "none",
      stroke: color,
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      opacity: 0.95,
    }),
  );
}

function diamond(
  ctx: FxContext,
  p: { x: number; y: number },
  size: number,
  color: string,
  opacity = 1,
  host?: SVGElement,
): SVGPathElement {
  const el = node("path", {
    d: `M ${p.x} ${p.y - size} L ${p.x + size} ${p.y} L ${p.x} ${p.y + size} L ${p.x - size} ${p.y} Z`,
    fill: color,
    opacity,
  });
  (host ?? ctx.svg).appendChild(el);
  return el;
}

function hexShield(ctx: FxContext, p: { x: number; y: number }, color: string, r = 13): void {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    pts.push(`${(p.x + Math.cos(a) * r).toFixed(1)} ${(p.y + Math.sin(a) * r * 1.1).toFixed(1)}`);
  }
  const path = node("path", { d: `M ${pts.join(" L ")} Z`, fill: "none", stroke: color, "stroke-width": 1.6 });
  path.style.transformOrigin = `${p.x}px ${p.y}px`;
  path.style.animation = `fx-pop 240ms cubic-bezier(.2,.9,.3,1.3) both`;
  ctx.svg.appendChild(path);
}

function sparks(ctx: FxContext, p: { x: number; y: number }, color: string, count = 8): void {
  if (ctx.settings.reduce) return;
  for (let i = 0; i < count; i++) {
    const dot = document.createElement("div");
    dot.className = "fx-spark";
    const size = 2 + Math.random() * 3;
    const a = Math.random() * Math.PI * 2;
    const dist = 16 + Math.random() * 32;
    dot.style.cssText = `left:${p.x}px;top:${p.y}px;width:${size}px;height:${size}px;background:${color};
      box-shadow:0 0 6px ${color};--fx-dx:${(Math.cos(a) * dist).toFixed(0)}px;--fx-dy:${(Math.sin(a) * dist).toFixed(0)}px;
      animation: fx-sparkfly ${320 + Math.random() * 240}ms cubic-bezier(.2,.7,.3,1) both;`;
    ctx.layer.appendChild(dot);
    setTimeout(() => dot.remove(), 640);
  }
}

function ringAt(ctx: FxContext, p: { x: number; y: number }, color: string, size = 64): void {
  if (ctx.settings.reduce) return;
  const el = document.createElement("div");
  el.className = "fx-ring";
  el.style.cssText = `left:${p.x - size / 2}px;top:${p.y - size / 2}px;width:${size}px;height:${size}px;border-color:${color};`;
  ctx.layer.appendChild(el);
  setTimeout(() => el.remove(), 460);
}

/** 提亮（往白里混）：内置几何没有模板配色，靠它给光柱/光晕做出「白核」。 */
function tint(color: string, k: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1]!, 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * k));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------- ① 施法

/**
 * 施法层：**引擎不内置预设**（ADR-076 §3.0）—— 这里只提供几个常用形态的实现，
 * 未知 preset 降级成「环」，扩展注册的新预设不会让渲染器崩。
 *
 * 方向是第一原则：引力朝内（converge）、斥力朝外（repulse）、虚式先内后外（collapse）。
 * 不看颜色、只听名字也能分辨，这是同屏两个术式同时起手时的辨识度。
 */
function castRing(
  ctx: FxContext,
  p: { x: number; y: number },
  r: number,
  color: string,
  o: {
    width?: number;
    dash?: string;
    dur: number;
    delayMs?: number;
    reverse?: boolean;
    /** 描边用的油漆（可以是 `url(#渐变)`）；缺省 = 单色 `color` */
    stroke?: string;
    /** 压扁成椭圆（地面上的圈） */
    ry?: number;
    /** 关掉外圈散光（默认开着） */
    halo?: boolean;
  } = { dur: 400 },
): void {
  const paint = o.stroke ?? color;
  const c = o.ry !== undefined
    ? node("ellipse", {
        cx: p.x, cy: p.y, rx: r, ry: o.ry,
        fill: "none",
        stroke: paint,
        "stroke-width": o.width ?? 2,
        opacity: 0,
        ...(o.dash !== undefined ? { "stroke-dasharray": o.dash } : {}),
      })
    : node("circle", {
        cx: p.x, cy: p.y, r,
        fill: "none",
        stroke: paint,
        "stroke-width": o.width ?? 2,
        opacity: 0,
        ...(o.dash !== undefined ? { "stroke-dasharray": o.dash } : {}),
      });
  /**
   * 用 `fx-bloom` 而不是 `fx-castfade`：环是**成型物**，要「亮起来 → 站住 → 散掉」。
   * 线性淡出会让法阵在演到一半时就灰掉，看起来像没电了。
   */
  const fade = `fx-bloom ${o.dur}ms ${o.delayMs ?? 0}ms ease-out both`;
  c.style.animation = o.dash !== undefined
    ? `${fade}, ${o.reverse === true ? "fx-castdashrev" : "fx-castdash"} ${o.dur * 2}ms ${o.delayMs ?? 0}ms linear both`
    : fade;

  /**
   * 光晕：同一条线再画一遍，加粗 3 倍、模糊 4px、压低不透明度。
   *
   * 一条 2px 的线在深色卡片上只是「一根线」；有了下面这层散光才像**发光的环**。
   * 设计稿里每个圈都带这层，而且它比把线加粗更有效 —— 加粗会糊掉细节，加光晕不会。
   */
  if (o.halo !== false && !ctx.settings.reduce) {
    const halo = c.cloneNode(true) as SVGElement;
    halo.setAttribute("stroke-opacity", "0.34");
    halo.setAttribute("stroke-width", String((o.width ?? 2) * 3));
    halo.setAttribute("filter", "blur(4px)");
    halo.style.animation = c.style.animation;
    ctx.svg.appendChild(halo);
  }
  ctx.svg.appendChild(c);
}

/** 施法粒子：`inward` 从外圈往回收，`outward` 从中心炸出去。 */
function castMotes(
  ctx: FxContext,
  p: { x: number; y: number },
  color: string,
  count: number,
  radius: number,
  inward: boolean,
  durMs: number,
): void {
  if (ctx.settings.reduce) return;
  for (let i = 0; i < count; i++) {
    const a = (Math.PI * 2 * i) / count + Math.random() * 0.3;
    const r = radius * (0.7 + Math.random() * 0.5);
    const dot = document.createElement("div");
    dot.className = "fx-spark";
    const size = 2 + Math.random() * 2.5;
    const x = inward ? p.x + Math.cos(a) * r : p.x;
    const y = inward ? p.y + Math.sin(a) * r : p.y;
    const dx = Math.cos(a) * (inward ? -r : r);
    const dy = Math.sin(a) * (inward ? -r : r);
    dot.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size}px;background:${color};
      box-shadow:0 0 7px ${color};--fx-dx:${dx.toFixed(0)}px;--fx-dy:${dy.toFixed(0)}px;
      animation: fx-sparkfly ${durMs}ms ease-out both;`;
    ctx.layer.appendChild(dot);
    setTimeout(() => dot.remove(), durMs + 80);
  }
}

// ---------------------------------------------------------------- ② 表现 DSL（ADR-078）

type Pt = { x: number; y: number };

/**
 * 画一段表现需要的锚点：两张卡 + 起止点。
 *
 * 所有图元都相对**卡片**定位（不写绝对坐标）：卡片在竖屏 / 横屏 / 管理端宽度都不一样，
 * 写死像素的模板换个分辨率就废了。
 */
interface FxAnchors {
  caster: FxAnchor;
  target: FxAnchor;
  board: { w: number; h: number };
  from: Pt;
  to: Pt;
  /**
   * `at: target` 的**落点**（缺省 = 目标卡面中心）。
   *
   * 受击要打在「刃插进去的那一点」（宽度的 30%），而 `rect` 还得是整张卡 ——
   * 割口、登场光环这些要按卡片真实宽度铺。所以点与盒子分开给。
   */
  impact?: Pt;
}

function pointOf(name: FxAnchorName | undefined, a: FxAnchors): Pt {
  switch (name) {
    case "self":
      return centerOf(a.caster);
    case "hand":
      return handOf(a.caster);
    case "ground":
      return groundOf(a.caster);
    case "targetGround":
      return groundOf(a.target);
    case "mid":
      return { x: (a.from.x + a.to.x) / 2, y: (a.from.y + a.to.y) / 2 };
    case "board":
      return { x: a.board.w / 2, y: a.board.h / 2 };
    default:
      return a.impact ?? centerOf(a.target);
  }
}

function rectOfAnchor(name: FxAnchorName | undefined, a: FxAnchors): FxAnchor {
  switch (name) {
    case "self":
    case "hand":
    case "ground":
      return a.caster;
    case "board":
      return { x: 0, y: 0, w: a.board.w, h: a.board.h };
    default:
      return a.target;
  }
}

/** 割口布局（固定表，不用随机数：同一场战斗两次重放必须一模一样）。 */
const CUT_LAYOUT = [
  { cx: 0.3, cy: 0.34, angle: -0.22, len: 0.3 },
  { cx: 0.56, cy: 0.66, angle: 0.18, len: 0.34 },
  { cx: 0.42, cy: 0.44, angle: -0.05, len: 0.22 },
  { cx: 0.5, cy: 0.48, angle: 0.03, len: 0.88 },
  { cx: 0.68, cy: 0.3, angle: 0.12, len: 0.2 },
  { cx: 0.24, cy: 0.58, angle: -0.16, len: 0.24 },
] as const;

// ---------------------------------------------------------------- 渐变与旋转

interface FillOpts {
  /** 首标不透明度（缺省 1） */
  fromOpacity?: number;
  /** 中间标不透明度（缺省 0.85） */
  midOpacity?: number;
  /** 末标不透明度（缺省 1） */
  edgeOpacity?: number;
  /** 整体再乘一道（层自己的 `opacity`），三个色标一起缩 */
  alpha?: number;
}

/**
 * 线性渐变：沿两点铺 1–3 个色标。
 *
 * 环用「沿直径」、柱用「沿高度」、光条用「从内到外」，方向全由**图元**决定 ——
 * 模板只给颜色，不给角度（给了角度，换分辨率就歪）。
 */
function linearFill(
  ctx: FxContext,
  a: { x: number; y: number },
  b: { x: number; y: number },
  colors: readonly string[],
  o: FillOpts = {},
): string {
  const id = `fx-lg-${++uid}`;
  const g = node("linearGradient", {
    id,
    gradientUnits: "userSpaceOnUse",
    x1: a.x.toFixed(1),
    y1: a.y.toFixed(1),
    x2: b.x.toFixed(1),
    y2: b.y.toFixed(1),
  });
  const mul = o.alpha ?? 1;
  const n = colors.length;
  colors.forEach((c, i) => {
    const off = n === 1 ? 0 : (i / (n - 1)) * 100;
    const op = i === 0 ? (o.fromOpacity ?? 1) : i === n - 1 ? (o.edgeOpacity ?? 1) : (o.midOpacity ?? 0.85);
    g.appendChild(node("stop", { offset: `${off.toFixed(1)}%`, "stop-color": c, "stop-opacity": (op * mul).toFixed(3) }));
  });
  defsOf(ctx.svg).appendChild(g);
  return `url(#${id})`;
}

/** 径向渐变（圆）：中心 → 边缘，`r0` 是中空半径。 */
function radialFill(
  ctx: FxContext,
  p: { x: number; y: number },
  r0: number,
  r1: number,
  colors: readonly string[],
  o: FillOpts = {},
): string {
  const id = `fx-rg-${++uid}`;
  const g = node("radialGradient", { id, gradientUnits: "userSpaceOnUse", cx: p.x, cy: p.y, r: Math.max(1, r1) });
  const mul = o.alpha ?? 1;
  const n = colors.length;
  const inner = Math.min(0.92, Math.max(0, r0) / Math.max(1, r1));
  colors.forEach((c, i) => {
    const t = n === 1 ? 0 : i / (n - 1);
    const off = (inner + (1 - inner) * t) * 100;
    const op = i === 0 ? (o.fromOpacity ?? 1) : i === n - 1 ? (o.edgeOpacity ?? 1) : (o.midOpacity ?? 0.85);
    g.appendChild(node("stop", { offset: `${off.toFixed(1)}%`, "stop-color": c, "stop-opacity": (op * mul).toFixed(3) }));
  });
  defsOf(ctx.svg).appendChild(g);
  return `url(#${id})`;
}

/**
 * 径向渐变（椭圆）：`objectBoundingBox` 单位，**跟着形状压扁**。
 *
 * 圆形的 `radialFill` 直接套在扁椭圆上，纵向衰减会比横向慢一倍 —— 地上的光池
 * 会变成一坨往下漏的光。这里必须按包围盒算。
 */
function ellipseFill(ctx: FxContext, colors: readonly string[], o: FillOpts = {}): string {
  const id = `fx-eg-${++uid}`;
  const g = node("radialGradient", { id, cx: "50%", cy: "50%", r: "50%" });
  const mul = o.alpha ?? 1;
  const n = colors.length;
  colors.forEach((c, i) => {
    const off = n === 1 ? 0 : (i / (n - 1)) * 100;
    const op = i === 0 ? (o.fromOpacity ?? 1) : i === n - 1 ? (o.edgeOpacity ?? 0) : (o.midOpacity ?? 0.85);
    g.appendChild(node("stop", { offset: `${off.toFixed(1)}%`, "stop-color": c, "stop-opacity": (op * mul).toFixed(3) }));
  });
  defsOf(ctx.svg).appendChild(g);
  return `url(#${id})`;
}

/**
 * 转一层几何。
 *
 * 用 `transform` 属性逐帧写角度，不用 CSS `@keyframes` + `transform-origin`：
 * SVG 的 `transform-box` 默认值各浏览器不一致，写 origin 会出现「绕左上角转」。
 * 直接写 `rotate(deg cx cy)` 没有这个歧义。
 */
function spinLayer(
  ctx: FxContext,
  g: SVGGElement,
  p: { x: number; y: number },
  turns: number,
  durMs: number,
  delayMs: number,
): void {
  if (turns === 0 || ctx.settings.reduce) return;
  const start = performance.now() + delayMs;
  const step = (): void => {
    if (ctx.aborted() || !g.isConnected) return;
    const t = Math.min(1, Math.max(0, (performance.now() - start) / durMs));
    g.setAttribute("transform", `rotate(${(turns * 360 * t).toFixed(2)} ${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * 画一个图元。
 *
 * 这是渲染层**唯一的**样式入口：它不认识任何术式名，只认识「环 / 光柱 / 光线 /
 * 粒子 / 雷弧 / 刀光 / 割口 / 盾 / 闪屏 / 遮幅 / 三角 / 扇形 / 光晕」这些几何。
 * 模板用它们拼出想要的样子（ADR-078）。
 *
 * 颜色可以先过一道渐变：单色也能画，但**有渐变才像光** —— 纯色圆看着像贴纸，
 * 白核 + 本色 + 暗边才像发光体。
 */
function drawLayer(
  ctx: FxContext,
  layer: FxPrimitive,
  a: FxAnchors,
  base: { color: string; d: number; width: number },
): void {
  const color = layer.color ?? base.color;
  const d = Math.max(60, layer.durationMs ?? base.d);
  const delay = layer.delayMs ?? 0;
  const anchor = pointOf(layer.at, a);
  const p = layer.offset === undefined ? anchor : { x: anchor.x + layer.offset[0], y: anchor.y + layer.offset[1] };
  const rect = rectOfAnchor(layer.at, a);

  // 旋转：把这一层整体塞进 <g>，转的是几何，不是虚线
  const turns = layer.turns ?? 0;
  if (turns !== 0) {
    const g = node("g");
    ctx.svg.appendChild(g);
    spinLayer(ctx, g, p, turns, d, delay);
    const host = { ...ctx, svg: g as unknown as SVGSVGElement };
    drawLayer(host, { ...layer, turns: 0 } as FxPrimitive, a, base);
    return;
  }

  const fade = (el: SVGElement | HTMLDivElement, ms: number, at: number): void => {
    el.style.animation = `fx-castfade ${ms}ms ${at}ms ease-out both`;
  };
  /** 光晕类：亮起来 → 停一拍 → 退掉（直线淡入淡出看不出「扫过去」） */
  const bloom = (el: SVGElement, ms: number, at: number): void => {
    el.style.animation = `fx-bloom ${ms}ms ${at}ms ease-out both`;
  };
  const alpha = layer.opacity ?? 1;

  switch (layer.shape) {
    case "ring": {
      const stroke =
        layer.gradient !== undefined
          ? linearFill(
              ctx,
              { x: p.x - layer.r, y: p.y - layer.r },
              { x: p.x + layer.r, y: p.y + layer.r },
              layer.gradient,
              { fromOpacity: 0.92, midOpacity: 1, edgeOpacity: 0.8, alpha },
            )
          : undefined;
      castRing(ctx, p, layer.r, color, {
        width: layer.width ?? 1.8,
        ...(stroke !== undefined ? { stroke } : {}),
        ...(layer.ry !== undefined ? { ry: layer.ry } : {}),
        ...(layer.dash !== undefined ? { dash: layer.dash.join(" ") } : {}),
        dur: d,
        delayMs: delay,
        ...(layer.spin === -1 ? { reverse: true } : {}),
      });
      return;
    }
    case "pool": {
      const fill =
        layer.gradient !== undefined
          ? ellipseFill(ctx, layer.gradient, { alpha, edgeOpacity: 0 })
          : color;
      const el = node("ellipse", {
        cx: p.x,
        cy: p.y,
        rx: layer.rx,
        ry: layer.ry ?? layer.rx * 0.32,
        fill,
        opacity: alpha,
        style: `filter: blur(${layer.blur ?? 5}px)`,
      });
      el.style.opacity = "0";
      bloom(el, d, delay);
      ctx.svg.appendChild(el);
      return;
    }
    case "pillar": {
      const y = layer.rise === false ? p.y - layer.h / 2 : p.y - layer.h;
      const colors = layer.gradient ?? [color];
      // 底亮顶散：光柱一定是从地面“长”出来的，不是天上掉下来一块
      const opts: FillOpts = { fromOpacity: Math.min(1, alpha + 0.1), midOpacity: alpha * 0.7, edgeOpacity: 0 };
      const soft = node("rect", {
        x: p.x - layer.w / 2,
        y,
        width: layer.w,
        height: layer.h,
        fill: linearFill(ctx, { x: p.x, y: y + layer.h }, { x: p.x, y }, colors, opts),
        style: `filter: blur(${layer.blur ?? 5}px)`,
      });
      soft.style.opacity = "0";
      bloom(soft, d, delay);
      ctx.svg.appendChild(soft);

      // 芯：窄、少模糊，光柱才像「一束」而不是「一块」
      const core = layer.core ?? 0.34;
      if (core > 0) {
        const cw = Math.max(1, layer.w * core);
        const hot = node("rect", {
          x: p.x - cw / 2,
          y,
          width: cw,
          height: layer.h,
          fill: linearFill(ctx, { x: p.x, y: y + layer.h }, { x: p.x, y }, colors, {
            fromOpacity: 1,
            midOpacity: alpha * 0.5,
            edgeOpacity: 0,
          }),
          style: "filter: blur(2px)",
        });
        hot.style.opacity = "0";
        bloom(hot, d, delay);
        ctx.svg.appendChild(hot);
      }
      return;
    }
    case "rays": {
      for (let i = 0; i < layer.count; i++) {
        const ang = (layer.from ?? -Math.PI / 2) + (Math.PI * 2 * i) / layer.count;
        const inner = { x: p.x + Math.cos(ang) * layer.inner, y: p.y + Math.sin(ang) * layer.inner };
        const outer = { x: p.x + Math.cos(ang) * layer.outer, y: p.y + Math.sin(ang) * layer.outer };
        const stroke =
          layer.gradient !== undefined
            ? linearFill(
                ctx,
                inner,
                outer,
                layer.gradient,
                layer.fade === "in"
                  ? { fromOpacity: 1, midOpacity: 0.72, edgeOpacity: 0.06, alpha }
                  : { fromOpacity: 0.15, midOpacity: 0.9, edgeOpacity: 1, alpha },
              )
            : color;
        const el = node("line", {
          x1: inner.x.toFixed(1),
          y1: inner.y.toFixed(1),
          x2: outer.x.toFixed(1),
          y2: outer.y.toFixed(1),
          stroke,
          "stroke-width": layer.width ?? 1.4,
          "stroke-linecap": "round",
          opacity: 1,
        });
        el.style.opacity = "0";
        bloom(el, d, delay + i * (layer.stagger ?? 0));
        ctx.svg.appendChild(el);
      }
      return;
    }
    case "motes": {
      castMotes(ctx, p, color, layer.count, layer.radius, layer.dir === "in", d);
      return;
    }
    case "sparks": {
      sparks(ctx, p, color, layer.count);
      return;
    }
    case "bolt": {
      for (let i = 0; i < layer.count; i++) {
        const spread = layer.spread ?? Math.PI * 1.62;
        const ang = layer.count === 1 ? 0 : -Math.PI * 0.8 + (spread * i) / (layer.count - 1);
        const len = layer.lenMin + Math.random() * Math.max(0, layer.lenMax - layer.lenMin);
        const to = { x: p.x + Math.cos(ang) * len, y: p.y + Math.sin(ang) * len * 0.85 };
        const segs = layer.segments ?? 4;
        const pts: string[] = [`${p.x.toFixed(1)} ${p.y.toFixed(1)}`];
        for (let k = 1; k < segs; k++) {
          const t = k / segs;
          pts.push(
            `${(p.x + (to.x - p.x) * t + (Math.random() - 0.5) * 9).toFixed(1)} ${(p.y + (to.y - p.y) * t + (Math.random() - 0.5) * 9).toFixed(1)}`,
          );
        }
        pts.push(`${to.x.toFixed(1)} ${to.y.toFixed(1)}`);
        const dPath = `M ${pts.join(" L ")}`;
        const w = layer.width ?? 2;
        const head = layer.gradient?.[1] ?? color;
        ctx.svg.appendChild(
          node("path", {
            d: dPath,
            fill: "none",
            stroke: color,
            "stroke-width": w * 1.8,
            "stroke-linecap": "round",
            opacity: 0.28,
            filter: "blur(4px)",
          }),
        );
        ctx.svg.appendChild(
          node("path", {
            d: dPath,
            fill: "none",
            stroke: gradient(ctx, p, to, head, layer.gradient?.[0] ?? color),
            "stroke-width": w,
            "stroke-linecap": "round",
            opacity: 0.95,
          }),
        );
      }
      return;
    }
    case "orb": {
      const fill =
        layer.gradient !== undefined
          ? radialFill(ctx, p, 0, layer.r, layer.gradient, {
              alpha,
              fromOpacity: 1,
              midOpacity: 0.95,
              edgeOpacity: 0.85,
            })
          : color;
      const el = node("circle", { cx: p.x, cy: p.y, r: layer.r, fill, opacity: layer.opacity ?? 0.95 });
      ctx.svg.appendChild(el);
      /**
       * 球必须有**寿命**：以前只画不收，施法演完球还杵在血条上（看起来像卡住了）。
       * 会飞的球在「飞完 + 一点余辉」时就散；不飞的球跟这一段同寿。
       */
      const travel = layer.to === undefined ? 0 : Math.round(d * (layer.travel ?? 0.42));
      const life = layer.to === undefined ? d : travel + 180;
      el.style.opacity = "0";
      el.style.animation = `fx-orb ${life}ms ${delay}ms ease-out both`;
      if (layer.to !== undefined) {
        el.style.transition = `transform ${travel}ms ${delay}ms cubic-bezier(.5,0,.3,1)`;
        requestAnimationFrame(() => {
          el.style.transform = `translate(${layer.to![0].toFixed(1)}px, ${layer.to![1].toFixed(1)}px)`;
        });
      }
      return;
    }
    case "arc": {
      const bow = layer.bow ?? [54, -10];
      const dPath = `M ${a.from.x} ${a.from.y} Q ${(a.from.x + a.to.x) / 2 + bow[0]} ${(a.from.y + a.to.y) / 2 + bow[1]} ${a.to.x} ${a.to.y}`;
      const w = layer.width ?? base.width;
      if (layer.profile === "line") {
        const r = hairline(ctx, dPath, {
          color,
          width: Math.max(1, w),
          durationMs: d,
          ...(layer.dash !== undefined ? { dash: layer.dash.join(" ") } : {}),
        });
        if (layer.head === "chevron") chevron(ctx, r.end, r.angle, color, 7);
        return;
      }
      const r = trail(ctx, dPath, {
        color: layer.gradient?.[1] ?? color,
        ...(layer.gradient?.[0] !== undefined ? { colorFrom: layer.gradient![0] } : {}),
        width: Math.max(1, w),
        durationMs: d,
        delayMs: delay,
        profile: layer.profile ?? "comet",
        glow: layer.core !== false,
        core: layer.core !== false,
        ...(layer.coreColor !== undefined ? { coreColor: layer.coreColor } : {}),
      });
      if (layer.head === "chevron") chevron(ctx, r.end, r.angle, color, 7, r.group);
      if (layer.head === "diamond") diamond(ctx, r.end, 6, color, 1, r.group);
      return;
    }
    case "cuts": {
      for (let i = 0; i < layer.count; i++) {
        const spec = CUT_LAYOUT[i % CUT_LAYOUT.length]!;
        const cx = rect.x + rect.w * spec.cx;
        const cy = rect.y + rect.h * spec.cy;
        const len = (rect.w * (layer.length ?? spec.len)) / 2;
        const dx = Math.cos(spec.angle) * len;
        const dy = Math.sin(spec.angle) * len;
        trail(ctx, `M ${(cx - dx).toFixed(1)} ${(cy - dy).toFixed(1)} L ${(cx + dx).toFixed(1)} ${(cy + dy).toFixed(1)}`, {
          color,
          width: layer.width ?? 3.6,
          durationMs: 100,
          delayMs: delay + i * (layer.stagger ?? 40),
          profile: "blade",
          glow: false,
          core: false,
        });
      }
      return;
    }
    case "hexagon": {
      const stroke =
        layer.gradient !== undefined
          ? linearFill(
              ctx,
              { x: p.x - layer.r, y: p.y - layer.r },
              { x: p.x + layer.r, y: p.y + layer.r },
              layer.gradient,
              { fromOpacity: 0.6, midOpacity: 1, edgeOpacity: 0.7, alpha },
            )
          : color;
      hexShield(ctx, p, stroke, layer.r);
      ringAt(ctx, p, color, layer.r * 1.4);
      return;
    }
    case "flash": {
      if (ctx.settings.noFlash || ctx.settings.reduce) return;
      const flashAlpha = layer.alpha ?? 0.5;
      const el = document.createElement("div");
      el.className = "fx-flash";
      el.style.background = `radial-gradient(circle ${layer.radius}px at ${p.x}px ${p.y}px, ${color}, transparent 76%)`;
      el.style.opacity = String(flashAlpha);
      ctx.layer.appendChild(el);
      setTimeout(() => el.remove(), 320);
      return;
    }
    case "bars": {
      const top = document.createElement("div");
      const bottom = document.createElement("div");
      const height = a.board.h;
      for (const [el, y] of [
        [top, 0],
        [bottom, height - layer.h],
      ] as const) {
        el.className = "fx-bar";
        el.style.cssText = `position:absolute;left:0;right:0;top:${y}px;height:${layer.h}px;background:#05070d;z-index:8;pointer-events:none;`;
        el.style.animation = `fx-fadein 180ms ${delay}ms both`;
        ctx.layer.appendChild(el);
        setTimeout(() => el.remove(), d + delay + 200);
      }
      return;
    }
    case "diamond": {
      const fill =
        layer.gradient !== undefined
          ? radialFill(ctx, p, 0, layer.size, layer.gradient, { alpha, fromOpacity: 1, midOpacity: 0.9, edgeOpacity: 0.8 })
          : color;
      const el = diamond(ctx, p, layer.size, fill);
      // 菱形也要散：以前画完就留在原地（瞄准准星的中心点会一直挂在手上）
      el.style.opacity = "0";
      bloom(el, d, delay);
      return;
    }
    case "polygon": {
      const from = layer.from ?? -Math.PI / 2;
      const pts: string[] = [];
      for (let i = 0; i < layer.sides; i++) {
        const ang = from + (Math.PI * 2 * i) / layer.sides;
        pts.push(`${(p.x + Math.cos(ang) * layer.r).toFixed(1)} ${(p.y + Math.sin(ang) * layer.r).toFixed(1)}`);
      }
      const stroke =
        layer.gradient !== undefined
          ? linearFill(
              ctx,
              { x: p.x - layer.r, y: p.y - layer.r },
              { x: p.x + layer.r, y: p.y + layer.r },
              layer.gradient,
              { fromOpacity: 0.85, midOpacity: 1, edgeOpacity: 0.75, alpha },
            )
          : color;
      const el = node("path", {
        d: `M ${pts.join(" L ")} Z`,
        fill: "none",
        stroke,
        "stroke-width": layer.width ?? 1.4,
        "stroke-linejoin": "round",
        ...(layer.dash !== undefined ? { "stroke-dasharray": layer.dash.join(" ") } : {}),
      });
      el.style.opacity = "0";
      bloom(el, d, delay);
      if (!ctx.settings.reduce) {
        const halo = el.cloneNode(true) as SVGElement;
        halo.setAttribute("stroke-opacity", "0.3");
        halo.setAttribute("stroke-width", String((layer.width ?? 1.4) * 3.4));
        halo.setAttribute("filter", "blur(4px)");
        halo.style.animation = el.style.animation;
        ctx.svg.appendChild(halo);
      }
      ctx.svg.appendChild(el);
      return;
    }
    case "fan": {
      const span = layer.arc ?? Math.PI / 3;
      const inner = layer.inner ?? 0;
      const starts = layer.mirror === true
        ? [layer.from ?? -Math.PI / 2, (layer.from ?? -Math.PI / 2) + Math.PI]
        : [layer.from ?? -Math.PI / 2];
      const at = (ang: number, r: number): string =>
        `${(p.x + Math.cos(ang) * r).toFixed(1)} ${(p.y + Math.sin(ang) * r).toFixed(1)}`;
      const large = span > Math.PI ? 1 : 0;
      for (const a0 of starts) {
        const a1 = a0 + span;
        const dPath =
          inner <= 0.5
            ? `M ${p.x.toFixed(1)} ${p.y.toFixed(1)} L ${at(a0, layer.outer)} A ${layer.outer} ${layer.outer} 0 ${large} 1 ${at(a1, layer.outer)} Z`
            : `M ${at(a0, inner)} L ${at(a0, layer.outer)} A ${layer.outer} ${layer.outer} 0 ${large} 1 ${at(a1, layer.outer)} L ${at(a1, inner)} A ${inner} ${inner} 0 ${large} 0 ${at(a0, inner)} Z`;
        const el = node("path", {
          d: dPath,
          fill:
            layer.gradient !== undefined
              ? radialFill(ctx, p, inner, layer.outer, layer.gradient, {
                  alpha,
                  fromOpacity: 1,
                  midOpacity: 0.7,
                  edgeOpacity: 0,
                })
              : color,
          ...(layer.blur !== undefined ? { style: `filter: blur(${layer.blur}px)` } : {}),
        });
        el.style.opacity = "0";
        bloom(el, d, delay);
        ctx.svg.appendChild(el);
      }
      return;
    }
    case "cage": {
      /**
       * 铁栅栏：上下横梁 + 一排竖条，逐根「砸下来」。
       *
       * 收灵不是「打一下」，是**把东西关起来**：横梁先定位，竖条一根根落下，
       * 最后整组散掉。用 `rays` 画不出横梁与节奏，所以单开一个图元。
       */
      // `fit: true` ⇒ 宽高按卡片比例算（写死像素在宽卡上会变成一个火柴盒）
      const boxW = layer.fit === true ? rect.w * layer.w : layer.w;
      const boxH = layer.fit === true ? rect.h * layer.h : layer.h;
      const hw = boxW / 2;
      const hh = boxH / 2;
      const stroke =
        layer.gradient !== undefined
          ? linearFill(
              ctx,
              { x: p.x - hw, y: p.y - hh },
              { x: p.x + hw, y: p.y + hh },
              layer.gradient,
              { fromOpacity: 0.95, midOpacity: 1, edgeOpacity: 0.7, alpha },
            )
          : color;
      const w = layer.width ?? 2;
      for (const dy of [-hh, hh]) {
        const rail = node("line", {
          x1: (p.x - hw).toFixed(1),
          y1: (p.y + dy).toFixed(1),
          x2: (p.x + hw).toFixed(1),
          y2: (p.y + dy).toFixed(1),
          stroke,
          "stroke-width": w * 1.7,
          "stroke-linecap": "round",
        });
        rail.style.opacity = "0";
        bloom(rail, d, delay);
        ctx.svg.appendChild(rail);
      }
      for (let i = 0; i < layer.count; i++) {
        const x = p.x - hw + (boxW * (i + 0.5)) / layer.count;
        const bar = node("line", {
          x1: x.toFixed(1),
          y1: (p.y - hh).toFixed(1),
          x2: x.toFixed(1),
          y2: (p.y + hh).toFixed(1),
          stroke,
          "stroke-width": w,
          "stroke-linecap": "round",
        });
        bar.style.opacity = "0";
        bar.style.animation = `fx-cage-drop ${d}ms ${delay + i * (layer.stagger ?? 34)}ms cubic-bezier(.2,.9,.3,1.15) both`;
        ctx.svg.appendChild(bar);
      }
      return;
    }
    case "glow": {
      const el = node("circle", {
        cx: p.x,
        cy: p.y,
        r: layer.r,
        fill:
          layer.gradient !== undefined
            ? radialFill(ctx, p, 0, layer.r, layer.gradient, {
                alpha,
                fromOpacity: 1,
                midOpacity: 0.5,
                edgeOpacity: 0,
              })
            : color,
        ...(layer.blur !== undefined ? { style: `filter: blur(${layer.blur}px)` } : {}),
      });
      el.style.opacity = "0";
      bloom(el, d, delay);
      ctx.svg.appendChild(el);
      return;
    }
    default:
      return;
  }
}

/** 一段表现：按声明顺序画每一层。模板没定义 = 什么都不画（不是崩溃）。 */
function drawEffect(
  ctx: FxContext,
  def: FxEffect | undefined,
  a: FxAnchors,
  base: { color: string; d: number; width: number },
): void {
  if (def === undefined) return;
  for (const layer of def.layers) drawLayer(ctx, layer, a, base);
}

// ---------------------------------------------------------------- ① 施法

/**
 * 施法段。
 *
 * **引擎不内置任何施法样式**（ADR-078）：`cast.preset` 指向模板的 `presentation.effects`，
 * 没配就是没有 —— 大部分技能抬手就打，本来就不该有起手动作。
 */
async function drawCast(
  ctx: FxContext,
  def: FxEffect | undefined,
  a: FxAnchors,
  color: string,
  durMs: number,
): Promise<void> {
  const d = Math.max(140, durMs * scale(ctx.settings));
  if (def !== undefined) drawEffect(ctx, def, a, { color, d, width: 2 });
  await sleep(ctx.settings.reduce ? 40 : d * 0.55);
}

// ---------------------------------------------------------------- ② 轨迹

function drawTrace(
  ctx: FxContext,
  from: Pt,
  to: Pt,
  cast: BattleFxCastVM,
  hit: BattleFxHitVM | undefined,
  multi: boolean,
  anchors: FxAnchors,
): void {
  // 收灵 / 吸取：方向反过来（目标 → 自己），否则看起来像「又打了他一下」
  if (hit?.reverse === true) {
    const swap = from;
    from = to;
    to = swap;
  }
  // 每一击可以带自己的轨迹（全体治疗：自己上行、友军扇形）；缺省回落到 cast 级
  const preset = hit?.trace?.preset ?? cast.trace.preset;
  if (preset === null || preset === "none") return;
  const def = hit?.trace?.def ?? cast.trace.def;
  const dur = cast.trace.durationMs * scale(ctx.settings);
  const color = hit?.trace?.color ?? cast.trace.color;
  const width = hit?.trace?.width ?? cast.trace.width;
  const outcome = hit?.outcome ?? "hit";

  /**
   * 未命中 / 免疫是**语义收尾**，不是样式：它必须发生在任何模板样式之上，
   * 否则「打空了却画出一条命中轨迹」。所以这两条在查模板之前处理。
   */
  if (outcome === "miss") {
    const mid = { x: (from.x + to.x) / 2 + 20, y: (from.y + to.y) / 2 - 10 };
    const d = `M ${from.x} ${from.y} Q ${mid.x} ${mid.y} ${to.x} ${to.y}`;
    const line = hairline(ctx, d, { color: "#8d96a8", width: 1.3, durationMs: dur * 0.8, dash: "5 6" });
    const probePath = probe(ctx, d);
    const cut = probePath.getPointAtLength(line.length * 0.62);
    probePath.remove();
    for (let i = 0; i < 3; i++) {
      ctx.svg.appendChild(
        node("circle", { cx: cut.x + i * 7, cy: cut.y - i * 3, r: 1.5 - i * 0.4, fill: "#8d96a8", opacity: 0.7 - i * 0.2 }),
      );
    }
    return;
  }

  if (outcome === "immune") {
    trail(ctx, `M ${from.x} ${from.y} Q ${(from.x + to.x) / 2 + 6} ${(from.y + to.y) / 2} ${to.x} ${to.y}`, {
      color: "#E6C97A",
      width: Math.max(2, width * 0.9),
      durationMs: dur * 0.85,
    });
    return;
  }

  if (def !== undefined) {
    drawEffect(ctx, def, { ...anchors, from, to }, { color, d: dur, width });
    return;
  }

  // 内置几何（不表达任何世界观）：直线箭头 / 群体扇刃 / 上升气流
  const bowX = preset === "updraft" ? 40 : 54;
  const bowY = preset === "updraft" ? 6 : -10;
  const d = `M ${from.x} ${from.y} Q ${(from.x + to.x) / 2 + bowX} ${(from.y + to.y) / 2 + bowY} ${to.x} ${to.y}`;

  if (preset === "fan") {
    trail(ctx, d, { color, width: 6.5, durationMs: dur, profile: "fan", glow: !multi, core: !multi });
    return;
  }
  if (preset === "updraft") {
    const r = trail(ctx, d, { color, width: Math.max(3, width), durationMs: dur });
    chevron(ctx, r.end, r.angle, color, 7, r.group);
    return;
  }
  // arrow（含未知 id 的兜底）
  const r = trail(ctx, d, { color, width: Math.max(2, width * 2), durationMs: dur });
  chevron(ctx, r.end, r.angle, color, 8, r.group);
}

// ---------------------------------------------------------------- ③ 受击

/**
 * 受击段。
 *
 * 模板给了 `def` 就按模板画（雷弧、割口、盾都走这里）；
 * 没给就走内置几何：火花 / 登场 / 离场 / 消散。
 */
function drawImpact(
  ctx: FxContext,
  preset: string | null,
  def: FxEffect | undefined,
  rect: FxAnchor,
  p: Pt,
  color: string,
  anchors: FxAnchors,
): void {
  if (preset === null || preset === "none") return;
  if (def !== undefined) {
    drawEffect(ctx, def, anchors, { color, d: 520, width: 2 });
    return;
  }
  const a: FxAnchors = { ...anchors, target: rect, from: p, to: p };
  switch (preset) {
    case "burst": {
      /**
       * 命中要有**体积**：光晕 + 一圈粗环 + 六道短射线 + 火花。
       *
       * 以前只有 10 个粒子和一圈 CSS 环，截图里「飞行中」和「已命中」几乎一样 ——
       * 验收直接判「没有命中」。
       */
      const hi = tint(color, 0.78);
      const mid = tint(color, 0.3);
      /**
       * 尺寸跟**卡片高度**走：写死半径在窄卡上会越界、在长条卡上又太小。
       * `h * 0.34` 大约刚好占满卡内容区，不会扎进相邻卡片。
       */
      const size = Math.round(Math.min(Math.max(rect.h * 0.34, 18), 34));
      drawLayer(ctx, { shape: "glow", at: "target", r: size * 2, gradient: [hi, mid, color], opacity: 0.8, durationMs: 460 }, a, { color, d: 460, width: 2 });
      // 环用**实亮色**：小半径上的渐变会只采到暗端，看起来像没有环
      drawLayer(ctx, { shape: "ring", at: "target", r: size * 0.7, width: 3, color: hi, durationMs: 380 }, a, { color, d: 380, width: 2 });
      drawLayer(
        ctx,
        { shape: "rays", at: "target", count: 6, inner: size * 0.3, outer: size * 1.05, width: 2.2, from: 0.52, fade: "in", gradient: [hi, color], durationMs: 300 },
        a,
        { color, d: 300, width: 2 },
      );
      sparks(ctx, p, hi, 12);
      return;
    }
    case "arrive": {
      /**
       * 登场（2026-11-24 重做）：**保留**原来的上升光柱，补上设计稿要的两件事 ——
       * 双扇扫光（边转边亮）和从白核到本色的渐变。
       *
       * 扇光绕**卡片中心**转，不绕脚下：绕脚下时会变成两盏探照灯，直接打到
       * 下一张卡上（实测观感很差）。半径也压到「刚好罩住卡片」。
       */
      const hi = tint(color, 0.72);
      const mid = tint(color, 0.28);
      const w = Math.max(1, rect.w);
      const sweep = Math.min(Math.max(w * 0.26, 46), 66);
      drawLayer(
        ctx,
        { shape: "glow", at: "target", r: Math.min(Math.max(w * 0.18, 30), 48), gradient: [hi, mid, color], opacity: 0.38, durationMs: 780 },
        a,
        { color, d: 780, width: 2 },
      );
      drawLayer(
        ctx,
        { shape: "pool", at: "targetGround", rx: Math.min(w * 0.22, 46), ry: 9, blur: 6, gradient: [hi, mid, color], opacity: 0.6, durationMs: 720 },
        a,
        { color, d: 720, width: 2 },
      );
      drawLayer(
        ctx,
        { shape: "pillar", at: "targetGround", w: 18, h: rect.h * 0.92, blur: 6, core: 0.3, gradient: [hi, mid, color], durationMs: 700 },
        a,
        { color, d: 700, width: 2 },
      );
      // 扇形扫光：对侧两片，绕卡片转 1.1 圈
      drawLayer(
        ctx,
        {
          shape: "fan",
          at: "target",
          inner: 20,
          outer: sweep + 8,
          arc: Math.PI / 6,
          mirror: true,
          turns: 0.55,
          blur: 2,
          gradient: [hi, mid, color],
          opacity: 0.44,
          durationMs: 760,
        },
        a,
        { color, d: 760, width: 2 },
      );
      drawLayer(ctx, { shape: "ring", at: "target", r: 15, width: 2.4, gradient: [hi, mid, color], durationMs: 600 }, a, { color, d: 600, width: 2 });
      drawLayer(
        ctx,
        { shape: "ring", at: "target", r: 25, width: 1.6, dash: [4, 5], gradient: [mid, color], durationMs: 600, delayMs: 70 },
        a,
        { color, d: 600, width: 2 },
      );
      drawLayer(ctx, { shape: "ring", at: "target", r: 34, width: 1.2, durationMs: 600, delayMs: 140 }, a, { color, d: 600, width: 2 });
      drawLayer(
        ctx,
        { shape: "rays", at: "target", count: 7, inner: 10, outer: 32, width: 1.3, stagger: 30, gradient: [color, hi], durationMs: 600 },
        a,
        { color, d: 600, width: 2 },
      );
      sparks(ctx, centerOf(rect), color, 9);
      return;
    }
    case "depart": {
      trail(ctx, `M ${p.x} ${p.y + 16} L ${p.x} ${p.y - 26}`, { color, width: 5, durationMs: 300 });
      ringAt(ctx, p, color, 44);
      sparks(ctx, p, color, 6);
      return;
    }
    case "dissolve": {
      castMotes(ctx, p, color, 10, 26, false, 460);
      ringAt(ctx, p, color, 48);
      return;
    }
    default:
      // 未知 id（加载期已拒，这里只是兜底）：给一圈火花，别静默什么都不演
      sparks(ctx, p, color, 8);
      return;
  }
}

function drawNumber(ctx: FxContext, hit: BattleFxHitVM, rect: FxAnchor, stack: number): void {
  if (hit.text === undefined) return;
  const px = rect.x + rect.w - 12;
  // 卡片高度不定（演练台是单行、游戏内是双行），所以按**卡片中线**落点，不写死 22px
  const py = rect.y + rect.h * 0.5 - stack * 32;
  const wrap = document.createElement("div");
  wrap.className = "fx-num";
  wrap.style.left = `${px}px`;
  wrap.style.top = `${py}px`;
  wrap.style.color = hit.color;
  wrap.style.fontSize = `${hit.size}px`;
  const s = Math.max(0.7, hit.size * 0.045);
  const shadows = [
    `${s}px 0 0 #05070d`, `${-s}px 0 0 #05070d`, `0 ${s}px 0 #05070d`, `0 ${-s}px 0 #05070d`,
    `${s * 0.72}px ${s * 0.72}px 0 #05070d`, `${-s * 0.72}px ${s * 0.72}px 0 #05070d`,
    `${s * 0.72}px ${-s * 0.72}px 0 #05070d`, `${-s * 0.72}px ${-s * 0.72}px 0 #05070d`,
  ];
  if (hit.critTier !== undefined) shadows.push(`0 0 16px ${hit.color}`, `0 0 32px ${hit.color}88`);
  wrap.style.textShadow = shadows.join(",");

  const text = document.createElement("span");
  text.className = "fx-num__t";
  text.textContent = hit.text;
  if (!ctx.settings.reduce) {
    text.style.animation = "fx-pop 300ms cubic-bezier(.18,.9,.28,1.25) both";
    wrap.style.animation = "fx-rise 900ms 240ms ease-out both";
  }
  wrap.appendChild(text);
  ctx.layer.appendChild(wrap);
  setTimeout(() => wrap.remove(), 1500);

  let offset = 0;
  for (const label of hit.labels) {
    const el = document.createElement("div");
    el.className = "fx-label";
    el.style.left = `${px}px`;
    el.style.top = `${py + hit.size * 0.5 + 8 + offset}px`;
    el.style.color = label.text === "" ? "#ffd479" : "#ffd479";
    if (label.latin !== undefined) {
      el.className = "fx-label fx-label--dual";
      const main = document.createElement("b");
      main.textContent = label.text;
      const sub = document.createElement("span");
      sub.textContent = label.latin;
      el.append(main, sub);
    } else {
      const tag = document.createElement("span");
      tag.className = "fx-tag";
      tag.textContent = label.text;
      el.appendChild(tag);
    }
    if (!ctx.settings.reduce) el.style.animation = "fx-fadein 200ms 80ms both";
    ctx.layer.appendChild(el);
    setTimeout(() => el.remove(), 1500);
    offset += 18;
  }
}

// ---------------------------------------------------------------- 播放

/** 每段施放一个代次：上一段的「余辉清理」不能把下一段刚画的擦掉。 */
let castGen = 0;

export async function playCast(ctx: FxContext, cast: BattleFxCastVM): Promise<void> {
  // 一次施放独占这一层：先清上一段的残留。
  // 轨迹没有自己的生命周期，不清就会一直叠在屏上（多轮之后满屏横线）。
  const gen = ++castGen;
  ctx.svg.innerHTML = "";
  // 只清「不会自己消失」的：数字与标签。粒子/光环有自己的定时器，
  // 留着它们才能让上一段的消散和下一段重叠（漩涡的两拍就是这个效果）。
  ctx.layer.querySelectorAll(".fx-num, .fx-label").forEach((n) => n.remove());

  const actorRect = anchorOf(ctx.board, cast.actorId);
  const hand = handOf(actorRect);
  const boardRect = ctx.board.getBoundingClientRect();
  const anchorsFor = (target: FxAnchor): FxAnchors => ({
    caster: actorRect,
    target,
    board: { w: boardRect.width, h: boardRect.height },
    from: hand,
    to: centerOf(target),
  });

  /**
   * 施法段：样式全在模板里（`cast.def`），这里只负责「什么时候开始、占多久」。
   *
   * 锚点**不从 cast 定义里推**：轨迹那一段的跨度（从手边划出去的长弧）是刻意保留的，
   * 起点一挪整条线就塌成一条短线，比「施法和轨迹差几像素」难看得多。
   */
  drawCast(
    ctx,
    cast.cast.def,
    anchorsFor(anchorOf(ctx.board, cast.hits[0]?.targetId ?? cast.actorId)),
    cast.cast.color,
    cast.cast.durationMs,
  ).catch(() => undefined);

  // 轨迹：每个目标一根（数量 = 目标数），各自按自己的结果收尾
  const multi = cast.hits.length > 1;
  cast.hits.forEach((hit, i) => {
    const rect = anchorOf(ctx.board, hit.targetId);
    // 目标是**自己**：没有「飞行」，轨迹直接画在自己卡里（左下 → 右上）
    const selfHit = hit.targetId === cast.actorId;
    // 用比例而不是 ±6px：锚点盒子（.battle-self）比可见面板多一点内边距，
    // 贴边写死会把箭头尖端画到卡片外面去（实测高 11px）
    const from = selfHit ? { x: rect.x + rect.w * 0.42, y: rect.y + rect.h * 0.94 } : hand;
    /**
     * 落点取宽度的 30%：**这一条决定轨迹的跨度**。
     *
     * 改到中心会把弧压短一半（尤其是窄卡），整条线塌成一小截 —— 视觉上只剩「一坨光」。
     * 落点位置和受击点必须**用同一个算式**，否则刃插在 A 处、爆点在 B 处。
     */
    const to = selfHit
      ? { x: rect.x + rect.w * 0.64, y: rect.y + rect.h * 0.16 }
      : { x: rect.x + rect.w * 0.45, y: rect.y + rect.h * 0.5 };
    setTimeout(() => {
      if (ctx.aborted()) return;
      drawTrace(ctx, from, to, cast, hit, multi, anchorsFor(rect));
    }, i * (ctx.settings.fast ? 25 : 55));
  });

  /**
   * 施法 → 受击的时序。
   *
   * 有轨迹：施法只占前半程，剩下的交给飞行段（否则抬手就要干等一整段）。
   * **无轨迹**（召唤 / 自我增益）：没有飞行段可等，就该等**施法整段演完** ——
   * 之前这里固定乘 0.55，法阵还在成型就跳去演登场，看起来像「施法本身就是受击」。
   */
  const hasTrace = cast.trace.preset !== null && cast.trace.preset !== "none";
  const castMs =
    cast.cast.preset === null
      ? 0
      : ctx.settings.reduce
        ? 40
        : cast.cast.durationMs * scale(ctx.settings) * (hasTrace ? 0.55 : 0.92);
  const traceMs = hasTrace ? cast.trace.durationMs * scale(ctx.settings) : 0;
  await sleep(castMs + traceMs + 20);
  if (ctx.aborted()) return;

  // 受击 + 结算：逐目标错开
  const seen = new Map<string, number>();
  cast.hits.forEach((hit, i) => {
    const rect = anchorOf(ctx.board, hit.targetId);
    /** 命中点 = 轨迹终点的**同一个算式**（30% / 垂直居中），两边必须一致 */
    const p = { x: rect.x + rect.w * 0.45, y: rect.y + rect.h * 0.5 };
    const stack = seen.get(hit.targetId) ?? 0;
    seen.set(hit.targetId, stack + 1);
    setTimeout(() => {
      if (ctx.aborted()) return;
      // 伤害用轨迹色（技能色会染轨迹），其余用**这一击自己的语义色**：
      // 治疗绿 / 召唤蓝 / 消散紫 / 免疫金 —— 以前非伤害一律金，召唤登场也变成金色。
      /**
       * 伤害 / 治疗打在 p（刃插进去的那一点）；召唤、收回、消散是「整张卡的事」，
       * 不传 `impact`，让它落在卡面中心。
       */
      const atPoint = hit.kind === "damage" || hit.kind === "heal";
      drawImpact(
        ctx,
        hit.impact,
        hit.def,
        rect,
        p,
        hit.kind === "damage" ? cast.trace.color : hit.color,
        { ...anchorsFor(rect), from: p, to: p, ...(atPoint ? { impact: p } : {}) },
      );
      if (hit.kind === "summon") {
        /**
         * 登场不能只有一圈光：卡片本身要「弹」一下，否则召唤的回报感是零。
         * 没有立绘可换，就把重量压在卡片上（缩小 → 过冲 → 落定 + 提亮）。
         */
        const el = ctx.board.querySelector<HTMLElement>(`[data-unit-id="${hit.targetId}"]`);
        if (el) {
          el.classList.add("fx-arrive-pop");
          setTimeout(() => el.classList.remove("fx-arrive-pop"), 620);
        }
      }
      if (hit.kind === "miss") {
        const tag = document.createElement("div");
        tag.className = "fx-label";
        tag.style.left = `${p.x + 14}px`;
        tag.style.top = `${p.y - 12}px`;
        tag.innerHTML = `<span class="fx-tag" style="color:#A0A8B8;border-color:#A0A8B855">MISS</span>`;
        ctx.layer.appendChild(tag);
        setTimeout(() => tag.remove(), 1200);
        return;
      }
      drawNumber(ctx, hit, rect, stack);
      if (hit.critTier !== undefined) {
        ctx.board.querySelector<HTMLElement>(`[data-unit-id="${hit.targetId}"]`)?.classList.add("fx-shake");
        setTimeout(() => ctx.board.querySelector<HTMLElement>(`[data-unit-id="${hit.targetId}"]`)?.classList.remove("fx-shake"), 360);
      }
    }, i * (ctx.settings.fast ? 60 : 150));
  });

  // 收尾：等最后的受击 / 数字演完再交给下一段（登场光环 520ms，留 620ms 才不被擦掉）
  await sleep((cast.hits.length - 1) * 150 + 620);
  // 余辉：留一会儿再收，下一段开始时也会被上面的清理兜住
  setTimeout(() => {
    if (gen === castGen) ctx.svg.innerHTML = "";
  }, 700);
}
