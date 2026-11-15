import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadTemplates, readAssetEntries, type TemplateScanLogger } from "./templates.js";

/**
 * T-06 Group B 最小集：
 * - demo-agentic 的 `rules.yaml` / `assets/manifest.yaml` 原样过 `RulesSchema` / `AssetManifestSchema`；
 * - 坏 `rules.yaml` 在加载期**被拒绝**（走与其它白名单文件同一条失败通道），绝不静默忽略。
 */

const silentLogger: TemplateScanLogger = { warn: () => {}, error: () => {}, info: () => {} };
const SPEC_TEMPLATES = fileURLToPath(new URL("../../../specs/data/templates", import.meta.url));

const tempRoots: string[] = [];

function cloneDemoTemplate(): string {
  const root = mkdtempSync(path.join(tmpdir(), "life-sim-tpl-"));
  tempRoots.push(root);
  cpSync(path.join(SPEC_TEMPLATES, "demo-agentic"), path.join(root, "demo-agentic"), {
    recursive: true,
  });
  process.env.TEMPLATES_DIR = root;
  return root;
}

beforeAll(() => {
  delete process.env.TEMPLATES_DIR;
});

afterEach(() => {
  delete process.env.TEMPLATES_DIR;
});

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe("T-06 Group B loader 绑定", () => {
  it("demo-agentic 的 rules.yaml / manifest.yaml 原样通过 schema", () => {
    cloneDemoTemplate();
    const registry = loadTemplates(silentLogger);
    const entry = registry.resolve({ id: "demo-agentic", version: "1.0.0" });
    expect(entry).toBeDefined();
    // rules.yaml 的 5 个顶层键 + fallbackDag 原样保留
    expect(entry?.rules?.fallbackDag.dagId).toBe("demo-agentic.fallback.v1");
    expect(entry?.rules?.fallbackDag.nodes.map((n) => n.id)).toEqual([
      "n1.awaken",
      "n2.trial",
      "n3.hiddenSeed",
    ]);
    expect(entry?.rules?.llmTriggers).toHaveLength(3);
    // manifest.yaml 落到类型化表，path 仍在服务端
    expect(entry?.assetManifest?.assets[0]?.assetId).toBe("portrait.mentor.neutral");
    expect(readAssetEntries(entry?.assetManifest)).toEqual([
      {
        assetId: "portrait.mentor.neutral",
        path: "portraits/mentor-neutral.png",
        kind: "portrait",
        characterRef: "npc-mentor",
      },
    ]);
  });

  it("损坏的 rules.yaml ⇒ 加载期拒绝（不静默丢文件）", () => {
    const root = cloneDemoTemplate();
    writeFileSync(
      path.join(root, "demo-agentic", "1.0.0", "rules.yaml"),
      "llmTriggers: not-an-array\ntoolProfile: {}\n",
      "utf8",
    );
    expect(() => loadTemplates(silentLogger)).toThrow(/rules\.yaml/);
  });

  it("rules.yaml 多一个顶层键（.strict()）⇒ 同样拒绝", () => {
    const root = cloneDemoTemplate();
    const file = path.join(root, "demo-agentic", "1.0.0", "rules.yaml");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, `${original}\n__unexpected: true\n`, "utf8");
    expect(() => loadTemplates(silentLogger)).toThrow(/rules\.yaml/);
  });
});
