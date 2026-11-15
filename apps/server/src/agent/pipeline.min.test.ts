import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { advanceTurnV2 } from "@life-sim/game-core";
import { loadTemplates, type ReadyTemplateEntry, type TemplateScanLogger } from "../templates.js";
import { worldStore } from "../store.js";
import { pipelineForTurn, resolveAgentConfig } from "./pipeline.js";

/**
 * T-11 接线最小集：**无 provider 时零回归**。
 * 判据两条：
 * ① `pipelineForTurn(..., undefined)` 返回 `entry.pipeline` 本身（同一引用 ⇒ 配置逐字段不变）；
 * ② 同种子两局在同一 command 下结算，快照除 worldId 外逐字段相等。
 */

const silentLogger: TemplateScanLogger = { warn: () => {}, error: () => {}, info: () => {} };
const SPEC_TEMPLATES = fileURLToPath(
  new URL("../../../../specs/data/templates", import.meta.url),
);

let dataDirPath: string;
let templatesDirPath: string;
let entry: ReadyTemplateEntry;

beforeAll(() => {
  templatesDirPath = mkdtempSync(path.join(tmpdir(), "life-sim-templates-"));
  cpSync(path.join(SPEC_TEMPLATES, "demo-agentic"), path.join(templatesDirPath, "demo-agentic"), {
    recursive: true,
  });
  process.env.TEMPLATES_DIR = templatesDirPath;
  dataDirPath = mkdtempSync(path.join(tmpdir(), "life-sim-agent-"));
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

describe("resolveAgentConfig", () => {
  it("无凭证且 env 不齐 ⇒ undefined（mock 路径）", () => {
    expect(resolveAgentConfig(undefined, {})).toBeUndefined();
    expect(resolveAgentConfig(undefined, { model: "m" })).toBeUndefined();
  });

  it("用户凭证齐备 ⇒ 三要素（baseUrl 缺省走默认端点）", () => {
    const cfg = resolveAgentConfig({ model: "m1", apiKey: "k1" }, {});
    expect(cfg?.model).toBe("m1");
    expect(cfg?.apiKey).toBe("k1");
    expect(cfg?.baseUrl).toMatch(/^https?:\/\//);
  });

  it("env 三项齐备 ⇒ 采用 env", () => {
    const cfg = resolveAgentConfig(undefined, {
      baseUrl: "https://llm.example/v1",
      model: "m2",
      apiKey: "k2",
    });
    expect(cfg).toEqual({ baseUrl: "https://llm.example/v1", model: "m2", apiKey: "k2" });
  });
});

describe("pipelineForTurn", () => {
  it("无 provider ⇒ 返回 entry.pipeline 本身（零回归）", () => {
    const world = worldStore.create({ templateId: "demo-agentic", playerName: "阿零" }, entry);
    expect(pipelineForTurn(world, entry, undefined)).toBe(entry.pipeline);
  });

  it("有 provider ⇒ 注入 gateway + rules + 双视角", () => {
    const world = worldStore.create({ templateId: "demo-agentic", playerName: "阿接" }, entry);
    const pipeline = pipelineForTurn(world, entry, {
      baseUrl: "https://llm.example/v1",
      model: "m",
      apiKey: "k",
    });
    expect(pipeline.gateway).toBeDefined();
    expect(pipeline.rules).toBe(entry.rules);
    expect(pipeline.perspective).toBe("world");
    expect(pipeline.targetPerspective).toBe("player");
    // 结局 / 评价配置逐字段继承
    expect(pipeline.endingConfig).toBe(entry.pipeline.endingConfig);
    expect(pipeline.evaluationConfig).toBe(entry.pipeline.evaluationConfig);
  });

  it("同种子两局：无 gateway 的结算结果与基线逐字段相等", () => {
    const command = { action: { type: "rest", description: "" }, mode: "single" as const };
    const baseline = worldStore.create(
      { templateId: "demo-agentic", playerName: "阿基", seed: 7 },
      entry,
    );
    const candidate = worldStore.create(
      { templateId: "demo-agentic", playerName: "阿基", seed: 7 },
      entry,
    );
    const resA = advanceTurnV2(
      baseline,
      command,
      entry.template,
      entry.lookup,
      undefined,
      entry.pipeline,
    );
    const resB = advanceTurnV2(
      candidate,
      command,
      entry.template,
      entry.lookup,
      undefined,
      pipelineForTurn(candidate, entry, undefined),
    );
    const strip = (snapshot: typeof resA.snapshot) => ({ ...snapshot, worldId: "" });
    expect(strip(resB.snapshot)).toEqual(strip(resA.snapshot));
  });
});
