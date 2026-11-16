import Fastify from "fastify";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import {
  advanceTurnV2,
  assembleArchive,
  battleActionV2,
  buildEndingNarrativeRequest,
  buildEvaluationSummaryRequest,
  chooseOptionV2,
  createDefaultEndingConfig,
  createRunnerContext,
  createTimeAdapter,
  equipErrorCodeOf,
  equipV2,
  evaluateLifeV2,
  finalizeEvaluationSummary,
  playerVisibleEntries,
  projectArchiveForPlayer,
  projectSnapshotV2,
  resolveEnding,
  unequipV2,
  useItemV2,
  visibleFactRefs,
  type ConditionContext,
  type TurnPipelineConfig,
} from "@life-sim/game-core";
import { pipelineForTurn, resolveAgentConfig } from "./agent/pipeline.js";
import {
  BattleCommandSchema,
  EndingNarrativeOutputSchema,
  EvaluationSummaryOutputSchema,
  TURN_ACTION_DESCRIPTION_MAX,
  TURN_ACTION_TYPE_MAX,
} from "@life-sim/shared";
import type {
  EndingConfig,
  EndingRecord,
  EndingView,
  Perspective,
  V2Snapshot,
  V2TurnResult,
  WorldStateV2,
} from "@life-sim/shared";
import { compareVersions, loadTemplates, readAssetEntries, type ReadyTemplateEntry } from "./templates.js";
import { dataDir, hydrate, loadPersistedWorlds, worldStore } from "./store.js";
import { createLLMProvider, readLLMConfig, resolveProviderForRequest, type LLMProvider } from "./llm/provider.js";
import { userCredentials } from "./llm/userCredentials.js";
import { probeLlmConnectivity } from "./llm/probe.js";
import {
  adapterFromOutcome,
  decorateEndingView,
  generateNarrative,
  type NarrativeOutcome,
} from "./narrative/generate.js";
import { recordNarrative } from "./narrative/trace.js";
import { readNarrativeBlocks } from "./narrative/read.js";
import { registerNarrativeStreamRoute } from "./narrative/stream.js";
import {
  captureStructuralSavepoint,
  restoreStructuralSavepoint,
  withWorldLock,
} from "./world-lock.js";
import {
  getFlavors,
  getFlavorsForEvents,
  scheduleEventFlavors,
  type TriggeredEventLike,
} from "./narrative/flavorCache.js";

const app = Fastify({ logger: true });

/**
 * 兜底内容类型解析（防 415）。
 *
 * Fastify 默认只认识 application/json 与 text/plain，其余类型（application/octet-stream、
 * x-www-form-urlencoded、text/html…）会在路由之前直接回 415 FST_ERR_CTP_INVALID_MEDIA_TYPE。
 * 但客户端实际链路不可控：内置预览面板、反向代理、表单式提交都可能塞进别的 Content-Type，
 * 甚至对一个不读请求体的端点（如 POST /api/worlds/:id/archive）。
 *
 * 因此注册 catch-all：未知类型一律收下；内容像 JSON 就按 JSON 解析（代理/面板可能
 * 把 JSON body 连同错误的 Content-Type 一起转发过来），其余按字符串原样交给 Zod 判定。
 * 精确匹配的 application/json / text/plain 解析器优先级更高，既有端点行为不变。
 */
app.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => {
  const text = typeof body === "string" ? body.trim() : "";
  if (text === "") return done(null, undefined);
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return done(null, JSON.parse(text) as unknown);
    } catch {
      /* 不是合法 JSON，退回字符串，由路由的 Zod 校验给出明确报错 */
    }
  }
  done(null, text);
});

// ---------- 模板注册（R2.8 / ADR-0029：`<id>/<version>/` 两级，启动期 fail-fast） ----------

const registry = loadTemplates(app.log);
app.log.info({ templatesDir: registry.dir }, "templates_loaded");

// ---------- R2.7 · LLM Provider（启动期只读 env，加载期不得报错） ----------

/**
 * 无 env 且无云端会话 ⇒ Mock ⇒ 叙事恒模板（零回归）；密钥只在服务端 env 读取，
 * 绝不硬编码 / 提交 / 写日志。日志只记录 provider id，不含任何凭证字面量。
 */
const llmProvider = createLLMProvider(readLLMConfig());
app.log.info({ provider: llmProvider.id }, "llm_provider_ready");

// R2.8 · R-LLM-07/08：声明请求级 provider 槽位（仅类型，不写任何凭证字面量）。
// 非可选：preHandler 在每个请求进入 handler 前都赋值，故读取处视为已定义。
declare module "fastify" {
  interface FastifyRequest {
    llmProvider: LLMProvider;
  }
}

/**
 * R2.8 · R-LLM-07/08：每个请求按 `x-life-sim-llm-session` 头解析用户自带 key 凭证，
 * 命中 ⇒ 构造用户 key 的 OpenAI 兼容 provider（优先级 ①），否则回退全局 provider（②/③）。
 * 凭证只在内存查找、绝不入日志、绝不进响应体。未带头 / 头无效 ⇒ 回退全局 provider。
 */
app.addHook("preHandler", (request, _reply, done) => {
  const sid = request.headers["x-life-sim-llm-session"];
  const creds = typeof sid === "string" ? userCredentials.lookup(sid) : undefined;
  request.llmProvider = resolveProviderForRequest(creds, llmProvider);
  done();
});

// ---------- 存档加载（R-PS-05 / ADR-0029 C-2/C-3/C-4）：先定版本、再比指纹，坏档可见可删 ----------

const persisted = loadPersistedWorlds(registry);
hydrate(persisted.loaded);
if (persisted.unloadable.length > 0) {
  for (const e of persisted.unloadable) {
    app.log.error(
      { dataDir: dataDir(), file: e.file, reason: e.reason, detail: e.detail },
      "world_unloadable",
    );
  }
}
app.log.info(
  { dataDir: dataDir(), loaded: persisted.loaded.length, unloadable: persisted.unloadable.length },
  "worlds_loaded",
);

/** 投影 + 评价：评价始终来自唯一事实来源（T4-04），结局按模板集决胜结果投影。 */
function projectWorld(world: WorldStateV2, entry: ReadyTemplateEntry) {
  return projectSnapshotV2(
    world,
    entry.template,
    // 生成事件属于**这个世界的存档**，不在模板里 ⇒ 投影也必须用带 overlay 的 lookup。
    // 漏了这一处就会出现"存档里 slot 已经有值、API 却返回 slotEvent: null"——
    // 事件真的上桌了，只是投影看不见它。
    entry.lookup.withGenerated(world.generatedEvents),
    evaluateLifeV2(world, entry.evaluationConfig),
    entry.endingConfig?.endings,
  );
}

/**
 * 世界 + 其**内存模板快照**（I-2）：模板对象与 lookup 来自建局/载入时固化的 Entry，
 * 不再按 `templateId` 反查全局注册表——热加载替换 Entry 不会改变在跑世界。
 */
function getWorld(id: string): { world: WorldStateV2; entry: ReadyTemplateEntry } | null {
  const record = worldStore.get(id);
  return record ? { world: record.state, entry: record.entry } : null;
}

// ---------- R2.7 · 叙事编排（结局 / 总结 / 事件 flavor 的服务端接入） ----------

/**
 * 非权威装饰结果缓存：避免同一终止轮次重复调 LLM。
 * 不进 `WorldStateV2`、不进 replay、不落盘；缓存只影响玩家可见展示字段。
 *
 * 🔴 F4：键**必须**含视角。旧键 `${worldId}:${turnIndex}` 会被跨请求共享，
 * 一次 `world` 窗口取的 outcome 会被后续 `player` 请求命中（跨窗口串味，P0）。
 */
const endingOutcomeCache = new Map<string, NarrativeOutcome>();
const TEMPLATE_OUTCOME: NarrativeOutcome = { source: "template", data: null, diagnostic: null };

/** 装饰缓存键：`worldId:turnIndex:perspective`（视角是第一等维度）。 */
function narrativeCacheKey(worldId: string, turnIndex: number, perspective: Perspective): string {
  return `${worldId}:${turnIndex}:${perspective}`;
}

/** diagnostic 只写服务端日志（可诊断、不静默）；绝不含 apiKey / token / session。 */
function logNarrativeDiagnostic(diagnostic: string | null): void {
  if (diagnostic !== null) app.log.warn({ diagnostic }, "narrative_fallback");
}

interface EndingResolution {
  endingConfig: EndingConfig;
  ctx: ConditionContext;
  options: { fallbackId?: string };
  /** 未注入 adapter 的 base 记录：模板 title/summary + 本局证据 ids。 */
  base: EndingRecord;
}

/** 结局决胜的单一构造点：与终止时刻、归档时刻同输入 ⇒ 同结果（确定性）。 */
function resolveEndingBase(
  world: WorldStateV2,
  lookup: ReadyTemplateEntry["lookup"],
  cfg: TurnPipelineConfig,
): EndingResolution {
  const endingConfig = cfg.endingConfig ?? createDefaultEndingConfig();
  const ctx: ConditionContext = {
    state: world,
    lookup,
    rng: createRunnerContext(world.seed).rng,
  };
  const options: { fallbackId?: string } =
    endingConfig.fallback !== undefined ? { fallbackId: endingConfig.fallback } : {};
  const base = resolveEnding(world, endingConfig.endings, ctx, options);
  return { endingConfig, ctx, options, base };
}

/**
 * 🔴 隐藏结局红线（主理人裁决 6）：模板 `narrativeConfig.masked` 命中 ⇒ 绝不注入 LLM adapter、
 * 绝不把 hidden 原文交给 LLM，保留模板掩码标题/总结。玩家侧另由 `decorateEndingView`
 * 判 `visibility === "hidden"` 二次拦截。
 */
function isMaskedEnding(resolution: EndingResolution): boolean {
  return resolution.endingConfig.endings.some(
    (ending) => ending.endingId === resolution.base.endingId && ending.narrativeConfig.masked !== undefined,
  );
}

/**
 * 结局叙事 outcome：未终止世界 / 隐藏结局快速短路为 template（零 LLM 调用）；
 * 其余走 `generateNarrative`（mock 亦短路为 template）。
 * 管线配置取该世界的内存快照 `entry.pipeline`（不查全局表）。
 *
 * F3：LLM 产出的结局正文（title + summary）经 `recordNarrative` 落 trace，
 * 刷新后仍可通过 `GET /api/worlds/:id/narrative` 读回；存档只留 `traceRef`。
 */
async function endingOutcomeFor(
  world: WorldStateV2,
  entry: ReadyTemplateEntry,
  perspective: Perspective = "player",
  provider: LLMProvider = llmProvider,
): Promise<NarrativeOutcome> {
  if (world.termination === null) return TEMPLATE_OUTCOME;
  const resolution = resolveEndingBase(world, entry.lookup, entry.pipeline);
  // Axis 1（F4 保留）：隐藏结局绝不把原文交给 LLM。判据由模板 masked 声明 + 决胜结果得出。
  if (isMaskedEnding(resolution)) return TEMPLATE_OUTCOME;
  const outcome = await generateNarrative(
    buildEndingNarrativeRequest({
      templateTitle: resolution.base.title,
      templateSummary: resolution.base.summary,
      allowedEvidenceIds: resolution.base.evidenceIds,
    }),
    EndingNarrativeOutputSchema,
    provider,
  );
  logNarrativeDiagnostic(outcome.diagnostic);
  recordEndingNarrative(world, entry, resolution, outcome);
  return outcome;
}

/** 从结局 outcome 中取出玩家可见正文（仅 `llm` 源有值；template / fallback 保留模板文案）。 */
function narrativeTextOf(outcome: NarrativeOutcome): string | null {
  if (outcome.source !== "llm") return null;
  const data = outcome.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const { title, summary } = data as Record<string, unknown>;
  if (typeof title !== "string" || typeof summary !== "string") return null;
  return `${title}\n\n${summary}`;
}

/**
 * F3 写入侧①：结局正文 → trace。`perspective` 只用于日志 / 未来的窗口化写侧，
 * 落账窗口固定为 player（HTTP 端点对外只有玩家视角）。
 */
function recordEndingNarrative(
  world: WorldStateV2,
  entry: ReadyTemplateEntry,
  resolution: EndingResolution,
  outcome: NarrativeOutcome,
): void {
  const text = narrativeTextOf(outcome);
  if (text === null) return;
  try {
    recordNarrative(world, entry, {
      reason: "ending.narrative",
      blocks: [
        {
          blockId: `ending:${resolution.base.endingId}`,
          kind: "narrative",
          text,
          // 证据 id 若不在 player 窗口可见集合内，写侧会被过滤掉（不回退、不报错）。
          refs: resolution.base.evidenceIds,
        },
      ],
    });
  } catch (error) {
    // 叙事落 trace 失败绝不阻断玩法响应（F3：正文是展示层，不是权威状态）。
    app.log.warn({ error: error instanceof Error ? error.message : String(error) }, "narrative_trace_failed");
  }
}

/** F3 写入侧②：人生总结正文 → trace（`memory` 类块，玩家窗口）。 */
function recordEvaluationNarrative(
  world: WorldStateV2,
  entry: ReadyTemplateEntry,
  outcome: NarrativeOutcome,
): void {
  if (outcome.source !== "llm") return;
  const data = outcome.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return;
  const summary = (data as Record<string, unknown>).summary;
  if (typeof summary !== "string" || summary.length === 0) return;
  try {
    recordNarrative(world, entry, {
      reason: "evaluation.summary",
      blocks: [
        {
          blockId: `evaluation:${world.turnIndex}`,
          kind: "memory",
          text: summary,
          refs: [],
        },
      ],
    });
  } catch (error) {
    app.log.warn({ error: error instanceof Error ? error.message : String(error) }, "narrative_trace_failed");
  }
}

/**
 * Axis 2（F4）：结局叙事能否进入该视角的输出投影。
 * 判据只有两层，且都来自 game-core：
 * ① 统一台账里显式授予了该结局事实（`ending:<id>`）⇒ 可见；
 * ② 台账未声明结局事实（P0 模板均如此）⇒ 用 core 已算好的 `EndingView.visibility`
 *    （`buildEndingView` 依据模板 `narrativeConfig.masked` 派生，含 hidden 掩码规则）。
 * server 不新增自己的可见性字符串判断。
 */
function endingVisibleInWindow(
  world: WorldStateV2,
  ending: EndingView,
  perspective: Perspective,
): boolean {
  if (perspective === "world") return true;
  if (visibleFactRefs(world, perspective).has(`ending:${ending.endingId}`)) return true;
  return ending.visibility === "public";
}

/**
 * 所有返回 `snapshot` 的路由统一走这里：**响应层装饰**，不改 `V2Snapshot` 类型、
 * 不改 `projectSnapshotV2`、不写权威状态。
 *
 * `perspective` 是必填的第一等维度（F4 1+1+N）：装饰缓存按视角分键，
 * 是否允许装饰由 core 窗口层（`endingVisibleInWindow`）判定。
 */
async function decorateSnapshot(
  snapshot: V2Snapshot,
  world: WorldStateV2,
  entry: ReadyTemplateEntry,
  perspective: Perspective,
  provider: LLMProvider = llmProvider,
): Promise<V2Snapshot> {
  const ending = snapshot.ending;
  if (!ending) return snapshot;
  if (!endingVisibleInWindow(world, ending, perspective)) return snapshot;
  const key = narrativeCacheKey(world.id, snapshot.turnIndex, perspective);
  let outcome = endingOutcomeCache.get(key);
  if (outcome === undefined) {
    outcome = await endingOutcomeFor(world, entry, perspective, provider);
    endingOutcomeCache.set(key, outcome);
  }
  return decorateEndingView(snapshot, outcome);
}

/**
 * 事件 flavor 后台生成超时。**绝不阻塞当轮结算**（fire-and-forget），所以放宽到 15s：
 * 3s 对真实模型（尤其推理型 / 走本地网关的）几乎必然超时，而 flavor 只是装饰，
 * 超时后静默回退模板文案——代价只是"少一句润色"，不是错误。放宽只是让它有机会成功。
 */
const FLAVOR_TIMEOUT_MS = 15000;

/**
 * 事件结算 `worldStore.save(...)` 之后调用：**fire-and-forget**，绝不 await LLM。
 * 失败 / 超时只记服务端可诊断日志（不含 key / token / session），静默回退模板。
 */
function scheduleFlavors(
  request: import("fastify").FastifyRequest,
  worldId: string,
  snapshot: V2Snapshot,
  events: readonly TriggeredEventLike[],
): void {
  scheduleEventFlavors({
    worldId,
    turnIndex: snapshot.turnIndex,
    worldTime: snapshot.worldTime,
    events,
    provider: request.llmProvider,
    timeoutMs: FLAVOR_TIMEOUT_MS,
    onDiagnostic: (diagnostic) => request.log.warn({ diagnostic }, "narrative_fallback"),
  });
}

/**
 * 响应层下发的可选 `eventFlavors`（按 `eventId` 键）：本轮已缓存 ∪ 该世界历史缓存。
 * 纯读非权威缓存，缺省 `{}`；绝不写 state / replay / 落盘。合并历史缓存使
 * 后台生成的文案能在后续响应中呈现（fire-and-forget 的固有延迟由缓存弥合）。
 */
function responseEventFlavors(
  worldId: string,
  snapshot: V2Snapshot,
  events: readonly TriggeredEventLike[],
): Record<string, string> {
  return {
    ...getFlavors(worldId),
    ...getFlavorsForEvents(worldId, snapshot.turnIndex, snapshot.worldTime, events),
  };
}

// ---------- 输入校验（Zod） ----------

const createWorldSchema = z.object({
  templateId: z.string().min(1),
  /** R2.8 / R-TG-01：版本目录名；该 id 只有一个可载版本时可省略（隐式取它）。 */
  templateVersion: z.string().min(1).max(40).optional(),
  playerName: z.string().min(1).max(20),
  seed: z.number().int().optional(),
  /** R-OP-01：可选，按 openingId 选择开局；省略则用默认/首个开局。 */
  openingId: z.string().min(1).optional(),
});

const turnSchema = z.object({
  action: z.object({
    type: z.string().min(1).max(TURN_ACTION_TYPE_MAX),
    description: z.string().max(TURN_ACTION_DESCRIPTION_MAX).default(""),
  }),
  mode: z.enum(["single", "fast"]).default("single"),
  /** 主动结束这一生（playerRequested 终止信号），仍走同一轮次管线与结局决胜 */
  endLife: z.boolean().optional(),
});

const chooseSchema = z.object({ optionId: z.string().min(1).max(40) });

// 战斗命令的入参校验直接引用 shared 的定义（D-15 单一真源）：
// 曾经这里手写一份 discriminatedUnion，与 `BattleCommand` 是同一契约的第二份真源，
// 新增命令（如 `pass`）时服务端会静默 400 拒收。现在结构上不可能再漂移。

const useItemSchema = z.object({ itemId: z.string().min(1) });

// ---------- API ----------

app.get("/health", async () => ({ ok: true, service: "life-sim-server", protocol: "v2" }));

/**
 * R2.8 · R-LLM-07：登录页提交自定义 LLM 凭证，服务端仅内存持有并 mint 不透明 sessionId。
 * 凭证绝不回显、绝不落盘、绝不进日志。校验失败转 400，不崩溃。
 */
const llmCredentialsSchema = z.object({
  apiKey: z.string().min(1),
  model: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

app.post("/api/llm-credentials", async (request, reply) => {
  const parsed = llmCredentialsSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_credentials", detail: parsed.error.flatten() });
  }
  try {
    const sessionId = userCredentials.mint(parsed.data);
    return reply.code(201).send({ sessionId });
  } catch {
    return reply.code(400).send({ error: "invalid_credentials" });
  }
});

/**
 * R2.8 · R-LLM-07：提交前的**连通性探测**（不 mint 会话、不入内存、不产生任何副作用）。
 *
 * 语义分层（前端要能稳定区分「我填错了」与「服务端炸了」）：
 * - 通 ⇒ 200 `{ ok: true, model, latencyMs }`；
 * - 探测失败（鉴权 / 网络 / 超时 / 响应形状）⇒ **仍然 200** `{ ok: false, reason, detail }`；
 * - 请求体不合法 ⇒ 400 `{ error: "invalid_credentials", detail }`。
 * `detail` 已在 probe 内部脱敏截断，绝不回显 apiKey。
 */
app.post("/api/llm-credentials/test", async (request, reply) => {
  const parsed = llmCredentialsSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_credentials", detail: parsed.error.flatten() });
  }
  return probeLlmConnectivity(parsed.data);
});

/**
 * 模板列表（R-TG-01 AC② / R-TG-14）：**两级结构**（先选模板、再选版本）。
 * 只读、无写入端点（R-TG-17）；不含 hidden / NPC 私有数据。
 */
app.get("/api/templates", async () => ({ templates: registry.listTemplates() }));

/** T-06 · 静态资源下发允许的扩展名（`.svg/.html` 等可脚本化格式一律拒绝）。 */
const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * T-06 · 静态资源下发（分叉③ A）：**只按 assetId 查 manifest 表定位路径，绝不接受客户端路径**。
 * manifest 已在加载期过 `AssetManifestSchema`（T-06 Group B），此处直接读类型化条目。
 * 越界路径 / 非白名单扩展名一律 403。
 */
app.get("/api/templates/:id/:version/assets/:assetId", async (request, reply) => {
  const { id, version, assetId } = request.params as {
    id: string;
    version: string;
    assetId: string;
  };
  const entry = registry.resolve({ id, version });
  if (!entry) {
    return reply.code(404).send({ error: "template_version_missing", templateId: id, version });
  }
  const found = readAssetEntries(entry.assetManifest).find((a) => a.assetId === assetId);
  if (!found) {
    return reply.code(404).send({ error: "asset_not_found", assetId });
  }
  // 扩展名白名单以 manifest 内的 path 为准（assetId 是不透明标识，不是文件名）。
  const ext = path.extname(found.path).toLowerCase();
  if (!(ext in ASSET_CONTENT_TYPES)) {
    return reply.code(403).send({ error: "asset_type_forbidden", assetId });
  }
  // 路径安全：客户端只给 assetId，路径来自服务端 manifest；仍强制落在 assets/ 根内。
  if (path.isAbsolute(found.path) || found.path.split(/[\\/]/).includes("..")) {
    return reply.code(403).send({ error: "asset_path_forbidden", assetId });
  }
  const assetsRoot = path.resolve(registry.dir, id, version, "assets");
  const target = path.resolve(assetsRoot, found.path);
  if (target !== assetsRoot && !target.startsWith(assetsRoot + path.sep)) {
    return reply.code(403).send({ error: "asset_path_forbidden", assetId });
  }
  if (path.extname(target).toLowerCase() !== ext) {
    return reply.code(403).send({ error: "asset_type_forbidden", assetId });
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    return reply.code(404).send({ error: "asset_not_found", assetId });
  }
  return reply
    .type(ASSET_CONTENT_TYPES[ext]!)
    .header("Cache-Control", "public, max-age=3600")
    .send(readFileSync(target));
});

app.post("/api/worlds", async (request, reply) => {
  const parsed = createWorldSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
  }
  const { templateId, templateVersion } = parsed.data;
  // R-TG-16 / I-1：模板存在性判定前先做一次请求驱动的增量刷新，这样「刚 mkdir 的版本目录」
  // 在本请求就可见（`versionsOf` 内部也会刷，但 idExists 不刷，故这里显式调一次）。
  registry.ensureFresh();
  if (!registry.idExists(templateId)) {
    return reply.code(404).send({ error: "template_not_found", templateId });
  }
  // R-TG-01 / A-5：单版本 ⇒ 隐式取它；多版本缺版本号 ⇒ 400（**不得**默认取最高版，
  // 否则等于替玩家猜「哪条人生线」）。版本不存在 ⇒ 404；版本存在但载不动 ⇒ 409。
  const ready = registry
    .versionsOf(templateId)
    .filter((candidate): candidate is ReadyTemplateEntry => candidate.status === "ready")
    // 复用注册表同一套「补 0 后全序」（A-3）：`2` 必须排在 `10` 之前，
    // 不许在这里另写一套字符串序（两套排序并存早晚变成两套真相）。
    .sort((a, b) => compareVersions(a.ref.version, b.ref.version));
  let entry: ReadyTemplateEntry;
  if (templateVersion !== undefined) {
    const found = registry.get({ id: templateId, version: templateVersion });
    if (!found) {
      return reply.code(404).send({ error: "template_version_missing", templateId, templateVersion });
    }
    if (found.status !== "ready") {
      return reply
        .code(409)
        .send({ error: "template_invalid", templateId, templateVersion, reason: found.reason });
    }
    entry = found;
  } else if (ready.length === 0) {
    return reply
      .code(404)
      .send({ error: "template_not_found", templateId, detail: "该模板下没有可载入的版本" });
  } else if (ready.length > 1) {
    return reply.code(400).send({
      error: "template_version_required",
      templateId,
      versions: ready.map((candidate) => candidate.ref.version),
    });
  } else {
    entry = ready[0]!;
  }
  if (parsed.data.openingId !== undefined) {
    const allowed = entry.openings.map((o) => o.openingId);
    if (!allowed.includes(parsed.data.openingId)) {
      // R-TG-14 AC③：提交不属于所选 `(id, version)` 的 openingId ⇒ **400** 且错误含允许集合。
      return reply
        .code(400)
        .send({ error: "opening_not_found", openingId: parsed.data.openingId, allowed });
    }
  }
  const world = worldStore.create(parsed.data, entry);
  const snapshot = await decorateSnapshot(projectWorld(world, entry), world, entry, "player", request.llmProvider);
  return reply.code(201).send({ worldId: world.id, snapshot });
});

app.get("/api/worlds/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const found = getWorld(id);
  if (!found) {
    // R-TG-10 / C-5：存在但不可载 ⇒ 409 + 封闭 reason（**不得** 404、**不得**静默消失）
    const unloadable = worldStore.unloadable(id);
    if (unloadable) {
      return reply.code(409).send({
        error: "world_unloadable",
        reason: unloadable.reason,
        detail: unloadable.detail,
        templateId: unloadable.templateId,
        templateVersion: unloadable.templateVersion,
      });
    }
    return reply.code(404).send({ error: "world_not_found" });
  }
  return {
    worldId: found.world.id,
    snapshot: await decorateSnapshot(
      projectWorld(found.world, found.entry),
      found.world,
      found.entry,
      "player",
      request.llmProvider,
    ),
    // 可选新增字段：非权威缓存里的事件 flavor（缺省 {}）；缺省完全等同原行为
    eventFlavors: getFlavors(id),
  };
});

// ---------- T-11（部分）· LLM 网关注入 ----------
// 注入策略与实现都在 `agent/pipeline.ts`（可单测）：无 provider ⇒ 原样返回 `entry.pipeline`。
// 这里只负责把「本请求的会话凭证 / env」翻译成配置。

function requestAgentConfig(request: import("fastify").FastifyRequest) {
  const sid = request.headers["x-life-sim-llm-session"];
  const creds = typeof sid === "string" ? userCredentials.lookup(sid) : undefined;
  return resolveAgentConfig(creds, readLLMConfig());
}

/**
 * ADR-0035：**所有会推进世界的接口共用同一条事务边界**。
 *
 * 锁内必须按四步走，缺一步都会留下可观测的缺陷：
 * 1. **锁内重取世界**：锁只保证临界区串行，不保证进临界区前读到的 `world` 引用是新的
 *    （外层 `getWorld` 只用于 404 快路径）；`entry.pipeline` 是启动期快照，也不该直接用；
 * 2. **per-request pipeline**：gateway 由 `pipelineForTurn` 按本请求的凭证注入 —— 直接用
 *    `entry.pipeline` 会得到「没有 gateway」，结构写入（`story.submitBranch`）根本不执行；
 * 3. **保存点 + 回滚**：非 `committed` 的收场整体撤销（ADR-0035 §5「宁可不发生，也不许晚到」）；
 * 4. **重投影**：引擎返回的 `res.snapshot` 算在结构写入之前，直接下发会让玩家看不到刚被
 *    摆上桌的事件（IO-3）。
 */
async function runWorldTransaction(
  request: import("fastify").FastifyRequest,
  id: string,
  step: (
    world: WorldStateV2,
    entry: ReadyTemplateEntry,
    pipeline: TurnPipelineConfig,
  ) => V2TurnResult,
) {
  return withWorldLock(id, async () => {
    const current = getWorld(id);
    if (!current) return { ok: false as const };
    const { world, entry } = current;

    const pipeline = {
      ...pipelineForTurn(world, entry, requestAgentConfig(request)),
      deferInvocation: true as const,
    };
    const res = step(world, entry, pipeline);

    // 结构写入必须在世界再推进之前落账；非 committed ⇒ 整体回滚。
    const inv = res.state.pendingInvocation;
    if (inv !== undefined && pipeline.gateway !== undefined) {
      const savepoint = captureStructuralSavepoint(res.state);
      const outcome = await pipeline.gateway.invoke(inv);
      if (outcome.outcome !== "committed") restoreStructuralSavepoint(res.state, savepoint);
    }

    const fresh = projectWorld(res.state, entry);
    worldStore.save(res.state);
    scheduleFlavors(request, id, fresh, res.triggeredEvents);
    const snapshot = await decorateSnapshot(fresh, res.state, entry, "player", request.llmProvider);
    return {
      ok: true as const,
      turnIndex: res.snapshot.turnIndex,
      elapsed: res.elapsed,
      snapshot,
      triggeredEvents: res.triggeredEvents,
      wheelResult: res.wheelResult,
      eventFlavors: responseEventFlavors(id, fresh, res.triggeredEvents),
    };
  });
}

/**
 * 显式「确认转盘」入口（可发现性）：**无请求体**。
 *
 * 槽内事件是 `kind === "random"` 时，快照的 `slotEvent.options` **缺省 / 为空** ——
 * 这不是死锁，而是等待玩家确认已掷出的那一格（扇区见 `slotEvent.wheel`）。
 * 本路由不消耗行动、不推时间，只结算已呈现的扇区，并返回 `wheelResult`。
 *
 * 兼容：`POST /api/worlds/:id/turns` 在槽为 random 时仍等价（旧客户端），
 * 但新客户端 / 脚本应使用本路由 —— 从路径就能看出语义，不必反查 `action` 魔法串。
 */
app.post("/api/worlds/:id/wheels/confirm", async (request, reply) => {
  const { id } = request.params as { id: string };
  const found = getWorld(id);
  if (!found) return reply.code(404).send({ error: "world_not_found" });
  const slot = found.world.slot;
  const pending = slot === null ? undefined : found.entry.lookup.event(slot.eventId);
  if (slot === null || pending?.kind !== "random") {
    // 没有待确认的转盘：明确 409，而不是把它当成一次自由行动（action 会被引擎当未知动作）。
    return reply.code(409).send({ error: "no_pending_wheel" });
  }

  try {
    const tx = await runWorldTransaction(request, id, (world, entry, pipeline) =>
      advanceTurnV2(
        world,
        { action: { type: "wheel-confirm", description: "" }, mode: "single" },
        entry.template,
        entry.lookup.withGenerated(world.generatedEvents),
        undefined,
        pipeline,
      ),
    );
    if (!tx.ok) return reply.code(404).send({ error: "world_not_found" });
    return {
      worldId: id,
      turnIndex: tx.turnIndex,
      elapsed: tx.elapsed,
      snapshot: tx.snapshot,
      triggeredEvents: tx.triggeredEvents,
      wheelResult: tx.wheelResult,
      eventFlavors: tx.eventFlavors,
    };
  } catch (error) {
    return handleEngineError(request, reply, error);
  }
});

/**
 * 推进轮次（自由行动）。
 * 拒绝条件（ADR-0034 §5）：`slot` 被占（`pending_event_required`）或战斗进行中（`battle_in_progress`）。
 * **例外**：槽内是 `random` 时本接口即「转盘确认」——请求体里的 `action` 被忽略（不校验、不报错）。
 * 新客户端请改用上方的显式路由 `POST /api/worlds/:id/wheels/confirm`。
 */
app.post("/api/worlds/:id/turns", async (request, reply) => {
  const { id } = request.params as { id: string };
  const found = getWorld(id);
  if (!found) return reply.code(404).send({ error: "world_not_found" });

  const parsed = turnSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
  }

  try {
    const tx = await runWorldTransaction(request, id, (world, entry, pipeline) =>
      advanceTurnV2(world, parsed.data, entry.template, entry.lookup.withGenerated(world.generatedEvents), undefined, pipeline),
    );
    // 锁内重取时世界已被删除（并发删档）：与快路径同一响应，不落到 handleEngineError 的 400。
    if (!tx.ok) return reply.code(404).send({ error: "world_not_found" });
    return {
      worldId: id,
      turnIndex: tx.turnIndex,
      elapsed: tx.elapsed,
      snapshot: tx.snapshot,
      triggeredEvents: tx.triggeredEvents,
      wheelResult: tx.wheelResult,
      eventFlavors: tx.eventFlavors,
    };
  } catch (error) {
    return handleEngineError(request, reply, error);
  }
});

app.post("/api/worlds/:id/events/choose", async (request, reply) => {
  const { id } = request.params as { id: string };
  const found = getWorld(id);
  if (!found) return reply.code(404).send({ error: "world_not_found" });

  const parsed = chooseSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
  }

  try {
    const tx = await runWorldTransaction(request, id, (world, entry, pipeline) =>
      chooseOptionV2(world, parsed.data, entry.template, entry.lookup.withGenerated(world.generatedEvents), pipeline),
    );
    if (!tx.ok) return reply.code(404).send({ error: "world_not_found" });
    return {
      worldId: id,
      snapshot: tx.snapshot,
      triggeredEvents: tx.triggeredEvents,
      wheelResult: tx.wheelResult,
      eventFlavors: tx.eventFlavors,
    };
  } catch (error) {
    return handleEngineError(request, reply, error);
  }
});

app.post("/api/worlds/:id/battle", async (request, reply) => {
  const { id } = request.params as { id: string };
  const found = getWorld(id);
  if (!found) return reply.code(404).send({ error: "world_not_found" });

  const parsed = BattleCommandSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
  }

  try {
    const tx = await runWorldTransaction(request, id, (world, entry, pipeline) =>
      battleActionV2(world, parsed.data, entry.template, entry.lookup.withGenerated(world.generatedEvents), pipeline),
    );
    if (!tx.ok) return reply.code(404).send({ error: "world_not_found" });
    return {
      worldId: id,
      snapshot: tx.snapshot,
      triggeredEvents: tx.triggeredEvents,
      wheelResult: tx.wheelResult,
      eventFlavors: tx.eventFlavors,
    };
  } catch (error) {
    return handleEngineError(request, reply, error);
  }
});

app.post("/api/worlds/:id/items/use", async (request, reply) => {
  const { id } = request.params as { id: string };
  const found = getWorld(id);
  if (!found) return reply.code(404).send({ error: "world_not_found" });

  const parsed = useItemSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
  }

  try {
    const res = useItemV2(found.world, parsed.data, found.entry.template, found.entry.lookup.withGenerated(found.world.generatedEvents), found.entry.pipeline);
    worldStore.save(res.state);
    scheduleFlavors(request, found.world.id, res.snapshot, res.triggeredEvents);
    const snapshot = await decorateSnapshot(res.snapshot, res.state, found.entry, "player", request.llmProvider);
    return {
      worldId: found.world.id,
      snapshot,
      eventFlavors: responseEventFlavors(found.world.id, res.snapshot, res.triggeredEvents),
    };
  } catch (error) {
    return handleEngineError(request, reply, error);
  }
});

// ---------- 装备穿脱（R-EQ-07 / R-EQ-08 / design §5.2）：不推进时间 ----------

const equipSchema = z.object({ itemId: z.string().min(1) }).strict();
const unequipSchema = z.object({ instanceId: z.string().min(1) }).strict();

/** 穿脱错误码映射：409 = 状态冲突但请求合法；400 = 请求本身不对（design §5.2 表）。 */
function handleEquipError(request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply, error: unknown) {
  const code = equipErrorCodeOf(error);
  if (code === null) return handleEngineError(request, reply, error);
  request.log.warn({ code }, "equipment_error");
  if (code === "slot_full" || code === "slot_category_mismatch") {
    return reply.code(409).send({ error: code, detail: error instanceof Error ? error.message : String(error) });
  }
  return reply.code(400).send({ error: code, detail: error instanceof Error ? error.message : String(error) });
}

app.post("/api/worlds/:id/equipment/equip", async (request, reply) => {
  const { id } = request.params as { id: string };
  const found = getWorld(id);
  if (!found) return reply.code(404).send({ error: "world_not_found" });

  const parsed = equipSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
  }

  try {
    const res = equipV2(found.world, parsed.data, found.entry.template, found.entry.lookup.withGenerated(found.world.generatedEvents));
    worldStore.save(res.state);
    const snapshot = await decorateSnapshot(res.snapshot, res.state, found.entry, "player", request.llmProvider);
    return { worldId: found.world.id, snapshot };
  } catch (error) {
    return handleEquipError(request, reply, error);
  }
});

app.post("/api/worlds/:id/equipment/unequip", async (request, reply) => {
  const { id } = request.params as { id: string };
  const found = getWorld(id);
  if (!found) return reply.code(404).send({ error: "world_not_found" });

  const parsed = unequipSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
  }

  try {
    const res = unequipV2(found.world, parsed.data, found.entry.template, found.entry.lookup.withGenerated(found.world.generatedEvents));
    worldStore.save(res.state);
    const snapshot = await decorateSnapshot(res.snapshot, res.state, found.entry, "player", request.llmProvider);
    return { worldId: found.world.id, snapshot };
  } catch (error) {
    return handleEquipError(request, reply, error);
  }
});

/**
 * 世界列表（R-PS-04 / R-TG-10 C-5 / design §3.5）：按 savedAt 倒序；空目录返回空数组。
 * 每行带 `loadable: boolean` + `reason?`——「存在但不可载」的档**必须可见**（修 E-03），
 * 否则玩家 localStorage 留着 worldId、点开才发现打不开。status 由 archived / termination 推导。
 */
app.get("/api/worlds", async () => {
  const loadableRows = worldStore.all().map(({ state: w, entry }) => {
    const status: "running" | "terminated" | "archived" =
      w.archived === true ? "archived" : w.termination !== null ? "terminated" : "running";
    // endingTitle：已终止时按结局模板决胜（同输入 ⇒ 同结果）；隐藏结局显示掩码标题
    let endingTitle: string | undefined;
    if (w.termination !== null) {
      const cfgEnding = entry.endingConfig ?? createDefaultEndingConfig();
      const ctx = { state: w, lookup: entry.lookup, rng: createRunnerContext(w.seed).rng };
      const ending = resolveEnding(
        w,
        cfgEnding.endings,
        ctx,
        cfgEnding.fallback !== undefined ? { fallbackId: cfgEnding.fallback } : {},
      );
      const tpl = cfgEnding.endings.find((e) => e.endingId === ending.endingId);
      endingTitle = tpl?.narrativeConfig.masked
        ? (tpl.narrativeConfig.masked.title ?? "未公开的结局")
        : (tpl?.narrativeConfig.title ?? tpl?.name);
    }
    return {
      id: w.id,
      templateId: entry.ref.id,
      templateVersion: entry.ref.version,
      templateName: entry.template.meta.name,
      playerName: w.player.name,
      turnIndex: w.turnIndex,
      worldTime: w.worldTime,
      formattedTime: createTimeAdapter(entry.template).format(w.worldTime),
      status,
      endingTitle,
      loadable: true,
      savedAt: worldStore.savedAt(w.id) ?? "",
    };
  });
  // 不可载档：只下发诊断所需字段（封闭 reason + 具体对象），不含 state 片段。
  const unloadableRows = worldStore.unloadableAll().map((u) => ({
    id: u.id,
    templateId: u.templateId,
    templateVersion: u.templateVersion,
    loadable: false,
    reason: u.reason,
    detail: u.detail,
    savedAt: u.savedAt ?? "",
  }));
  const worlds = [...loadableRows, ...unloadableRows].sort((a, b) =>
    a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0,
  );
  return { worlds };
});

/** 删除世界（R-PS-04）：删文件 + 删内存条目；删除确认由前端负责。不可载的档同样可删（R-TG-10 AC①）。 */
app.delete("/api/worlds/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    worldStore.delete(id);
  } catch {
    return reply.code(404).send({ error: "world_not_found" });
  }
  return { deleted: id };
});

app.get("/api/worlds/:id/history", async (request, reply) => {
  const { id } = request.params as { id: string };
  const record = worldStore.get(id);
  if (!record) return reply.code(404).send({ error: "world_not_found" });
  // 玩家端出口只下发 public 条目（R-VS-02 / 协议 §21.1）
  return { history: playerVisibleEntries(record.state.history) };
});

/**
 * T-07 / F3 读回端点：叙事正文只存于 append-only `<worldId>.trace.jsonl`。
 *
 * 玩家窗口投影（F4）在**块级**做三件事，缺一不可：
 * ① `targetPerspective !== "player"` ⇒ 整块丢弃（world 窗口块永不外泄）；
 * ② `visibility === "hidden"` ⇒ 整块丢弃（T-05a 裁决：**不**替换成 maskText，maskText 也不下发）；
 * ③ `refs[]` 任一不在 `visibleFactRefs(state,"player")` 内 ⇒ 整块丢弃
 *    （防御「块本体是 player 的、却引用了 player 看不见的事实」这种越窗写法）。
 *
 * 响应只给 `ContentBlockVM`（blockId / kind / text）。**绝不**回传整条 `LlmTrace`
 * （receipts / diagnostics / contextHash / callsHash / toolProfile / token 数都不出服务端）。
 */
app.get("/api/worlds/:id/narrative", async (request, reply) => {
  const { id } = request.params as { id: string };
  const record = worldStore.get(id);
  if (!record) return reply.code(404).send({ error: "world_not_found" });
  const q = request.query as { fromTurn?: string };
  const parsedFrom = q.fromTurn !== undefined ? Number.parseInt(q.fromTurn, 10) : undefined;
  const fromTurn =
    parsedFrom !== undefined && !Number.isNaN(parsedFrom) ? parsedFrom : undefined;
  // 没有 trace 文件 ⇒ `blocks: []`（不是错误、不是 404），由 readNarrativeBlocks 承担。
  return { worldId: id, blocks: readNarrativeBlocks(id, record.state, fromTurn) };
});

/**
 * 归档封存（#30 遗留补齐）：只能封存已终止的世界。
 * 组装五类数据 → 置 archived=true → 走 worldStore.seal()（save() 的唯一例外通道）。
 * 幂等：重复调用返回同一份归档记录，不重复改写状态。
 */
app.post("/api/worlds/:id/archive", async (request, reply) => {
  const { id } = request.params as { id: string };
  const found = getWorld(id);
  if (!found) return reply.code(404).send({ error: "world_not_found" });
  if (found.world.termination === null) {
    return reply.code(409).send({ error: "not_terminated", hint: "世界尚未终止，无法归档" });
  }
  const cfg = found.entry.pipeline;
  // 归档时的结局记录：按终局状态重新决胜（与终止时刻同输入 ⇒ 同结果，确定性）
  const resolution = resolveEndingBase(found.world, found.entry.lookup, cfg);
  // 🔴 隐藏结局红线（裁决 6）：masked 结局一律不注入 LLM adapter、不装饰，保留模板掩码文案
  const masked = isMaskedEnding(resolution);
  const evaluation = evaluateLifeV2(found.world, cfg.evaluationConfig);

  // R2.7 · T-S2：人生总结接真实 LLM。只经 finalizeEvaluationSummary 替换 summary / summarySource；
  // dimensions / evidenceIds / overall 逐字段不变（strict schema 拒任何篡改）。
  // 隐藏结局同裁决 6：一并跳过 LLM 装饰与 adapter 注入，保留模板文案。
  const summaryOutcome = masked
    ? TEMPLATE_OUTCOME
    : await generateNarrative(
        buildEvaluationSummaryRequest(evaluation),
        EvaluationSummaryOutputSchema,
        request.llmProvider,
      );
  logNarrativeDiagnostic(summaryOutcome.diagnostic);
  // F3 写入侧②：人生总结同样落 trace（刷新后归档页仍能看到 LLM 文案）。
  recordEvaluationNarrative(found.world, found.entry, summaryOutcome);
  const finalEvaluation = masked
    ? evaluation
    : finalizeEvaluationSummary(evaluation, adapterFromOutcome(summaryOutcome));

  // R2.7 · T-S1：结局叙事接真实 LLM。outcome 同时用于响应层装饰
  // `snapshot.ending.narrativeSource`（主理人裁决 3：玩家可见准绳）。
  // F3 写入侧③：结局正文在 `endingOutcomeFor` 内即落 trace（与装饰同源，不重复生成）。
  const endingOutcome = masked
    ? TEMPLATE_OUTCOME
    : await endingOutcomeFor(found.world, found.entry, "player", request.llmProvider);
  const endingAdapter = masked ? undefined : adapterFromOutcome(endingOutcome);
  const ending = resolveEnding(
    found.world,
    resolution.endingConfig.endings,
    resolution.ctx,
    {
      ...resolution.options,
      ...(endingAdapter !== undefined ? { narrativeAdapter: endingAdapter } : {}),
    },
  );
  const archived = assembleArchive(
    found.world,
    found.entry.template,
    found.entry.lookup,
    ending,
    finalEvaluation,
    resolution.endingConfig.endings,
  );
  // 响应层装饰：纯函数、不改 state / 不改 V2Snapshot 类型；hidden 结局自动跳过
  archived.record.snapshot = decorateEndingView(archived.record.snapshot, endingOutcome);
  worldStore.seal(archived.state);
  // 归档响应只下发 public 历史 + hidden 计数（R-VS-04）；完整记录随 seal 落盘（存档事实保留全量）
  return { worldId: found.world.id, archive: projectArchiveForPlayer(archived.record) };
});

function handleEngineError(request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply, error: unknown) {
  request.log.error(error);
  const message = error instanceof Error ? error.message : String(error);
  // ADR-0034 §5：错误码**不新增**，语义随模型重述——
  // `pending_event_required` 现在表示「呈现槽被占，须先处理槽内事件」（不再叫"待决事件队列"）；
  // 例外：槽内是 `random` 时 `turns` 被解释为「转盘确认」（ADR-0034 §8-⑩），不会走到这里。
  const interactionErrors = new Set([
    "pending_event_required",
    "battle_in_progress",
    "battle_not_active",
    "no_pending_event",
    // ADR-0024 决策 8：待决事件的前提在本轮复核中失效 ⇒ 状态冲突（不是请求非法）。
    // 与 option_not_available 区分开，客户端据此提示「状态已过期，请重取快照」。
    "event_premise_invalidated",
  ]);
  if (interactionErrors.has(message)) {
    return reply.code(409).send({ error: message });
  }
  // 终止 / 归档门禁：语义上是状态冲突（409），不是请求非法（400）
  if (message.startsWith("[TERMINATED]")) {
    return reply.code(409).send({ error: "terminated", detail: message });
  }
  if (message.startsWith("[ARCHIVED]")) {
    return reply.code(409).send({ error: "archived", detail: message });
  }
  return reply.code(400).send({ error: message });
}

// ---------- 静态托管 web 构建产物（单端口供手机访问） ----------

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

app.setNotFoundHandler((request, reply) => {
  if (request.raw.url?.startsWith("/api/")) {
    return reply.code(404).send({ error: "not_found" });
  }
  if (!existsSync(webDist)) {
    return reply.code(503).send({ error: "web_dist_missing", hint: "run: pnpm --filter @life-sim/web build" });
  }
  const urlPath = (request.raw.url ?? "/").split("?")[0];
  const filePath = path.join(webDist, urlPath === "/" ? "index.html" : urlPath);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(webDist)) {
    return reply.code(403).send({ error: "forbidden" });
  }
  const target = existsSync(resolved) && statSync(resolved).isFile() ? resolved : path.join(webDist, "index.html");
  const ext = path.extname(target).toLowerCase();
  reply.type(MIME[ext] ?? "application/octet-stream").send(readFileSync(target));
});

const port = Number(process.env.PORT ?? 3000);
// SSE 叙事流：正文可流式下发，但**结构写入仍在回合事务内**（ADR-0035 §6）。必须在 listen 前注册。
await registerNarrativeStreamRoute(app);
await app.listen({ port, host: "0.0.0.0" });
