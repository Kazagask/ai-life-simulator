import { describe, expect, it } from "vitest";
import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewModel } from "@life-sim/rpg-ui";
import { NarrativeStage } from "./NarrativeStage.js";

const h = createElement;
const render = (node: ReactElement) => renderToStaticMarkup(node);
const TAG = /<span class="tag ai-narrative-tag">AI 书写中…<\/span>/;

/**
 * 最小 ViewModel 夹具：只带一条正文，媒体 / 选项 / 战斗全空 ——
 * 本文件只锁「进行中提示的判据」，不重复 rpg-ui 里已覆盖的渲染矩阵。
 */
const BASE_VIEW: ViewModel = {
  player: { id: "p1", name: "林暮" },
  npcs: [],
  slot: null,
  evaluation: { summary: "" },
  media: [],
  content: [{ blockId: "b1", kind: "narrative", text: "天色暗下来了。" }],
  availableActions: [],
  formattedTime: "第 2 年 · 春",
  lifeStage: "adult",
  lifeStageLabel: "成年",
  statusBar: [],
  battle: null,
  ending: null,
  turnIndex: 7,
};

/** 头部提示的判据：读渲染结果，不读组件内部实现。 */
const showsWriting = (view: ViewModel, busy: boolean) =>
  TAG.test(render(h(NarrativeStage, { view, busy })));
const countWriting = (html: string) => (html.match(/AI 书写中…/g) ?? []).length;

describe("NarrativeStage 进行中提示（以「请求在飞」为主信号）", () => {
  it("busy 为真就显示 —— 不依赖投影里的 llmPending（事务内同步等 LLM，它恒为缺省）", () => {
    expect(BASE_VIEW.llmPending).toBeUndefined();
    expect(showsWriting(BASE_VIEW, true)).toBe(true);
  });

  it("busy 为假且 llmPending 缺省时不显示（空闲态不能常亮）", () => {
    expect(showsWriting(BASE_VIEW, false)).toBe(false);
  });

  it("llmPending 保留且仍生效：异步实现回填该字段时，busy 为假也能提示", () => {
    const asyncView: ViewModel = { ...BASE_VIEW, llmPending: true };
    expect(showsWriting(asyncView, false)).toBe(true);
    // 两者同时为真时也只出一个提示，不叠两条。
    expect(countWriting(render(h(NarrativeStage, { view: asyncView, busy: true })))).toBe(1);
  });
});
