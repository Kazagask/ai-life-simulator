import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmTrace } from "@life-sim/shared";
import { loadTemplates, type ReadyTemplateEntry, type TemplateScanLogger } from "./templates.js";
import { appendTrace, dataDir, loadPersistedWorlds, traceFile, worldStore } from "./store.js";

/**
 * T-07 持久层最小集：
 * - `appendTrace` 真的落盘、逐行可解析、附加字段被丢弃（sanitisation 边界）；
 * - `persist()` 写 `traceRef` / `contentRef` / `assetFingerprint`；
 * - `schemaVersion !== 4` 仍走封闭拒载码（不迁移、不回填）。
 */

const silentLogger: TemplateScanLogger = { warn: () => {}, error: () => {}, info: () => {} };

const SPEC_TEMPLATES = fileURLToPath(new URL("../../../specs/data/templates", import.meta.url));

let dataDirPath: string;
let templatesDirPath: string;
let entry: ReadyTemplateEntry;
/** 无 `rules.yaml` 的模板（`jjk-2006`）：用来断「不种 DAG」的零回归那一半。 */
let legacyEntry: ReadyTemplateEntry;

beforeAll(() => {
  // 只复制用到的两个模板进临时模板根：别的模板目录可能正被其它 worker 编辑，
  // 启动期 fail-fast 会连坐（本测试只关心 store 持久层与建局种子）。
  templatesDirPath = mkdtempSync(path.join(tmpdir(), "life-sim-templates-"));
  for (const id of ["demo-agentic", "jjk-2006"]) {
    cpSync(path.join(SPEC_TEMPLATES, id), path.join(templatesDirPath, id), { recursive: true });
  }
  process.env.TEMPLATES_DIR = templatesDirPath;
  dataDirPath = mkdtempSync(path.join(tmpdir(), "life-sim-store-"));
  process.env.LIFE_SIM_DATA_DIR = dataDirPath;
  const registry = loadTemplates(silentLogger);
  const resolved = registry.resolve({ id: "demo-agentic", version: "1.0.0" });
  if (!resolved) throw new Error("demo-agentic@1.0.0 未加载");
  entry = resolved;
  const legacy = registry.resolve({ id: "jjk-2006", version: "1.0.0" });
  if (!legacy) throw new Error("jjk-2006@1.0.0 未加载");
  legacyEntry = legacy;
});

afterAll(() => {
  rmSync(dataDirPath, { recursive: true, force: true });
  rmSync(templatesDirPath, { recursive: true, force: true });
  delete process.env.TEMPLATES_DIR;
  delete process.env.LIFE_SIM_DATA_DIR;
});

function baseTrace(overrides: Partial<LlmTrace> = {}): LlmTrace {
  return {
    invocationId: "inv-1",
    turnIndex: 3,
    worldTime: 120,
    reason: "test.trace",
    contextHash: "ctx",
    toolProfile: "narrative",
    callsHash: "calls",
    receipts: [],
    diagnostics: [],
    inputTokens: 10,
    outputTokens: 20,
    latencyMs: 5,
    outcome: "committed",
    templateRef: "demo-agentic@1.0.0",
    contentBlocks: [
      {
        blockId: "b1",
        kind: "narrative",
        text: "正文",
        refs: [],
        visibility: "public",
        targetPerspective: "player",
      },
    ],
    ...overrides,
  };
}

describe("appendTrace", () => {
  it("追加写入 jsonl，逐行可解析", () => {
    const world = worldStore.create({ templateId: "demo-agentic", playerName: "阿追" }, entry);
    appendTrace(world.id, baseTrace({ invocationId: "a1" }));
    appendTrace(world.id, baseTrace({ invocationId: "a2", turnIndex: 4 }));

    const lines = readFileSync(traceFile(world.id), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) => JSON.parse(line) as LlmTrace);
    expect(parsed.map((t) => t.invocationId)).toEqual(["a1", "a2"]);
    expect(parsed[1]!.turnIndex).toBe(4);
  });

  it("附加字段（apiKey / prompt / raw）永不落盘", () => {
    const world = worldStore.create({ templateId: "demo-agentic", playerName: "阿追" }, entry);
    const leaky = {
      ...baseTrace({ invocationId: "leaky" }),
      apiKey: "sk-should-never-land",
      prompt: "完整 prompt",
    } as unknown as LlmTrace;
    appendTrace(world.id, leaky);

    const raw = readFileSync(traceFile(world.id), "utf8");
    expect(raw).toContain("leaky");
    expect(raw).not.toContain("sk-should-never-land");
    expect(raw).not.toContain("完整 prompt");
  });
});

describe("persist 信封字段", () => {
  it("写 traceRef / contentRef / assetFingerprint", () => {
    const world = worldStore.create({ templateId: "demo-agentic", playerName: "阿追" }, entry);
    world.traceRef = "trace:inv-42";
    worldStore.save(world);

    const envelope = JSON.parse(
      readFileSync(path.join(dataDir(), `${world.id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(envelope.schemaVersion).toBe(4);
    expect(envelope.traceRef).toBe("trace:inv-42");
    expect(envelope.contentRef).toBe("trace:inv-42");
    expect(envelope.assetFingerprint).toBe(entry.assetFingerprint);
    expect((envelope.state as Record<string, unknown>).traceRef).toBe("trace:inv-42");
  });

  it("没有 traceRef 时不写这两个字段", () => {
    const world = worldStore.create({ templateId: "demo-agentic", playerName: "阿追" }, entry);
    const envelope = JSON.parse(
      readFileSync(path.join(dataDir(), `${world.id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect("traceRef" in envelope).toBe(false);
    expect("contentRef" in envelope).toBe(false);
    expect(envelope.assetFingerprint).toBe(entry.assetFingerprint);
  });
});

describe("信封版本封闭拒载", () => {
  it("schemaVersion !== 4 ⇒ envelope_schema_version_unsupported", () => {
    const registry = loadTemplates(silentLogger);
    const bogusId = "legacy-world-0001";
    writeFileSync(
      path.join(dataDir(), `${bogusId}.json`),
      JSON.stringify({
        schemaVersion: 3,
        savedAt: "2026-01-01T00:00:00.000Z",
        templateId: "demo-agentic",
        templateVersion: "1.0.0",
        templateFingerprint: entry.semanticFingerprint,
        state: {},
      }),
      "utf8",
    );

    const { unloadable } = loadPersistedWorlds(registry);
    const rejected = unloadable.find((u) => u.id === bogusId);
    expect(rejected?.reason).toBe("envelope_schema_version_unsupported");
  });

  /**
   * 模板随时会被改（demo-agentic 本轮就补了开局 / 转盘 / 战斗三段）⇒ 以旧语义指纹落盘的存档
   * 必须走 `template_content_drift` 封闭拒载，且 detail 同时给出两个指纹便于诊断。
   */
  it("语义指纹不符 ⇒ template_content_drift（detail 含两侧指纹）", () => {
    const registry = loadTemplates(silentLogger);
    const world = worldStore.create({ templateId: "demo-agentic", playerName: "阿漂" }, entry);
    const file = path.join(dataDir(), `${world.id}.json`);
    const envelope = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    envelope.templateFingerprint = "sha256:stale-fingerprint-from-an-older-template";
    writeFileSync(file, JSON.stringify(envelope), "utf8");

    const { unloadable } = loadPersistedWorlds(registry);
    const rejected = unloadable.find((u) => u.id === world.id);
    expect(rejected?.reason).toBe("template_content_drift");
    expect(rejected?.detail).toContain("sha256:stale-fingerprint-from-an-older-template");
    expect(rejected?.detail).toContain(entry.semanticFingerprint);
  });

  /** `assetFingerprint` 只是展示完整性锚：变了 / 缺了都**不得**拒载（分叉③ A）。 */
  it("assetFingerprint 变化不参与拒载", () => {
    const registry = loadTemplates(silentLogger);
    const world = worldStore.create({ templateId: "demo-agentic", playerName: "阿立" }, entry);
    const file = path.join(dataDir(), `${world.id}.json`);
    const envelope = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    envelope.assetFingerprint = "sha256:completely-different-assets";
    writeFileSync(file, JSON.stringify(envelope), "utf8");

    const { unloadable, loaded } = loadPersistedWorlds(registry);
    expect(unloadable.find((u) => u.id === world.id)).toBeUndefined();
    expect(loaded.some((record) => record.state.id === world.id)).toBe(true);
  });
});

/**
 * ADR-0037 D1：建世界期必须把模板 `rules.fallbackDag` 种进 `state.taskDag`。
 *
 * 这条链的断点在生产调用点上（`store.ts` 的 `createWorldV2(...)` 少传第 5 参），
 * 所以两条都断：正向证明「有 rules ⇒ 种」；反向证明「无 rules ⇒ 逐字段停在空 DAG」。
 * 只断正向会漏掉「无条件种一个默认 DAG」这种改坏法（jjk-2006 会被凭空塞进节点）。
 */
describe("建局 taskDag 种子（ADR-0037 D1 / IO-10）", () => {
  it("demo-agentic（有 rules.yaml）⇒ 种入 fallbackDag：3 节点、dagId 为模板声明值", () => {
    const world = worldStore.create(
      { templateId: "demo-agentic", playerName: "阿种", seed: 3 },
      entry,
    );
    expect(world.taskDag.dagId).toBe("demo-agentic.fallback.v1");
    expect(world.taskDag.version).toBe(1);
    expect(world.taskDag.nodes).toHaveLength(3);
    expect(world.taskDag.nodes.map((n) => n.id)).toEqual(["n1.awaken", "n2.trial", "n3.hiddenSeed"]);
    // 种子是 structuredClone 进来的，不是 rules 里的对象引用（改动不得反写模板）。
    expect(world.taskDag.nodes[0]).not.toBe(entry.rules?.fallbackDag.nodes[0]);
  });

  it("jjk-2006（无 rules.yaml）⇒ taskDag 停在空 DAG，dagId 仍是 initial", () => {
    const world = worldStore.create(
      { templateId: "jjk-2006", playerName: "阿空", seed: 3 },
      legacyEntry,
    );
    expect(world.taskDag.dagId).toBe("initial");
    expect(world.taskDag.nodes).toHaveLength(0);
    expect(world.taskDag.edges).toHaveLength(0);
  });
});
