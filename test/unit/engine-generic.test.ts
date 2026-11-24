import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 引擎通用性守卫（2026-11-23 自查）。
 *
 * 内核（game-core / shared / template-loader / agent-runtime）是**通用模拟器**：
 * 它不该知道任何一个具体作品的名字、角色 id、属性叫法或状态 id。
 * 这类东西只允许出现在模板里；一旦写进内核，换一个世界就得改代码。
 *
 * 与 `prompt-hygiene.test.ts` 的分工：那个守「模型能看到的提示词」，
 * 这个守**源码本身**（含注释 —— 注释里的专名会被下一个人照抄进逻辑）。
 */

const ROOTS = [
  "packages/game-core/src",
  "packages/shared/src",
  "packages/template-loader/src",
  "packages/agent-runtime/src",
  // 叙事层（LLM 提示词的最后一公里）：这里也必须世界无关，世界事实只从模板来。
  "apps/server/src/narrative",
  /**
   * 渲染层（2026-11-24 加）：表现的**样式**已经从引擎搬到模板 DSL（ADR-078），
   * 这里就不该再出现任何作品专名 —— 出现一个，说明又有一层样式被写死回前端了。
   */
  "packages/rpg-ui/src",
];

/**
 * 禁用词表：作品名 / 角色 id / 世界观专名 / 世界专属属性名。
 *
 * 通用词（hp/mp/暴击/闪避/装备/状态）不在此列 —— 它们是模拟器概念，
 * 不是某个世界的词。新增作品时**不要**往这里加它的词；正确做法是确认内核没有它。
 */
const FORBIDDEN = [
  // 作品与角色
  "咒术回战",
  "咒力",
  "咒术",
  "六眼",
  "无下限",
  "黑闪",
  "天与咒缚",
  "甚尔",
  "五条",
  "宿傩",
  "瓦勒蒙",
  "jjk",
  "valmont",
  "gojo",
  "geto",
  "toji",
  "sukuna",
  // 世界专属 id（模板词）
  "six-eyes",
  "limitless",
  "black-flash",
  "heavenly-restriction",
  "cursedEnergy",
  "npc-gojo",
  "npc-geto",
  "npc-toji",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

describe("引擎通用性：内核源码里没有世界事实", () => {
  it("不含作品名 / 角色 id / 世界专属属性名（含注释）", () => {
    const violations: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const text = readFileSync(file, "utf8");
        for (const word of FORBIDDEN) {
          if (!text.includes(word)) continue;
          const line = text.split("\n").findIndex((l) => l.includes(word)) + 1;
          violations.push(`${relative(".", file)}:${line} 含「${word}」`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("没有任何按模板 id / 世界 id 分支的逻辑", () => {
    const violations: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const text = readFileSync(file, "utf8");
        for (const pattern of [/templateId\s*===/, /state\.worldId\s*===/, /world\s*===\s*"/]) {
          if (pattern.test(text)) violations.push(`${relative(".", file)} 命中 ${pattern}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
