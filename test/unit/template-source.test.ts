import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MemoryTemplateSource } from "@life-sim/shared";
import { loadTemplates, loadTemplateFromSource } from "../../apps/server/src/templates.ts";

/**
 * 本地化迁移第一步：声明式模板的加载必须只依赖 `TemplateSource`（2026-11-21）。
 *
 * 这条用例守的不是「能跑」，而是**两份来源逐字段一致**：
 * 把磁盘上的同一批文件塞进内存源，走的是同一段判定（合并分域 → schema → 交叉引用），
 * 产出的模板必须和磁盘加载的 `entry.template` 完全相等。将来客户端用 fetch / IndexedDB
 * 建源时，只要这条成立，服务端与浏览器就不会算出两个世界。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };

const DECLARATIVE = [
  "world.yaml",
  "characters.yaml",
  "skills.yaml",
  "items.yaml",
  "statuses.yaml",
  "events.yaml",
  "equipment.yaml",
  "combat-ai.yaml",
  "opening.yaml",
  "endings.yaml",
  "evaluation.yaml",
  "rules.yaml",
  "lore.md",
  "assets/manifest.yaml",
] as const;

function memorySourceOf(versionDir: string): MemoryTemplateSource {
  const files: Record<string, string> = {};
  for (const rel of DECLARATIVE) {
    try {
      files[rel] = readFileSync(path.join(versionDir, rel), "utf8");
    } catch {
      // 可选分域缺文件是合法的（loader 按 present 集合判断）。
    }
  }
  return new MemoryTemplateSource(files);
}

describe("模板源：磁盘与内存同源", () => {
  it("jjk-2006/3.0.0 从内存源加载出的模板与磁盘加载逐字段相等", () => {
    const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
    if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
    const versionDir = path.join("specs", "data", "templates", "jjk-2006", "3.0.0");

    const fromMemory = loadTemplateFromSource(memorySourceOf(versionDir));
    expect(fromMemory).toEqual(entry.template);
  });

  it("内存源缺 world.yaml：加载失败，且读文件时能定位到路径", () => {
    const source = new MemoryTemplateSource({ "characters.yaml": "characters: []" });
    expect(() => loadTemplateFromSource(source)).toThrow();
    expect(() => source.read("world.yaml")).toThrow(/world\.yaml/);
  });

  it("MemoryTemplateSource 按层列目录，不递归", () => {
    const source = new MemoryTemplateSource({
      "world.yaml": "a",
      "assets/manifest.yaml": "b",
    });
    expect(source.list("").map((e) => `${e.kind}:${e.rel}`)).toEqual([
      "dir:assets",
      "file:world.yaml",
    ]);
    expect(source.list("assets").map((e) => e.rel)).toEqual(["manifest.yaml"]);
    expect(source.exists("assets")).toBe(true);
    expect(source.exists("nope")).toBe(false);
  });
});
