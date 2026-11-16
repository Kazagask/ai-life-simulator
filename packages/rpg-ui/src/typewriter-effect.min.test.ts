import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentBlockVM } from "@life-sim/shared";
import { useTypewriter } from "./NarrativeStream.js";

/**
 * effect 侧的行为测试：没有 DOM 也照样能跑。
 *
 * 做法：把 `react` 的 `useState` / `useRef` / `useEffect` 换成一个极简替身 —— 它就是
 * 「按声明顺序取槽位 + 依赖浅比较后才重跑 effect」这一层语义，而这正是上一版 bug 的所在：
 * effect 依赖里含 `frame` 时，定时器每推一格都会被自己的 `setFrame` 重新唤醒，动画在第一
 * tick 后就死（或直接跳全文）。真实 React 里这个死法一模一样，只是没法在 node 环境挂载。
 *
 * 这个文件 mock 了 `react`，所以**不能**再做 SSR 断言（那部分在 `typewriter.min.test.ts`）。
 */

const h = vi.hoisted(() => {
  const state: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const pending: { deps?: unknown[]; fn: () => void | (() => void) }[] = [];
  const committed: { deps?: unknown[]; cleanup?: () => void }[] = [];
  let cursor = 0;
  let dirty = false;

  const sameDeps = (a: unknown[] | undefined, b: unknown[] | undefined): boolean =>
    a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  return {
    reset() {
      state.length = 0;
      refs.length = 0;
      pending.length = 0;
      committed.length = 0;
      cursor = 0;
      dirty = false;
    },
    begin() {
      cursor = 0;
      pending.length = 0;
    },
    useState<T>(init: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
      const slot = cursor;
      cursor += 1;
      if (!(slot in state)) state[slot] = typeof init === "function" ? (init as () => T)() : init;
      const set = (next: T | ((prev: T) => T)): void => {
        const prev = state[slot] as T;
        state[slot] = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        dirty = true;
      };
      return [state[slot] as T, set];
    },
    useRef<T>(value: T): { current: T } {
      const slot = cursor;
      cursor += 1;
      if (!(slot in refs)) refs[slot] = { current: value };
      return refs[slot] as { current: T };
    },
    useEffect(fn: () => void | (() => void), deps?: unknown[]): void {
      const slot = cursor;
      cursor += 1;
      pending[slot] = { fn, deps };
    },
    /** 提交：依赖变了才 cleanup + 重跑（与 React 一致的最小语义）。 */
    commit(): void {
      for (let slot = 0; slot < pending.length; slot += 1) {
        const entry = pending[slot];
        if (entry === undefined) continue;
        const prev = committed[slot];
        if (prev !== undefined && sameDeps(prev.deps, entry.deps)) continue;
        prev?.cleanup?.();
        const cleanup = entry.fn();
        committed[slot] = { deps: entry.deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
      }
    },
    dirty(): boolean {
      return dirty;
    },
    clean(): void {
      dirty = false;
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: h.useState, useRef: h.useRef, useEffect: h.useEffect } as unknown as typeof actual;
});

type Frame = ReturnType<typeof useTypewriter>;

const n = (blockId: string, text: string): ContentBlockVM => ({ blockId, kind: "narrative", text });
const o = (blockId: string, text: string): ContentBlockVM => ({ blockId, kind: "option", text });

let content: ContentBlockVM[] = [];
let frame: Frame = null;

/**
 * node 环境没有 `window` ⇒ 组件按 reduce 处理（这是 SSR 的正确行为）。
 * 这里只塞一个 `matchMedia` 桩把「允许动效」打开，不引入 jsdom：
 * 组件读的唯一浏览器 API 就是它。
 */
function setMotion(reduce: boolean | null): void {
  if (reduce === null) {
    delete (globalThis as { window?: unknown }).window;
    return;
  }
  (globalThis as { window?: unknown }).window = {
    matchMedia: (query: string) => ({ matches: reduce, media: query }),
  };
}

/** 跑一趟「render + commit」（effect 内 setState 会标脏，由 flush 补渲染）。 */
function pass(next: ContentBlockVM[]): Frame {
  h.begin();
  const result = useTypewriter(next);
  h.commit();
  return result;
}

function flush(): void {
  let guard = 0;
  while (h.dirty() && guard < 20) {
    h.clean();
    frame = pass(content);
    guard += 1;
  }
}

function render(next: ContentBlockVM[]): void {
  content = next;
  frame = pass(next);
  flush();
}

function tick(ms = 16): void {
  vi.advanceTimersByTime(ms);
  flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  h.reset();
  content = [];
  frame = null;
  setMotion(false); // 默认允许动效；reduce / 无 window 各自单测显式设置
});

afterEach(() => {
  vi.useRealTimers();
  setMotion(false);
});

describe("打字机 effect：新块才播，且一定播完", () => {
  it("挂载时块已存在 ⇒ 首帧就是全文，且不启动定时器（刷新不重放动画）", () => {
    render([n("n1", "灯芯爆了一下。")]);
    expect(frame?.visible).toBe("灯芯爆了一下。");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("新块到达 ⇒ 从空开始逐 tick 推进（不是一步到位）⇒ 走完才是全文", () => {
    render([n("n1", "旧句。")]);
    const text = "灯芯爆了一下，屋里暗下去半格，你把窗推开一条缝。";
    render([n("n1", "旧句。"), n("n2", text)]);

    expect(frame?.blockId).toBe("n2");
    expect(frame?.visible).toBe("");

    tick();
    const first = frame?.visible ?? "";
    // 关键断言：第一个 tick 之后**只露出前缀**。effect 若依赖 `frame`，这里会直接是全文。
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(text.length);

    tick(2000);
    expect(frame?.visible).toBe(text);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("块切换 ⇒ 旧块停手、新块从空开始（旧块按 blockId 判定，自动恢复全文）", () => {
    render([n("n1", "旧句。")]);
    render([n("n1", "旧句。"), n("n2", "第一段新正文，写得长一些，够播好几帧。")]);
    tick(64);
    expect((frame?.visible ?? "").length).toBeGreaterThan(0);
    expect(frame?.visible).not.toBe("第一段新正文，写得长一些，够播好几帧。");

    render([
      n("n1", "旧句。"),
      n("n2", "第一段新正文，写得长一些，够播好几帧。"),
      n("n3", "第二段。"),
    ]);
    expect(frame?.blockId).toBe("n3");
    expect(frame?.visible).toBe("");
  });

  it("动画期间上游追加字数 ⇒ 立即跳全文，不在半句上继续爬也不排队", () => {
    render([n("n1", "旧句。")]);
    const head = "灯芯爆了一下，屋里暗下去半格";
    render([n("n1", "旧句。"), n("n2", head)]);
    tick();
    expect((frame?.visible ?? "").length).toBeLessThan(head.length);

    const grown = `${head}，风从缝里灌进来。`;
    render([n("n1", "旧句。"), n("n2", grown)]);
    expect(frame?.visible).toBe(grown);
  });

  it("末尾是 option 块时打字目标仍是 narrative，选项文本原样交给渲染器", () => {
    render([n("n1", "旧句。")]);
    render([n("n1", "旧句。"), n("n2", "你站在岔路口。"), o("o1", "沿着溪水往上游走")]);
    // 目标不是 option 块（否则选项会被逐字截断，玩家点到半截指令）。
    expect(frame?.blockId).toBe("n2");
  });

  it("无 window（node / SSR）⇒ 按 reduce 处理：新块也直接全文，不起定时器", () => {
    setMotion(null);
    expect(typeof window).toBe("undefined");
    h.reset();

    render([n("n1", "旧句。")]);
    render([n("n1", "旧句。"), n("n2", "新的一段正文。")]);
    expect(frame?.visible).toBe("新的一段正文。");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("prefers-reduced-motion: reduce ⇒ 同样直接全文，不启动定时器", () => {
    setMotion(true);
    h.reset();

    render([n("n1", "旧句。")]);
    render([n("n1", "旧句。"), n("n2", "新的一段正文。")]);
    expect(frame?.visible).toBe("新的一段正文。");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("内容清空 ⇒ frame 归 null，不留半句", () => {
    render([n("n1", "旧句。")]);
    render([n("n1", "旧句。"), n("n2", "新的一段正文，够长。")]);
    tick();
    render([]);
    expect(frame).toBeNull();
  });
});
