import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MemoryTemplateSource } from "@life-sim/shared";
import { loadTemplateBundle, loadTemplatePackage, semanticFingerprintOf } from "@life-sim/template-loader";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * 第三期第一刀：把「运行时包」的组装从服务端下沉到纯加载器（2026-11-21）。
 *
 * 守的是**同一份模板只有一个包**：服务端目录扫描组出来的 Entry 与客户端下载模板包后
 * 组出来的 Bundle，除注册表字段（ref / mtime / 资产 / 指纹）外必须逐字段相等。
 * 这条不成立，浏览器里的世界迟早和服务端算出两个结果。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };
const VERSION_DIR = path.join("specs", "data", "templates", "jjk-2006", "3.0.0");

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
  "ui.yaml",
] as const;

/** 读磁盘上的声明式文件（缺失即跳过：可选分域缺文件合法）。 */
function filesOf(dir: string = VERSION_DIR, patch: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {};
  for (const rel of DECLARATIVE) {
    try {
      files[rel] = readFileSync(path.join(dir, rel), "utf8");
    } catch {
      /* 可选分域缺文件 */
    }
  }
  return { ...files, ...patch };
}

/** `undefined` 键在 JSON 里会消失；用它把两边的「缺省」归一后再比。 */
const normalized = (value: unknown): unknown =>
  value === undefined ? null : JSON.parse(JSON.stringify(value));

describe("TemplateBundle：服务端与客户端同一个包", () => {
  it("内存源组出的包与磁盘 Entry 逐字段相等", () => {
    const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
    if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");

    const bundle = loadTemplateBundle(new MemoryTemplateSource(filesOf()));

    expect(normalized(bundle.template)).toEqual(normalized(entry.template));
    expect(normalized(bundle.openings)).toEqual(normalized(entry.openings));
    expect(normalized(bundle.openingDag)).toEqual(normalized(entry.openingDag));
    expect(normalized(bundle.endingConfig)).toEqual(normalized(entry.endingConfig));
    expect(normalized(bundle.evaluationConfig)).toEqual(normalized(entry.evaluationConfig));
    expect(normalized(bundle.rules)).toEqual(normalized(entry.rules));
    expect(normalized(bundle.lore)).toEqual(normalized(entry.lore));
    expect(normalized(bundle.assetManifest)).toEqual(normalized(entry.assetManifest));
    expect(normalized(bundle.ui)).toEqual(normalized(entry.ui));
  });

  it("可选分域都在包里：开局 DAG / 结局 / 评价 / UI / 规则 / 设定", () => {
    const bundle = loadTemplateBundle(new MemoryTemplateSource(filesOf()));
    expect(bundle.openingDag?.nodes.length).toBeGreaterThan(0);
    expect(bundle.endingConfig?.endings.length).toBeGreaterThan(0);
    expect(bundle.evaluationConfig).toBeDefined();
    expect(bundle.ui?.place).toBeDefined();
    expect(bundle.rules).toBeDefined();
    expect(Array.isArray(bundle.lore)).toBe(true);
  });

  it("expectedId 不符：拒载并说明两边身份", () => {
    const source = new MemoryTemplateSource(filesOf());
    expect(() => loadTemplateBundle(source, { expectedId: "not-jjk" })).toThrow(/不一致/);
  });

  it("ui.playerCard 引用未声明属性：拒载（交叉校验仍在纯层）", () => {
    const files = filesOf();
    files["ui.yaml"] = files["ui.yaml"]!.replace(
      /attributes: \[[^\]]*\]/,
      "attributes: [grade, bogusAttribute]",
    );
    expect(() => loadTemplateBundle(new MemoryTemplateSource(files))).toThrow(
      /playerCard 引用了未声明的属性：bogusAttribute/,
    );
  });

  it("模板包解析一次就带出 bundle（客户端不必再解析一遍 YAML）", () => {
    const files = filesOf();
    const template = loadTemplateBundle(new MemoryTemplateSource(files)).template;
    const fingerprint = semanticFingerprintOf(
      Object.entries(files).map(([rel, content]) => ({ rel, content })),
      template,
    );
    const result = loadTemplatePackage({ templateId: "jjk-2006", version: "3.0.0", fingerprint, files });

    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    expect(result.fingerprint).toBe(fingerprint);
    expect(result.bundle.template.meta.id).toBe("jjk-2006");
    expect(result.bundle.openingDag).toBeDefined();
  });
});
