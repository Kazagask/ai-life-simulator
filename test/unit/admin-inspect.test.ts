import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerServerExtensions } from "../../apps/server/src/extensions.ts";
import { buildOrchestration, diagnoseOrchestration, type AdminIssue } from "../../apps/server/src/admin-data.ts";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * `admin-data.ts` 的体检规则回归。
 *
 * 这里跑**真实模板**（`specs/data/templates`）而不是 fixture：体检的价值就在于
 * 「这 4 个版本有没有写出无人生还的旗标」，用假模板测等于不测。
 * 规则收紧导致误报时，第一个断言会立刻失败——这正是我们要的信号。
 */

const noopLogger = {
  warn: () => undefined,
  error: () => undefined,
  info: () => undefined,
};

// 扩展必须先于模板扫描注册，否则声明了 family 的模板会被判 unknown_extension。
registerServerExtensions();
const registry = loadTemplates(noopLogger);

describe("模板体检", () => {
  it("所有可载入版本没有 error 级问题", () => {
    const errors: string[] = [];
    for (const t of registry.listTemplates()) {
      for (const v of t.versions) {
        if (!v.loadable) continue;
        const entry = registry.resolve({ id: t.id, version: v.version });
        if (!entry) continue;
        const issues = diagnoseOrchestration(buildOrchestration(entry));
        for (const issue of issues) {
          if (issue.level === "error") errors.push(`${t.id}@${v.version} ${issue.rule}: ${issue.message}`);
        }
      }
    }
    expect(errors).toEqual([]);
  });

  it("legacy 开局 handoff 排队的事件不算孤立链事件", () => {
    const entry = registry.resolve({ id: "jjk-shinjuku", version: "1.0.0" });
    expect(entry).toBeDefined();
    const orch = buildOrchestration(entry!);
    expect(orch.stats.openingSeedEvents).toContain("evt:gojo-open");
    expect(orch.stats.orphanChainEvents).not.toContain("evt:gojo-open");
  });

  it("开局写入的旗标计入写方，不会误报成死旗标", () => {
    const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
    expect(entry).toBeDefined();
    const orch = buildOrchestration(entry!);
    const savedRiko = orch.flags.find((f) => f.id === "savedRiko");
    expect(savedRiko).toBeDefined();
    expect(savedRiko!.writers.some((w) => w.source === "opening")).toBe(true);
    expect(diagnoseOrchestration(orch).some((i) => i.rule === "flag-never-written" && i.subject === "savedRiko")).toBe(
      false,
    );
  });

  it("结局条件读的旗标无人写入时判 error", () => {
    const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
    const orch = buildOrchestration(entry!);
    // 造一个只被结局读取、无人写入的旗标，验证规则确实会报。
    orch.flags.push({
      id: "__probe_dead_flag",
      writers: [],
      readers: [{ flag: "__probe_dead_flag", where: "ending", ref: "end-probe" }],
    });
    (orch.endings as Array<Record<string, unknown>>).push({
      endingId: "end-probe",
      triggerConditions: [{ flag: "__probe_dead_flag", eq: true }],
    });
    const issues = diagnoseOrchestration(orch);
    expect(issues.some((i) => i.level === "error" && i.rule === "ending-unreachable" && i.subject === "end-probe")).toBe(
      true,
    );
  });
});

/* ------------------------------------------------------------------ *
 * sink-event：链上事件没有出口
 * ------------------------------------------------------------------ */

const FIXTURE = path.resolve("test/fixtures/templates/p0/1.0.0");
const SILENT = { warn: () => undefined, error: () => undefined, info: () => undefined };

/**
 * 在 p0 fixture 的 `events.yaml` 末尾追加一个事件，加载 `p0@2.0.0` 后跑体检。
 * 不读真实模板：同事正在重写 3.0.0 的剧情，规则不能依赖它当前的形状。
 */
function diagnoseWithEvent(eventYaml: string): AdminIssue[] {
  const dir = mkdtempSync(path.join(tmpdir(), "life-sim-sink-"));
  try {
    cpSync(FIXTURE, path.join(dir, "p0", "1.0.0"), { recursive: true });
    const versionDir = path.join(dir, "p0", "2.0.0");
    cpSync(FIXTURE, versionDir, { recursive: true });
    const target = path.join(versionDir, "events.yaml");
    writeFileSync(target, `${readFileSync(target, "utf8")}\n${eventYaml}`);

    const previous = process.env.TEMPLATES_DIR;
    process.env.TEMPLATES_DIR = dir;
    let registry;
    try {
      registry = loadTemplates(SILENT);
    } finally {
      if (previous === undefined) delete process.env.TEMPLATES_DIR;
      else process.env.TEMPLATES_DIR = previous;
    }

    const entry = registry.resolve({ id: "p0", version: "2.0.0" });
    expect(entry).toBeDefined();
    return diagnoseOrchestration(buildOrchestration(entry!));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 链上事件，选项既不 nextEventId 也不写结局旗标。 */
const SINK_EVENT = `  - id: ev:sink
    title: 无出口
    trigger:
      source: chain
    kind: normal
    settle:
      normal:
        options:
          - id: opt-sink
            text: 走完了
            effects:
              - type: setFlag
                id: line
                value: sink
`;

/** 同样没有出边，但写了一个被结局触发条件读取的旗标。 */
const SINK_EVENT_WITH_ENDING = `  - id: ev:sink-ending
    title: 通向结局
    trigger:
      source: chain
    kind: normal
    settle:
      normal:
        options:
          - id: opt-sink-ending
            text: 落幕
            effects:
              - type: setFlag
                id: endingShort
                value: good
`;

/** 日常事件：source=pool，本来就不在链上，没有下一幕很正常。 */
const POOL_LEAF_EVENT = `  - id: ev:pool-leaf
    title: 日常
    trigger:
      source: pool
      probability: 0.1
    kind: normal
    settle:
      normal:
        options:
          - id: opt-pool-leaf
            text: 就这样
            effects:
              - type: setFlag
                id: line
                value: pool
`;

describe("sink-event", () => {
  it("链上事件没有任何出边 ⇒ warn", () => {
    const issues = diagnoseWithEvent(SINK_EVENT);
    const sink = issues.find((i) => i.rule === "sink-event" && i.subject === "ev:sink");
    expect(sink).toBeDefined();
    expect(sink!.level).toBe("warn");
    expect(sink!.message).toContain("ev:sink");
  });

  it("写了结局 / 终止条件读取的旗标 ⇒ 不算无出口", () => {
    const issues = diagnoseWithEvent(SINK_EVENT_WITH_ENDING);
    expect(issues.some((i) => i.rule === "sink-event" && i.subject === "ev:sink-ending")).toBe(false);
  });

  it("source=pool 的日常事件没有出边也不报", () => {
    const issues = diagnoseWithEvent(POOL_LEAF_EVENT);
    expect(issues.some((i) => i.rule === "sink-event" && i.subject === "ev:pool-leaf")).toBe(false);
  });
});
