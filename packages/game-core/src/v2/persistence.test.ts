import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorldStateV2Schema, type WorldStateV2, type WorldTemplateV2 } from "@life-sim/shared";
import { advanceTurnV2 } from "./turn.js";
import { createLookup } from "./lookup.js";
import { loadPersistedWorlds, worldStore, dataDir } from "../../../../apps/server/src/store.js";

/**
 * 存档持久化（R-PS-01..07 / ADR-0007 / 协议 §21.2）。
 * 数据目录用 LIFE_SIM_DATA_DIR 指向临时目录，不污染仓库 data/。
 */

function makeTemplate(): WorldTemplateV2 {
  return {
    meta: { id: "t", name: "持久化", description: "d", startYear: 2000, engineProtocol: "v2" },
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
  } as unknown as WorldTemplateV2;
}

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "life-sim-store-"));
  process.env.LIFE_SIM_DATA_DIR = dataRoot;
});

afterEach(() => {
  delete process.env.LIFE_SIM_DATA_DIR;
  rmSync(dataRoot, { recursive: true, force: true });
});

function makeRealWorld(turns = 3): WorldStateV2 {
  const template = makeTemplate();
  const state = worldStore.create({ templateId: "t", playerName: "存档者", seed: 42 }, template);
  const lookup = createLookup(template);
  for (let i = 0; i < turns; i++) {
    const res = advanceTurnV2(state, { action: { type: "free", description: `行动 ${i}` } }, template, lookup);
    worldStore.save(res.state);
  }
  return state;
}

function readEnvelope(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(dataDir(), `${id}.json`), "utf-8"));
}

describe("数据目录（2026-11-11 用户裁决：不在 apps/server 下，可挂载）", () => {
  it("LIFE_SIM_DATA_DIR 覆盖生效", () => {
    expect(dataDir()).toBe(path.resolve(dataRoot));
  });
  it("缺省时解析到仓库根 data/worlds（与 cwd 无关）", () => {
    delete process.env.LIFE_SIM_DATA_DIR;
    expect(dataDir().replace(/\\/g, "/")).toMatch(/data\/worlds$/);
  });
});

describe("写入与信封（R-PS-01/03）", () => {
  it("create/save 落盘；信封字段齐全（schemaVersion=1 / savedAt / templateId / fingerprint / state）", () => {
    const state = makeRealWorld();
    const envelope = readEnvelope(state.id);
    expect(envelope.schemaVersion).toBe(1);
    expect(typeof envelope.savedAt).toBe("string");
    expect(envelope.templateId).toBe("t");
    expect(typeof envelope.templateFingerprint).toBe("string");
    expect(envelope.templateFingerprint).toMatch(/^sha256:/);
    expect((envelope.state as { id: string }).id).toBe(state.id);
    expect(existsSync(path.join(dataDir(), `${state.id}.json.tmp`))).toBe(false); // tmp 已被 rename
  });

  it("写失败（JSON.stringify 抛错）时旧文件完好、tmp 不残留", () => {
    const state = makeRealWorld();
    const before = readFileSync(path.join(dataDir(), `${state.id}.json`), "utf-8");
    const bad = structuredClone(state) as WorldStateV2;
    const flagRef: Record<string, unknown> = bad.flags;
    flagRef.self = flagRef; // 循环引用 → stringify 抛错（在 touch 文件之前）
    expect(() => worldStore.save(bad)).toThrow();
    expect(readFileSync(path.join(dataDir(), `${state.id}.json`), "utf-8")).toBe(before);
    expect(existsSync(path.join(dataDir(), `${state.id}.json.tmp`))).toBe(false);
  });
});

describe("加载校验（R-PS-02/05）", () => {
  function fingerprints(): Map<string, string> {
    return new Map([["t", "sha256:fp-t"]]);
  }

  it("真实快照通过 WorldStateV2Schema（双向类型断言在编译期守漂移）", () => {
    const state = makeRealWorld();
    expect(WorldStateV2Schema.safeParse(state).success).toBe(true);
  });

  it("故意改坏字段被拒并给出字段路径", () => {
    const state = makeRealWorld();
    const broken = structuredClone(state);
    delete (broken as unknown as Record<string, unknown>).seed;
    const parsed = WorldStateV2Schema.safeParse(broken);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.includes("seed"))).toBe(true);
    }
    const badVisibility = structuredClone(state);
    (badVisibility.history[0] as { visibility?: string }).visibility = "leaked";
    const parsed2 = WorldStateV2Schema.safeParse(badVisibility);
    expect(parsed2.success).toBe(false);
    if (!parsed2.success) {
      expect(parsed2.error.issues.some((i) => i.path.join(".").includes("history"))).toBe(true);
    }
  });

  it("合法档加载回内存逐字段相等；坏类档逐个跳过且不阻断（R-PS-05 三类）", () => {
    const state = makeRealWorld();
    // 合法档
    const good = loadPersistedWorlds(fingerprints());
    // 注意：指纹用 fp-t，而 persist 时 getTemplateFingerprint("t") 未加载模板 → sha256:unknown，
    // 因此这里按"指纹一致"路径测合法档需同指纹。构造手工信封绕开：
    void good;
    const envelope = readEnvelope(state.id) as { state: WorldStateV2; savedAt: string; templateId: string; templateFingerprint: string };
    const dir = dataDir();
    // 三类坏档
    writeFileSync(path.join(dir, "bad-truncated.json"), "{ \"schemaVersion\": 1, \"state\": {", "utf-8");
    writeFileSync(
      path.join(dir, "bad-version.json"),
      JSON.stringify({ ...envelope, schemaVersion: 99, state: { ...envelope.state, id: "w-bad-version" } }),
      "utf-8",
    );
    writeFileSync(
      path.join(dir, "bad-fingerprint.json"),
      JSON.stringify({ ...envelope, templateFingerprint: "sha256:stale", state: { ...envelope.state, id: "w-bad-fp" } }),
      "utf-8",
    );
    writeFileSync(
      path.join(dir, "bad-state.json"),
      JSON.stringify({ ...envelope, templateFingerprint: "sha256:fp-t", state: { ...envelope.state, id: "w-bad-state", turnIndex: -1 } }),
      "utf-8",
    );
    // 合法档（指纹与 fingerprints() 一致）
    writeFileSync(
      path.join(dir, `${state.id}.json`),
      JSON.stringify({ ...envelope, templateFingerprint: "sha256:fp-t" }),
      "utf-8",
    );
    const result = loadPersistedWorlds(fingerprints());
    expect(result.errors.map((e) => e.reason)).toEqual(
      expect.arrayContaining(["json_parse_failed", "schema_version_mismatch: 99", "template_fingerprint_mismatch"]),
    );
    expect(result.errors.some((e) => e.reason.startsWith("state_schema_invalid"))).toBe(true);
    const loaded = result.loaded.find((w) => w.id === state.id);
    expect(loaded).toBeDefined();
    expect(loaded).toEqual(envelope.state);
  });
});

describe("往返一致性（R-PS-07）", () => {
  it("落盘 → 读回 → schema 校验 → 逐字段相等（含 flags / chains / firedEvents / history）", () => {
    const state = makeRealWorld();
    const envelope = readEnvelope(state.id) as { state: WorldStateV2 };
    const parsed = WorldStateV2Schema.parse(envelope.state);
    expect(parsed).toEqual(state); // toEqual 忽略键序：逐字段值相等即往返无损
    // 关键字段不丢失、不补默认值
    expect(parsed.flags).toEqual(state.flags);
    expect(parsed.firedEvents).toEqual(state.firedEvents);
    expect(parsed.history.length).toBe(state.history.length);
    expect(parsed.player.inventory).toEqual(state.player.inventory);
  });
});

describe("归档与删除（R-PS-04/06）", () => {
  it("封存落盘（archived=true 进文件）；封存后 save 拒写（归档只读）", () => {
    const state = makeRealWorld();
    state.termination = { reason: "测试终止", worldTime: state.worldTime, turnIndex: state.turnIndex, source: "condition" };
    worldStore.save(state);
    const sealed = worldStore.seal(state);
    expect((readEnvelope(state.id) as { state: { archived: boolean } }).state.archived).toBe(true);
    expect(() => worldStore.save(sealed)).toThrow(/ARCHIVED/);
  });

  it("delete 删文件 + 删内存；重复删除报错", () => {
    const state = makeRealWorld();
    const file = path.join(dataDir(), `${state.id}.json`);
    expect(existsSync(file)).toBe(true);
    worldStore.delete(state.id);
    expect(existsSync(file)).toBe(false);
    expect(worldStore.get(state.id)).toBeUndefined();
    expect(() => worldStore.delete(state.id)).toThrow(/world_not_found/);
  });
});
