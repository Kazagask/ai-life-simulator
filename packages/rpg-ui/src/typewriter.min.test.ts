import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContentBlockVM } from "@life-sim/shared";
import { NarrativeStream, durationFor, prefersReducedMotion, revealStep, typingIndex } from "./NarrativeStream.js";

/**
 * 打字机：节奏函数 + 渲染面的静态断言。
 *
 * 这里的测试**没有 DOM**（`environment: "node"`，全仓也没有 jsdom）：动画那一侧只能靠
 * 「纯函数 + SSR 全文」来锁，effect 的真实行为在 `typewriter-effect.min.test.ts` 里用
 * 一个极简 hooks 替身跑（那一文件会 mock `react`，所以不能和 SSR 断言混在一起）。
 */

const block = (blockId: string, kind: string, text: string): ContentBlockVM => ({ blockId, kind, text });

describe("打字机节奏：按字数算、封顶、一定收敛", () => {
  it("100 字 @36cps 的时长被 maxDurationMs 封顶到 650ms，且步长 ≥ 1", () => {
    expect(durationFor(100, 36, 650)).toBe(650);
    expect(revealStep(100, 36, 650)).toBeGreaterThanOrEqual(1);
  });

  it("未触顶时按字数等比（18 字 @36cps ⇒ 500ms），短句不会被拖成长动画", () => {
    expect(durationFor(18, 36, 650)).toBeCloseTo(500, 5);
    // 18 字 / 500ms ⇒ 16ms 一格推 1 个字（不快进，读得清）。
    expect(revealStep(18, 36, 650)).toBe(1);
  });

  it("一定收敛：任何字数下 step × ticks ≥ 字数（不会永远差最后几个字）", () => {
    for (const length of [1, 2, 7, 50, 100, 200, 500, 2000]) {
      const step = revealStep(length, 36, 650);
      const ticks = Math.ceil(length / step);
      expect(step * ticks).toBeGreaterThanOrEqual(length);
      // 也不许一步到位地「瞬间全文」——至少要走 2 格才收尾（1、2 字这种极短句除外）。
      if (length > 2) expect(ticks).toBeGreaterThan(1);
    }
  });

  it("charsPerSecond ≤ 0 被钳到 1：不出现除零 / Infinity", () => {
    expect(Number.isFinite(durationFor(10, 0, 650))).toBe(true);
    expect(durationFor(10, 0, 650)).toBe(650);
    expect(revealStep(10, -5, 650)).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(revealStep(10, -5, 650))).toBe(true);
  });

  it("空文本不排动画：步长給 1 兜底，调用方按 length === 0 直接跳全文", () => {
    expect(revealStep(0, 36, 650)).toBe(1);
    expect(durationFor(0, 36, 650)).toBe(16);
  });
});

describe("打字目标的选择：只挑最后一块**有正文**的 narrative", () => {
  it("末尾是 option 块时，目标仍是它前面那块 narrative", () => {
    const content = [block("n1", "narrative", "正文一"), block("o1", "option", "向左走")];
    expect(typingIndex(content)).toBe(0);
  });

  it("末尾是 flavor 旁注时同理（旁注不参与打字机）", () => {
    const content = [block("n1", "narrative", "正文一"), block("f1", "flavor", "夜风")];
    expect(typingIndex(content)).toBe(0);
  });

  it("取最后一个 narrative，而不是第一个", () => {
    const content = [block("n1", "narrative", "旧"), block("n2", "flavor", "旁注"), block("n3", "narrative", "新")];
    expect(typingIndex(content)).toBe(2);
  });

  it("空 content ⇒ -1；全是空正文的 narrative ⇒ -1（没有可揭示的文本）", () => {
    expect(typingIndex([])).toBe(-1);
    expect(typingIndex([block("n1", "narrative", ""), block("o1", "option", "走")])).toBe(-1);
  });
});

describe("SSR / 首帧不逐字（node 环境无 window ⇒ 按 reduce 处理）", () => {
  it("prefersReducedMotion() 在没有 window 时返回 true", () => {
    expect(typeof window).toBe("undefined");
    expect(prefersReducedMotion()).toBe(true);
  });

  it("首帧 HTML 就是完整正文 —— 刷新 / 重进不该重放动画，静态快照里更不能是半句", () => {
    const text = "灯芯爆了一下，屋里暗下去半格。";
    const html = renderToStaticMarkup(createElement(NarrativeStream, { content: [block("n1", "narrative", text)] }));
    expect(html).toContain(text);
  });

  it("选项块永不被截断：narrative 在打字，选项文本仍完整（少一个字就点错指令）", () => {
    const text = "你站在岔路口。";
    const option = "沿着溪水往上游走";
    const content = [block("n1", "narrative", text), block("o1", "option", option)];
    const html = renderToStaticMarkup(createElement(NarrativeStream, { content }));
    expect(html).toContain(text);
    expect(html).toContain(option);
  });
});
