import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { selectInvocationLore } from "@life-sim/game-core";
import { loadTemplates } from "../../apps/server/src/templates.ts";
import { fixtureEntry, makeWorld } from "../helpers/world.ts";

describe("lore.md + prompt.style", () => {
  it("解析条目、常驻/关键词标记与 style", () => {
    const entry = fixtureEntry();
    expect(entry.rules?.prompt?.style?.trim()).toBe("句子短，动作具体；不要写总结陈词。");
    expect(entry.lore?.map((lore) => [lore.id, lore.always, lore.priority])).toEqual([
      ["世界基调", true, 90],
      ["战斗规则", false, 80],
    ]);
  });

  it("引擎筛选：常驻全进；关键词命中才进；按 p/id 排序", () => {
    const { state, entry } = makeWorld();
    state.slot = null;
    const lore = entry.lore ?? [];

    expect(selectInvocationLore(state, entry.lookup, [], lore).map((x) => x.id)).toEqual([
      "世界基调",
    ]);
    expect(selectInvocationLore(state, entry.lookup, ["战斗"], lore).map((x) => x.id)).toEqual([
      "世界基调",
      "战斗规则",
    ]);
  });

  it("keys 为空 ⇒ 加载期拒载并指出标题", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "life-sim-lore-"));
    const versionDir = path.join(dir, "p0", "1.0.0");
    cpSync(path.resolve("test/fixtures/templates/p0/1.0.0"), versionDir, { recursive: true });
    const file = path.join(versionDir, "lore.md");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(/> keys:.*\| p: 80/, "> keys:  | p: 80"),
    );

    const previous = process.env.TEMPLATES_DIR;
    process.env.TEMPLATES_DIR = dir;
    try {
      expect(() => loadTemplates({ warn: () => {}, error: () => {}, info: () => {} })).toThrow(
        /条目「战斗规则」的 keys 为空/,
      );
    } finally {
      if (previous === undefined) delete process.env.TEMPLATES_DIR;
      else process.env.TEMPLATES_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
