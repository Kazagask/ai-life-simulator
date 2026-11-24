import { describe, expect, it } from "vitest";
import type { OpeningPrologueRequestInput } from "@life-sim/game-core";
import {
  fallbackPrologue,
  openingPrologue,
  prologueFactsOf,
} from "../../apps/server/src/narrative/prologue.ts";
import type { LLMProvider } from "../../apps/server/src/llm/provider.ts";

/**
 * 开局序章（2026-11-19）。
 *
 * 纪律：LLM 只写装饰文本；mock / 超时 / 结构不符一律回退模板拼的文案。
 * 这一组用例锁的是「回退一定存在」——没有兜底文案，玩家在世界没配 key 时会看到空白序章。
 */

const facts: OpeningPrologueRequestInput = {
  worldTitle: "咒术回战 · 十二年",
  worldSummary: "2006 到 2019。",
  player: { name: "夜见", gender: "female", age: 15 },
  attributes: [{ name: "咒力", value: 12 }],
  traits: ["术式·空间"],
  choices: [{ step: "出身", choice: "普通人家，靠自己考进高专" }],
  setting: ["舞台：2006 年的东京。"],
};

const mockProvider: LLMProvider = {
  id: "mock",
  complete: async () => {
    throw new Error("mock 不该被调用");
  },
};

function providerReturning(candidate: unknown): LLMProvider {
  return { id: "openai-compatible", complete: async () => candidate };
}

describe("开局序章", () => {
  it("mock provider 不调模型，直接给模板兜底文案", async () => {
    const out = await openingPrologue(facts, "2006 年 4 月", mockProvider);
    expect(out.source).toBe("template");
    expect(out.text).toContain("夜见");
    expect(out.text).toContain("2006 年 4 月");
  });

  it("合法输出 ⇒ source=llm，正文即模型文本", async () => {
    const out = await openingPrologue(facts, "2006 年 4 月", providerReturning({ text: " 四月的光落在台阶上。 " }));
    expect(out.source).toBe("llm");
    expect(out.text).toBe("四月的光落在台阶上。");
  });

  it("结构不符 ⇒ 回退兜底文案（不是空串，也不抛到路由）", async () => {
    const out = await openingPrologue(facts, "2006 年 4 月", providerReturning({ body: "胡写" }));
    expect(out.source).toBe("template");
    expect(out.diagnostic).not.toBeNull();
    expect(out.text).toBe(fallbackPrologue(facts, "2006 年 4 月"));
  });

  it("兜底文案只拼已落定的事实：选择为空时不硬凑一句话", () => {
    const bare = fallbackPrologue({ ...facts, choices: [], traits: [] }, "2006 年 4 月");
    expect(bare).toContain("夜见");
    expect(bare).not.toContain("这些是你自己选的");
    expect(bare).toContain("身上什么也没有");
  });

  it("prologueFactsOf 只取 always 设定段，并把属性 id 翻成人话", () => {
    const state = {
      player: {
        name: "夜见",
        gender: "female",
        age: 15,
        attributes: { energy: 12, intellect: 3, virtue: 1 },
        statuses: [{ statusId: "tech-space" }],
      },
    } as unknown as Parameters<typeof prologueFactsOf>[0];
    const template = {
      meta: { name: "咒术回战 · 十二年", description: "2006 到 2019。" },
      attributes: {
        order: ["energy", "intellect", "virtue"],
        labels: { energy: "咒力", intellect: "智力", virtue: "善名" },
      },
      statuses: [{ id: "tech-space", name: "术式·空间" }],
    } as unknown as Parameters<typeof prologueFactsOf>[1];
    const out = prologueFactsOf(state, template, [], [
      { id: "stage", title: "舞台", text: "2006 年的东京。", always: true, keys: [], priority: 90 },
      { id: "keyword", title: "关键词", text: "不该进序章。", always: false, keys: ["x"], priority: 10 },
    ]);
    // 属性清单来自模板（statusBar 缺省 ⇒ attributes.order 的数值属性），不再写死。
    expect(out.attributes.map((a) => a.name)).toEqual(["咒力", "智力", "善名"]);
    expect(out.traits).toEqual(["术式·空间"]);
    expect(out.setting).toEqual(["舞台：2006 年的东京。"]);
  });

  it("属性清单优先读 statusBar 的 attribute 段：换世界不用改代码", () => {
    const state = {
      player: { name: "甲", gender: "female", age: 16, attributes: { energy: 9, wits: 4 }, statuses: [] },
    } as unknown as Parameters<typeof prologueFactsOf>[0];
    const template = {
      meta: { name: "另一个世界", description: "。" },
      attributes: {
        order: ["energy", "wits"],
        labels: { energy: "气", wits: "机敏" },
      },
      // 面板只想露「机敏」：序章就只提它，不因为属性表里有「气」就硬塞。
      statusBar: [{ id: "sb", label: "属性", source: "attribute", keys: ["wits"] }],
      statuses: [],
    } as unknown as Parameters<typeof prologueFactsOf>[1];
    const out = prologueFactsOf(state, template, [], []);
    expect(out.attributes).toEqual([{ name: "机敏", value: 4 }]);
  });
});
