import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerExtensionRuntime, resetExtensionRuntimes } from "@life-sim/game-core";
import { familyExtension } from "@life-sim/ext-family";
import { loadTemplates, type TemplateRegistry } from "../../apps/server/src/templates.ts";

/**
 * `unknown_extension` 拒载（扩展层保证：模板声明了没装的扩展 ⇒ 该版本不可载）。
 *
 * 三条锁定：
 * 1. 缺失 id ⇒ 该版本 `invalid` + 封闭码 `unknown_extension`，`reason` 带缺失 id 与已注册 id 列表；
 * 2. **服务不必因此拒启动**（只有这一种失败不走启动期 fail-fast）—— 其它模板照样可玩；
 * 3. 装了之后同一份模板立刻 `ready`（注册表是被查的那一张，不是第二份名单）。
 */
const silentLogger = { warn: () => {}, error: () => {}, info: () => {} };

/**
 * 复制 p0 fixture 到 `p0/2.0.0`，在 `world.yaml` 末尾拼一段顶层 yaml。
 *
 * 同时保留一份干净的 `p0/1.0.0`：`unknown_extension` 不走启动期 fail-fast，
 * 但 `loadTemplates` 仍要求**至少一个可载版本**（否则 `no_templates_found_in`），
 * 所以必须有一个正常版本陪跑 —— 这正是线上「三模板里坏一个，其它照样玩」的形状。
 */
function templateWithExtensions(extensionsYaml: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "life-sim-ext-"));
  cpSync(path.resolve("test/fixtures/templates/p0/1.0.0"), path.join(dir, "p0", "1.0.0"), {
    recursive: true,
  });
  const versionDir = path.join(dir, "p0", "2.0.0");
  cpSync(path.resolve("test/fixtures/templates/p0/1.0.0"), versionDir, { recursive: true });
  const worldFile = path.join(versionDir, "world.yaml");
  // 覆盖写：先读原文再拼一段（追加模式会把整份原文再写一遍 ⇒ 重复键）。
  writeFileSync(worldFile, `${readFileSync(worldFile, "utf8")}\n${extensionsYaml}`);
  return dir;
}

function loadFrom(dir: string): TemplateRegistry {
  const previous = process.env.TEMPLATES_DIR;
  process.env.TEMPLATES_DIR = dir;
  try {
    return loadTemplates(silentLogger);
  } finally {
    if (previous === undefined) delete process.env.TEMPLATES_DIR;
    else process.env.TEMPLATES_DIR = previous;
  }
}

describe("unknown_extension：声明了没装的扩展 ⇒ 该版本不可载", () => {
  afterEach(() => resetExtensionRuntimes());

  it("未注册的 id ⇒ loadable:false + reasonCode，且不阻断服务启动", () => {
    const dir = templateWithExtensions("extensions:\n  nope: true\n");
    try {
      // 关键：loadTemplates 不 throw（否则整台服务被一个缺包打挂）。
      const registry = loadFrom(dir);
      expect(registry.resolve({ id: "p0", version: "2.0.0" })).toBeUndefined();
      // 同目录的干净版本照常可载 —— 「坏一个版本」不等于「整台服务不可用」。
      expect(registry.resolve({ id: "p0", version: "1.0.0" })).toBeDefined();

      const versions = registry.versionsOf("p0");
      expect(versions.map((entry) => entry.ref.version)).toEqual(["1.0.0", "2.0.0"]);
      const listed = registry
        .listTemplates()
        .flatMap((template) => template.versions)
        .find((version) => version.version === "2.0.0")!;
      expect(listed.loadable).toBe(false);
      if (listed.loadable) throw new Error("unreachable");
      expect(listed.reasonCode).toBe("unknown_extension");
      expect(listed.reason).toContain('"nope"');
      expect(listed.reason).toContain("已注册的扩展 id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("注册 runtime 后同一份模板立刻可载（判据就是那张注册表）", () => {
    const dir = templateWithExtensions("extensions:\n  family: true\n");
    try {
      registerExtensionRuntime(familyExtension);
      const registry = loadFrom(dir);
      const entry = registry.resolve({ id: "p0", version: "2.0.0" });
      expect(entry?.template.extensions).toEqual({ family: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不声明 extensions ⇒ 不查表、照常可载", () => {
    const dir = templateWithExtensions("");
    try {
      const registry = loadFrom(dir);
      expect(registry.resolve({ id: "p0", version: "2.0.0" })?.template.extensions).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
