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

  it("node 级 as：同一节点不同 self 走不同正文/选项，goto 门控但不额外占轮次", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "life-sim-branch-as-"));
    const versionDir = path.join(dir, "p0", "1.0.0");
    cpSync(path.resolve("test/fixtures/templates/p0/1.0.0"), versionDir, { recursive: true });
    writeFileSync(
      path.join(versionDir, "events.yaml"),
      `
  - id: ev:branch-as
    title: 角色分派
    trigger: { source: chain }
    branch:
      - node: first
        title: 首
        text: 首。
        options:
          - text: 继续
            goto: second
      - node: second
        as: npc-friend
        title: 二·友
        text: 只有朋友看到的剧情。
        options:
          - { text: 朋友出口, nextEventId: ev:final }
      - node: second
        title: 二·默认
        text: 其他人看到的剧情。
        options:
          - { text: 默认出口, nextEventId: ev:final }
`,
      { flag: "a" },
    );

    const previous = process.env.TEMPLATES_DIR;
    process.env.TEMPLATES_DIR = dir;
    try {
      const registry = loadTemplates({ warn: () => {}, error: () => {}, info: () => {} });
      const entry = registry.resolve({ id: "p0", version: "1.0.0" });
      expect(entry?.status).toBe("ready");
      if (entry?.status !== "ready") throw new Error("template not ready");
      const first = entry.template.events.find((e) => e.id === "ev:branch-as");
      const variant = entry.template.events.find((e) => e.id === "ev:branch-as#second@npc-friend");
      const fallback = entry.template.events.find((e) => e.id === "ev:branch-as#second");
      expect(variant?.narrative).toBe("只有朋友看到的剧情。");
      expect(fallback?.narrative).toBe("其他人看到的剧情。");
      expect(variant?.trigger.conditions).toEqual([{ selfIs: "npc-friend" }]);
      // 兜底变体带 selfIsNot：直接按 id 入队也不会与 as 变体串戏。
      expect(fallback?.trigger.conditions).toEqual([{ selfIsNot: "npc-friend" }]);
      if (first?.kind !== "normal" || variant?.kind !== "normal") throw new Error("kind");
      // 两条门控选项同文、同目标语义：玩家只看得到一条，不额外耗一轮。
      expect(first.settle.normal.options.map((o) => o.text)).toEqual(["继续", "继续"]);
      expect(first.settle.normal.options.map((o) => o.visibleWhen)).toEqual([
        [{ selfIs: "npc-friend" }],
        undefined,
      ]);
      expect(first.settle.normal.options.map((o) => o.nextEventId)).toEqual([
        "ev:branch-as#second@npc-friend",
        "ev:branch-as#second",
      ]);
      expect(variant.settle.normal.options[0]?.nextEventId).toBe("ev:final");
    } finally {
      if (previous === undefined) delete process.env.TEMPLATES_DIR;
      else process.env.TEMPLATES_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("node 级 as：首节点多变体共用父 trigger、入边按 self 分派、兜底带 selfIsNot", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "life-sim-branch-first-as-"));
    const versionDir = path.join(dir, "p0", "1.0.0");
    cpSync(path.resolve("test/fixtures/templates/p0/1.0.0"), versionDir, { recursive: true });
    writeFileSync(
      path.join(versionDir, "events.yaml"),
      `
  - id: ev:upstream
    title: 上游
    kind: normal
    trigger: { source: chain }
    settle:
      normal:
        options:
          - { text: 进入分派, nextEventId: ev:first-as }
  - id: ev:first-as
    title: 首节点分派
    trigger: { source: chain }
    branch:
      - node: opening
        as: npc-friend
        title: 友之开幕
        text: 朋友看到的开场。
        options:
          - { text: 朋友出口, nextEventId: ev:final }
      - node: opening
        title: 默认开幕
        text: 其他人看到的开场。
        options:
          - { text: 默认出口, nextEventId: ev:final }
`,
      { flag: "a" },
    );

    const previous = process.env.TEMPLATES_DIR;
    process.env.TEMPLATES_DIR = dir;
    try {
      const registry = loadTemplates({ warn: () => {}, error: () => {}, info: () => {} });
      const entry = registry.resolve({ id: "p0", version: "1.0.0" });
      expect(entry?.status).toBe("ready");
      if (entry?.status !== "ready") throw new Error("template not ready");

      const fallback = entry.template.events.find((e) => e.id === "ev:first-as");
      const variant = entry.template.events.find((e) => e.id === "ev:first-as#opening@npc-friend");
      expect(fallback?.narrative).toBe("其他人看到的开场。");
      expect(variant?.narrative).toBe("朋友看到的开场。");
      // 多变体首节点共用父 trigger（source=chain），只叠 self 门控。
      expect(variant?.trigger.source).toBe("chain");
      expect(variant?.trigger.conditions).toEqual([{ selfIs: "npc-friend" }]);
      expect(fallback?.trigger.source).toBe("chain");
      expect(fallback?.trigger.conditions).toEqual([{ selfIsNot: "npc-friend" }]);

      // 上游入边被拆成两条同形、self 门控的选项：玩家仍只看到一条、不额外占轮次。
      const upstream = entry.template.events.find((e) => e.id === "ev:upstream");
      if (upstream?.kind !== "normal") throw new Error("upstream kind");
      expect(upstream.settle.normal.options.map((o) => o.text)).toEqual(["进入分派", "进入分派"]);
      expect(upstream.settle.normal.options.map((o) => o.visibleWhen)).toEqual([
        [{ selfIs: "npc-friend" }],
        [{ selfIsNot: "npc-friend" }],
      ]);
      expect(upstream.settle.normal.options.map((o) => o.nextEventId)).toEqual([
        "ev:first-as#opening@npc-friend",
        "ev:first-as",
      ]);
    } finally {
      if (previous === undefined) delete process.env.TEMPLATES_DIR;
      else process.env.TEMPLATES_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("node 级 as：多变体缺兜底 ⇒ 加载期拒载", () => {
    const cases = [
      {
        label: "多变体缺兜底",
        yaml: `
  - id: ev:branch-as-bad
    title: 坏分支
    trigger: { source: chain }
    branch:
      - node: first
        title: 首
        text: 首。
        options:
          - { text: 去, goto: second }
      - node: second
        as: npc-friend
        title: 二·友
        text: 友。
        options:
          - { text: 出口, nextEventId: ev:final }
      - node: second
        as: player
        title: 二·我
        text: 我。
        options:
          - { text: 出口, nextEventId: ev:final }
`,
        expect: /缺少无 as 的兜底变体/,
      },
    ];
    for (const { label, yaml, expect: pattern } of cases) {
      const dir = mkdtempSync(path.join(tmpdir(), "life-sim-branch-as-bad-"));
      const versionDir = path.join(dir, "p0", "1.0.0");
      cpSync(path.resolve("test/fixtures/templates/p0/1.0.0"), versionDir, { recursive: true });
      writeFileSync(path.join(versionDir, "events.yaml"), yaml, { flag: "a" });
      const previous = process.env.TEMPLATES_DIR;
      process.env.TEMPLATES_DIR = dir;
      try {
        expect(() => loadTemplates({ warn: () => {}, error: () => {}, info: () => {} }), label).toThrow(pattern);
      } finally {
        if (previous === undefined) delete process.env.TEMPLATES_DIR;
        else process.env.TEMPLATES_DIR = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("node 级 as 数组：多个 self 共用同一节点，兜底排除每一个 as", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "life-sim-branch-as-multi-"));
    const versionDir = path.join(dir, "p0", "1.0.0");
    cpSync(path.resolve("test/fixtures/templates/p0/1.0.0"), versionDir, { recursive: true });
    writeFileSync(
      path.join(versionDir, "events.yaml"),
      `
  - id: ev:branch-as-multi
    title: 多角色共用
    trigger: { source: chain }
    branch:
      - node: first
        title: 首
        text: 首。
        options:
          - text: 继续
            goto: second
      - node: second
        as: [npc-friend, player-civilian]
        title: 二·共用
        text: 两个人看到的同一段。
        options:
          - { text: 出口, nextEventId: ev:final }
      - node: second
        title: 二·默认
        text: 其他人看到的。
        options:
          - { text: 默认出口, nextEventId: ev:final }
`,
      { flag: "a" },
    );

    const previous = process.env.TEMPLATES_DIR;
    process.env.TEMPLATES_DIR = dir;
    try {
      const registry = loadTemplates({ warn: () => {}, error: () => {}, info: () => {} });
      const entry = registry.resolve({ id: "p0", version: "1.0.0" });
      expect(entry?.status).toBe("ready");
      if (entry?.status !== "ready") throw new Error("template not ready");

      const first = entry.template.events.find((e) => e.id === "ev:branch-as-multi");
      const friend = entry.template.events.find((e) => e.id === "ev:branch-as-multi#second@npc-friend");
      const custom = entry.template.events.find(
        (e) => e.id === "ev:branch-as-multi#second@player-civilian",
      );
      const fallback = entry.template.events.find((e) => e.id === "ev:branch-as-multi#second");
      expect(friend?.narrative).toBe("两个人看到的同一段。");
      expect(custom?.narrative).toBe("两个人看到的同一段。");
      expect(fallback?.narrative).toBe("其他人看到的。");
      expect(fallback?.trigger.conditions).toEqual([
        { selfIsNot: "npc-friend" },
        { selfIsNot: "player-civilian" },
      ]);
      if (first?.kind !== "normal") throw new Error("kind");
      expect(first.settle.normal.options.map((o) => o.nextEventId)).toEqual([
        "ev:branch-as-multi#second@npc-friend",
        "ev:branch-as-multi#second@player-civilian",
        "ev:branch-as-multi#second",
      ]);
    } finally {
      if (previous === undefined) delete process.env.TEMPLATES_DIR;
      else process.env.TEMPLATES_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
