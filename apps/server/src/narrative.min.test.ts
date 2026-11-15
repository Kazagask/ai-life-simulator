import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmTrace } from "@life-sim/shared";
import { loadTemplates, type ReadyTemplateEntry, type TemplateScanLogger } from "./templates.js";
import { appendTrace, traceFile, worldStore } from "./store.js";
import { recordNarrative } from "./narrative/trace.js";
import { parseTraceLines, projectNarrativeBlocks, readNarrativeBlocks } from "./narrative/read.js";

/**
 * T-07 读侧 / F3 写入侧最小集：
 * - 只返回 `ContentBlockVM`，hidden / world 窗口块、引用越窗的块**整块消失**；
 * - 无 trace 文件 ⇒ `blocks: []`；
 * - `recordNarrative` 走 dispatch 落 trace 并铸造 traceRef。
 */

const silentLogger: TemplateScanLogger = { warn: () => {}, error: () => {}, info: () => {} };
const SPEC_TEMPLATES = fileURLToPath(new URL("../../../specs/data/templates", import.meta.url));

let dataDirPath: string;
let templatesDirPath: string;
let entry: ReadyTemplateEntry;

beforeAll(() => {
  templatesDirPath = mkdtempSync(path.join(tmpdir(), "life-sim-templates-"));
  cpSync(path.join(SPEC_TEMPLATES, "demo-agentic"), path.join(templatesDirPath, "demo-agentic"), {
    recursive: true,
  });
  process.env.TEMPLATES_DIR = templatesDirPath;
  dataDirPath = mkdtempSync(path.join(tmpdir(), "life-sim-narrative-"));
  process.env.LIFE_SIM_DATA_DIR = dataDirPath;
  const registry = loadTemplates(silentLogger);
  const resolved = registry.resolve({ id: "demo-agentic", version: "1.0.0" });
  if (!resolved) throw new Error("demo-agentic@1.0.0 未加载");
  entry = resolved;
});

afterAll(() => {
  rmSync(dataDirPath, { recursive: true, force: true });
  rmSync(templatesDirPath, { recursive: true, force: true });
  delete process.env.TEMPLATES_DIR;
  delete process.env.LIFE_SIM_DATA_DIR;
});

function newWorld(name: string) {
  return worldStore.create({ templateId: "demo-agentic", playerName: name }, entry);
}

function traceWith(
  overrides: Partial<LlmTrace>,
  blocks: NonNullable<LlmTrace["contentBlocks"]>,
): LlmTrace {
  return {
    invocationId: "inv-x",
    turnIndex: 1,
    worldTime: 60,
    reason: "test",
    contextHash: "c",
    toolProfile: "narrative",
    callsHash: "h",
    receipts: [],
    diagnostics: [],
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    outcome: "committed",
    templateRef: "demo-agentic@1.0.0",
    contentBlocks: blocks,
    ...overrides,
  };
}

describe("player 窗口投影", () => {
  it("hidden 块、world 窗口块、越窗 ref 块都整块消失", () => {
    const world = newWorld("阿读");
    // 玩家台账里只授予一个事实；另一条事实只存在于世界侧，player 看不见。
    world.observationLedger.player = [
      { factRef: "flag:known", level: "known", source: "rule", sinceTurn: 0 },
    ];

    appendTrace(
      world.id,
      traceWith({ invocationId: "t1", turnIndex: 2 }, [
        {
          blockId: "ok",
          kind: "narrative",
          text: "可见正文",
          refs: ["flag:known"],
          visibility: "public",
          targetPerspective: "player",
        },
        {
          blockId: "hidden",
          kind: "narrative",
          text: "隐秘正文",
          refs: [],
          visibility: "hidden",
          targetPerspective: "player",
          maskText: "被掩码的文案",
        },
        {
          blockId: "world-only",
          kind: "narrative",
          text: "world 正文",
          refs: [],
          visibility: "public",
          targetPerspective: "world",
        },
        {
          blockId: "leaky-ref",
          kind: "narrative",
          text: "引用了玩家看不见的事实",
          refs: ["flag:secret"],
          visibility: "public",
          targetPerspective: "player",
        },
      ]),
    );

    const blocks = readNarrativeBlocks(world.id, world);
    expect(blocks).toEqual([{ blockId: "ok", kind: "narrative", text: "可见正文" }]);
    // maskText 绝不下发
    expect(JSON.stringify(blocks)).not.toContain("被掩码的文案");
    expect(JSON.stringify(blocks)).not.toContain("隐秘正文");
    expect(JSON.stringify(blocks)).not.toContain("world 正文");
  });

  it("没有 trace 文件 ⇒ 空列表", () => {
    const world = newWorld("阿空");
    expect(readNarrativeBlocks(world.id, world)).toEqual([]);
  });

  it("fromTurn 过滤掉更早的轮次", () => {
    const world = newWorld("阿早");
    const block = (id: string, text: string) => ({
      blockId: id,
      kind: "narrative" as const,
      text,
      refs: [],
      visibility: "public" as const,
      targetPerspective: "player" as const,
    });
    appendTrace(world.id, traceWith({ invocationId: "early", turnIndex: 1 }, [block("b1", "早期")]));
    appendTrace(world.id, traceWith({ invocationId: "late", turnIndex: 5 }, [block("b2", "后期")]));

    expect(readNarrativeBlocks(world.id, world, 4).map((b) => b.blockId)).toEqual(["b2"]);
    expect(readNarrativeBlocks(world.id, world).map((b) => b.blockId)).toEqual(["b1", "b2"]);
  });

  it("损坏行被跳过，不影响其余行", () => {
    const traces = parseTraceLines('{"bad json\nnot json at all\n');
    expect(traces).toEqual([]);
    expect(projectNarrativeBlocks(newWorld("阿坏"), traces)).toEqual([]);
  });
});

describe("F3 写入侧 recordNarrative", () => {
  it("正文落 trace、state 只留 traceRef", () => {
    const world = newWorld("阿写");
    const traceRef = recordNarrative(world, entry, {
      reason: "ending.narrative",
      blocks: [{ blockId: "ending:end-1", kind: "narrative", text: "落幕\n\n一生收束" }],
    });

    expect(world.traceRef).toBeDefined();
    expect(traceRef).toBe(world.traceRef);
    const firstLine = JSON.parse(
      readFileSync(traceFile(world.id), "utf8").split("\n")[0]!,
    ) as LlmTrace;
    expect(world.traceRef).toBe(`trace:${firstLine.invocationId}`);
    expect(firstLine.contentBlocks?.[0]?.text).toBe("落幕\n\n一生收束");

    const blocks = readNarrativeBlocks(world.id, world);
    expect(blocks).toEqual([
      { blockId: "ending:end-1", kind: "narrative", text: "落幕\n\n一生收束" },
    ]);
    // 正文字段绝不进 WorldStateV2
    expect(JSON.stringify(world)).not.toContain("一生收束");
  });
});
