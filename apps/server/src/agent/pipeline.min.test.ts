import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { advanceTurnV2, createConditionRegistry, evaluateTriggers } from "@life-sim/game-core";
import { loadTemplates, type ReadyTemplateEntry, type TemplateScanLogger } from "../templates.js";
import { traceFile, worldStore } from "../store.js";
import { readNarrativeBlocks } from "../narrative/read.js";
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
  /** 模拟「模板没有 rules.yaml」的 Entry（`jjk-2006` 就是这种形状）。 */
  function withoutRules(template: ReadyTemplateEntry): ReadyTemplateEntry {
    const clone = { ...template } as ReadyTemplateEntry;
    delete (clone as { rules?: unknown }).rules;
    return clone;
  }

  it("无 provider 且模板无 rules.yaml ⇒ 返回 entry.pipeline 本身（真零回归）", () => {
    const world = worldStore.create({ templateId: "demo-agentic", playerName: "阿零" }, entry);
    const noRules = withoutRules(entry);
    expect(pipelineForTurn(world, noRules, undefined)).toBe(noRules.pipeline);
  });

  it("无 key 但模板有 rules.yaml ⇒ 注入 mock 网关（无 key 可跑）", () => {
    const world = worldStore.create({ templateId: "demo-agentic", playerName: "阿默" }, entry);
    const pipeline = pipelineForTurn(world, entry, undefined);
    expect(pipeline.gateway).toBeDefined();
    expect(pipeline.rules).toBe(entry.rules);
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

  it("mock 网关：flagSet 触发产出 invocation，正文/选项落 trace 且被 narrative 端点读回", async () => {
    const world = worldStore.create({ templateId: "demo-agentic", playerName: "阿触", seed: 11 }, entry);
    // 模板 task.completed 触发条件：flag "took-right"（rules.yaml 第 3 条）。
    world.flags["took-right"] = true;
    const pipeline = pipelineForTurn(world, entry, undefined);
    expect(pipeline.gateway).toBeDefined();

    const invocations = evaluateTriggers(
      world,
      entry.rules!,
      createConditionRegistry(),
      { seed: world.seed, turnIndex: world.turnIndex },
    );
    const completed = invocations.find((inv) => inv.reason === "task.completed");
    expect(completed).toBeDefined();
    // 触发链没有 unknown_reference 静默失败：三个内置 op 都已注册。
    expect(completed?.context.facts.perspective).toBe("world");

    await pipeline.gateway!.invoke(completed!);

    expect(existsSync(traceFile(world.id))).toBe(true);
    const blocks = readNarrativeBlocks(world.id, world);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((b) => b.kind === "narrative")).toBe(true);
    expect(blocks.some((b) => b.kind === "option")).toBe(true);
  });

  it("同种子两局：无 gateway 的结算结果与基线逐字段相等", () => {
    const command = { action: { type: "rest", description: "" }, mode: "single" as const };
    // 无 rules.yaml 的模板（如 jjk-2006）⇒ 不注入网关，管线配置与基线同源。
    const noRules = withoutRules(entry);
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
      pipelineForTurn(candidate, noRules, undefined),
    );
    const strip = (snapshot: typeof resA.snapshot) => ({ ...snapshot, worldId: "" });
    expect(strip(resB.snapshot)).toEqual(strip(resA.snapshot));
  });
});
