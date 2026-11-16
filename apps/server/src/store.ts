import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ContentBlock, LlmTrace, OpeningTemplate, WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
import { LlmTraceSchema, WorldStateV2Schema } from "@life-sim/shared";
import {
  createDefaultOpeningTemplate,
  createRunnerContext,
  createWorldV2,
  handoff,
  revalidateSlot,
  runOpening,
  selectOpeningTemplate,
  type OpeningRunnerContext,
} from "@life-sim/game-core";
import type { ReadyTemplateEntry, TemplateRegistry } from "./templates.js";

/**
 * 世界仓储（R-PS-01..06 / ADR-0007 / ADR-0029）：
 * - 内存 Map 为主存取层，落盘为持久层（save / seal / create 内同步写）；
 * - 单局一文件 `<worldId>.json`，信封
 *   `{ schemaVersion: 2, savedAt, templateId, templateVersion?, templateFingerprint, state }`；
 * - **模板引用是存档事实、不可变**（R-TG-08）：`persist()` 只读该世界 record 里的
 *   `entry.ref` + `entry.semanticFingerprint`，**不查全局注册表、不写占位符**
 *   （旧的「全局指纹查表 + 占位符指纹」已删除）；
 * - 原子写：`.tmp` + rename，失败删 tmp 并抛错（不吞异常）；
 * - 数据目录：默认仓库根 `data/worlds/`（按模块位置解析，不依赖 cwd），
 *   `LIFE_SIM_DATA_DIR` 环境变量可覆盖为任意绝对路径以支持挂载（2026-11-11 用户裁决）。
 */

/**
 * 信封版本（F3 / T-07）：**3 → 4**。
 *
 * 4 的破坏面：`WorldStateV2` 改状态模型（锚点 / `traceRef` 进存档、LLM 叙事正文只进
 * append-only `*.trace.jsonl`、不进 state）。本次**不做迁移 / 不推断版本 / 不回填**：
 * schemaVersion !== 4 的旧档（含全部 v3 档）一律走封闭拒载码
 * `envelope_schema_version_unsupported`，世界列表仍可见 + 可删（用户 2026-11-15
 * 已明确接受「旧档再次拒载」这个代价）。
 *
 * 历史：R2.5 升 1 → 2；ADR-0034 §5 升 2 → 3；F3 升 3 → 4。
 */
const SCHEMA_VERSION = 4;

/** 内存保存时间（savedAt），列表接口按其倒序。 */
const savedAtById = new Map<string, string>();

interface StoreEnvelope {
  schemaVersion: number;
  savedAt: string;
  templateId: string;
  /** R2.8 / C-1：可选。缺失时启动期按 C-2 唯一性推断并原子回填。 */
  templateVersion?: string;
  /** 语义指纹（H-8：字段名保持不变；语义 ≙ `semanticFingerprint`）。 */
  templateFingerprint: string;
  /** F3：叙事 trace 引用（不承载正文，正文只在 append-only `*.trace.jsonl`）。 */
  traceRef?: string;
  /** F3：trace 内叙事段定位锚（不承载正文）。 */
  contentRef?: string;
  /** 分叉③ A：展示完整性锚，写入信封但**不参与拒载**（缺失 / 变化 ⇒ 立绘降级，世界仍可载）。 */
  assetFingerprint?: string;
  state: WorldStateV2;
}

/**
 * R2.8 / C-4：**封闭**拒载原因枚举（无自由文本 code）。模板侧四码必须分列：
 * `template_missing`（`<id>` 目录没了）/ `template_version_missing`（版本目录没了）/
 * `template_invalid`（目录在但加载失败）/ `template_version_ambiguous`（≥2 版本且信封
 * 无 `templateVersion`）——合并即失去可诊断性。
 */
export type UnloadableReason =
  | "envelope_json_invalid"
  | "envelope_schema_version_unsupported"
  | "template_missing"
  | "template_version_missing"
  | "template_version_ambiguous"
  | "template_invalid"
  | "template_content_drift"
  | "world_state_invalid";

/** 「存在但不可载」的世界条目（R-TG-10 / C-5：列表可见、可删、带封闭 reason）。 */
export interface UnloadableWorld {
  /** 世界 id（= 文件名基名，与 `worldFile()` 同一口径）。 */
  id: string;
  file: string;
  reason: UnloadableReason;
  /** 具体对象（可诊断）：哪个文件 / 哪个 `(id,version)` / 哪个字段路径。 */
  detail: string;
  templateId?: string;
  templateVersion?: string;
  savedAt?: string;
}

/**
 * 已载入世界记录（R2.8 / I-2 + C-6：**一条 record 同时承载内存快照与固化 ref**，
 * 不开两个 Map）。`entry` 里的模板对象与 lookup 是这一局的快照——热加载替换注册表
 * Entry 不改变它，因此「运行中改 yaml」不会让在跑世界中途换语义。
 */
export interface WorldRecord {
  state: WorldStateV2;
  entry: ReadyTemplateEntry;
}

export function dataDir(): string {
  const override = process.env.LIFE_SIM_DATA_DIR;
  if (override && override.trim() !== "") return path.resolve(override);
  // apps/server/src → 仓库根/data/worlds（与 templates.ts 的仓库根解析一致，不依赖 cwd）
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data/worlds");
}

function worldFile(id: string): string {
  // id 为 randomUUID，无路径分隔符风险；防御性校验兜底
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`invalid_world_id: ${id}`);
  }
  return path.join(dataDir(), `${id}.json`);
}

/**
 * F3 / T-07：叙事正文 append-only trace 文件路径（`data/worlds/<worldId>.trace.jsonl`），
 * 与存档同目录；随 `worldStore.delete` 一并清理。正文写入见 `appendTrace`（同一文件下方）。
 */
export function traceFile(worldId: string): string {
  // 与 worldFile 同一口径的防御性校验，避免 worldId 里夹路径分隔符读到目录外
  if (worldId.includes("/") || worldId.includes("\\") || worldId.includes("..")) {
    throw new Error(`invalid_world_id: ${worldId}`);
  }
  return path.join(dataDir(), `${worldId}.trace.jsonl`);
}

/** 内容块只挑契约字段：`maskText` 可以留在 trace 元数据里，其余自由字段一律丢弃。 */
function pickContentBlock(block: ContentBlock): ContentBlock {
  return {
    blockId: block.blockId,
    kind: block.kind,
    ...(block.text !== undefined ? { text: block.text } : {}),
    refs: [...block.refs],
    visibility: block.visibility,
    targetPerspective: block.targetPerspective,
    ...(block.maskText !== undefined ? { maskText: block.maskText } : {}),
    ...(block.assetId !== undefined ? { assetId: block.assetId } : {}),
    ...(block.slot !== undefined ? { slot: block.slot } : {}),
  };
}

/**
 * F3 / T-07 写入侧：把一条 `LlmTrace` **追加**到 `data/worlds/<worldId>.trace.jsonl`。
 *
 * - 只接受完整 `LlmTrace`（agent-runtime 产出的对象）；函数内部**逐字段重建**再
 *   `LlmTraceSchema.parse`，因此调用方误挂的额外字段（apiKey / prompt / 原始响应）永远进不了磁盘。
 * - append-only：只 `appendFileSync`，绝不重写 / 截断既有行；损坏行由读侧跳过。
 * - 叙事正文只落这里，`WorldStateV2` 只保留 `traceRef`（F3 硬不变量）。
 */
export function appendTrace(worldId: string, trace: LlmTrace): void {
  const sanitized: LlmTrace = {
    invocationId: trace.invocationId,
    turnIndex: trace.turnIndex,
    worldTime: trace.worldTime,
    reason: trace.reason,
    contextHash: trace.contextHash,
    toolProfile: trace.toolProfile,
    callsHash: trace.callsHash,
    receipts: trace.receipts.map((receipt) => ({
      callId: receipt.callId,
      outcome: receipt.outcome,
      ...(receipt.code !== undefined ? { code: receipt.code } : {}),
      ...(receipt.detail !== undefined ? { detail: receipt.detail } : {}),
      ...(receipt.changes !== undefined ? { changes: receipt.changes.map((c) => ({ ...c })) } : {}),
      ...(receipt.factsHint !== undefined ? { factsHint: { ...receipt.factsHint } } : {}),
    })),
    diagnostics: [...trace.diagnostics],
    inputTokens: trace.inputTokens,
    outputTokens: trace.outputTokens,
    latencyMs: trace.latencyMs,
    outcome: trace.outcome,
    ...(trace.fallbackCode !== undefined ? { fallbackCode: trace.fallbackCode } : {}),
    templateRef: trace.templateRef,
    ...(trace.contentBlocks !== undefined
      ? { contentBlocks: trace.contentBlocks.map(pickContentBlock) }
      : {}),
    /**
     * ⚠ 这里逐字段重建 trace，**新增字段必须同步加进来**，否则会被静默丢掉
     * （`calls` 就踩过这个坑：agent-runtime 明明写了，落盘却看不到）。
     * 之所以不用 spread：contentBlock / factsHint 需要脱敏与白名单。
     */
    ...(trace.calls !== undefined ? { calls: trace.calls.map((call) => ({ ...call })) } : {}),
  };
  const parsed = LlmTraceSchema.parse(sanitized);
  const file = traceFile(worldId);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(parsed)}\n`, "utf-8");
}

/** trace 文件是否存在（读侧用于区分「没有叙事」与「文件缺失」）。 */
export function traceExists(worldId: string): boolean {
  return existsSync(traceFile(worldId));
}

/** 信封原子写（R-PS-03）：tmp → rename；失败删 tmp 并把错误抛给调用方。 */
function writeEnvelopeAtomic(target: string, envelope: StoreEnvelope): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(envelope, null, 2), "utf-8");
    renameSync(tmp, target); // 同分区原子替换
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // 清理失败不掩盖原错误
    }
    throw error;
  }
}

/**
 * 落盘（R-TG-08 AC①/②/③）：模板引用三元组只从该世界 record 的 `entry` 取——
 * 建局后替换或删除该版本目录，信封三元组仍逐字节不变。缺 record ⇒
 * `template_ref_missing`（500），**严禁**回落全局查表或占位符指纹。
 */
function persist(state: WorldStateV2): void {
  const record = worlds.get(state.id);
  if (!record) throw new Error(`template_ref_missing: ${state.id}`);
  const savedAt = new Date().toISOString();
  const envelope: StoreEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    savedAt,
    templateId: record.entry.ref.id,
    templateVersion: record.entry.ref.version,
    templateFingerprint: record.entry.semanticFingerprint,
    // F3：只落引用锚，不落正文（正文在 append-only `<worldId>.trace.jsonl`）。
    ...(state.traceRef !== undefined ? { traceRef: state.traceRef } : {}),
    // `contentRef` 是该 trace 内叙事段的定位锚，与 `traceRef` 同源、不承载正文。
    ...(state.traceRef !== undefined ? { contentRef: state.traceRef } : {}),
    // 分叉③ A：展示完整性锚，写入信封但**不参与**载入期拒载判定。
    ...(record.entry.assetFingerprint !== undefined
      ? { assetFingerprint: record.entry.assetFingerprint }
      : {}),
    state,
  };
  writeEnvelopeAtomic(worldFile(state.id), envelope);
  savedAtById.set(state.id, savedAt);
}

const worlds = new Map<string, WorldRecord>();

/** 「存在但不可载」的档（R-TG-10 / C-5）：启动期收集，供列表接口下发与按 id 删除。 */
const unloadableById = new Map<string, UnloadableWorld>();

/**
 * 启动加载（R-PS-05 / C-2 / C-3 / C-4）：逐档校验，任一关不过 ⇒ 收进「存在但不可载」
 * 条目（带封闭 reason + 具体对象），**不阻断启动、不静默消失**。
 *
 * 判定顺序写死「**先定版本、再比指纹**」（C-2）：
 * JSON.parse → schemaVersion → `(id,version)` 解析（含唯一性推断与回填）→ 语义指纹 → state schema。
 */
export function loadPersistedWorlds(registry: TemplateRegistry): {
  loaded: WorldRecord[];
  unloadable: UnloadableWorld[];
} {
  const dir = dataDir();
  const loaded: WorldRecord[] = [];
  const unloadable: UnloadableWorld[] = [];
  unloadableById.clear();
  if (!existsSync(dir)) return { loaded, unloadable };

  for (const fileName of readdirSync(dir)) {
    if (!fileName.endsWith(".json")) continue; // 跳过 <id>.json.tmp 等中间文件
    const file = path.join(dir, fileName);
    const worldId = fileName.slice(0, -".json".length);

    const reject = (
      reason: UnloadableReason,
      detail: string,
      refs: { templateId?: string; templateVersion?: string; savedAt?: string } = {},
    ): void => {
      const entry: UnloadableWorld = { id: worldId, file, reason, detail, ...refs };
      unloadable.push(entry);
      unloadableById.set(entry.id, entry);
    };

    let envelope: StoreEnvelope;
    try {
      envelope = JSON.parse(readFileSync(file, "utf-8")) as StoreEnvelope;
    } catch (error) {
      reject("envelope_json_invalid", `${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (envelope === null || typeof envelope !== "object") {
      reject("envelope_json_invalid", `${file}: 信封不是对象`);
      continue;
    }

    const savedAt = typeof envelope.savedAt === "string" ? envelope.savedAt : undefined;
    if (envelope.schemaVersion !== SCHEMA_VERSION) {
      reject(
        "envelope_schema_version_unsupported",
        `${file}: schemaVersion=${String(envelope.schemaVersion)}（期望 ${SCHEMA_VERSION}）`,
        { savedAt },
      );
      continue;
    }

    const templateId = envelope.templateId;
    if (typeof templateId !== "string" || templateId === "") {
      reject("template_missing", `${file}: 信封缺少 templateId`, { savedAt });
      continue;
    }
    const envelopeVersion =
      typeof envelope.templateVersion === "string" && envelope.templateVersion !== ""
        ? envelope.templateVersion
        : undefined;
    const refs: { templateId: string; templateVersion?: string; savedAt?: string } = {
      templateId,
      ...(envelopeVersion !== undefined ? { templateVersion: envelopeVersion } : {}),
      ...(savedAt !== undefined ? { savedAt } : {}),
    };

    // ① 先定版本（C-2）。
    if (!registry.idExists(templateId)) {
      reject("template_missing", `<id>=${templateId} 的模板目录不存在`, refs);
      continue;
    }
    let version = envelopeVersion;
    if (version === undefined) {
      const versions = registry.versionsOf(templateId);
      if (versions.length === 0) {
        reject(
          "template_missing",
          `<id>=${templateId} 下没有任何已注册版本，信封亦无 templateVersion`,
          refs,
        );
        continue;
      }
      if (versions.length > 1) {
        reject(
          "template_version_ambiguous",
          `<id>=${templateId} 注册了 ${versions.length} 个版本（${versions
            .map((v) => v.ref.version)
            .join(", ")}），信封缺 templateVersion，需手工补填`,
          refs,
        );
        continue;
      }
      version = versions[0]!.ref.version;
    }
    const entry = registry.get({ id: templateId, version });
    if (!entry) {
      reject(
        "template_version_missing",
        registry.versionDirExists(templateId, version)
          ? `<id>=${templateId} 下 <version>=${version} 目录存在，但无任何白名单 yaml（未注册为模板版本）`
          : `<id>=${templateId} 下 <version>=${version} 目录不存在`,
        refs,
      );
      continue;
    }
    if (entry.status !== "ready") {
      reject("template_invalid", entry.reason, refs);
      continue;
    }

    // ② 再比指纹（C-3）：基准 = 该版本目录**实时重算**的语义指纹。
    if (envelope.templateFingerprint !== entry.semanticFingerprint) {
      reject(
        "template_content_drift",
        `${templateId}@${version}: 信封 templateFingerprint=${String(
          envelope.templateFingerprint,
        )}，磁盘实时语义指纹=${entry.semanticFingerprint}`,
        refs,
      );
      continue;
    }

    // ③ state schema。
    const parsed = WorldStateV2Schema.safeParse(envelope.state);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      reject("world_state_invalid", `${file}: ${issue?.path.join(".") || "<root>"}: ${issue?.message}`, refs);
      continue;
    }

    // 回填（C-2）：唯一性推断成功且信封缺 templateVersion ⇒ 原子重写**只加这一个字段**。
    // 不走 save()——这是信封迁移，不是状态写入；不动 state、不动 archived。
    if (envelopeVersion === undefined) {
      writeEnvelopeAtomic(file, {
        schemaVersion: envelope.schemaVersion,
        savedAt: envelope.savedAt,
        templateId: envelope.templateId,
        templateVersion: version,
        templateFingerprint: envelope.templateFingerprint,
        // 迁移只补 `templateVersion`：F3 引用锚 / 展示锚逐字段保留。
        ...(envelope.traceRef !== undefined ? { traceRef: envelope.traceRef } : {}),
        ...(envelope.contentRef !== undefined ? { contentRef: envelope.contentRef } : {}),
        ...(envelope.assetFingerprint !== undefined
          ? { assetFingerprint: envelope.assetFingerprint }
          : {}),
        state: envelope.state,
      });
    }

    loaded.push({ state: parsed.data as WorldStateV2, entry });
    savedAtById.set(parsed.data.id, envelope.savedAt);
  }
  return { loaded, unloadable };
}

/**
 * 启动时把校验通过的存档装入内存（`loadPersistedWorlds` 之后、`listen` 之前调用一次）。
 *
 * ADR-0024 决策 2.3 #5：载入即规范化一次 —— 旧档 / 手改档里可能残留「前提已失效」的待决事件
 * （例如排队期间角色已死的旧场景）。这里逐世界跑一次复核，有变更立即回写，
 * 免得玩家载入后第一屏就看到一个不该存在的场景。
 *
 * 模板不可解析的档在 `loadPersistedWorlds` 就已收进不可载条目，因此这条是**防御性冗余**；
 * 成本约一行、幂等，且覆盖夹具与手改存档。
 */
export function hydrate(records: readonly WorldRecord[]): void {
  for (const record of records) {
    const { dropped } = revalidateSlot(record.state, record.entry.lookup);
    worlds.set(record.state.id, record);
    if (dropped.length > 0) persist(record.state);
  }
}

export interface CreateWorldInputV2 {
  templateId: string;
  playerName: string;
  seed?: number;
  /** R-OP-01：多开局模板时按 openingId 选择；省略则取加载顺序首个。 */
  openingId?: string;
}

export const worldStore = {
  /**
   * 建局（R-TG-08 / I-2）：`entry` 由调用方从注册表 `resolve()` 得来（不信客户端字段），
   * 同时写入「内存快照」与「固化 ref」——一条 record 两面。
   */
  create(input: CreateWorldInputV2, entry: ReadyTemplateEntry): WorldStateV2 {
    // 第 4 参 `ctx` 刻意仍传 `undefined`：不传 ctx ⇒ 沿用 `Math.random()` 派生 seed 的既有口径，
    // 改成 `createRunnerContext(...)` 会改变建局 seed 的来源，破坏确定性复现。
    const base = createWorldV2(input, entry.template, randomUUID(), undefined);
    // 开局为可选分域：提供 opening.yaml 时跑自定义开局，否则用最小默认开局；
    // 两条路径都执行 runOpening + handoff，使新世界 openingCompleted === true。
    // 本轮按 openingId 选择（R-OP-01）；未指定时取加载顺序首个。
    const selected = selectOpeningTemplate(entry.openings, input.openingId);
    if (input.openingId !== undefined && !selected) {
      // 路由层已返回 404；store 层再做一次防御性拒绝，避免静默回退到默认开局。
      throw new Error(`opening_not_found: ${input.openingId}`);
    }
    const tpl: OpeningTemplate = selected ?? createDefaultOpeningTemplate();
    const ctx: OpeningRunnerContext = {
      ...createRunnerContext(base.seed),
      lookup: entry.lookup,
    };
    const { state: opened, run } = runOpening(base, tpl, ctx);
    const world = handoff(opened, run, ctx.lookup);
    worlds.set(world.id, { state: world, entry });
    unloadableById.delete(world.id);
    persist(world);
    return world;
  },
  get(id: string): WorldRecord | undefined {
    return worlds.get(id);
  },
  save(state: WorldStateV2): void {
    // R-AR-02 / R-EV-06 / P3：归档只读。已归档世界（store 内或传入状态）拒绝任何写入。
    const existing = worlds.get(state.id);
    if (state.archived === true || existing?.state.archived === true) {
      throw new Error("[ARCHIVED] 本局已归档，只读，拒绝写入世界状态");
    }
    // 模板引用沿用建局/载入时固化的那一份，不随注册表变化（R-TG-08）。
    if (!existing) throw new Error(`template_ref_missing: ${state.id}`);
    worlds.set(state.id, { state, entry: existing.entry });
    persist(state);
  },
  /**
   * 归档封存入口（#30 遗留补齐）：把已终止世界置 archived=true 并落库+落盘。
   * 这是 save() 的**唯一**例外通道——save() 拒绝 archived 写入，封存必须走这里。
   * 未终止世界拒绝封存（R-AR-01 需要终止记录）。
   */
  seal(state: WorldStateV2): WorldStateV2 {
    if (state.termination === null) {
      throw new Error("[archive_requires_termination] 尚未终止，拒绝归档");
    }
    const sealed: WorldStateV2 = state.archived === true ? state : { ...state, archived: true };
    const existing = worlds.get(sealed.id);
    if (!existing) throw new Error(`template_ref_missing: ${sealed.id}`);
    worlds.set(sealed.id, { state: sealed, entry: existing.entry });
    persist(sealed);
    return sealed;
  },
  /** savedAt（最近保存时间），世界不存在时返回 undefined。 */
  savedAt(id: string): string | undefined {
    return savedAtById.get(id);
  },
  /** 全部可载世界（供列表接口；排序由调用方决定）。 */
  all(): WorldRecord[] {
    return [...worlds.values()];
  },
  /** 全部「存在但不可载」的档（R-TG-10 / C-5：列表可见、可删）。 */
  unloadableAll(): UnloadableWorld[] {
    return [...unloadableById.values()];
  },
  /** 按 id 查不可载条目（`GET /api/worlds/:id` 据此返回 409 而非 404）。 */
  unloadable(id: string): UnloadableWorld | undefined {
    return unloadableById.get(id);
  },
  /**
   * 删除世界（R-PS-04）：删文件 + 删内存条目。不存在时报错由路由层映射 404。
   * 归档世界也可删除——删除是管理操作，不受只读门禁约束（否则目录只增不减）。
   * R-TG-10 AC①：**不可载的档同样允许删除**，否则坏档永久滞留。
   */
  delete(id: string): void {
    const file = worldFile(id);
    const hasFile = existsSync(file);
    if (!worlds.has(id) && !hasFile) throw new Error("world_not_found");
    worlds.delete(id);
    savedAtById.delete(id);
    unloadableById.delete(id);
    if (hasFile) unlinkSync(file);
    // F3：一并清理 append-only trace 文件（找不到 / 读不了都忽略，不影响删除结果）。
    try {
      const trace = traceFile(id);
      if (existsSync(trace)) unlinkSync(trace);
    } catch {
      // 清理失败不掩盖删除结果
    }
  },
};

export type { WorldTemplateV2 };
