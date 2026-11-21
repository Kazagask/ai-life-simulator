import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  AssetManifestSchema,
  BUILTIN_UI_CAPABILITIES,
  EffectSchema,
  EndingConfigSchema,
  EvaluationConfigSchema,
  EventTriggerSchema,
  ENGINE_VERSION,
  OpeningBranchDagSchema,
  OpeningTemplateSchema,
  RulesSchema,
  satisfiesVersion,
  TemplateEffectSchema,
  TimeSpecSchema,
  UiConfigSchema,
  WorldTemplateV2Schema,
  type AssetManifest,
  type EndingConfig,
  type EvaluationConfig,
  type LoreRule,
  type OpeningBranchDag,
  type OpeningTemplate,
  type Rules,
  type TimeSpec,
  type UiConfig,
  type WorldTemplateV2,
  type TemplateSource,
} from "@life-sim/shared";
import {
  DECLARATIVE_FILES,
  DECLARATIVE_SET,
  NESTED_DECLARATIVE,
  TemplateLoadError,
  assertExtensionsInstalled,
  assertKinshipCompliance,
  assertOpenVocabularyDeclared,
  assertVersionRequirements,
  fingerprintOfPairs,
  firstIssue,
  loadAssetManifest,
  loadLore,
  loadOpenings,
  loadOptionalConfig,
  loadRules,
  loadTemplate,
  loadUi,
  readAssetEntries,
  semanticFingerprintOf,
  type TemplateLoadReasonCode,
} from "@life-sim/template-loader";
import { FsTemplateSource } from "./template-source-fs.js";

/**
 * 公开面：加载器已搬到 `@life-sim/template-loader`（浏览器也要用同一份），
 * 这里保持原有导出名，**调用点零改动**（tests / index.ts / admin 都从本文件 import）。
 */
export {
  assertKinshipCompliance,
  loadTemplateFromSource,
  parseLoreMarkdown,
  readAssetEntries,
} from "@life-sim/template-loader";
export type { AssetTableEntry } from "@life-sim/template-loader";
export type { TemplateLoadReasonCode } from "@life-sim/template-loader";
import {
  BUILTIN_CONDITION_OPS,
  collectExtensionConditions,
  createLookup,
  getExtensionRuntime,
  hasExtensionRuntime,
  isKinshipKind,
  registeredUiCapabilities,
  resolveExtensionRuntimes,
  validateOpeningDag,
  validateStyleRefs,
  type TemplateLookup,
  type TurnPipelineConfig,
} from "@life-sim/game-core";
import { installedExtensionIds } from "./extensions.js";

/**
 * 模板注册表（ADR-0029 / R2.8）：
 *
 * - **身份 = `(目录名, 版本目录名)`**：磁盘形状 `TEMPLATES_DIR/<id>/<version>/`，
 *   id 取上一级目录名、version 取版本目录名（`^\d+(\.\d+){0,2}$`）。无 `_meta.json`、
 *   无服务端生成 id、无导入端点（R-TG-01 / R4 / R-TG-17）。
 * - **目录结构即元数据**：`<id>/` 层只允许子目录；`<version>/` 层只允许 15 个白名单
 *   `declarative` 文件（平铺在版本目录根）+ `assets/**`；其余文件一律 **warn + 忽略**，
 *   不参与指纹、不参与校验、不拒载（R-TG-15 / H-1）。`assets/manifest.yaml` 是唯一带 `/`
 *   的嵌套白名单条目，由 `scanVersion` 在顶层循环后按相对路径定向补读（T-06）。
 * - **分层指纹**（实时计算、不落盘）：
 *   `semanticFingerprint` = 14 个文件（13 yaml + lore.md）（文件名 + `"\0"` + 内容，不含路径）
 *   + 模板声明的扩展 id/version 对 ⇒ 决定可载性；**第 15 个 `ui.yaml` 进白名单但不进指纹**
 *   （纯渲染声明，改页签不废存档）；
 *   游离 yaml 不参与（有意偏离旧 `endsWith(".yaml")` 实现）；
 *   `assetFingerprint` 只算 `assets/**`（相对路径 + `"\0"` + 内容），空集取确定常量，
 *   仅用于诊断，**不参与任何拒载判定**（H-2 / C-3）。
 * - **失败哲学按时机分两套**（B-4）：启动期 `loadTemplates()` fail-fast（任一含 yaml 的
 *   版本校验失败 / `meta.id` ≠ 目录名 ⇒ throw，进程退出；空版本目录只 warn）；运行期
 *   请求驱动热加载（I-1..I-5）：`ensureFresh()` 只重扫 mtime 变了的版本，单目录隔离失败
 *   （有旧 Entry 保留旧的、无旧 Entry 标 `invalid`），**绝不 throw、绝不退出进程**。
 */

/** 版本目录名格式（A-3，已裁决 B）。`2` 与 `2.0.0` 是**不同**版本，不做等价归一。 */
const VERSION_PATTERN = /^\d+(\.\d+){0,2}$/;

/**
 * 白名单 declarative 文件（11 → 13 → 14 → 15：2026-11-18 增 ui.yaml）。
 *
 * 其中 14 个进语义指纹与加载校验；`ui.yaml` 是唯一的例外——进白名单、进加载期校验，
 * 但**不进语义指纹**（`specs/SPEC.md` §1.5：纯渲染声明，改页签不该让旧存档拒载）。
 * 前 6 个必需（缺失 ⇒ schema 校验失败）；`equipment/combat-ai` 与
 * `opening/endings/evaluation` 是可选分域；`rules.yaml` / `assets/manifest.yaml` /
 * `ui.yaml` 是独立声明式文件（各自独立 loader，绝不并入 `TEMPLATE_MERGE_FILES`，
 * 也不作为新顶层键塞进 `world.yaml`）。
 * `assets/manifest.yaml` 是唯一带 `/` 的嵌套条目：顶层 Dirent 不可见，定向补读。
 */

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

/**
 * 模板加载期的**封闭拒载码**：`reason` 是自由文本（给人看），码给程序与运维看。
 *
 * - `unknown_extension`：模板 `extensions:` 声明了服务端没装的扩展包。
 *   它必须与「yaml 写错了」的 `template_invalid` 分开 —— 否则运维会去翻模板文件，
 *   而真正要做的是补一条 `apps/server/src/extensions.ts` 的装配。
 * - `unknown_effect_type` / `unknown_condition_op`：模板用了**开放形**效果 / 条件
 *   （`{ type }` / `{ op, args }`），但既不在内核白名单里、也没有任何**已声明**的扩展
 *   注册它。两者都是「模板作者以为有这个能力、其实没人实现」⇒ 拒载比运行期静默强。
 * - `kinship_conflict`：模板声明了 `extensions.family`，却仍在 `characters[].relations[]`
 *   里写亲属边。两种亲缘模式互斥（`extensions/family/doc/FAMILY-GRAPH.md` §1/§2）：装了扩展就只写
 *   `fatherId`/`motherId` 指针。当前实现不是「扩展覆盖模板」，而是模板那条先占位、
 *   扩展推导出的行被 `factCounterpartIds` 静默丢弃 —— 模板作者以为在用扩展，其实扩展被架空。
 * - `core_version_mismatch` / `extension_version_mismatch`：`world.yaml#requires` 声明的
 *   主包 / 扩展版本与实际装配的不符。两者都是「依赖没对齐」，不是 yaml 语法错误 =>
 *   只废这一个版本，其它模板照常跑（SOFT_REASON_CODES）。
 */
const SOFT_REASON_CODES: ReadonlySet<TemplateLoadReasonCode> = new Set<TemplateLoadReasonCode>([
  "unknown_extension",
  "unknown_effect_type",
  "unknown_condition_op",
  "kinship_conflict",
  "core_version_mismatch",
  "extension_version_mismatch",
]);

/**
 * 加载期校验：模板 `extensions:` 声明的每个 id 都必须在**已注册 runtime** 里找得到
 * （`registerExtensionRuntime` 的产物，由 `apps/server` 启动期装配）。
 *
 * 未声明 `extensions` ⇒ 直接返回（保证 4：不声明就一次都不跑，也不该因此拒载）。
 * 判据用 game-core 的 `hasExtensionRuntime` —— 与投影期 `resolveExtensionRuntimes`
 * 读的是同一张表，两处口径不可能漂移。
 */


interface TemplateEntryBase {
  ref: TemplateRef;
  /** 版本目录内所有文件 mtime 的最大值（顶层文件 + `assets/**` 递归，**不用目录 mtime**）。
   *  `ensureFresh()` 以此为变更检测基准（T-TG-11 / R-TG-16）。 */
  mtime: number;
}

/** 可载入版本：`resolve()` 只返回这一种。 */
export interface ReadyTemplateEntry extends TemplateEntryBase {
  status: "ready";
  template: WorldTemplateV2;
  lookup: TemplateLookup;
  openings: OpeningTemplate[];
  /** ADR-001：新语法前实例化开局 DAG（与 legacy openings 互斥）。 */
  openingDag?: OpeningBranchDag;
  endingConfig?: EndingConfig;
  evaluationConfig?: EvaluationConfig;
  pipeline: TurnPipelineConfig;
  semanticFingerprint: string;
  assetFingerprint: string;
  assetCount: number;
  /** 独立声明式 loader 读取结果：`rules.yaml` / `assets/manifest.yaml`（T-06 Group B 已绑定 schema）。 */
  rules?: Rules;
  /** `lore.md` 解析结果（含 keys/always/p；引擎按可见文本筛选）。 */
  lore?: readonly LoreRule[];
  assetManifest?: AssetManifest;
  /** `ui.yaml` 解析结果（第 15 个白名单文件；只下发前端，不进模板对象、不进指纹）。 */
  ui?: UiConfig;
}

/**
 * 不可载入版本（运行期热加载失败且无旧 Entry 时产生）。
 * 启动期不会出现——启动期失败一律 throw（B-4 fail-fast）。
 */
export interface InvalidTemplateEntry extends TemplateEntryBase {
  status: "invalid";
  /** 可诊断原因：含 `(id, version)` 与首个 issue 路径 / 文件路径。 */
  reason: string;
  /** 封闭拒载码（可机读）：`unknown_extension` 时 `reason` 里带缺失 id 与已注册 id 列表；
   *  `unknown_effect_type` / `unknown_condition_op` 时带可诊断路径与非法 type / op。 */
  reasonCode?: TemplateLoadReasonCode;
}

export type TemplateEntry = ReadyTemplateEntry | InvalidTemplateEntry;

/** `GET /api/templates` 下发的资产公开投影（**不下发二进制、不下发 path**）。 */
export interface AssetSummary {
  assetId: string;
  kind: string;
  characterRef?: string;
}

/** 两级模板列表的版本层（`GET /api/templates`）。 */
export type TemplateVersionSummary =
  | {
      id: string;
      version: string;
      name: string;
      description: string;
      startYear: number;
      openings: Array<{ id: string; name: string; description: string }>;
      /** ADR-001：该版本使用前实例化开局向导；存在即前端走 /api/openings 流程。 */
      openingDag?: { openingId: string; name: string; description?: string };
      /**
       * 语义指纹（`sha256:…`）：客户端下载模板包后拿它做「该不该重新下载」的判据
       * （缓存里的包与当前指纹不同 ⇒ 模板变过，重下）。只对 ready 版本有。
       */
      fingerprint: string;
      assetCount: number;
      assetFingerprint: string;
      /** T-06：从 assetManifest 派生的 assetId 列表（无 path / 无二进制）。 */
      assets?: AssetSummary[];
      loadable: true;
    }
  | {
      id: string;
      version: string;
      loadable: false;
      reason: string;
      /** 封闭拒载码（可机读，随 `reason` 一起下发）。 */
      reasonCode?: TemplateLoadReasonCode;
    };

/** 两级模板列表的模板层（先选模板、再选版本）。 */
export interface TemplateSummary {
  id: string;
  name: string;
  /**
   * 隐藏模板（world.yaml `meta.hidden`）：`GET /api/templates` 不列它。
   * 注册表**照常**把它算进来 —— `inspect` 与体检要看得见测试田。
   */
  hidden?: boolean;
  /** 前端默认选中的版本：唯一可载版本 ⇒ 它本身；多版本 ⇒ 补 0 后全序最高的可载版本。 */
  startVersion?: string;
  versions: TemplateVersionSummary[];
}

/** 最小日志接口，避免 templates.ts 依赖 Fastify / pino 类型。 */
export interface TemplateScanLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

export interface TemplateRegistry {
  /** 扫描根目录（`TEMPLATES_DIR`）。 */
  readonly dir: string;
  /**
   * 请求驱动热加载入口（I-1 / R-TG-16）：比对每个版本目录的**文件 mtime 最大值**，
   * 只重扫变化的版本；无定时器、无文件监听 API。`resolve` / `versionsOf` / `listTemplates`
   * 入口已自动调用，路由在「先判 id 存在、再取版本」的路径上需显式调一次。
   */
  ensureFresh(): void;
  /** 模板层目录是否存在（用于把 `template_missing` 与 `template_version_missing` 分开）。 */
  idExists(id: string): boolean;
  /** 版本目录是否存在——含「空版本目录 / 被忽略的目录」，用于拒载原因细分。 */
  versionDirExists(id: string, version: string): boolean;
  /** 任一状态（ready / invalid）的注册记录（**不**触发刷新，仅供已解析 ref 的复查）。 */
  get(ref: TemplateRef): TemplateEntry | undefined;
  /** 仅 `ready`（可载入）版本；`invalid` 版本返回 undefined。先 `ensureFresh()`。 */
  resolve(ref: TemplateRef): ReadyTemplateEntry | undefined;
  /** 某 id 下已注册的全部版本（ready + invalid）；未注册的 id 返回空数组。先 `ensureFresh()`。 */
  versionsOf(id: string): TemplateEntry[];
  /** 两级结构（ready + invalid 都列，invalid 带 `loadable:false` + `reason`）。先 `ensureFresh()`。 */
  listTemplates(): TemplateSummary[];
  /**
   * 诊断计数（R-TG-16 AC⑥/⑧）：`statCount` = `ensureFresh()` 累计 stat 调用数；
   * `rescanCount` = 累计**实际重扫**版本次数（mtime 未变时恒不增长）。测试/运维用。
   */
  diagnostics(): { statCount: number; rescanCount: number };
}

function templatesDir(): string {
  if (process.env.TEMPLATES_DIR) return path.resolve(process.env.TEMPLATES_DIR);
  // apps/server/src → 仓库根/specs/data/templates
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../specs/data/templates");
}

function keyOf(ref: TemplateRef): string {
  return `${ref.id}@${ref.version}`;
}

/**
 * 补 0 后全序比较（A-3）：`2` < `2.0.1` < `1.2.3` 这类「段数不同」也能排序。
 * **版本排序的唯一实现点**：注册表内部与 API 响应（多版本 400 的 `versions[]`）都复用它，
 * 不许再出现第二套字符串序。
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => Number.parseInt(s, 10));
  const pb = b.split(".").map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < 3; i += 1) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return a < b ? -1 : a > b ? 1 : 0;
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
}

function scanAssets(versionDir: string, logger: TemplateScanLogger, ref: TemplateRef): AssetScan {
  const root = path.join(versionDir, "assets");
  if (!existsSync(root)) {
    return { fingerprint: EMPTY_ASSET_FINGERPRINT, count: 0 };
  }
  const files: Array<{ rel: string; abs: string }> = [];
  for (const file of walkFiles(root)) {
    const ext = path.extname(file.rel).toLowerCase();
    if (FORBIDDEN_ASSET_EXTS.has(ext)) {
      logger.warn(
        { templateId: ref.id, version: ref.version, file: `assets/${file.rel}` },
        "template_asset_ignored: 可执行/可载入类型不参与 asset 指纹（H-1）",
      );
      continue;
    }
    // T-06：嵌套声明式白名单文件（assets/manifest.yaml）进语义指纹、由独立 loader 消费，
    // 不得再计入 assetCount / assetFingerprint（否则双重计入）。二进制资源仍不进语义指纹。
    if (NESTED_DECLARATIVE.includes(`assets/${file.rel}`)) continue;
    files.push(file);
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return {
    fingerprint: fingerprintOfPairs(files.map((f) => ({ name: f.rel, content: readFileSync(f.abs, "utf8") }))),
    count: files.length,
  };
}

function statMtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------- 模板侧分支事件（P1）：加载期展开成普通事件，运行时不感知 branch ----------


type VersionScan =
  | { ok: true; entry: ReadyTemplateEntry }
  | {
      ok: false;
      reason: string;
      mtime: number;
      /** 带封闭码的失败（见 `TemplateLoadReasonCode`）；其它失败留空 ⇒ 归 `template_invalid`。 */
      reasonCode?: TemplateLoadReasonCode;
    };

/** stat 计数回调（R-TG-16 AC⑧）：只在运行期 `ensureFresh()` 里挂，启动期不计数。 */
type StatCounter = (() => void) | undefined;

/**
 * 版本目录的「变更检测基准」= **目录内所有文件 mtime 的最大值**（顶层文件 + `assets/**` 递归）。
 *
 * 🔴 **不得用目录 mtime 代替**（R-TG-16 AC①/AC⑨）：就地编辑一个已存在的文件**不会**改变
 * 其父目录的 mtime，只 stat 目录会漏掉最常见的那种改动（改文案 / 调数值）。
 * 允许 stat 文件、禁止「readdir 后直接 stat 目录」。
 */
function versionMaxMtime(versionDir: string, onStat?: StatCounter): number {
  let max = 0;
  for (const entry of readdirSync(versionDir, { withFileTypes: true })) {
    if (entry.isFile()) {
      onStat?.();
      max = Math.max(max, statMtime(path.join(versionDir, entry.name)));
      continue;
    }
    if (entry.isDirectory() && entry.name === "assets") {
      for (const file of walkFiles(path.join(versionDir, "assets"))) {
        onStat?.();
        max = Math.max(max, statMtime(file.abs));
      }
    }
  }
  return max;
}

/**
 * 扫描一个版本目录。
 *
 * 返回 `{ ok: false }` 表示「含 ≥1 个白名单 yaml 但加载失败」——调用方按时机决定
 * throw（启动期）还是标 `invalid` / 保留旧 Entry（运行期）。空版本目录返回 `null`
 * （调用方 warn + 忽略）。
 */
function scanVersion(
  id: string,
  version: string,
  versionDir: string,
  logger: TemplateScanLogger,
): VersionScan | null {
  const ref: TemplateRef = { id, version };
  // 本地化迁移第一步：声明式文件的读取统一走 `TemplateSource`，扫描与资产仍走 fs。
  const source = new FsTemplateSource(versionDir);
  const declarative: string[] = [];

  let dirEntries;
  try {
    dirEntries = source.list("");
  } catch (error) {
    return { ok: false, reason: `${keyOf(ref)}: 版本目录不可读：${firstIssue(error)}`, mtime: 0 };
  }

  for (const entry of dirEntries) {
    const rel = entry.rel;
    if (entry.kind === "file" && DECLARATIVE_SET.has(rel)) {
      declarative.push(rel);
      continue;
    }
    if (entry.kind === "file") {
      // 非白名单文件（游离 notes.yaml / .md / .png …）：warn + 忽略，不拒载（H-1）。
      logger.warn(
        { templateId: id, version, file: rel },
        "template_file_ignored: 非白名单声明式文件不参与加载与指纹",
      );
      continue;
    }
    if (entry.kind === "dir" && rel === "assets") continue; // 由 scanAssets 统一扫
    if (entry.kind === "dir") {
      logger.warn(
        { templateId: id, version, dir: rel },
        "template_directory_ignored: 版本目录根只允许 assets/ 子目录",
      );
    }
  }

  // T-06 path-aware 补读：白名单里带 `/` 的嵌套条目（assets/manifest.yaml）在顶层 Dirent
  // 中不可见，顶层循环后按相对路径定向补读；不改上面 assets/ 目录的 `continue` 语义
  // （assets/ 仍不作为声明式目录整体扫描），只做定向补读。
  for (const rel of NESTED_DECLARATIVE) {
    if (source.exists(rel)) declarative.push(rel);
  }

  if (declarative.length === 0) return null; // 空版本目录：占位，不是模板（B-4 第 3 条）

  // 变更检测基准与 Entry.mtime 同源（顶层全部文件 + assets/**），不是目录 mtime。
  const mtime = versionMaxMtime(versionDir);
  const asset = scanAssets(versionDir, logger, ref);

  const present = new Set(declarative);
  try {
    const template = loadTemplate(source, present);
    // A-7：`world.templateId` 恒等于 `template.meta.id`（createWorldV2 写入），因此
    // `meta.id ≡ <id> 目录名` 是身份正确性的唯一保证 —— 不等即模板缺陷。
    if (template.meta.id !== id) {
      throw new Error(
        `world.yaml: meta.id (${template.meta.id}) 与模板目录名 (${id}) 不一致`,
      );
    }
    // 扩展层：模板声明了没注册的 id ⇒ 拒载（`unknown_extension`），不是「投影期悄悄跳过」。
    assertExtensionsInstalled(template);
    assertVersionRequirements(template);
    // 亲缘模式互斥：装了 family 又自己写亲属边 ⇒ 加载期拒载（`kinship_conflict`）。
    // 三个模板已全部合规（valmont 迁到 fatherId/motherId 指针，jjk-2006 撤掉 family 声明），
    // 闸门自此真正生效；它是软码（只废这一个版本，不拒进程），见 SOFT_REASON_CODES。
    assertKinshipCompliance(template);
    const loadedOpenings = loadOpenings(source, present);
    const openings = loadedOpenings.legacy;
    const openingDag = loadedOpenings.branchDag;
    const endingConfig = loadOptionalConfig(source, "endings.yaml", present, EndingConfigSchema);
    const evaluationConfig = loadOptionalConfig(
      source,
      "evaluation.yaml",
      present,
      EvaluationConfigSchema,
    );
    // 开放形词表裁定：模板写了扩展效果 / 条件就必须有「谁实现它」的答案 ——
    // 内核白名单之外一律要求在 `extensions:` 里声明过（`unknown_effect_type` /
    // `unknown_condition_op`）。放在 opening / endings 解析之后，因为扫描要覆盖它们。
    assertOpenVocabularyDeclared(template, openings, endingConfig);
    // T-06：两个新声明式文件各有独立 loader，**加载期即 schema 校验并 fail-fast**——
    // 坏 `rules.yaml` / `assets/manifest.yaml` 走与其它白名单文件同一条失败通道（catch → reason），
    // 不再「warn + 静默丢文件」（否则 malformed rules 会退化成 undefined，运行时才炸）。
    const rules = present.has("rules.yaml") ? loadRules(source) : undefined;
    const lore = present.has("lore.md") ? loadLore(source) : undefined;
    const assetManifest = present.has("assets/manifest.yaml")
      ? loadAssetManifest(source)
      : undefined;
    const ui = present.has("ui.yaml") ? loadUi(source) : undefined;
    // ADR-002 D2：未知样式 id 一律拒载（不静默回退）——静默回退会让模板作者以为改了颜色，
    // 线上却没变，比加载失败更难查。错误带字段路径 + 实体位置。
    const styleIssues = validateStyleRefs(template, ui);
    if (styleIssues.length > 0) {
      throw new Error(
        `style_ref_invalid: ${styleIssues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      );
    }
    // ADR-004：加点节点引用的属性 / 预算参数是跨文件的，zod 看不到，必须在拿到
    // template + ui 之后交叉校验（与样式引用同一层、同一失败通道）。
    if (openingDag !== undefined) {
      const openingIssues = validateOpeningDag(openingDag, template, ui);
      if (openingIssues.length > 0) {
        throw new Error(
          `opening_invalid: ${openingIssues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
        );
      }
    }
    // ADR-003 D10：ui.yaml 的资源展示配置只能引用 world.yaml 已声明的资源。
    if (ui?.resources !== undefined) {
      const unknownResources = Object.keys(ui.resources).filter(
        (key) => template.resources[key] === undefined,
      );
      if (unknownResources.length > 0) {
        throw new Error(`ui.yaml: 未知资源：${unknownResources.join(", ")}（需先在 world.yaml resources 声明）`);
      }
    }
    // 人生页人物卡的属性清单（2026-11-19）：只能引用已声明属性，写错就拒载 ——
    // 静默跳过会让模板作者以为「这张卡应该显示等级」，线上却少一行。
    if (ui?.playerCard?.attributes !== undefined) {
      const unknownAttrs = ui.playerCard.attributes.filter(
        (key) => !template.attributes.order.includes(key),
      );
      if (unknownAttrs.length > 0) {
        throw new Error(
          `ui.yaml: playerCard 引用了未声明的属性：${unknownAttrs.join(", ")}（需先在 world.yaml attributes.order 声明）`,
        );
      }
    }
    // `ui.yaml` 进白名单但不进指纹：展示声明变更不废旧档（SPEC §1.5）。
    // 这里显式过滤，防止白名单数组后续调整时误把它算进语义指纹。
    //
    // 扩展版本也进指纹：模板里的 `extensions:` 只写 id + config，同样的 yaml 配上
    // 改过规则的扩展代码仍会算出不同结果 ⇒ 旧档必须拒载。`version` 缺省按 "*"，
    // 但扩展包改了行为就必须升版本，这是扩展作者的责任（见 SPEC §1.6 / §2.6）。
    // 指纹的组合规则（14 个文件 + 扩展版本）在加载器包里 —— 客户端下载模板后要算同一个数，
    // 两边各写一份迟早漂；`semanticFingerprintOf` 是唯一实现。
    const semanticFingerprint = semanticFingerprintOf(
      [...declarative].map((file) => ({ rel: file, content: source.read(file) })),
      template,
    );
    const entry: ReadyTemplateEntry = {
      ref,
      status: "ready",
      template,
      lookup: createLookup(template),
      openings,
      ...(openingDag !== undefined ? { openingDag } : {}),
      ...(endingConfig !== undefined ? { endingConfig } : {}),
      ...(evaluationConfig !== undefined ? { evaluationConfig } : {}),
      ...(rules !== undefined ? { rules } : {}),
      ...(lore !== undefined ? { lore } : {}),
      ...(assetManifest !== undefined ? { assetManifest } : {}),
      ...(ui !== undefined ? { ui } : {}),
      pipeline: {
        endingConfig,
        evaluationConfig,
        ...(lore !== undefined ? { lore } : {}),
      },
      semanticFingerprint,
      assetFingerprint: asset.fingerprint,
      assetCount: asset.count,
      mtime,
    };
    return { ok: true, entry };
  } catch (error) {
    const reasonCode = error instanceof TemplateLoadError ? error.reasonCode : undefined;
    return {
      ok: false,
      reason: `${keyOf(ref)}: ${firstIssue(error)}`,
      mtime,
      ...(reasonCode !== undefined ? { reasonCode } : {}),
    };
  }
}

interface ScanResult {
  entries: Map<string, TemplateEntry>;
  idDirs: Set<string>;
  versionDirs: Set<string>;
  /** 每个版本目录的变更检测基准（文件 mtime 最大值），含被忽略的空版本目录。 */
  mtimes: Map<string, number>;
}

/**
 * 全量扫描注册表。
 *
 * `failFast: true`（启动期 fail-fast，R-TG-04 的**六种**失败形态）：任一
 * 「含 ≥1 白名单 yaml 但加载失败」的版本、**`<id>/` 下出现不匹配 `^\d+(\.\d+){0,2}$` 的目录名**
 * （A-3 / B-4 #1）、或零模板 ⇒ 抛错，进程退出；**空的版本目录只 warn**（B-4 #3：
 * 那是 `mkdir` 还没 `cp` 完，与「版本号写错」的意图不同，不得混为一谈）。
 * `failFast: false`（运行期热加载，T-TG-11 复用）—— 该版本标 `invalid` + reason（或保留旧
 * Entry），非法版本名只 warn 一次 + 忽略，不影响其他版本、不退出进程（I-3）。
 */
function scanAll(dir: string, logger: TemplateScanLogger, failFast: boolean): ScanResult {
  const entries = new Map<string, TemplateEntry>();
  const idDirs = new Set<string>();
  const versionDirs = new Set<string>();
  const mtimes = new Map<string, number>();
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
        // A-3 / B-4 #1：版本号格式由目录名承载。启动期遇到这种目录**必须拒绝启动**——
        // 它和「空版本目录」是两种意图：空目录是 mkdir 了还没 cp（B-4 #3，warn 跳过），
        // 而「11 个合法 yaml 装在 v2/ 里」是明确想做模板、只是版本号写错；
        // 静默跳过会让运维对着「我放了模板但列表里没有」查半天。
        if (failFast) {
          throw new Error(
            `template_version_dir_invalid: <id>=${id} 下存在目录 "${version}"，` +
              `但版本目录名必须是 ^\\d+(\\.\\d+){0,2}$（例如 1.0.0、2、1.2.3）；路径：${path.join(idDir, version)}`,
          );
        }
        logger.warn(
          { templateId: id, dir: version },
          "template_version_dir_ignored: 版本目录名不匹配 ^\\d+(\\.\\d+){0,2}$",
        );
        continue;
      }
      versionDirs.add(keyOf({ id, version }));
      const versionDir = path.join(idDir, version);
      // 变更检测基准：即便该版本是空目录 / 坏模板也要记，运行期才不会每次请求重扫。
      let mtime = 0;
      try {
        mtime = versionMaxMtime(versionDir);
      } catch {
        mtime = 0; // 读不了就当 0：由 scanVersion 给出可诊断原因
      }
      mtimes.set(keyOf({ id, version }), mtime);
      const scan = scanVersion(id, version, versionDir, logger);
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
        // 例外：封装码类失败不是「yaml 写错了」而是「能力对不上」——
        // `unknown_extension` 是服务端没装那个扩展包；`unknown_effect_type` /
        // `unknown_condition_op` 是模板要的能力没有任何已声明扩展提供。
        // 为此拒整个进程不合理（其它模板照样能玩），所以启动期也只标该版本不可载 ——
        // 与运行期同一个收敛形状，玩家侧看到 `loadable:false` + 封闭码，服务继续起。
        if (scan.reasonCode !== undefined && SOFT_REASON_CODES.has(scan.reasonCode)) {
          logger.error(
            { templateId: id, version, reason: scan.reason, reasonCode: scan.reasonCode },
            "template_capability_missing: 该版本不可载（服务继续启动）",
          );
          entries.set(keyOf({ id, version }), {
            ref: { id, version },
            status: "invalid",
            reason: scan.reason,
            reasonCode: scan.reasonCode,
            mtime: scan.mtime,
          });
          continue;
        }
        throw new Error(`${scan.reasonCode ?? "template_invalid"}: ${scan.reason}`);
      }
      logger.error({ templateId: id, version, reason: scan.reason }, "template_reload_failed");
      entries.set(keyOf({ id, version }), {
        ref: { id, version },
        status: "invalid",
        reason: scan.reason,
        ...(scan.reasonCode !== undefined ? { reasonCode: scan.reasonCode } : {}),
        mtime: scan.mtime,
      });
    }
  }
  return { entries, idDirs, versionDirs, mtimes };
}

function createRegistry(dir: string, result: ScanResult, logger: TemplateScanLogger): TemplateRegistry {
  const byKey = new Map(result.entries);
  const ids = new Set(result.idDirs);
  const versionDirs = new Set(result.versionDirs);
  const mtimeByKey = new Map(result.mtimes);
  const counters = { statCount: 0, rescanCount: 0 };
  let rootMissingLogged = false;
  /** 运行期非法版本目录名的「只警告一次」去重（`id/目录名`）。 */
  const warnedVersionDirs = new Set<string>();

  /** 纯读（不刷新）：`listTemplates` 内部用，避免一次调用多次 ensureFresh。 */
  const entriesOf = (id: string): TemplateEntry[] =>
    [...byKey.values()].filter((entry) => entry.ref.id === id);

  /**
   * 单个版本重扫（I-3：**运行期隔离，绝不 throw、绝不退出进程**）。
   *
   * - 成功 ⇒ 换入新 Entry（同 `(id,version)` 内容变了就顶替旧的，I-1）；
   * - 失败 ⇒ 有旧 Entry 就**保留旧 Entry 继续服务** + `log.error`（含目录与原因）；
   *   没有旧 Entry 才标 `invalid`（带 reason），其余版本与进程不受影响；
   * - 变成空目录 ⇒ 移除 Entry（不再是模板版本）。
   */
  function reloadVersion(id: string, version: string, versionDir: string, mtime: number): void {
    const key = keyOf({ id, version });
    const previous = byKey.get(key);
    let scan: VersionScan | null;
    try {
      scan = scanVersion(id, version, versionDir, logger);
    } catch (error) {
      // scanVersion 已把已知失败收敛成返回值；这里兜住意料之外的异常，同样不向上抛。
      logger.error(
        { templateId: id, version, dir: versionDir, reason: firstIssue(error) },
        "template_reload_failed: 保留旧 Entry 继续服务",
      );
      return;
    }
    if (scan === null) {
      byKey.delete(key);
      logger.warn(
        { templateId: id, version },
        "template_version_empty: 版本目录内已无任何白名单 yaml，移除该版本",
      );
      return;
    }
    if (scan.ok) {
      byKey.set(key, scan.entry);
      logger.info({ templateId: id, version, fingerprint: scan.entry.semanticFingerprint }, "template_reloaded");
      return;
    }
    if (previous) {
      logger.error(
        { templateId: id, version, dir: versionDir, reason: scan.reason },
        "template_reload_failed: 保留旧 Entry 继续服务",
      );
      return;
    }
    logger.error(
      { templateId: id, version, dir: versionDir, reason: scan.reason },
      "template_reload_failed: 无旧 Entry，标 invalid",
    );
    byKey.set(key, {
      ref: { id, version },
      status: "invalid",
      reason: scan.reason,
      ...(scan.reasonCode !== undefined ? { reasonCode: scan.reasonCode } : {}),
      mtime,
    });
  }

  /**
   * 请求驱动热加载（I-1 / R-TG-16）：比对每个 `<id>/<version>` 的**文件 mtime 最大值**
   * （顶层文件 + `assets/**` 递归，不是目录 mtime），只重扫变化的版本。
   *
   * - 无定时器、无文件监听 API（AC⑦，全仓 grep 零命中）；每次调用只做 `stat`，
   *   未变化时**不重解析 yaml**（AC⑧）；
   * - 新增版本目录 ⇒ 立即注册；版本目录消失 ⇒ 移除 Entry（I-4）；
   * - 只影响新建世界与后续载入：已载入世界的 `record.entry` 是快照，不被回溯改写（I-2）。
   *
   * 已知局限：受 mtime 精度与竞态影响，最多**晚一次请求**才看到变更。
   */
  function ensureFresh(): void {
    if (!existsSync(dir)) {
      if (!rootMissingLogged) {
        logger.error({ dir }, "templates_dir_missing: 运行期模板根目录消失，注册表清空");
        rootMissingLogged = true;
      }
      byKey.clear();
      ids.clear();
      versionDirs.clear();
      mtimeByKey.clear();
      return;
    }
    rootMissingLogged = false;

    const seenKeys = new Set<string>();
    const seenIds = new Set<string>();
    for (const idEntry of readdirSync(dir, { withFileTypes: true })) {
      if (!idEntry.isDirectory()) continue; // 启动期已 warn 过，运行期不重复刷日志
      const id = idEntry.name;
      seenIds.add(id);
      for (const versionEntry of readdirSync(path.join(dir, id), { withFileTypes: true })) {
        if (!versionEntry.isDirectory()) continue;
        const version = versionEntry.name;
        if (!VERSION_PATTERN.test(version)) {
          // 运行期只 warn + 忽略（I-3）：不能因为有人刚 mkdir 了个 v2/ 的手滑就把服务打挂。
          // 每个 (id, 目录名) 只警告一次，避免按请求频率灌日志；启动期这种目录会直接 throw。
          if (!warnedVersionDirs.has(`${id}/${version}`)) {
            warnedVersionDirs.add(`${id}/${version}`);
            logger.warn(
              { templateId: id, dir: version },
              "template_version_dir_ignored: 版本目录名不匹配 ^\\d+(\\.\\d+){0,2}$（运行期忽略，不阻断服务）",
            );
          }
          continue;
        }
        const key = keyOf({ id, version });
        seenKeys.add(key);
        const versionDir = path.join(dir, id, version);
        let mtime: number;
        try {
          mtime = versionMaxMtime(versionDir, () => {
            counters.statCount += 1;
          });
        } catch (error) {
          logger.error({ templateId: id, version, dir: versionDir, reason: firstIssue(error) }, "template_stat_failed");
          continue; // 保留现状：读不了不改判定
        }
        if (mtimeByKey.get(key) === mtime) continue; // AC⑥：mtime 未变 ⇒ 不重扫
        mtimeByKey.set(key, mtime);
        counters.rescanCount += 1;
        reloadVersion(id, version, versionDir, mtime);
      }
    }

    // 目录被删 / 改名 ⇒ 移除 Entry（I-4）；已载入世界靠 record.entry 快照继续跑。
    for (const key of [...byKey.keys()]) {
      if (!seenKeys.has(key)) {
        const entry = byKey.get(key)!;
        byKey.delete(key);
        logger.warn({ templateId: entry.ref.id, version: entry.ref.version }, "template_version_removed: 版本目录已消失");
      }
    }
    for (const key of [...mtimeByKey.keys()]) if (!seenKeys.has(key)) mtimeByKey.delete(key);

    ids.clear();
    for (const id of seenIds) ids.add(id);
    versionDirs.clear();
    for (const key of seenKeys) versionDirs.add(key);
  }

  /** 两级列表（纯函数投影，供 `listTemplates` 使用）。 */
  function buildList(): TemplateSummary[] {
    const grouped = new Map<string, TemplateEntry[]>();
    for (const entry of byKey.values()) {
      const list = grouped.get(entry.ref.id);
      if (list) list.push(entry);
      else grouped.set(entry.ref.id, [entry]);
    }
    return [...grouped.keys()].sort().map((id) => {
      const list = entriesOf(id).sort((a, b) => compareVersions(a.ref.version, b.ref.version));
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
              ...(entry.openingDag !== undefined
                ? {
                    openingDag: {
                      openingId: entry.openingDag.openingId,
                      name: entry.openingDag.name,
                      ...(entry.openingDag.description !== undefined
                        ? { description: entry.openingDag.description }
                        : {}),
                    },
                  }
                : {}),
              fingerprint: entry.semanticFingerprint,
              assetCount: entry.assetCount,
              assetFingerprint: entry.assetFingerprint,
              // T-06：assetId 列表 + kind + characterRef；不下发 path / 二进制。
              assets: readAssetEntries(entry.assetManifest).map((a) => ({
                assetId: a.assetId,
                kind: a.kind,
                ...(a.characterRef !== undefined ? { characterRef: a.characterRef } : {}),
              })),
              loadable: true,
            }
          : {
              id,
              version: entry.ref.version,
              loadable: false,
              reason: entry.reason,
              ...(entry.reasonCode !== undefined ? { reasonCode: entry.reasonCode } : {}),
            },
      );
      const nameOfStart = start?.status === "ready" ? start.template.meta.name : (start?.ref.id ?? id);
      return {
        id,
        name: nameOfStart,
        // 隐藏模板：注册表照常收录（inspect / 体检要看得见），列表端点自己过滤。
        ...(start?.status === "ready" && start.template.meta.hidden === true ? { hidden: true } : {}),
        ...(start !== undefined ? { startVersion: start.ref.version } : {}),
        versions,
      };
    });
  }

  return {
    dir,
    ensureFresh,
    idExists: (id) => ids.has(id),
    versionDirExists: (id, version) => versionDirs.has(keyOf({ id, version })),
    get: (ref) => byKey.get(keyOf(ref)),
    resolve: (ref) => {
      ensureFresh();
      const entry = byKey.get(keyOf(ref));
      return entry?.status === "ready" ? entry : undefined;
    },
    versionsOf: (id) => {
      ensureFresh();
      return entriesOf(id);
    },
    listTemplates: () => {
      ensureFresh();
      return buildList();
    },
    diagnostics: () => ({ statCount: counters.statCount, rescanCount: counters.rescanCount }),
  };
}

/**
 * 启动期加载（R-TG-04 fail-fast）：扫描 `TEMPLATES_DIR/<id>/<version>/`，任一含 yaml 的
 * 版本校验失败 / `meta.id` ≠ 目录名 ⇒ 抛错（进程退出）；整个目录零模板 ⇒ 抛错。
 * 之后的变更由 `registry.ensureFresh()` 在请求驱动下增量换入（T-TG-11）。
 */
/**
 * 读取一个版本的**声明式文件正文**（模板包端点用）。
 *
 * 只读白名单里的文本文件（含 `assets/manifest.yaml`），不含资产二进制：
 * 包回答的是「这个世界能不能起来」，二进制仍走按 assetId 的下载端点。
 * 与 `scanVersion` 用同一个 `FsTemplateSource`，不另写一套读取逻辑。
 */
export function readDeclarativeFiles(ref: TemplateRef): Record<string, string> {
  const source = new FsTemplateSource(path.join(templatesDir(), ref.id, ref.version));
  const files: Record<string, string> = {};
  for (const rel of DECLARATIVE_FILES) {
    if (source.exists(rel)) files[rel] = source.read(rel);
  }
  return files;
}

export function loadTemplates(logger: TemplateScanLogger): TemplateRegistry {
  const dir = templatesDir();
  const result = scanAll(dir, logger, true);
  const readyCount = [...result.entries.values()].filter((e) => e.status === "ready").length;
  if (readyCount === 0) throw new Error(`no_templates_found_in: ${dir}`);
  return createRegistry(dir, result, logger);
}
