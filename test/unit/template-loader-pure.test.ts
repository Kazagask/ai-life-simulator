import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@life-sim/shared";
import { fingerprintOfPairs } from "@life-sim/template-loader";

/**
 * 纯层加载器（2026-11-21）：`@life-sim/template-loader` 要能在**浏览器**里跑，
 * 所以两件事必须有守卫：
 *
 * 1. **没有 `node:` 依赖**：一旦有人顺手 import `node:crypto` / `node:fs`，
 *    这个包就再也进不了浏览器 —— 类型检查看不出来（root 装了 @types/node）。
 * 2. **指纹逐字节不变**：纯 TS 的 SHA-256 必须与旧实现（`createHash` 逐段 update）
 *    算出同一个数，否则所有旧存档会在升级那一刻集体拒载。
 */

const loaderSrc = path.resolve(__dirname, "../../packages/template-loader/src");

describe("template-loader 是纯层（可进浏览器）", () => {
  it("源码里没有任何 `node:` 导入", () => {
    const files = readdirSync(loaderSrc, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => path.join(loaderSrc, entry.name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text.includes('from "node:'), path.basename(file)).toBe(false);
      expect(text.includes("require("), path.basename(file)).toBe(false);
      // 进程环境也属于宿主：加载器只吃 `TemplateSource`
      expect(text.includes("process.env"), path.basename(file)).toBe(false);
    }
  });
});

describe("纯 TS SHA-256 与 node:crypto 一致", () => {
  it("覆盖空串 / ASCII / 中文 / 补位边界", () => {
    const cases = [
      "",
      "abc",
      "中文",
      "咒术回战 · 命数 2006",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(64),
      "x".repeat(1000),
    ];
    for (const text of cases) {
      const expected = createHash("sha256").update(text, "utf8").digest("hex");
      expect(sha256Hex(text), `len=${text.length}`).toBe(expected);
    }
  });
});

describe("语义指纹与旧实现逐字节一致", () => {
  it("多文件「名 + \\0 + 内容」的拼接方式没变", () => {
    const pairs = [
      { name: "world.yaml", content: "meta:\n  id: demo\n" },
      { name: "lore.md", content: "## 一\n中文设定。\n" },
      { name: "events.yaml", content: "events: []\n" },
    ];
    // 旧实现：逐段 update(name) / update("\0") / update(content)
    const hash = createHash("sha256");
    for (const pair of pairs) {
      hash.update(pair.name);
      hash.update("\0");
      hash.update(pair.content);
    }
    expect(fingerprintOfPairs(pairs)).toBe(`sha256:${hash.digest("hex")}`);
  });

  it("空集是确定值（不会长出不稳定的 undefined）", () => {
    expect(fingerprintOfPairs([])).toBe(`sha256:${sha256Hex("")}`);
  });
});
