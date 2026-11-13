import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorldStateV2 } from "@life-sim/shared";
import { loadPersistedWorlds, worldStore } from "../../../../apps/server/src/store.js";
import {
  loadTemplates,
  type ReadyTemplateEntry,
  type TemplateRegistry,
  type TemplateScanLogger,
} from "../../../../apps/server/src/templates.js";

/**
 * R2.8 · T-TG-08 核心：**旧档迁移四格矩阵**（R-TG-10 AC④ / R-TG-15 AC⑨ / R-TG-08 AC④）。
 *
 * 为什么必须用「固化夹具 + 临时目录」而不是 `data/worlds`：
 *   - `data/worlds` 会被冒烟与手工测试改变（本轮已 65 → 67 又被删改过），把它当基线等于
 *     把验收结论挂在一个随时会动的目录上（tasks.md「口径澄清」第 3 条明令禁止）；
 *   - 夹具在此**当场生成**（create + 2 回合，seed 固定 ⇒ 同输入同结果），落盘到 `os.tmpdir()`
 *     下的临时 `LIFE_SIM_DATA_DIR` / `TEMPLATES_DIR`，**绝不读写仓库的 `data/worlds` 与
 *     `specs/data/templates`**（后者只读复制）。
 *
 * 四格矩阵（每格的「迁移前基线」只作一次性留档，**不进 CI 断言**；CI 断言的是「迁移后绝对期望」）：
 *
 * | 格 | 夹具 | 迁移前（旧 loader，一次性留档） | 迁移后（CI 断言） |
 * |---|---|---|---|
 * | 正 1 | `schemaVersion=2` + `templateVersion="1.0.0"` | 载入成功 | 载入成功；`state` 深比较相等；信封**逐字节不变**（无回填） |
 * | 正 2 | `schemaVersion=2` + **无** `templateVersion` | 载入成功（旧 loader 不读该字段） | 载入成功；信封**新增** `templateVersion`；`state` 深比较不变；`archived` 不变 |
 * | 负 1 | 信封指纹 ≠ 当前语义指纹 | 拒载（`template_content_drift`） | 拒载，`reason = template_content_drift`，`detail` 含 `(id,version)` |
 * | 负 2 | `templateVersion="9.9.9"`（无该版本目录） | **N/A**——旧 loader 不读 `templateVersion`，会载入成功 | 拒载，`reason = template_version_missing`（**基线 = N/A**，不得写成前后一致） |
 *
 * 正样本的 `templateFingerprint` **在 setup 时按当前模板实时计算**（白名单 11 个 yaml、按文件名
 * 排序、拼 `name + "\0" + content` 的 sha256，本文件**独立实现**、不 import 服务端的 hashPairs），
 * 不写死常量——模板一改，写死的常量会让整格变红。只有负 1 用「故意不匹配」的常量。
 *
 * 回归判据（四类，任一命中即判回归）：
 *   ① 原本被拒载的格现在被接受 ⇒ 回归（fail-open）；
 *   ② 正样本载不进来 ⇒ 回归；
 *   ③ 任一格相对自身基线的差异**无法归入「新增拒绝」或「原因细分」** ⇒ 回归；
 *   ④ 无基线格（负 2）未满足绝对期望 ⇒ 回归。
 *   「新增拒绝」与「原因细分」**不算**回归（fail-closed：多拒一个比少拒一个安全）。
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REAL_TEMPLATES_DIR = path.join(REPO_ROOT, "specs", "data", "templates");
const TEMPLATE_ID = "jjk-2006";
const VERSION = "1.0.0";

/** R-TG-15 / H-2.1：唯一进语义指纹的 11 个白名单文件名。 */
const WHITELIST = [
  "world.yaml",
  "characters.yaml",
  "skills.yaml",
  "items.yaml",
  "statuses.yaml",
  "events.yaml",
  "equipment.yaml",
  "combat-ai.yaml",
  "opening.yaml",
  "endings.yaml",
  "evaluation.yaml",
] as const;

/** 负 1 专用的「故意不匹配」常量（其余任何指纹都实时算）。 */
const DELIBERATELY_WRONG_FINGERPRINT = `sha256:${"deadbeef".repeat(8)}`;

interface LogLine {
  level: "warn" | "error" | "info";
  msg: string;
  obj: Record<string, unknown>;
}

function makeLogging(): { lines: LogLine[]; logger: TemplateScanLogger } {
  const lines: LogLine[] = [];
  return {
    lines,
    logger: {
      warn: (obj, msg) => lines.push({ level: "warn", msg, obj }),
      error: (obj, msg) => lines.push({ level: "error", msg, obj }),
      info: (obj, msg) => lines.push({ level: "info", msg, obj }),
    },
  };
}

/**
 * 独立实现 H-2.1（**不 import 服务端 `hashPairs`**）：白名单 11 个 yaml 按文件名排序，
 * 逐个 update `文件名 + "\0" + 内容`，取 sha256。路径不参与 ⇒ 目录迁移不改指纹。
 */
function semanticFingerprintOf(versionDir: string): string {
  const hash = createHash("sha256");
  for (const name of [...WHITELIST].sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(path.join(versionDir, name), "utf-8"));
  }
  return `sha256:${hash.digest("hex")}`;
}

interface Envelope {
  schemaVersion: number;
  savedAt: string;
  templateId: string;
  templateVersion?: string;
  templateFingerprint: string;
  state: WorldStateV2 & { id: string };
}

function readEnvelope(file: string): Envelope {
  return JSON.parse(readFileSync(file, "utf-8")) as Envelope;
}

let root: string;
let templatesDir: string;
let worldsDir: string;
let scratchDir: string;
let registry: TemplateRegistry;
let entry: ReadyTemplateEntry;
/** 当前模板的实时语义指纹（setup 计算，不写死）。 */
let currentFingerprint: string;
/** 固化的世界状态（create + 2 回合，seed 固定）。 */
let fixtureState: WorldStateV2;
/** 建局时服务端写出的信封（savedAt 等取它，保证夹具与真实落盘同形）。 */
let baseEnvelope: Envelope;

let logs: LogLine[];

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "r28-migration-"));
  templatesDir = path.join(root, "templates");
  worldsDir = path.join(root, "worlds");
  scratchDir = path.join(root, "_scratch");
  mkdirSync(worldsDir, { recursive: true });
  mkdirSync(scratchDir, { recursive: true });
  // 只读复制真实模板到临时根目录：仓库 specs/data/templates 不被改动。
  cpSync(path.join(REAL_TEMPLATES_DIR, TEMPLATE_ID), path.join(templatesDir, TEMPLATE_ID), {
    recursive: true,
  });

  currentFingerprint = semanticFingerprintOf(path.join(templatesDir, TEMPLATE_ID, VERSION));

  const made = makeLogging();
  logs = made.lines;
  process.env.TEMPLATES_DIR = templatesDir;
  // 建局需要落盘：先指向独立 scratch 目录，取到信封后立刻删掉，不污染本文件的 worldsDir。
  process.env.LIFE_SIM_DATA_DIR = scratchDir;
  registry = loadTemplates(made.logger);
  const resolved = registry.resolve({ id: TEMPLATE_ID, version: VERSION });
  expect(resolved).toBeDefined();
  entry = resolved!;

  // 建局用的 Entry 指纹必须与「独立实现」算出的一致（服务端 hashPairs ≡ H-2.1）。
  expect(entry.semanticFingerprint).toBe(currentFingerprint);

  const created = worldStore.create(
    {
      templateId: TEMPLATE_ID,
      playerName: "四格夹具",
      seed: 20261113,
      openingId: "op-2006-tokyo",
    },
    entry,
  );
  const createdFile = path.join(scratchDir, `${created.id}.json`);
  baseEnvelope = readEnvelope(createdFile);

  // 让夹具带上开局结算后的真实内容（flags / history / scheduledEvents / 待决事件），
  // 而不是一个手搓的最小对象——但仍然**完全确定性**（seed 固定、无真实时间）。
  fixtureState = JSON.parse(JSON.stringify(created)) as WorldStateV2;
  worldStore.delete(created.id);
});

afterAll(() => {
  delete process.env.TEMPLATES_DIR;
  delete process.env.LIFE_SIM_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  // 每格独立目录：`loadPersistedWorlds` 会回填信封（正 2），不能跨格复用文件。
  rmSync(worldsDir, { recursive: true, force: true });
  mkdirSync(worldsDir, { recursive: true });
  process.env.LIFE_SIM_DATA_DIR = worldsDir;
});

interface FixtureOptions {
  /** `undefined` ⇒ 写 `"1.0.0"`；`null` ⇒ **不写**该字段（旧档形态）。 */
  templateVersion?: string | null;
  templateFingerprint?: string;
}

/**
 * 写一份夹具档：文件名 = 世界 id（与 store 的 `worldFile()` 同口径——拒载条目的 `id`
 * 取的是**文件名基名**，不是 `state.id`，所以两者必须一致，否则断言会指错对象）。
 */
function writeFixture(worldId: string, options: FixtureOptions = {}): string {
  const envelope: Record<string, unknown> = {
    schemaVersion: 2,
    savedAt: baseEnvelope.savedAt,
    templateId: TEMPLATE_ID,
    templateFingerprint: options.templateFingerprint ?? currentFingerprint,
    state: { ...fixtureState, id: worldId },
  };
  const version = options.templateVersion === undefined ? VERSION : options.templateVersion;
  if (version !== null) envelope.templateVersion = version;
  const file = path.join(worldsDir, `${worldId}.json`);
  writeFileSync(file, JSON.stringify(envelope, null, 2), "utf-8");
  return file;
}

describe("四格矩阵 · 正 1：有 templateVersion ⇒ 载入成功、state 深比较相等、信封不改写", () => {
  it("loaded[0].state 与夹具深比较相等，且信封逐字节不变（无回填）", () => {
    const file = writeFixture("w-pos-1", { templateVersion: VERSION });
    const before = readFileSync(file, "utf-8");

    const result = loadPersistedWorlds(registry);

    expect(result.unloadable).toEqual([]);
    const loaded = result.loaded.find((r) => r.state.id === "w-pos-1");
    expect(loaded).toBeDefined();
    expect(loaded!.state).toEqual({ ...fixtureState, id: "w-pos-1" });
    expect(loaded!.entry.ref).toEqual({ id: TEMPLATE_ID, version: VERSION });
    expect(readFileSync(file, "utf-8")).toBe(before);
  });
});

describe("四格矩阵 · 正 2：无 templateVersion（旧档）⇒ 唯一性推断 + 回填，state 与 archived 不变", () => {
  it("载入成功；信封新增 templateVersion；state 深比较不变；archived 不变", () => {
    const file = writeFixture("w-pos-2", { templateVersion: null });
    const before = readEnvelope(file);
    expect("templateVersion" in before).toBe(false);
    const archivedBefore = before.state.archived;

    const result = loadPersistedWorlds(registry);

    expect(result.unloadable).toEqual([]);
    const loaded = result.loaded.find((r) => r.state.id === "w-pos-2");
    expect(loaded).toBeDefined();
    expect(loaded!.state).toEqual({ ...fixtureState, id: "w-pos-2" });

    const after = readEnvelope(file);
    // 回填只加这一个字段：其余键逐个相等（含 state 与 savedAt 原文）
    expect(after.templateVersion).toBe(VERSION);
    expect({ ...after, templateVersion: undefined }).toEqual({ ...before, templateVersion: undefined });
    expect(after.state).toEqual(before.state);
    expect(after.state.archived).toBe(archivedBefore);
    expect(after.templateFingerprint).toBe(currentFingerprint);
  });
});

describe("四格矩阵 · 负 1：信封指纹与当前语义指纹不符 ⇒ template_content_drift", () => {
  it("拒载，reason = template_content_drift，detail 含 (id,version)；信封不被改写", () => {
    const file = writeFixture("w-neg-1", { templateFingerprint: DELIBERATELY_WRONG_FINGERPRINT });
    const before = readFileSync(file, "utf-8");

    const result = loadPersistedWorlds(registry);

    expect(result.loaded).toEqual([]);
    expect(result.unloadable).toHaveLength(1);
    const rejected = result.unloadable[0]!;
    expect(rejected.reason).toBe("template_content_drift");
    expect(rejected.templateId).toBe(TEMPLATE_ID);
    expect(rejected.templateVersion).toBe(VERSION);
    expect(rejected.detail).toContain(`${TEMPLATE_ID}@${VERSION}`);
    // 「码 + 具体对象」：同时给出信封值与磁盘值
    expect(rejected.detail).toContain(DELIBERATELY_WRONG_FINGERPRINT);
    expect(rejected.detail).toContain(currentFingerprint);
    expect(readFileSync(file, "utf-8")).toBe(before);
  });
});

describe("四格矩阵 · 负 2：templateVersion 指向不存在的版本目录 ⇒ template_version_missing（基线 N/A）", () => {
  it("拒载，reason = template_version_missing，detail 指明缺失的版本目录", () => {
    // ⚠️ 本格的「迁移前基线 = N/A」：旧 loader 不读 templateVersion，会正常载入。
    // 所以这一格**不存在**「迁移前后一致」这种断言，只有「迁移后的绝对期望」。
    writeFixture("w-neg-2", { templateVersion: "9.9.9" });

    const result = loadPersistedWorlds(registry);

    expect(result.loaded).toEqual([]);
    expect(result.unloadable).toHaveLength(1);
    const rejected = result.unloadable[0]!;
    expect(rejected.reason).toBe("template_version_missing");
    expect(rejected.templateId).toBe(TEMPLATE_ID);
    expect(rejected.templateVersion).toBe("9.9.9");
    expect(rejected.detail).toContain(`<version>=9.9.9 目录不存在`);
  });
});

describe("四格矩阵 · 同批运行（一次载入四格，逐格断言 + 打印实际结果）", () => {
  it("四格判定互不串扰，结果向量与期望完全一致", () => {
    writeFixture("w-pos-1", { templateVersion: VERSION });
    writeFixture("w-pos-2", { templateVersion: null });
    writeFixture("w-neg-1", { templateFingerprint: DELIBERATELY_WRONG_FINGERPRINT });
    writeFixture("w-neg-2", { templateVersion: "9.9.9" });

    const result = loadPersistedWorlds(registry);

    const loadedIds = result.loaded.map((r) => r.state.id).sort();
    const rejectRows = result.unloadable
      .map((u) => ({ id: u.id, reason: u.reason, version: u.templateVersion }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));

    const table = [
      "格 | 夹具 | 结果 | reason",
      "正 1 | 有 templateVersion | 载入成功 | -",
      "正 2 | 无 templateVersion | 载入成功（已回填） | -",
      "负 1 | 指纹不符 | 拒载 | template_content_drift",
      "负 2 | 版本目录缺失 | 拒载 | template_version_missing",
      "--- 实际 ---",
      `loaded = ${JSON.stringify(loadedIds)}`,
      ...rejectRows.map((r) => `${r.id} → ${r.reason} (version=${String(r.version)})`),
    ].join("\n");
    console.log(`\n[四格矩阵实际运行结果]\n${table}\n`);

    expect(loadedIds).toEqual(["w-pos-1", "w-pos-2"]);
    expect(rejectRows).toEqual([
      { id: "w-neg-1", reason: "template_content_drift", version: "1.0.0" },
      { id: "w-neg-2", reason: "template_version_missing", version: "9.9.9" },
    ]);
    // 正 2 的档在本批运行里已被回填
    expect(readEnvelope(path.join(worldsDir, "w-pos-2.json")).templateVersion).toBe(VERSION);
  });
});

describe("R-TG-10 · 其余封闭原因码（缺模板三形态 + 歧义）", () => {
  it("template_missing：<id> 目录不存在", () => {
    const file = writeFixture("w-missing-id");
    const env = readEnvelope(file);
    writeFileSync(
      file,
      JSON.stringify({ ...env, templateId: "no-such-template" }, null, 2),
      "utf-8",
    );

    const result = loadPersistedWorlds(registry);

    expect(result.unloadable[0]!.reason).toBe("template_missing");
    expect(result.unloadable[0]!.detail).toContain("no-such-template");
  });

  it("template_version_ambiguous：手放第二个版本 + 信封无 templateVersion ⇒ 歧义（且先定版本、不比指纹）", () => {
    const secondDir = path.join(templatesDir, TEMPLATE_ID, "2.0.0");
    cpSync(path.join(templatesDir, TEMPLATE_ID, VERSION), secondDir, { recursive: true });
    try {
      // 新增版本目录由请求驱动热加载登记（不重启进程）
      expect(registry.versionsOf(TEMPLATE_ID).map((v) => v.ref.version).sort()).toEqual([
        "1.0.0",
        "2.0.0",
      ]);

      // AC② 反向用例：**两个版本都不匹配信封指纹**时，仍必须归 template_version_ambiguous，
      // 不得归 template_content_drift —— 因为「先定版本、再比指纹」，到不了比指纹那一步。
      writeFixture("w-ambiguous", {
        templateVersion: null,
        templateFingerprint: DELIBERATELY_WRONG_FINGERPRINT,
      });

      const result = loadPersistedWorlds(registry);

      expect(result.loaded).toEqual([]);
      expect(result.unloadable[0]!.reason).toBe("template_version_ambiguous");
      expect(result.unloadable[0]!.detail).toContain("2 个版本");
      expect(result.unloadable[0]!.detail).toContain("1.0.0");
      expect(result.unloadable[0]!.detail).toContain("2.0.0");
    } finally {
      rmSync(secondDir, { recursive: true, force: true });
      registry.ensureFresh();
      expect(registry.versionsOf(TEMPLATE_ID).map((v) => v.ref.version)).toEqual([VERSION]);
    }
  });

  it("template_invalid：注册表里 status='invalid' 的版本 ⇒ 该码（附 reachability 说明）", () => {
    // ⚠️ 可达性说明（验收报告已登记为 P2 观察项）：生产路径上 loadPersistedWorlds 只在启动期
    // 调一次，而启动期 scanAll(failFast=true) 遇坏模板会先 throw —— 所以「目录在但加载失败」
    // 在真实启动链上**不可达**，本码是防御性分支。此处用手工注册表证明「映射关系正确」，
    // 不等于证明「生产可触发」。
    const stub = {
      dir: "<stub>",
      ensureFresh: () => {},
      idExists: (id: string) => id === TEMPLATE_ID,
      versionDirExists: () => true,
      get: () => ({
        ref: { id: TEMPLATE_ID, version: VERSION },
        status: "invalid" as const,
        reason: `${TEMPLATE_ID}@${VERSION}: world.yaml: meta.id (x) 与模板目录名 (${TEMPLATE_ID}) 不一致`,
        mtime: 0,
      }),
      resolve: () => undefined,
      versionsOf: () => [],
      listTemplates: () => [],
      diagnostics: () => ({ statCount: 0, rescanCount: 0 }),
    };
    writeFixture("w-invalid");

    const result = loadPersistedWorlds(stub);

    expect(result.unloadable[0]!.reason).toBe("template_invalid");
    expect(result.unloadable[0]!.detail).toContain("meta.id");
  });

  it("原因码是封闭枚举：任意一次载入的 reason 只可能来自 8 个码", () => {
    const CLOSED = [
      "envelope_json_invalid",
      "envelope_schema_version_unsupported",
      "template_missing",
      "template_version_missing",
      "template_version_ambiguous",
      "template_invalid",
      "template_content_drift",
      "world_state_invalid",
    ];
    writeFixture("w-neg-1", { templateFingerprint: DELIBERATELY_WRONG_FINGERPRINT });
    writeFixture("w-neg-2", { templateVersion: "9.9.9" });
    writeFileSync(path.join(worldsDir, "bad-json.json"), "{ \"schemaVersion\": 2,", "utf-8");
    writeFileSync(path.join(worldsDir, "bad-version.json"), JSON.stringify({ schemaVersion: 1 }), "utf-8");
    const noId = readEnvelope(writeFixture("w-no-id"));
    writeFileSync(
      path.join(worldsDir, "w-no-id.json"),
      JSON.stringify({ ...noId, templateId: "" }, null, 2),
      "utf-8",
    );
    const badState = readEnvelope(writeFixture("w-bad-state"));
    writeFileSync(
      path.join(worldsDir, "w-bad-state.json"),
      JSON.stringify({ ...badState, state: { ...badState.state, turnIndex: -1 } }, null, 2),
      "utf-8",
    );

    const result = loadPersistedWorlds(registry);
    const reasons = result.unloadable.map((u) => u.reason);

    expect(reasons.every((r) => CLOSED.includes(r))).toBe(true);
    expect(reasons).toEqual(
      expect.arrayContaining([
        "envelope_json_invalid",
        "envelope_schema_version_unsupported",
        "template_missing",
        "template_content_drift",
        "template_version_missing",
        "world_state_invalid",
      ]),
    );
    // 每条拒绝都必须同时带「码 + 具体对象」
    for (const u of result.unloadable) expect(u.detail.length).toBeGreaterThan(0);
  });
});

describe("R-TG-01 AC④：模板身份取自**目录名**（yaml 里的 `meta.id` 不参与身份判定）", () => {
  it("把同一份模板放进 `renamed-tpl/1.0.0` 并把 meta.id 同步改名 ⇒ world.templateId = renamed-tpl", () => {
    const renamedRoot = path.join(templatesDir, "renamed-tpl");
    const renamedVersionDir = path.join(renamedRoot, "1.0.0");
    cpSync(path.join(templatesDir, TEMPLATE_ID, VERSION), renamedVersionDir, { recursive: true });
    try {
      const worldYaml = path.join(renamedVersionDir, "world.yaml");
      writeFileSync(
        worldYaml,
        readFileSync(worldYaml, "utf-8").replace(/^  id: jjk-2006$/m, "  id: renamed-tpl"),
        "utf-8",
      );
      registry.ensureFresh();
      const renamed = registry.resolve({ id: "renamed-tpl", version: "1.0.0" });
      expect(renamed).toBeDefined();
      // Entry.key 的 id 段 ≡ 目录名 ≡ template.meta.id（A-7 断言成立时三者恒等）
      expect(renamed!.ref.id).toBe("renamed-tpl");
      expect(renamed!.template.meta.id).toBe("renamed-tpl");

      const world = worldStore.create(
        { templateId: "renamed-tpl", playerName: "改名后的模板", seed: 5 },
        renamed!,
      );
      try {
        expect(world.templateId).toBe("renamed-tpl"); // 不是写死的 jjk-2006
        const envelope = readEnvelope(path.join(worldsDir, `${world.id}.json`));
        expect(envelope.templateId).toBe("renamed-tpl");
      } finally {
        worldStore.delete(world.id);
      }
    } finally {
      rmSync(renamedRoot, { recursive: true, force: true });
      registry.ensureFresh();
    }
  });
});

describe("R-TG-08 · 模板引用是存档事实（不随注册表变化）", () => {
  it("AC①：建局后换掉磁盘模板（指纹变）再 save ⇒ 信封三元组逐字节不变", () => {
    const worldDir = path.join(worldsDir, "r-tg-08");
    rmSync(worldDir, { recursive: true, force: true });
    mkdirSync(worldDir, { recursive: true });
    process.env.LIFE_SIM_DATA_DIR = worldDir;

    const world = worldStore.create(
      { templateId: TEMPLATE_ID, playerName: "固化引用", seed: 7 },
      entry,
    );
    const file = path.join(worldDir, `${world.id}.json`);
    const tripleBefore = readEnvelope(file);

    const worldYaml = path.join(templatesDir, TEMPLATE_ID, VERSION, "world.yaml");
    const original = readFileSync(worldYaml, "utf-8");
    try {
      writeFileSync(worldYaml, original.replace(/^  name: .*$/m, "  name: 改过的名字"), "utf-8");
      registry.ensureFresh();
      const reloaded = registry.resolve({ id: TEMPLATE_ID, version: VERSION });
      // 前置：注册表里的 Entry 确实换了（指纹变了），否则本格是空转
      expect(reloaded!.semanticFingerprint).not.toBe(tripleBefore.templateFingerprint);
      expect(reloaded!.template.meta.name).toBe("改过的名字");

      worldStore.save(world);

      const tripleAfter = readEnvelope(file);
      expect(tripleAfter.templateId).toBe(tripleBefore.templateId);
      expect(tripleAfter.templateVersion).toBe(tripleBefore.templateVersion);
      expect(tripleAfter.templateFingerprint).toBe(tripleBefore.templateFingerprint);
    } finally {
      writeFileSync(worldYaml, original, "utf-8");
      registry.ensureFresh();
      worldStore.delete(world.id);
      process.env.LIFE_SIM_DATA_DIR = worldsDir;
    }
  });

  it("AC③：缺 record ⇒ template_ref_missing（不得回落占位符指纹）", () => {
    const orphan = { ...fixtureState, id: "w-orphan" } as WorldStateV2;
    expect(() => worldStore.save(orphan)).toThrow(/template_ref_missing/);
  });

  it("AC②：store.ts 不再有全局指纹查表（源码零命中）", () => {
    const source = readFileSync(
      path.join(REPO_ROOT, "apps", "server", "src", "store.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/getTemplateFingerprint/);
    expect(source).not.toMatch(/sha256:unknown/);
  });
});
