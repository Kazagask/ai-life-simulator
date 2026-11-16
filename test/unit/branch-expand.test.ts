import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTemplates } from "../../apps/server/src/templates.ts";
import { fixtureEntry } from "../helpers/world.ts";

describe("模板 branch 加载期展开", () => {
  it("首节点沿用父 id、其余 <id>#<node>、goto/goto.after/nextEventId 全部生效", () => {
    const { template } = fixtureEntry();
    const first = template.events.find((e) => e.id === "ev:branch");
    const second = template.events.find((e) => e.id === "ev:branch#second");
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    if (first?.kind !== "normal" || second?.kind !== "normal") throw new Error("branch event kind");
    expect(first.settle.normal.options[0]?.nextEventId).toBe("ev:branch#second");
    expect(second.trigger.source).toBe("chain");
    expect(second.trigger.window?.start).toEqual({ value: 2, unit: "hour" });
    expect(second.settle.normal.options[0]?.nextEventId).toBe("ev:final");
  });

  it("同一节点被两条 branch 写成不同 after ⇒ 加载期拒载", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "life-sim-branch-"));
    const versionDir = path.join(dir, "p0", "1.0.0");
    cpSync(path.resolve("test/fixtures/templates/p0/1.0.0"), versionDir, { recursive: true });
    writeFileSync(
      path.join(versionDir, "events.yaml"),
      `
  - id: ev:branch2
    title: 冲突分支
    trigger: { source: chain }
    branch:
      - node: first
        title: 首
        text: 首。
        options:
          - text: 去第二节点（2h）
            goto: { node: second, after: { value: 2, unit: hour } }
          - text: 去第二节点（3h）
            goto: { node: second, after: { value: 3, unit: hour } }
      - node: second
        title: 二
        text: 二。
        options:
          - text: 出口
            nextEventId: ev:final
`,
      { flag: "a" },
    );

    const previous = process.env.TEMPLATES_DIR;
    process.env.TEMPLATES_DIR = dir;
    try {
      expect(() => loadTemplates({ warn: () => {}, error: () => {}, info: () => {} })).toThrow(
        /同一幕只能有一个延迟/,
      );
    } finally {
      if (previous === undefined) delete process.env.TEMPLATES_DIR;
      else process.env.TEMPLATES_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
