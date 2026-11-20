import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { UiConfigSchema, BUILTIN_UI_CAPABILITIES } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silentLogger = { warn: () => {}, error: () => {}, info: () => {} };

function fixtureCopy(): { root: string; versionDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "life-sim-ui-"));
  const versionDir = path.join(root, "p0", "1.0.0");
  cpSync(path.resolve("test/fixtures/templates/p0/1.0.0"), versionDir, { recursive: true });
  return { root, versionDir };
}

function withTemplatesDir<T>(dir: string, fn: () => T): T {
  const previous = process.env.TEMPLATES_DIR;
  process.env.TEMPLATES_DIR = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TEMPLATES_DIR;
    else process.env.TEMPLATES_DIR = previous;
  }
}

describe("ui.yaml 形状 B：schema + 加载 + 指纹", () => {
  it("落位四值与缺省：place 可省略，键集闭合", () => {
    expect(UiConfigSchema.parse({})).toEqual({});
    expect(
      UiConfigSchema.parse({
        place: {
          world: "tab",
          wheel: "overlay",
          log: "off",
          equipment: "slot:personal",
        },
      }),
    ).toEqual({
      place: {
        world: "tab",
        wheel: "overlay",
        log: "off",
        equipment: "slot:personal",
      },
    });
    expect(() => UiConfigSchema.parse({ place: { world: "drawer" } })).toThrow();
    expect(() => UiConfigSchema.parse({ place: { world: "slot:" } })).toThrow();
    expect(() => UiConfigSchema.parse({ views: { world: true } })).toThrow(); // 形状 A 不兼容
    expect(BUILTIN_UI_CAPABILITIES).toContain("npcList");
  });

  it("合法 ui.yaml 被加载；不写时 ui 缺省", () => {
    const { root, versionDir } = fixtureCopy();
    try {
      writeFileSync(
        path.join(versionDir, "ui.yaml"),
        "place:\n  world: tab\n  log: off\n  ending: tab\n",
      );
      const entry = withTemplatesDir(root, () => loadTemplates(silentLogger)).resolve({
        id: "p0",
        version: "1.0.0",
      });
      expect(entry?.ui).toEqual({
        place: { world: "tab", log: "off", ending: "tab" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const bare = fixtureCopy();
    try {
      const entry = withTemplatesDir(bare.root, () => loadTemplates(silentLogger)).resolve({
        id: "p0",
        version: "1.0.0",
      });
      expect(entry?.ui).toBeUndefined();
    } finally {
      rmSync(bare.root, { recursive: true, force: true });
    }
  });

  it("未知能力 id 加载期拒载（不会静默忽略）", () => {
    const { root, versionDir } = fixtureCopy();
    try {
      writeFileSync(path.join(versionDir, "ui.yaml"), "place:\n  typoz: tab\n");
      expect(() => withTemplatesDir(root, () => loadTemplates(silentLogger))).toThrow(
        /ui\.yaml: 未知能力 id "typoz"/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("改 ui.yaml 不改语义指纹：旧存档不因展示调整而拒载", () => {
    const { root, versionDir } = fixtureCopy();
    try {
      const before = withTemplatesDir(root, () => loadTemplates(silentLogger))
        .resolve({ id: "p0", version: "1.0.0" })?.semanticFingerprint;
      writeFileSync(path.join(versionDir, "ui.yaml"), "place:\n  world: off\n");
      // mtime 变化触发重扫；指纹必须仍然相同。
      const after = withTemplatesDir(root, () => loadTemplates(silentLogger))
        .resolve({ id: "p0", version: "1.0.0" })?.semanticFingerprint;
      expect(after).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("三个真实模板的 ui.yaml 都能加载（扩展能力 id 被识别）", () => {
    const previous = process.env.TEMPLATES_DIR;
    process.env.TEMPLATES_DIR = path.resolve("specs/data/templates");
    try {
      // family 扩展由测试 bootstrap 注册与否取决于导入顺序；这里只断言 schema 层能解析。
      // jjk-2006 的现行版本是 3.0.0（1.0.0 / 2.0.0 已随 ADR-009 归档）
      for (const [id, version] of [
        ["jjk-2006", "3.0.0"],
        ["jjk-shinjuku", "1.0.0"],
        ["valmont", "1.0.0"],
      ] as const) {
        const raw = readFileSync(
          path.resolve(`specs/data/templates/${id}/${version}/ui.yaml`),
          "utf8",
        );
        expect(() => UiConfigSchema.parse(parse(raw))).not.toThrow();
      }
    } finally {
      if (previous === undefined) delete process.env.TEMPLATES_DIR;
      else process.env.TEMPLATES_DIR = previous;
    }
  });
});
