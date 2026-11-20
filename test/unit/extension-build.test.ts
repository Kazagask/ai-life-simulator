import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { installedExtensionIds } from "../../apps/server/src/extensions.ts";
import { webExtensionIds } from "../../apps/web/src/extensions.ts";

/**
 * 「加扩展就重新构建，编进去就行」（2026-11-21 用户裁决，ADR-070 D2）。
 *
 * 这句话要成立，必须有两个机械保证：
 * 1. 前端与后端编入的是**同一批**扩展 —— 否则会出现「模板能载入、页面少一块」；
 * 2. 模板里声明的每个扩展 id 都在这批里 —— 否则服务端加载期 `unknown_extension`，
 *    玩家看到的是「世界打不开」，而不是「少了个页签」。
 *
 * 两条都在这里守：任何一边漏编，CI 直接挂。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };
const TEMPLATE_ROOT = path.join("specs", "data", "templates");

function declaredExtensionIds(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const templateIds = readDirs(TEMPLATE_ROOT);
  for (const templateId of templateIds) {
    for (const version of readDirs(path.join(TEMPLATE_ROOT, templateId))) {
      const worldPath = path.join(TEMPLATE_ROOT, templateId, version, "world.yaml");
      let doc: unknown;
      try {
        doc = parse(readFileSync(worldPath, "utf8"));
      } catch {
        continue;
      }
      const extensions = (doc as { extensions?: Record<string, unknown> } | null)?.extensions;
      const ids = new Set(Object.keys(extensions ?? {}));
      out.set(`${templateId}@${version}`, ids);
    }
  }
  return out;
}

function readDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

describe("扩展的构建期编入（ADR-070 D2）", () => {
  it("前端与后端编入同一批扩展", () => {
    expect(webExtensionIds).toEqual(installedExtensionIds());
  });

  it("模板声明的扩展都在这批里（漏编 = 世界打不开）", () => {
    const installed = new Set(installedExtensionIds());
    const missing: string[] = [];
    for (const [ref, ids] of declaredExtensionIds()) {
      for (const id of ids) {
        if (!installed.has(id)) missing.push(`${ref}: ${id}`);
      }
    }
    expect(missing, "模板声明了未编入的扩展").toEqual([]);
  });

  it("至少装了 family（否则这条守卫是空跑）", () => {
    expect(installedExtensionIds()).toContain("family");
  });
});
