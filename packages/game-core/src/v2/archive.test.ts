import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  EndingConfigSchema,
  EvaluationConfigSchema,
  type EndingRecord,
  type HistoryEntryV2,
  type WorldStateV2,
  type WorldTemplateV2,
} from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { createActiveWorldV2 } from "./test-utils.js";
import { markTerminated } from "./ending.js";
import { evaluateLifeV2 } from "./life-evaluation.js";
import { assembleArchive, assertWritable, markArchived } from "./archive.js";
import { worldStore } from "../../../../apps/server/src/store.js";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// 测试隔离：worldStore 现在会落盘（R-PS-03）。模块顶层把数据目录指向临时目录，
// 避免 worldStore 用例把测试世界写进仓库 data/worlds/（模块按文件顺序初始化，可靠）。
process.env.LIFE_SIM_DATA_DIR = mkdtempSync(path.join(tmpdir(), "life-sim-store-"));


// ---------- 夹具 ----------

function makeTemplate(): WorldTemplateV2 {
  return {
    meta: { id: "t", name: "归档测试", description: "d", startYear: 2000, engineProtocol: "v2" },
    time: { defaultStep: { value: 1, unit: "day" } },
    genders: [{ id: "f", label: "女" }],
    mood: {
      min: 0,
      max: 100,
      defaultValue: 60,
      bands: [{ id: "normal", label: "平静", min: 0, max: 100, attributeModifiers: {} }],
    },
    statusBar: [{ id: "sb1", label: "基本", source: "identity" }],
    attributes: { order: ["str"], defaults: { str: 5 } },
    resources: { hp: { base: 100, perLevel: 0 }, mp: { base: 50, perLevel: 0 } },
    regen: { perTurn: { hp: 0, mp: 0 } },
    characters: [],
    skills: [],
    items: [],
    statuses: [],
    events: [],
  };
}

function makeActive(worldId = "w1"): WorldStateV2 {
  return createActiveWorldV2({ templateId: "t", playerName: "测试者", seed: 1 }, makeTemplate(), worldId);
}

function pushHistory(state: WorldStateV2, id: string, type: HistoryEntryV2["type"] = "event"): void {
  state.history.push({ id, turnIndex: 0, worldTime: 0, formattedTime: "", type, summary: "经历" });
}

function makeEnding(): EndingRecord {
  return {
    endingId: "end-a",
    evidenceIds: ["h1"],
    title: "落幕",
    summary: "一生收束",
    narrativeSource: "template",
  };
}

const EXAMPLES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../specs/data/examples",
);

// ---------- T4-06 · 归档五类数据 ----------

describe("T4-06 · assembleArchive 五类数据齐全并置 archived=true", () => {
  it("最终快照 / 事件历史 / 结局 / 评价 / 终止记录齐全且可回顾", () => {
    const state = makeActive();
    pushHistory(state, "h1", "event");
    const terminated = markTerminated(state, {
      reason: "主目标完成", worldTime: 0, turnIndex: 0, source: "condition",
    });
    const ending = makeEnding();
    const evaluation = evaluateLifeV2(terminated);
    const template = makeTemplate();
    const lookup = createLookup(template);
    const before = structuredClone(terminated);
    const { state: archived, record } = assembleArchive(terminated, template, lookup, ending, evaluation);

    expect(archived.archived).toBe(true);
    // ① 最终快照
    expect(record.snapshot.worldId).toBe(state.id);
    expect(record.snapshot.evaluation.summary).toBe(evaluation.summary);
    // ② 事件历史
    expect(record.history.map((h) => h.id)).toContain("h1");
    // ③ 结局
    expect(record.ending.endingId).toBe("end-a");
    // ④ 评价
    expect(record.evaluation.dimensions.length).toBeGreaterThan(0);
    // ⑤ 终止记录
    expect(record.termination.reason).toBe("主目标完成");
    // 事件 id 可被评价证据引用
    const ids = new Set(record.history.map((h) => h.id));
    for (const d of record.evaluation.dimensions) {
      for (const id of d.evidenceIds) expect(ids.has(id)).toBe(true);
    }
    // 纯函数：入参逐字段不变
    expect(terminated).toEqual(before);
  });

  it("尚未终止的世界拒绝归档（可诊断错误）", () => {
    const template = makeTemplate();
    expect(() =>
      assembleArchive(makeActive(), template, createLookup(template), makeEnding(), evaluateLifeV2(makeActive())),
    ).toThrow(/archive_requires_termination/);
  });

  it("markArchived 幂等；已归档世界 assertWritable 拒绝写入", () => {
    const state = makeActive();
    const once = markArchived(state);
    expect(once.archived).toBe(true);
    expect(markArchived(once)).toBe(once);
    expect(state.archived).toBe(false);
    expect(() => assertWritable(state)).not.toThrow();
    expect(() => assertWritable(once)).toThrow(/ARCHIVED/);
  });
});

// ---------- 归档只读：worldStore.save ----------

describe("统一门禁 · worldStore.save 对已归档世界拒绝写入", () => {
  it("未归档世界 save 正常；已归档（store 内或传入状态）一律拒绝", () => {
    const template = makeTemplate();
    const world = worldStore.create({ templateId: "t", playerName: "测试者", seed: 1 }, template);
    expect(world.archived).toBe(false);
    expect(() => worldStore.save(world)).not.toThrow();

    // 直接置归档标记（模拟归档动作落在 store 持有的引用上）
    world.archived = true;
    expect(() => worldStore.save(world)).toThrow(/ARCHIVED/);
    // 即便传入一份未标记的新状态，store 内已归档也拒绝覆盖
    const cloned = { ...world, archived: false };
    expect(() => worldStore.save(cloned)).toThrow(/ARCHIVED/);
  });
});

// ---------- 样例 YAML 通过 Schema 校验 ----------

describe("模板样例 · endings.yaml / evaluation.yaml 校验", () => {
  it("两个样例文件均通过对应 Schema（含 HP 判据拒绝的兜底约束）", () => {
    const endings: unknown = parse(readFileSync(path.join(EXAMPLES, "endings.yaml"), "utf8"));
    const evaluation: unknown = parse(readFileSync(path.join(EXAMPLES, "evaluation.yaml"), "utf8"));
    expect(EndingConfigSchema.safeParse(endings).success).toBe(true);
    expect(EvaluationConfigSchema.safeParse(evaluation).success).toBe(true);
  });
});
