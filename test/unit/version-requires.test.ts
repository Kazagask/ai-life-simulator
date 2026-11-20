import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_VERSION, satisfiesVersion } from "@life-sim/shared";
import { registerExtensionRuntime, resetExtensionRuntimes } from "@life-sim/game-core";
import { familyExtension } from "@life-sim/ext-family";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silentLogger = { warn: () => {}, error: () => {}, info: () => {} };

describe("版本声明：satisfiesVersion", () => {
  it("四种区间格式", () => {
    expect(satisfiesVersion("0.1.0", undefined)).toBe(true);
    expect(satisfiesVersion("9.9.9", "*")).toBe(true);
    expect(satisfiesVersion("0.1.0", "0.1.0")).toBe(true);
    expect(satisfiesVersion("0.1.1", "0.1.0")).toBe(false);
    expect(satisfiesVersion("0.1.7", "^0.1.0")).toBe(true);
    expect(satisfiesVersion("0.2.0", "^0.1.0")).toBe(false);
    expect(satisfiesVersion("1.0.0", ">=0.1.0")).toBe(true);
    expect(satisfiesVersion("0.0.9", ">=0.1.0")).toBe(false);
    expect(satisfiesVersion("0.1.0", "not-a-version")).toBe(false);
  });

  it("ENGINE_VERSION 与主包 package.json 同步", () => {
    const pkg = JSON.parse(readFileSync(path.resolve("packages/game-core/package.json"), "utf8"));
    expect(ENGINE_VERSION).toBe(pkg.version);
  });
});

describe("版本声明：加载期核对", () => {
  afterEach(() => resetExtensionRuntimes());

  /** 保留一份干净的 1.0.0 陪跑：坏一个版本不能让整个服务起不来。 */
  function cloneFixture(): { root: string; versionDir: string } {
    const root = mkdtempSync(path.join(tmpdir(), "life-sim-req-"));
    cpSync(path.resolve("test/fixtures/templates/p0/1.0.0"), path.join(root, "p0", "1.0.0"), {
      recursive: true,
    });
    const versionDir = path.join(root, "p0", "2.0.0");
    cpSync(path.resolve("test/fixtures/templates/p0/1.0.0"), versionDir, { recursive: true });
    return { root, versionDir };
  }

  function withDir<T>(root: string, fn: () => T): T {
    const previous = process.env.TEMPLATES_DIR;
    process.env.TEMPLATES_DIR = root;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.TEMPLATES_DIR;
      else process.env.TEMPLATES_DIR = previous;
    }
  }

  it("requires.core 不匹配 ⇒ 该版本 invalid，原因码可诊断", () => {
    const { root, versionDir } = cloneFixture();
    try {
      const file = path.join(versionDir, "world.yaml");
      writeFileSync(file, `requires:\n  core: "99.0.0"\n${readFileSync(file, "utf8")}`);
      const registry = withDir(root, () => loadTemplates(silentLogger));
      const bad = registry.listTemplates()[0].versions.find((v) => v.version === "2.0.0");
      expect(bad?.loadable).toBe(false);
      expect(bad?.loadable === false && bad.reasonCode).toBe("core_version_mismatch");
      // 陪跑版本照常可载：坏一个不拖垮整台服务。
      expect(registry.resolve({ id: "p0", version: "1.0.0" })?.status).toBe("ready");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires.extensions 声明了未启用的扩展 ⇒ 该版本 invalid", () => {
    const { root, versionDir } = cloneFixture();
    try {
      const file = path.join(versionDir, "world.yaml");
      writeFileSync(
        file,
        `requires:\n  extensions:\n    family: "^0.1.0"\n${readFileSync(file, "utf8")}`,
      );
      const registry = withDir(root, () => loadTemplates(silentLogger));
      const bad = registry.listTemplates()[0].versions.find((v) => v.version === "2.0.0");
      expect(bad?.loadable).toBe(false);
      expect(bad?.loadable === false && bad.reason).toContain(
        'requires.extensions["family"] 声明了版本，但 extensions: 里没有声明这个扩展',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("扩展版本进语义指纹：升版本会让同一模板换指纹", () => {
    const { root, versionDir } = cloneFixture();
    try {
      const file = path.join(versionDir, "world.yaml");
      writeFileSync(file, `extensions:\n  fake: true\n${readFileSync(file, "utf8")}`);
      registerExtensionRuntime({ id: "fake", version: "1.0.0" });
      const first = withDir(root, () => loadTemplates(silentLogger)).resolve({ id: "p0", version: "2.0.0" });
      resetExtensionRuntimes();
      registerExtensionRuntime({ id: "fake", version: "1.0.1" });
      const second = withDir(root, () => loadTemplates(silentLogger)).resolve({ id: "p0", version: "2.0.0" });

      expect(first?.status).toBe("ready");
      expect(second?.status).toBe("ready");
      expect(first?.status === "ready" && first.semanticFingerprint).toBeTruthy();
      expect(
        first?.status === "ready" && second?.status === "ready" && first.semanticFingerprint !== second.semanticFingerprint,
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("三个真实模板的 requires 都能加载（family 版本对得上）", () => {
    registerExtensionRuntime(familyExtension);
    withDir(path.resolve("specs/data/templates"), () => {
      const registry = loadTemplates(silentLogger);
      // jjk-2006 的现行版本是 3.0.0（1.0.0 / 2.0.0 已随 ADR-009 归档）
      for (const [id, version] of [
        ["jjk-2006", "3.0.0"],
        ["jjk-shinjuku", "1.0.0"],
        ["valmont", "1.0.0"],
      ] as const) {
        expect(registry.resolve({ id, version })?.status, id).toBe("ready");
      }
    });
  });
});
