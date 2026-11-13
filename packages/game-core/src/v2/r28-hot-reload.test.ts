import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorldStateV2 } from "@life-sim/shared";
import { advanceTurnV2, chooseOptionV2 } from "./turn.js";
import { checkAllConditions } from "./engine.js";
import { loadPersistedWorlds, worldStore } from "../../../../apps/server/src/store.js";
import {
  loadTemplates,
  type ReadyTemplateEntry,
  type TemplateRegistry,
  type TemplateScanLogger,
} from "../../../../apps/server/src/templates.js";

/**
 * R2.8 · T-TG-08 覆盖 R-TG-16（运行时热加载，8 条 AC）+ R-TG-15（文件角色 / 分层指纹）。
 *
 * 全部在**临时目录**里做：把 `specs/data/templates/jjk-2006` 只读复制到 `os.tmpdir()`，
 * `TEMPLATES_DIR` / `LIFE_SIM_DATA_DIR` 指向它。仓库的 `data/worlds` 与 `specs/data/templates`
 * 一个字节都不动（tasks.md「口径澄清」第 3 条）。
 *
 * 每条 AC 都要能回答「这条在什么情况下会红」——写在用例标题旁：
 *   AC① 红法：实现改用**目录 mtime** 做变更检测 ⇒ 就地编辑不改父目录 mtime ⇒ 名字不变 ⇒ 红。
 *         本用例同时断言「目录 mtime 未变」而「文件 mtime 变了」。
 *   AC② 红法：热加载把已载入世界的 `record.entry` 一起换掉 ⇒ 旧世界模板名变 / 推进崩。
 *   AC③ 红法：坏 yaml 让进程 throw（fail-fast 跑到运行期）或整表消失。
 *   AC④ 红法：删目录后 `resolve` 仍返回旧 Entry（列表幽灵）或已载入世界无法推进。
 *   AC⑤ 红法：重启后旧档不报 `template_content_drift`（静默载入错内容）。
 *   AC⑥ 红法：每次请求都重扫（rescanCount 恒增）。
 *   AC⑦ 红法：代码里出现 `setInterval` / `fs.watch`（grep 断言，见 r28-readonly-boundary）。
 *   AC⑧ 红法：`statCount` 不增长（计数器接空）或写死 43。
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REAL_TEMPLATE_DIR = path.join(REPO_ROOT, "specs", "data", "templates", "jjk-2006", "1.0.0");
const TEMPLATE_ID = "jjk-2006";
const VERSION = "1.0.0";
const REF = { id: TEMPLATE_ID, version: VERSION };

interface LogLine {
  level: "warn" | "error" | "info";
  msg: string;
  obj: Record<string, unknown>;
}

let root: string;
let templatesDir: string;
let versionDir: string;
let worldsDir: string;
let logs: LogLine[];
let registry: TemplateRegistry;
/** 夹具里的原始 world.yaml 文本（每个用例都可能改它，用它在 finally 里还原）。 */
let originalWorldYaml: string;

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

/** 递归统计版本目录内的文件数（= 契约里 `statCount` 每次调用的增量上限）。 */
function countFiles(dir: string): number {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else if (entry.isFile()) n += 1;
  }
  return n;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 写文件并保证 `mtimeMs` 真的变了。
 * 某些文件系统 mtime 精度只有 1–2 秒（design I-1 已知局限），同一毫秒内重复写会让
 * 「mtime 未变 ⇒ 不重扫」的用例假红。这里最多重试 20 次 × 5ms，仍不变就断言失败
 * （断言失败比用 `utimes` 造一个假 mtime 更诚实：我们要验的正是「写文件会改 mtime」）。
 */
function writeAndBump(file: string, content: string): void {
  const before = statSync(file).mtimeMs;
  for (let i = 0; i < 20; i += 1) {
    writeFileSync(file, content, "utf-8");
    if (statSync(file).mtimeMs !== before) return;
    sleepSync(5);
  }
  throw new Error(`mtime 未变化（文件系统精度不足）：${file}`);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "r28-hot-reload-"));
  templatesDir = path.join(root, "templates");
  versionDir = path.join(templatesDir, TEMPLATE_ID, VERSION);
  worldsDir = path.join(root, "worlds");
  mkdirSync(worldsDir, { recursive: true });
  cpSync(REAL_TEMPLATE_DIR, versionDir, { recursive: true });

  process.env.TEMPLATES_DIR = templatesDir;
  process.env.LIFE_SIM_DATA_DIR = worldsDir;

  const made = makeLogging();
  logs = made.lines;
  registry = loadTemplates(made.logger); // 启动期 fail-fast：夹具本身必须干净
  logs.length = 0; // 丢弃启动期日志，只保留运行期热加载日志
  originalWorldYaml = readFileSync(path.join(versionDir, "world.yaml"), "utf-8");
});

afterEach(() => {
  delete process.env.TEMPLATES_DIR;
  delete process.env.LIFE_SIM_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

function entryNow(): ReadyTemplateEntry {
  const entry = registry.resolve(REF);
  expect(entry).toBeDefined();
  return entry!;
}

/**
 * 把真实模板造出来的世界推进到「无待决事件」的可推进态（等价于前端在开局事件里选了一手）。
 * 用 `chooseOptionV2`（生产同一路径）而不是手改 state：手改会绕过 ADR-0024 的复核门。
 */
function resolvePending(state: WorldStateV2, entry: ReadyTemplateEntry): WorldStateV2 {
  let current = state;
  for (let guard = 0; guard < 30; guard += 1) {
    const pending = current.pendingEvents[0];
    if (!pending) return current;
    const event = entry.lookup.event(pending.eventId);
    if (!event || event.kind !== "normal") return current; // 战斗等不在本文件范围
    const ctx = { state: current, lookup: entry.lookup, rng: () => 0.5 };
    const visible = event.settle.normal.options.filter((o) => checkAllConditions(o.visibleWhen, ctx));
    const pick = visible[0] ?? event.settle.normal.options[0];
    if (!pick) return current;
    current = chooseOptionV2(
      current,
      { optionId: pick.id },
      entry.template,
      entry.lookup,
      entry.pipeline,
    ).state;
  }
  return current;
}

function createPlayableWorld(seed = 424242): { id: string; state: WorldStateV2 } {
  const entry = entryNow();
  const created = worldStore.create(
    { templateId: TEMPLATE_ID, playerName: "热加载探针", seed },
    entry,
  );
  const resolved = resolvePending(created, entry);
  worldStore.save(resolved);
  return { id: resolved.id, state: resolved };
}

describe("R-TG-16 AC①：就地改 meta.name（不动目录、不增删文件）⇒ 不重启即反映", () => {
  it("目录 mtime 未变、文件 mtime 变，listTemplates 立刻返回新 name", () => {
    const dirMtimeBefore = statSync(versionDir).mtimeMs;
    expect(registry.listTemplates()[0]!.name).toBe("咒术回战 · 命数十二年");

    const worldYaml = path.join(versionDir, "world.yaml");
    writeAndBump(worldYaml, originalWorldYaml.replace(/^  name: .*$/m, "  name: 热加载验证 · 就地改名"));

    // ✅ 这正是「不得用目录 mtime」的行为断言：目录 mtime 没动，只有文件 mtime 动了。
    expect(statSync(versionDir).mtimeMs).toBe(dirMtimeBefore);

    const list = registry.listTemplates();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("热加载验证 · 就地改名");
    expect(list[0]!.versions[0]).toMatchObject({ version: VERSION, name: "热加载验证 · 就地改名", loadable: true });
  });
});

describe("R-TG-16 AC⑥/⑧：mtime 未变不重扫；statCount 增量 = 版本目录文件数", () => {
  it("连续两次 listTemplates：rescanCount 增量 0，statCount 增量 = 文件数（动态计算，不写死）", () => {
    const fileCount = countFiles(versionDir);
    // 反向对照基线：11 = 白名单 yaml 数；若有人往夹具里加了文件，这条会跟着变，
    // 但断言本身只依赖「目录里到底有几个文件」，不依赖常量。
    expect(fileCount).toBeGreaterThanOrEqual(11);

    const d0 = registry.diagnostics();
    registry.listTemplates();
    const d1 = registry.diagnostics();
    registry.listTemplates();
    const d2 = registry.diagnostics();

    expect(d1.rescanCount - d0.rescanCount).toBe(0);
    expect(d2.rescanCount - d1.rescanCount).toBe(0);
    expect(d1.statCount - d0.statCount).toBe(fileCount);
    expect(d2.statCount - d1.statCount).toBe(fileCount);
  });

  it("反向对照：改一次文件后 rescanCount 恰好 +1（证明计数器没接空）", () => {
    const eventsYaml = path.join(versionDir, "events.yaml");
    const before = readFileSync(eventsYaml, "utf-8");
    const d0 = registry.diagnostics();
    registry.listTemplates();
    const d1 = registry.diagnostics();
    expect(d1.rescanCount - d0.rescanCount).toBe(0);

    writeAndBump(eventsYaml, `${before}\n# 热加载探针：只改注释也属于内容变更\n`);

    registry.listTemplates(); // ensureFresh 在 listTemplates 入口里跑
    const d2 = registry.diagnostics();
    expect(d2.rescanCount - d1.rescanCount).toBe(1);
    expect(d2.statCount - d1.statCount).toBe(countFiles(versionDir));
  });
});

describe("R-TG-15 AC①/④/⑤：assets 只影响 asset 指纹，不影响可载性", () => {
  it("新增 assets/ ⇒ semanticFingerprint 不变、assetCount 计入、assetFingerprint 变化；改 asset ⇒ 只 asset 指纹变", () => {
    const baseline = entryNow();
    const assetDir = path.join(versionDir, "assets");
    mkdirSync(assetDir);
    writeFileSync(path.join(assetDir, "portrait.txt"), "v1", "utf-8");

    const withAsset = entryNow();
    expect(withAsset.semanticFingerprint).toBe(baseline.semanticFingerprint);
    expect(withAsset.assetCount).toBe(1);
    expect(withAsset.assetFingerprint).not.toBe(baseline.assetFingerprint);

    const summary = registry.listTemplates()[0]!.versions[0] as { assetCount: number };
    expect(summary.assetCount).toBe(1); // AC⑤：GET /api/templates 暴露 assetCount

    writeAndBump(path.join(assetDir, "portrait.txt"), "v2");

    const afterChange = entryNow();
    expect(afterChange.semanticFingerprint).toBe(baseline.semanticFingerprint);
    expect(afterChange.assetFingerprint).not.toBe(withAsset.assetFingerprint);
    expect(afterChange.assetCount).toBe(1);
  });

  it("asset 变化后，指纹为 baseline 的旧档仍可载（asset 不参与拒载判定）", () => {
    const baseline = entryNow();
    const assetDir = path.join(versionDir, "assets");
    mkdirSync(assetDir);
    writeFileSync(path.join(assetDir, "portrait.txt"), "v1", "utf-8");
    registry.ensureFresh();

    const world = worldStore.create(
      { templateId: TEMPLATE_ID, playerName: "资源无关", seed: 9 },
      baseline,
    );
    const envelopeFile = path.join(worldsDir, `${world.id}.json`);
    const envelope = JSON.parse(readFileSync(envelopeFile, "utf-8")) as Record<string, unknown>;
    expect(envelope.templateFingerprint).toBe(baseline.semanticFingerprint);

    const result = loadPersistedWorlds(registry);
    expect(result.unloadable).toEqual([]);
    expect(result.loaded.map((r) => r.state.id)).toContain(world.id);
  });

  it("无 assets 时 assetFingerprint 是确定常量（空集 sha256，不是 undefined）", () => {
    const entry = entryNow();
    expect(entry.assetCount).toBe(0);
    expect(entry.assetFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry.assetFingerprint).toBe("sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("R-TG-15 AC③/⑦：非白名单文件 warn + 忽略，不参与指纹、不拒载", () => {
  it("版本目录根放游离 notes.yaml ⇒ 指纹不变 + warn + 旧档仍可载", () => {
    const baseline = entryNow();
    writeFileSync(path.join(versionDir, "notes.yaml"), "memo: 这是备注\n", "utf-8");

    const after = entryNow();
    expect(after.semanticFingerprint).toBe(baseline.semanticFingerprint);
    expect(
      logs.some((l) => l.level === "warn" && l.msg.startsWith("template_file_ignored") && l.obj.file === "notes.yaml"),
    ).toBe(true);

    const world = worldStore.create(
      { templateId: TEMPLATE_ID, playerName: "备注不影响", seed: 3 },
      baseline,
    );
    const result = loadPersistedWorlds(registry);
    expect(result.unloadable).toEqual([]);
    expect(result.loaded.map((r) => r.state.id)).toContain(world.id);
  });

  it("版本目录内放 .js / .svg / .md / .png / .wheel.json ⇒ warn + 忽略，模板仍 ready", () => {
    const baseline = entryNow();
    for (const file of ["hack.js", "pic.svg", "readme.md", "cover.png", "old.wheel.json"]) {
      writeFileSync(path.join(versionDir, file), "irrelevant", "utf-8");
    }

    const after = entryNow();
    expect(after.status).toBe("ready");
    expect(after.semanticFingerprint).toBe(baseline.semanticFingerprint);
    for (const file of ["hack.js", "pic.svg", "readme.md", "cover.png", "old.wheel.json"]) {
      expect(logs.some((l) => l.level === "warn" && l.obj.file === file)).toBe(true);
    }
    expect(registry.listTemplates()[0]!.versions[0]).toMatchObject({ loadable: true });
  });

  it("assets/ 内的 .js ⇒ warn + 不计入 assetCount（可执行/可载入类型一律忽略）", () => {
    const assetDir = path.join(versionDir, "assets");
    mkdirSync(assetDir);
    writeFileSync(path.join(assetDir, "run.js"), "console.log(1)", "utf-8");
    writeFileSync(path.join(assetDir, "pic.png"), "png", "utf-8");

    const entry = entryNow();
    expect(entry.assetCount).toBe(1); // 只有 pic.png
    expect(logs.some((l) => l.level === "warn" && l.msg.startsWith("template_asset_ignored"))).toBe(true);
  });
});

describe("R-TG-16 AC②/⑤：已载入世界持内存快照，热加载只影响新建世界", () => {
  it("改模板后：新世界用新 Entry，旧世界 record 快照逐字段不变且仍能推进一轮", () => {
    const { id } = createPlayableWorld();
    const before = worldStore.get(id)!;
    const beforeName = before.entry.template.meta.name;
    const beforeFp = before.entry.semanticFingerprint;
    const beforeTurn = before.state.turnIndex;

    writeAndBump(
      path.join(versionDir, "world.yaml"),
      originalWorldYaml.replace(/^  name: .*$/m, "  name: 新版本名字"),
    );

    const changedEntry = entryNow();
    expect(changedEntry.template.meta.name).toBe("新版本名字");
    expect(changedEntry.semanticFingerprint).not.toBe(beforeFp);

    // 旧世界：快照没被替换
    const after = worldStore.get(id)!;
    expect(after).toBe(before); // 同一个 record 对象
    expect(after.entry.template.meta.name).toBe(beforeName);
    expect(after.entry.semanticFingerprint).toBe(beforeFp);

    // 旧世界仍能推进一轮（用快照里的 template/lookup，不查注册表）
    const advanced = advanceTurnV2(
      after.state,
      { action: { type: "free", description: "热加载后继续" } },
      after.entry.template,
      after.entry.lookup,
      undefined,
      after.entry.pipeline,
    );
    expect(advanced.state.turnIndex).toBe(beforeTurn + 1);
    worldStore.save(advanced.state);
    // 落盘用的仍是旧 Entry 的三元组（R-TG-08）
    const envelope = JSON.parse(readFileSync(path.join(worldsDir, `${id}.json`), "utf-8")) as {
      templateFingerprint: string;
    };
    expect(envelope.templateFingerprint).toBe(beforeFp);

    // 新世界：拿到改后的 Entry
    const fresh = worldStore.create(
      { templateId: TEMPLATE_ID, playerName: "新世界", seed: 77 },
      entryNow(),
    );
    expect(worldStore.get(fresh.id)!.entry.template.meta.name).toBe("新版本名字");
  });

  it("AC⑤ 重启后：旧档因指纹不符 ⇒ template_content_drift；改后新建的档可载", () => {
    const { id: oldId } = createPlayableWorld();

    writeAndBump(
      path.join(versionDir, "world.yaml"),
      originalWorldYaml.replace(/^  name: .*$/m, "  name: 重启后漂移"),
    );
    // 模拟重启：全新注册表（不共享内存 Entry），但同一个磁盘目录
    const made = makeLogging();
    const freshRegistry = loadTemplates(made.logger);
    const newWorld = worldStore.create(
      { templateId: TEMPLATE_ID, playerName: "重启后新建", seed: 88 },
      freshRegistry.resolve(REF)!,
    );

    const result = loadPersistedWorlds(freshRegistry);

    const rejected = result.unloadable.find((u) => u.id === oldId);
    expect(rejected).toBeDefined();
    expect(rejected!.reason).toBe("template_content_drift");
    expect(result.loaded.map((r) => r.state.id)).toContain(newWorld.id);
  });
});

describe("R-TG-16 AC③：单个版本热加载失败隔离（绝不退出进程）", () => {
  it("从未成功加载过的坏版本 ⇒ status invalid + reason，其余版本不受影响", () => {
    // 起一个「只有 1.0.0」的干净注册表，再手放一个坏版本（启动期 fail-fast 就绕开了）
    const badVersion = "1.1.0";
    const badDir = path.join(templatesDir, TEMPLATE_ID, badVersion);
    mkdirSync(badDir, { recursive: true });
    for (const file of readdirSync(versionDir)) {
      if (file.endsWith(".yaml")) cpSync(path.join(versionDir, file), path.join(badDir, file));
    }
    writeFileSync(path.join(badDir, "world.yaml"), "meta:\n  id: jjk-2006\n   name: [坏掉的结构\n", "utf-8");

    const list = registry.listTemplates();
    expect(list).toHaveLength(1);
    const versions = list[0]!.versions;
    const healthy = versions.find((v) => v.version === VERSION)!;
    const broken = versions.find((v) => v.version === badVersion)!;
    expect(healthy).toMatchObject({ loadable: true });
    expect(broken).toMatchObject({ loadable: false });
    expect((broken as { reason: string }).reason).toContain(`jjk-2006@${badVersion}`);
    // 进程还活着：还能继续解析健康版本
    expect(registry.resolve(REF)).toBeDefined();
    expect(logs.some((l) => l.level === "error" && l.msg.startsWith("template_reload_failed"))).toBe(true);
  });

  it("已成功加载过的版本被改坏 ⇒ 保留旧 Entry 继续服务（口径澄清 #1，不转 invalid）", () => {
    const before = entryNow();
    writeAndBump(path.join(versionDir, "world.yaml"), "meta:\n  id: jjk-2006\n   name: [坏掉的结构\n");

    const after = registry.resolve(REF);
    expect(after).toBeDefined();
    expect(after!.status).toBe("ready");
    expect(after!.semanticFingerprint).toBe(before.semanticFingerprint);
    expect(after!.template.meta.name).toBe("咒术回战 · 命数十二年");
    // 列表里也不是 invalid（否则玩家连旧内容都开不了局）
    expect(registry.listTemplates()[0]!.versions[0]).toMatchObject({ loadable: true });
    expect(
      logs.some(
        (l) => l.level === "error" && String(l.obj.reason ?? "").includes(`jjk-2006@${VERSION}`),
      ),
    ).toBe(true);
  });

  it("空版本目录（mkdir 了但没拷 yaml）⇒ 忽略 + warn，不产生 invalid 条目、不 throw", () => {
    const emptyDir = path.join(templatesDir, TEMPLATE_ID, "1.2.0");
    mkdirSync(emptyDir, { recursive: true });

    const versions = registry.versionsOf(TEMPLATE_ID);
    expect(versions.map((v) => v.ref.version)).toEqual([VERSION]); // 空目录不算版本
    expect(logs.some((l) => l.msg.startsWith("template_version_empty"))).toBe(true);
    expect(registry.listTemplates()[0]!.versions).toHaveLength(1);
  });
});

describe("R-TG-16 AC④ / I-5：版本目录被删 ⇒ 不再列出，已载入世界仍能推进", () => {
  it("删目录后 listTemplates 不再列出该版本；已载入世界 record 仍可用、save 仍成功", () => {
    const { id, state } = createPlayableWorld();
    expect(registry.listTemplates()).toHaveLength(1);

    rmSync(versionDir, { recursive: true, force: true });
    registry.ensureFresh();

    expect(registry.listTemplates().flatMap((t) => t.versions)).toEqual([]);
    expect(registry.resolve(REF)).toBeUndefined();
    expect(logs.some((l) => l.level === "warn" && l.msg.startsWith("template_version_removed"))).toBe(true);

    // 已载入世界：内存快照还在，能继续推进并落盘
    const record = worldStore.get(id)!;
    expect(record.state).toEqual(state);
    const turnBefore = record.state.turnIndex; // 注意：advanceTurnV2 就地改写 state，必须先取值
    const advanced = advanceTurnV2(
      record.state,
      { action: { type: "free", description: "模板没了也要能继续走完这一生" } },
      record.entry.template,
      record.entry.lookup,
      undefined,
      record.entry.pipeline,
    );
    worldStore.save(advanced.state);
    expect(worldStore.get(id)!.state.turnIndex).toBe(turnBefore + 1);
  });
});
