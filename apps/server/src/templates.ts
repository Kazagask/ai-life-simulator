import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  EndingConfigSchema,
  EvaluationConfigSchema,
  OpeningTemplateSchema,
  WorldTemplateV2Schema,
  type EndingConfig,
  type EvaluationConfig,
  type OpeningTemplate,
  type WorldTemplateV2,
} from "@life-sim/shared";
import { createLookup, type TemplateLookup, type TurnPipelineConfig } from "@life-sim/game-core";

/**
 * 模板注册表（ADR-0029 / R2.8）：
 *
 * - **身份 = `(目录名, 版本目录名)`**：磁盘形状 `TEMPLATES_DIR/<id>/<version>/`，
 *   id 取上一级目录名、version 取版本目录名（`^\d+(\.\d+){0,2}$`）。无 `_meta.json`、
 *   无服务端生成 id、无导入端点（R-TG-01 / R4 / R-TG-17）。
 * - **目录结构即元数据**：`<id>/` 层只允许子目录；`<version>/` 层只允许 11 个白名单
 *   `declarative` yaml（平铺在版本目录根）+ `assets/**`；其余文件一律 **warn + 忽略**，
 *   不参与指纹、不参与校验、不拒载（R-TG-15 / H-1）。
 * - **分层指纹**（实时计算、不落盘）：
 *   `semanticFingerprint` 只算白名单 11 个 yaml（文件名 + `"\0"` + 内容，不含路径）⇒
 *   决定可载性；游离 yaml 不参与（有意偏离旧 `endsWith(".yaml")` 实现）；
 *   `assetFingerprint` 只算 `assets/**`（相对路径 + `"\0"` + 内容），空集取确定常量，
 *   仅用于诊断，**不参与任何拒载判定**（H-2 / C-3）。
 * - **失败哲学按时机分两套**（B-4）：启动期 `loadTemplates()` fail-fast（任一含 yaml 的
 *   版本校验失败 / `meta.id` ≠ 目录名 ⇒ throw，进程退出；空版本目录只 warn）；运行期
 *   单目录隔离（`scanAll({ failFast: false })` ⇒ 该版本标 `invalid` + reason，不退出），
 *   由 T-TG-11 的请求驱动热加载复用。
 */

/** 版本目录名格式（A-3，已裁决 B）。`2` 与 `2.0.0` 是**不同**版本，不做等价归一。 */
const VERSION_PATTERN = /^\d+(\.\d+){0,2}$/;

/**
 * 白名单 declarative yaml（H-2.1）：只有这 11 个文件进语义指纹与加载校验。
 * 前 6 个必需（缺失 ⇒ schema 校验失败）；`equipment/combat-ai` 与
 * `opening/endings/evaluation` 是可选分域。
 */
const DECLARATIVE_FILES = [
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

const DECLARATIVE_SET: ReadonlySet<string> = new Set(DECLARATIVE_FILES);

/**
 * 合并进 `WorldTemplateV2` 的文件（前 6 个必需 + 装备 / 战斗 AI 两个分域）。
 * `opening/endings/evaluation` **不并入**模板对象——它们是可选分域，各有自己的 schema
 * 与消费方（开局 / 结局决胜 / 评价），并入会撞 `WorldTemplateV2Schema` 的 strict 校验。
 */
const TEMPLATE_MERGE_FILES: ReadonlySet<string> = new Set([
  "world.yaml",
  "characters.yaml",
  "skills.yaml",
  "items.yaml",
  "statuses.yaml",
  "events.yaml",
  "equipment.yaml",
  "combat-ai.yaml",
]);

/**
 * `asset` 角色禁用的扩展名（H-1）：可执行 / 可载入类型即使放在 `assets/` 内也 **warn + 忽略**。
 * 本轮没有任何下发端点（H-7），因此 `asset` 只影响 `assetCount` / `assetFingerprint`。
 */
const FORBIDDEN_ASSET_EXTS: ReadonlySet<string> = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".jsx",
  ".tsx",
  ".wasm",
  ".node",
  ".so",
  ".dll",
  ".dylib",
  ".exe",
  ".bat",
  ".ps1",
  ".sh",
  ".html",
  ".htm",
  ".svg",
]);

/** `sha256("")`：空资产集的**确定**指纹（H-2.2），避免空集长出不稳定的 `undefined`。 */
const EMPTY_ASSET_FINGERPRINT = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** 模板身份（A-1）：id = 模板目录名，version = 版本目录名。 */
export interface TemplateRef {
  id: string;
  version: string;
}

interface TemplateEntryBase {
  ref: TemplateRef;
  /** 版本目录内所有文件 mtime 的最大值（顶层 yaml + `assets/**` 递归，**不用目录 mtime**）。
   *  本批只记录不消费；T-TG-11 的 `ensureFresh()` 以此为变更检测基准。 */
  mtime: number;
}

/** 可载入版本：`resolve()` 只返回这一种。 */
export interface ReadyTemplateEntry extends TemplateEntryBase {
  status: "ready";
  template: WorldTemplateV2;
  lookup: TemplateLookup;
  openings: OpeningTemplate[];
  endingConfig?: EndingConfig;
  evaluationConfig?: EvaluationConfig;
  pipeline: TurnPipelineConfig;
  semanticFingerprint: string;
  assetFingerprint: string;
  assetCount: number;
}

/**
 * 不可载入版本（运行期热加载失败且无旧 Entry 时产生）。
 * 启动期不会出现——启动期失败一律 throw（B-4 fail-fast）。
 */
export interface InvalidTemplateEntry extends TemplateEntryBase {
  status: "invalid";
  /** 可诊断原因：含 `(id, version)` 与首个 issue 路径 / 文件路径。 */
  reason: string;
}

export type TemplateEntry = ReadyTemplateEntry | InvalidTemplateEntry;

/** 两级模板列表的版本层（`GET /api/templates`）。 */
export type TemplateVersionSummary =
  | {
      id: string;
      version: string;
      name: string;
      description: string;
      startYear: number;
      openings: Array<{ id: string; name: string; description: string }>;
      assetCount: number;
      assetFingerprint: string;
      loadable: true;
    }
  | { id: string; version: string; loadable: false; reason: string };

/** 两级模板列表的模板层（先选模板、再选版本）。 */
export interface TemplateSummary {
  id: string;
  name: string;
  /** 前端默认选中的版本：唯一可载版本 ⇒ 它本身；多版本 ⇒ 补 0 后全序最高的可载版本。 */
  startVersion?: string;
  versions: TemplateVersionSummary[];
}

/** 最小日志接口，避免 templates.ts 依赖 Fastify / pino 类型。 */
export interface TemplateScanLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface TemplateRegistry {
  /** 扫描根目录（`TEMPLATES_DIR`）。 */
  readonly dir: string;
  /** 模板层目录是否存在（用于把 `template_missing` 与 `template_version_missing` 分开）。 */
  idExists(id: string): boolean;
  /** 版本目录是否存在——含「空版本目录 / 被忽略的目录」，用于拒载原因细分。 */
  versionDirExists(id: string, version: string): boolean;
  /** 任一状态（ready / invalid）的注册记录。 */
  get(ref: TemplateRef): TemplateEntry | undefined;
  /** 仅 `ready`（可载入）版本；`invalid` 版本返回 undefined。 */
  resolve(ref: TemplateRef): ReadyTemplateEntry | undefined;
  /** 某 id 下已注册的全部版本（ready + invalid）；未注册的 id 返回空数组。 */
  versionsOf(id: string): TemplateEntry[];
  /** 两级结构（ready + invalid 都列，invalid 带 `loadable:false` + `reason`）。 */
  listTemplates(): TemplateSummary[];
}

function templatesDir(): string {
  if (process.env.TEMPLATES_DIR) return path.resolve(process.env.TEMPLATES_DIR);
  // apps/server/src → 仓库根/specs/data/templates
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../specs/data/templates");
}

function keyOf(ref: TemplateRef): string {
  return `${ref.id}@${ref.version}`;
}

/** 补 0 后全序比较（A-3）：`2` < `2.0.1` < `1.2.3` 这类「段数不同」也能排序。 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => Number.parseInt(s, 10));
  const pb = b.split(".").map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < 3; i += 1) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function hashPairs(pairs: ReadonlyArray<{ name: string; content: string }>): string {
  const hash = createHash("sha256");
  for (const pair of pairs) {
    hash.update(pair.name);
    hash.update("\0");
    hash.update(pair.content);
  }
  return `sha256:${hash.digest("hex")}`;
}

function firstIssue(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    if (issue) return `${issue.path.join(".") || "<root>"}: ${issue.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 递归列出目录下全部文件（相对路径统一用 `/`，保证跨平台指纹一致）。 */
function walkFiles(root: string): Array<{ rel: string; abs: string }> {
  const out: Array<{ rel: string; abs: string }> = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) out.push({ rel, abs });
      // 符号链接等非普通文件：不进指纹、不跟随（避免读到目录外内容）
    }
  };
  walk(root, "");
  return out;
}

interface AssetScan {
  fingerprint: string;
  count: number;
  mtime: number;
}

function scanAssets(versionDir: string, logger: TemplateScanLogger, ref: TemplateRef): AssetScan {
  const root = path.join(versionDir, "assets");
  if (!existsSync(root)) {
    return { fingerprint: EMPTY_ASSET_FINGERPRINT, count: 0, mtime: 0 };
  }
  const files: Array<{ rel: string; abs: string }> = [];
  let mtime = 0;
  for (const file of walkFiles(root)) {
    const ext = path.extname(file.rel).toLowerCase();
    if (FORBIDDEN_ASSET_EXTS.has(ext)) {
      logger.warn(
        { templateId: ref.id, version: ref.version, file: `assets/${file.rel}` },
        "template_asset_ignored: 可执行/可载入类型不参与 asset 指纹（H-1）",
      );
      continue;
    }
    files.push(file);
    mtime = Math.max(mtime, statMtime(file.abs));
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return {
    fingerprint: hashPairs(files.map((f) => ({ name: f.rel, content: readFileSync(f.abs, "utf8") }))),
    count: files.length,
    mtime,
  };
}

function statMtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** 合并模板主域为一份 `WorldTemplateV2`（只读存在的文件，缺文件由 schema 校验报错）。 */
function loadTemplate(versionDir: string, files: ReadonlySet<string>): WorldTemplateV2 {
  const merged: Record<string, unknown> = {};
  for (const file of [...files].filter((f) => TEMPLATE_MERGE_FILES.has(f)).sort()) {
    const doc = parse(readFileSync(path.join(versionDir, file), "utf8")) as Record<string, unknown> | null;
    if (doc === null || typeof doc !== "object") {
      throw new Error(`${file}: yaml 根节点必须是映射`);
    }
    for (const [key, value] of Object.entries(doc)) {
      if (key === "meta") {
        merged.meta = value;
      } else if (merged[key] === undefined) {
        merged[key] = value;
      } else if (Array.isArray(merged[key]) && Array.isArray(value)) {
        merged[key] = [...(merged[key] as unknown[]), ...value];
      }
    }
  }
  return WorldTemplateV2Schema.parse(merged);
}

/** 读取可选 opening.yaml；openingId 重复属模板缺陷，加载期即失败。 */
function loadOpenings(versionDir: string, files: ReadonlySet<string>): OpeningTemplate[] {
  if (!files.has("opening.yaml")) return [];
  const file = path.join(versionDir, "opening.yaml");
  const list = z.array(OpeningTemplateSchema).parse(parse(readFileSync(file, "utf8")));
  const ids = new Set<string>();
  for (const t of list) {
    if (ids.has(t.openingId)) throw new Error(`opening.yaml: openingId 重复：${t.openingId}`);
    ids.add(t.openingId);
  }
  return list;
}

/** 按文件存在性加载单个可选分域；校验失败由调用方决定 fail-fast 还是标 invalid。 */
function loadOptionalConfig<T>(
  versionDir: string,
  file: string,
  files: ReadonlySet<string>,
  schema: { parse: (input: unknown) => T },
): T | undefined {
  if (!files.has(file)) return undefined;
  return schema.parse(parse(readFileSync(path.join(versionDir, file), "utf8")));
}

type VersionScan = { ok: true; entry: ReadyTemplateEntry } | { ok: false; reason: string; mtime: number };

/**
 * 扫描一个版本目录。
 *
 * 返回 `{ ok: false }` 表示「含 ≥1 个白名单 yaml 但加载失败」——调用方按时机决定
 * throw（启动期）还是标 `invalid`（运行期）。空版本目录返回 `null`（调用方 warn + 忽略）。
 */
function scanVersion(
  id: string,
  version: string,
  versionDir: string,
  logger: TemplateScanLogger,
): VersionScan | null {
  const ref: TemplateRef = { id, version };
  const declarative: string[] = [];
  let mtime = 0;

  let dirEntries: Dirent[];
  try {
    dirEntries = readdirSync(versionDir, { withFileTypes: true });
  } catch (error) {
    return { ok: false, reason: `${keyOf(ref)}: 版本目录不可读：${firstIssue(error)}`, mtime: 0 };
  }

  for (const entry of dirEntries) {
    const rel = entry.name;
    if (entry.isFile() && DECLARATIVE_SET.has(rel)) {
      declarative.push(rel);
      mtime = Math.max(mtime, statMtime(path.join(versionDir, rel)));
      continue;
    }
    if (entry.isFile()) {
      // 非白名单文件（游离 notes.yaml / .md / .png / .wheel.json …）：warn + 忽略，不拒载（H-1）。
      logger.warn(
        { templateId: id, version, file: rel },
        "template_file_ignored: 非白名单声明式文件不参与加载与指纹",
      );
      continue;
    }
    if (entry.isDirectory() && rel === "assets") continue; // 下面统一扫
    if (entry.isDirectory()) {
      logger.warn(
        { templateId: id, version, dir: rel },
        "template_directory_ignored: 版本目录根只允许 assets/ 子目录",
      );
    }
  }

  if (declarative.length === 0) return null; // 空版本目录：占位，不是模板（B-4 第 3 条）

  const asset = scanAssets(versionDir, logger, ref);
  mtime = Math.max(mtime, asset.mtime);

  const present = new Set(declarative);
  try {
    const template = loadTemplate(versionDir, present);
    // A-7：`world.templateId` 恒等于 `template.meta.id`（createWorldV2 写入），因此
    // `meta.id ≡ <id> 目录名` 是身份正确性的唯一保证 —— 不等即模板缺陷。
    if (template.meta.id !== id) {
      throw new Error(
        `world.yaml: meta.id (${template.meta.id}) 与模板目录名 (${id}) 不一致`,
      );
    }
    const openings = loadOpenings(versionDir, present);
    const endingConfig = loadOptionalConfig(versionDir, "endings.yaml", present, EndingConfigSchema);
    const evaluationConfig = loadOptionalConfig(
      versionDir,
      "evaluation.yaml",
      present,
      EvaluationConfigSchema,
    );
    const semanticFingerprint = hashPairs(
      [...declarative]
        .sort()
        .map((file) => ({ name: file, content: readFileSync(path.join(versionDir, file), "utf8") })),
    );
    const entry: ReadyTemplateEntry = {
      ref,
      status: "ready",
      template,
      lookup: createLookup(template),
      openings,
      ...(endingConfig !== undefined ? { endingConfig } : {}),
      ...(evaluationConfig !== undefined ? { evaluationConfig } : {}),
      pipeline: { endingConfig, evaluationConfig },
      semanticFingerprint,
      assetFingerprint: asset.fingerprint,
      assetCount: asset.count,
      mtime,
    };
    return { ok: true, entry };
  } catch (error) {
    return { ok: false, reason: `${keyOf(ref)}: ${firstIssue(error)}`, mtime };
  }
}

interface ScanResult {
  entries: Map<string, TemplateEntry>;
  idDirs: Set<string>;
  versionDirs: Set<string>;
}

/**
 * 全量扫描注册表。
 *
 * `failFast: true`（启动期）—— 任一「含 ≥1 白名单 yaml 但加载失败」的版本 ⇒ 抛错，
 * 进程退出；空的版本目录只 warn（B-4 第 3 条）。
 * `failFast: false`（运行期热加载，T-TG-11 复用）—— 该版本标 `invalid` + reason，
 * 不影响其他版本、不退出进程（I-3）。
 */
function scanAll(dir: string, logger: TemplateScanLogger, failFast: boolean): ScanResult {
  const entries = new Map<string, TemplateEntry>();
  const idDirs = new Set<string>();
  const versionDirs = new Set<string>();
  if (!existsSync(dir)) throw new Error(`templates_dir_missing: ${dir}`);

  for (const idEntry of readdirSync(dir, { withFileTypes: true })) {
    if (!idEntry.isDirectory()) {
      // `<id>` 层只允许子目录（残留的 *.wheel.json 等落在这里）：warn + 忽略（H-1）。
      logger.warn({ dir, entry: idEntry.name }, "template_file_ignored: <id> 层只允许版本子目录");
      continue;
    }
    const id = idEntry.name;
    idDirs.add(id);
    const idDir = path.join(dir, id);
    for (const versionEntry of readdirSync(idDir, { withFileTypes: true })) {
      if (!versionEntry.isDirectory()) {
        logger.warn(
          { templateId: id, entry: versionEntry.name },
          "template_file_ignored: <id> 层只允许版本子目录",
        );
        continue;
      }
      const version = versionEntry.name;
      if (!VERSION_PATTERN.test(version)) {
        // A-3：版本号格式由目录名承载；不匹配的目录不是模板版本。启动期不因此 fail-fast，
        // 因为「目录不是版本」与「版本内容坏了」是两件事（B-4）。
        logger.warn(
          { templateId: id, dir: version },
          "template_version_dir_ignored: 版本目录名不匹配 ^\\d+(\\.\\d+){0,2}$",
        );
        continue;
      }
      versionDirs.add(keyOf({ id, version }));
      const scan = scanVersion(id, version, path.join(idDir, version), logger);
      if (scan === null) {
        logger.warn(
          { templateId: id, version },
          "template_version_empty: 版本目录内无任何白名单 yaml，忽略（不视为模板）",
        );
        continue;
      }
      if (scan.ok) {
        entries.set(keyOf(scan.entry.ref), scan.entry);
        continue;
      }
      if (failFast) {
        throw new Error(`template_invalid: ${scan.reason}`);
      }
      logger.error({ templateId: id, version, reason: scan.reason }, "template_reload_failed");
      entries.set(keyOf({ id, version }), {
        ref: { id, version },
        status: "invalid",
        reason: scan.reason,
        mtime: scan.mtime,
      });
    }
  }
  return { entries, idDirs, versionDirs };
}

function createRegistry(dir: string, result: ScanResult): TemplateRegistry {
  const byKey = new Map(result.entries);
  const ids = new Set(result.idDirs);
  const versionDirs = new Set(result.versionDirs);

  const versionsOf = (id: string): TemplateEntry[] =>
    [...byKey.values()].filter((entry) => entry.ref.id === id);

  return {
    dir,
    idExists: (id) => ids.has(id),
    versionDirExists: (id, version) => versionDirs.has(keyOf({ id, version })),
    get: (ref) => byKey.get(keyOf(ref)),
    resolve: (ref) => {
      const entry = byKey.get(keyOf(ref));
      return entry?.status === "ready" ? entry : undefined;
    },
    versionsOf,
    listTemplates: () => {
      const grouped = new Map<string, TemplateEntry[]>();
      for (const entry of byKey.values()) {
        const list = grouped.get(entry.ref.id);
        if (list) list.push(entry);
        else grouped.set(entry.ref.id, [entry]);
      }
      return [...grouped.keys()].sort().map((id) => {
        const list = versionsOf(id).sort((a, b) => compareVersions(a.ref.version, b.ref.version));
        const ready = list.filter((entry): entry is ReadyTemplateEntry => entry.status === "ready");
        // startVersion = 默认选中版本：优先最高可载版本；全不可载时退回最高注册版本。
        const start = ready.at(-1) ?? list.at(-1);
        const versions: TemplateVersionSummary[] = list.map((entry) =>
          entry.status === "ready"
            ? {
                id,
                version: entry.ref.version,
                name: entry.template.meta.name,
                description: entry.template.meta.description,
                startYear: entry.template.meta.startYear,
                openings: entry.openings.map((o) => ({
                  id: o.openingId,
                  name: o.name,
                  description: o.description,
                })),
                assetCount: entry.assetCount,
                assetFingerprint: entry.assetFingerprint,
                loadable: true,
              }
            : { id, version: entry.ref.version, loadable: false, reason: entry.reason },
        );
        const nameOfStart =
          start?.status === "ready" ? start.template.meta.name : (start?.ref.id ?? id);
        return {
          id,
          name: nameOfStart,
          ...(start !== undefined ? { startVersion: start.ref.version } : {}),
          versions,
        };
      });
    },
  };
}

/**
 * 启动期加载（R-TG-04 fail-fast）：扫描 `TEMPLATES_DIR/<id>/<version>/`，任一含 yaml 的
 * 版本校验失败 / `meta.id` ≠ 目录名 ⇒ 抛错（进程退出）；整个目录零模板 ⇒ 抛错。
 */
export function loadTemplates(logger: TemplateScanLogger): TemplateRegistry {
  const dir = templatesDir();
  const result = scanAll(dir, logger, true);
  const readyCount = [...result.entries.values()].filter((e) => e.status === "ready").length;
  if (readyCount === 0) throw new Error(`no_templates_found_in: ${dir}`);
  return createRegistry(dir, result);
}

/** 扫描根目录（供日志 / 诊断；与 `TEMPLATES_DIR` 同一解析口径）。 */
export function templatesRoot(): string {
  return templatesDir();
}
