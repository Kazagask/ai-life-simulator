import Fastify from "fastify";
import { randomUUID } from "node:crypto";
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
  createOpeningSession,
  commitOpening,
  collectOpeningGains,
  createRunnerContext,
  createTimeAdapter,
  describeNode,
  resolveStep,
  equipErrorCodeOf,
  equipV2,
  evaluateLifeV2,
  finalizeEvaluationSummary,
  historyDigestOf,
  normalizeAllocation,
  playerVisibleEntries,
  projectArchiveForPlayer,
  projectSnapshotV2,
  resolveEnding,
  unequipV2,
  captureGainBaseline,
  diffGains,
  pushHistory,
  presentNewlyGeneratedV2,
  presentQueuedEventV2,
  useItemV2,
  visibleFactRefs,
  type ConditionContext,
  type TurnPipelineConfig,
} from "@life-sim/game-core";
import { pipelineForTurn, resolveAgentConfig } from "./agent/pipeline.js";
import { adminEnabled, registerAdminGuard, registerAdminRoutes } from "./admin.js";
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
  UiConfig,
  V2Snapshot,
  V2TurnResult,
  WorldStateV2,
} from "@life-sim/shared";
import {
  compareVersions,
  loadTemplates,
  readAssetEntries,
  readDeclarativeFiles,
  type ReadyTemplateEntry,
} from "./templates.js";
import { registerServerExtensions } from "./extensions.js";
import { dataDir, hydrate, loadPersistedWorlds, worldStore } from "./store.js";
import { createLLMProvider, readLLMConfig, resolveProviderForRequest, type LLMProvider } from "./llm/provider.js";
import { allowsPlaintextCredentials, openCredentialEnvelope } from "./llm/credentialEnvelope.js";
import { userCredentials } from "./llm/userCredentials.js";
import { probeLlmConnectivity } from "./llm/probe.js";
import {
  adapterFromOutcome,
  decorateEndingView,
  decorateEvaluationView,
  generateNarrative,
  type NarrativeOutcome,
} from "./narrative/generate.js";
import { recordNarrative } from "./narrative/trace.js";
import { openingPrologue, prologueFactsOf } from "./narrative/prologue.js";
import { recordTurnNarrative } from "./narrative/turn.js";
import { readNarrativeBlocks } from "./narrative/read.js";
import { registerNarrativeStreamRoute } from "./narrative/stream.js";
import { registerSyncRoutes } from "./sync.js";
import {
  captureStructuralSavepoint,
  restoreStructuralSavepoint,
  withWorldLock,
} from "./world-lock.js";
import { allocationBlockedReason } from "./allocation-guard.js";
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

/**
 * 🔴 **顺序不可换**：扩展注册必须早于模板扫描。
 * 模板加载期要按「已注册 runtime」校验 `extensions:`（未注册 ⇒ `unknown_extension` 拒载），
 * 晚一步注册就会把声明了 `extensions.family` 的合法模板全部判成未注册。
 */
registerServerExtensions();

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
    // 展示域（ui.yaml）：只用于解析样式（ADR-002 D2）；不传等价「模板没写样式」。
    entry.ui,
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
const evaluationOutcomeCache = new Map<string, NarrativeOutcome>();
const TEMPLATE_OUTCOME: NarrativeOutcome = { source: "template", data: null, diagnostic: null };

/** 装饰缓存键：`worldId:turnIndex:perspective`（视角是第一等维度）。 */
function narrativeCacheKey(worldId: string, turnIndex: number, perspective: Perspective): string {
  return `${worldId}:${turnIndex}:${perspective}`;
}

/** 评价总结与结局同轮生成，但**不是**同一份 outcome：键加后缀，互不覆盖。 */
function evaluationCacheKey(worldId: string, turnIndex: number, perspective: Perspective): string {
  return `${narrativeCacheKey(worldId, turnIndex, perspective)}:evaluation`;
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
  const evaluation = evaluateLifeV2(world, entry.evaluationConfig);
  const outcome = await generateNarrative(
    buildEndingNarrativeRequest({
      templateTitle: resolution.base.title,
      templateSummary: resolution.base.summary,
      allowedEvidenceIds: resolution.base.evidenceIds,
      // 只读素材：本局玩家可见经历（hidden 已被 `historyDigestOf` 滤掉）+ 维度摘要。
      // 没有这两样，模型只能复述模板句 —— 那不是收尾。
      history: historyDigestOf(world),
      dimensionSummaries: evaluation.dimensions.map((d) => ({ id: d.id, score: d.score, level: d.level })),
    }),
    EndingNarrativeOutputSchema,
    provider,
  );
  logNarrativeDiagnostic(outcome.diagnostic);
  recordEndingNarrative(world, entry, resolution, outcome);
  return outcome;
}

/**
 * 人生总结 outcome：**只在该局已收束时**生成（跑动中不调 LLM）。
 *
 * 与结局叙事同一套纪律：非权威、按 `worldId:turn:perspective` 缓存、落 trace 供刷新读回。
 * 隐藏结局（`masked`）一并短路 —— 总结里不得夹带隐藏结局的原文或暗示。
 *
 * 为什么结局时就要跑：归档只是「盖棺」，玩家在结局卡上就该看到评价；否则
 * `evaluation.summary` 会一直是引擎拼的「本局共记录 N 条经历」，看起来像没接线。
 */
async function evaluationOutcomeFor(
  world: WorldStateV2,
  entry: ReadyTemplateEntry,
  provider: LLMProvider = llmProvider,
): Promise<NarrativeOutcome> {
  if (world.termination === null) return TEMPLATE_OUTCOME;
  const resolution = resolveEndingBase(world, entry.lookup, entry.pipeline);
  if (isMaskedEnding(resolution)) return TEMPLATE_OUTCOME;
  const evaluation = evaluateLifeV2(world, entry.evaluationConfig);
  const outcome = await generateNarrative(
    buildEvaluationSummaryRequest(evaluation, historyDigestOf(world)),
    EvaluationSummaryOutputSchema,
    provider,
  );
  logNarrativeDiagnostic(outcome.diagnostic);
  recordEvaluationNarrative(world, entry, outcome);
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
 * 两件装饰：
 * 1. `ending` 的 LLM 解释（`perspective` 是第一等维度，由 core 窗口层判定可见性）；
 * 2. `ui.yaml` 的展示声明（`entry.ui`）—— 只在响应出口挂上，**引擎全程不读**。
 *
 * `perspective` 是必填的第一等维度（F4 1+1+N）：装饰缓存按视角分键，
 * 是否允许装饰由 core 窗口层（`endingVisibleInWindow`）判定。
 */
export type DecoratedSnapshot = V2Snapshot & { ui?: UiConfig };

async function decorateSnapshot(
  snapshot: V2Snapshot,
  world: WorldStateV2,
  entry: ReadyTemplateEntry,
  perspective: Perspective,
  provider: LLMProvider = llmProvider,
): Promise<DecoratedSnapshot> {
  const withUi = (value: V2Snapshot): DecoratedSnapshot =>
    entry.ui === undefined ? value : { ...value, ui: entry.ui };

  let decorated = snapshot;

  // ① 结局收尾：只在结局对该窗口可见时装饰（隐藏结局由 core 判 visibility）。
  const ending = decorated.ending;
  if (ending !== undefined && ending !== null && endingVisibleInWindow(world, ending, perspective)) {
    const key = narrativeCacheKey(world.id, snapshot.turnIndex, perspective);
    let outcome = endingOutcomeCache.get(key);
    if (outcome === undefined) {
      outcome = await endingOutcomeFor(world, entry, perspective, provider);
      endingOutcomeCache.set(key, outcome);
    }
    decorated = decorateEndingView(decorated, outcome);
  }

  // ② 人生评价：收束后才有意义（跑动中不调 LLM，保持模板占位）。与结局同轮、同一份缓存纪律。
  if (world.termination !== null) {
    const key = evaluationCacheKey(world.id, snapshot.turnIndex, perspective);
    let outcome = evaluationOutcomeCache.get(key);
    if (outcome === undefined) {
      outcome = await evaluationOutcomeFor(world, entry, provider);
      evaluationOutcomeCache.set(key, outcome);
    }
    decorated = decorateEvaluationView(decorated, outcome);
  }

  return withUi(decorated);
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
  /** 可空（R-NAME-01 / D-5）：不填 ⇒ 开局参数名或"无名氏"。 */
  playerName: z.string().min(0).max(20).optional(),
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
 * R2.8 · R-LLM-07 / BACKLOG B-01：提交自定义 LLM 凭证，服务端仅内存持有并 mint 不透明 sessionId。
 *
 * 请求体是**加密信封**（`{ envelope: { v, key, iv, data } }`，见 `llm/credentialEnvelope.ts`），
 * 不是明文 JSON —— wire 上只有密文；解密后仍只走内存，绝不回显、绝不落盘、绝不进日志。
 * 信封解不开 / 字段不合法**一律 400 `invalid_credentials`**（不区分原因，避免变成探测 oracle）。
 */
const llmCredentialsSchema = z.object({
  apiKey: z.string().min(1),
  model: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

app.post("/api/llm-credentials", async (request, reply) => {
  // 局域网 HTTP 下浏览器没有 WebCrypto ⇒ 只对私有来源接受明文信封（`v: 0`）。
  const allowPlaintext = allowsPlaintextCredentials(request);
  const parsed = llmCredentialsSchema.safeParse(openCredentialEnvelope(request.body, { allowPlaintext }));
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_credentials" });
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
 * - 请求体不合法（含**信封解不开**）⇒ 400 `{ error: "invalid_credentials" }`。
 * `detail` 已在 probe 内部脱敏截断，绝不回显 apiKey。
 */
app.post("/api/llm-credentials/test", async (request, reply) => {
  const allowPlaintext = allowsPlaintextCredentials(request);
  const parsed = llmCredentialsSchema.safeParse(openCredentialEnvelope(request.body, { allowPlaintext }));
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_credentials" });
  }
  return probeLlmConnectivity(parsed.data);
});

/**
 * 模板列表（R-TG-01 AC② / R-TG-14）：**两级结构**（先选模板、再选版本）。
 * 只读、无写入端点（R-TG-17）；不含 hidden / NPC 私有数据。
 */
app.get("/api/templates", async () => ({
  /*
   * 隐藏模板（`meta.hidden: true`，2026-11-20）不上列表：测试田与半成品不该出现在
   * 选模板界面。注册表仍然收录它 —— 建局（`POST /api/worlds`）按 id 照常可用，
   * `inspect` 与体检也照常看得见。
   */
  templates: registry.listTemplates().filter((t) => t.hidden !== true),
}));

/** T-06 · 静态资源下发允许的扩展名（`.svg/.html` 等可脚本化格式一律拒绝）。 */
const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * 模板包（ADR-070 第二期）：把一个版本的**声明式文件正文**与语义指纹一起下发。
 *
 * 客户端拿到后：`loadTemplateFromSource(MemorySource)` 重跑一遍加载与校验、
 * 自己算一次指纹并与 `fingerprint` 比对 —— 对不上就拒载（sha 不一致 / 文件缺页）。
 * 资产二进制不在包里（仍走 `/assets/:assetId`），这一步只解决「世界能不能起来」。
 */
app.get("/api/templates/:id/:version/package", async (request, reply) => {
  const { id, version } = request.params as { id: string; version: string };
  const entry = registry.resolve({ id, version });
  if (!entry) {
    return reply.code(404).send({ error: "template_version_missing", templateId: id, version });
  }
  return {
    templateId: entry.ref.id,
    version: entry.ref.version,
    fingerprint: entry.semanticFingerprint,
    // 含 `ui.yaml`：客户端拿它判缓存新鲜度（纯表现改动也要让旧包失效）
    packageFingerprint: entry.packageFingerprint,
    files: readDeclarativeFiles(entry.ref),
  };
});

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

// ---------- 前实例化开局会话（ADR-001 / R-OP-01..07） ----------
// 会话是 server 资源，**不属于世界**：commit 之前没有 WorldStateV2 / NPC / delayQueue。
// 只记 results；roll 在服务端按 node 派生掷骰，客户端动画只是"已定结果的呈现"。
interface OpeningSessionRecord {
  entry: ReadyTemplateEntry;
  core: ReturnType<typeof createOpeningSession>;
  playerName?: string;
  seed?: number;
}
const openingSessions = new Map<string, OpeningSessionRecord>();

const openingCreateSchema = z.object({
  templateId: z.string().min(1),
  templateVersion: z.string().min(1).max(40).optional(),
  seed: z.number().int().optional(),
  playerName: z.string().max(20).optional(),
});
const openingStepSchema = z.union([
  z.object({ kind: z.literal("roll") }),
  z.object({ kind: z.literal("choose"), optionId: z.string().min(1) }),
  z.object({ kind: z.literal("allocate"), allocation: z.record(z.string(), z.number()) }),
  // 输入节点（ADR-072 D7）：长度上限只是「别把整段文章塞进来」，真正的规则在模板里。
  z.object({ kind: z.literal("input"), value: z.string().max(200) }),
]);
const renameSchema = z.object({ name: z.string().min(1).max(20) });

function readyEntryFor(
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  templateId: string,
  templateVersion?: string,
): ReadyTemplateEntry | null {
  const ready = allReadyEntries().filter((e) => e.ref.id === templateId);
  let entry: ReadyTemplateEntry | undefined;
  if (templateVersion !== undefined) {
    entry = ready.find((e) => e.ref.version === templateVersion);
    if (!entry) {
      reply.code(404).send({ error: "template_version_missing", templateId, templateVersion });
      return null;
    }
  } else if (ready.length === 1) entry = ready[0];
  else {
    reply.code(ready.length === 0 ? 404 : 400).send({
      error: ready.length === 0 ? "template_not_found" : "template_version_required",
      templateId,
      ...(ready.length > 1 ? { versions: ready.map((e) => e.ref.version) } : {}),
    });
    return null;
  }
  return entry;
}

/** 包装 `templates.ensureFresh()` 的只读列表（与 /api/templates 同一入口）。 */
function allReadyEntries(): ReadyTemplateEntry[] {
  registry.ensureFresh();
  return registry.listTemplates().flatMap((t) =>
    registry.versionsOf(t.id).filter((e): e is ReadyTemplateEntry => e.status === "ready"),
  );
}

app.post("/api/openings", async (request, reply) => {
  const parsed = openingCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
  const entry = readyEntryFor(reply, parsed.data.templateId, parsed.data.templateVersion);
  if (!entry) return;
  if (!entry.openingDag) {
    return reply.code(404).send({ error: "opening_dag_not_found", templateId: parsed.data.templateId });
  }
  const seed = parsed.data.seed ?? Math.floor(Math.random() * 0xffffffff);
  // 向导里填的名字作为宿主初始参数（ADR-072 D7）：模板的输入节点用 {playerName} 读到它。
  const typedName = parsed.data.playerName?.trim();
  const core = createOpeningSession(
    entry.openingDag,
    seed,
    typedName !== undefined && typedName !== "" ? { playerName: typedName } : undefined,
  );
  const id = `open-${randomUUID()}`;
  // 第一个节点就是 allocate 且预算参数还没落定 ⇒ 模板顺序写反了。
  // 这是模板缺陷，但返回 400 比 500 更好定位（会话不落库，前端能直接看到原因）。
  let firstNode;
  try {
    firstNode = describeNode(entry.openingDag, core, { template: entry.template, ui: entry.ui });
  } catch (error) {
    return reply.code(400).send({
      error: "opening_dag_invalid",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  openingSessions.set(id, { entry, core, playerName: parsed.data.playerName, seed: parsed.data.seed });
  return reply.code(201).send({ sessionId: id, seed, node: firstNode });
});

app.post("/api/openings/:id/step", async (request, reply) => {
  const { id } = request.params as { id: string };
  const rec = openingSessions.get(id);
  if (!rec) return reply.code(404).send({ error: "opening_session_not_found" });
  const dag = rec.entry.openingDag;
  if (!dag) return reply.code(404).send({ error: "opening_dag_not_found" });
  const parsed = openingStepSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
  try {
    const outcome = resolveStep(dag, rec.core, parsed.data);
    rec.core = outcome.session;
    return {
      node: describeNode(dag, rec.core, { template: rec.entry.template, ui: rec.entry.ui }),
      done: rec.core.done,
      ...(outcome.resolved !== undefined ? { resolved: outcome.resolved } : {}),
      results: rec.core.results,
      // 每步都给「到目前为止拿到了什么」：向导里的「已经落定」直接展示它，
      // 与 commit 后的最终面板同一份数据（不会出现预览与结果对不上）。
      gains: collectOpeningGains(dag, rec.core, rec.entry.template, rec.entry.ui),
    };
  } catch (error) {
    return reply.code(400).send({ error: "opening_step_invalid", detail: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/openings/:id/commit", async (request, reply) => {
  const { id } = request.params as { id: string };
  const rec = openingSessions.get(id);
  if (!rec) return reply.code(404).send({ error: "opening_session_not_found" });
  const dag = rec.entry.openingDag;
  if (!dag) return reply.code(404).send({ error: "opening_dag_not_found" });
  try {
    // commit 一次建世界：前实例化参数直接写进 world，turnIndex = 0，无 delayQueue 开局事件。
    const state = commitOpening(dag, rec.core, rec.entry.template, randomUUID());
    // 会话里传的 playerName 作为兜底（参数表未声明 name 时）。
    if (rec.playerName && state.player.name === "无名氏") state.player.name = rec.playerName;

    /**
     * 开局序章（2026-11-19）：把「这一生拿到了什么」写成一段正文，再接第一幕。
     * 顺序不可换 —— 序章是第 0 轮的叙事，必须排在第一个事件之前落进历史。
     * LLM 只写装饰：失败 / 超时 / mock 一律回退模板拼的文案（见 narrative/prologue.ts）。
     */
    const choices = rec.core.results
      .map((r) => {
        const node = dag.nodes.find((n) => n.node === r.nodeId);
        const option = node?.options?.find((o) => o.id === r.optionId);
        return { step: node?.title ?? r.nodeId, choice: option?.text ?? "", mode: node?.mode };
      })
      // 只留**玩家拍板的那几步**：转盘落定的出身 / 术式会变成一长串清单，
      // 那是「命数」，写进开场白只会读成角色卡（已经由 traits 与序章正文交代）。
      .filter((c) => c.mode === "choose" && c.choice.length > 0)
      .map(({ step, choice }) => ({ step, choice }));
    const prologue = await openingPrologue(
      prologueFactsOf(state, rec.entry.template, choices, rec.entry.lore),
      createTimeAdapter(rec.entry.template).format(state.worldTime),
      request.llmProvider,
    );
    logNarrativeDiagnostic(prologue.diagnostic);
    pushHistory(state, rec.entry.template, {
      id: "t0-prologue",
      type: "milestone",
      summary: prologue.text,
      visibility: "public",
    });

    /**
     * 第一幕：把 `ev-open-01`（`source: schedule` + `window.start = 0`）直接请上桌。
     * 不推 `turnIndex`、不耗行动 —— 冷启动的槽是空的，只靠玩家下一次行动才 `nextTurn`，
     * 序章与第一幕之间就会断一次。
     */
    presentQueuedEventV2(state, rec.entry.template, rec.entry.lookup);

    worldStore.createFromState(state, rec.entry);
    openingSessions.delete(id);
    const snapshot = await decorateSnapshot(projectWorld(state, rec.entry), state, rec.entry, "player", request.llmProvider);
    return reply.code(201).send({
      worldId: state.id,
      snapshot,
      gains: collectOpeningGains(dag, rec.core, rec.entry.template, rec.entry.ui),
      prologue: prologue.text,
      prologueSource: prologue.source,
    });
  } catch (error) {
    return reply.code(400).send({ error: "opening_commit_failed", detail: error instanceof Error ? error.message : String(error) });
  }
});

/** 开局后改名（R-NAME-02）：只写权威 self 实体的名字，世界列表自然同步。 */
app.post("/api/worlds/:id/rename", async (request, reply) => {
  const { id } = request.params as { id: string };
  const found = getWorld(id);
  if (!found) return reply.code(404).send({ error: "world_not_found" });
  const parsed = renameSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
  found.world.player.name = parsed.data.name;
  worldStore.save(found.world);
  const snapshot = await decorateSnapshot(projectWorld(found.world, found.entry), found.world, found.entry, "player", request.llmProvider);
  return { worldId: id, snapshot };
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
        .send({
          error: "template_invalid",
          templateId,
          templateVersion,
          reason: found.reason,
          // 封闭拒载码（`unknown_extension` 时客户端可直接提示「该剧本需要未安装的扩展」）
          ...(found.reasonCode !== undefined ? { reasonCode: found.reasonCode } : {}),
        });
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
    // 回合增量基线（ADR-002 D4）：只抓玩家可见五类字段，不 clone 整状态。
    const gainBaseline = captureGainBaseline(world);
    const res = step(world, entry, pipeline);

    // 结构写入必须在世界再推进之前落账；非 committed ⇒ 整体回滚。
    const inv = res.state.pendingInvocation;
    if (inv !== undefined && pipeline.gateway !== undefined) {
      const savepoint = captureStructuralSavepoint(res.state);
      const outcome = await pipeline.gateway.invoke(inv);
      if (outcome.outcome !== "committed") {
        restoreStructuralSavepoint(res.state, savepoint);
      } else {
        /**
         * 本轮刚提交的分支立刻兑现（2026-11-21 用户实测「卡了半天无事发生」）。
         *
         * `advanceTurnV2` 的结算 tail 在 invoke **之前**就跑完了，模型这一轮写进
         * `generatedEvents` 的分支本来要等下一轮入队、再下一轮上桌。这里补上
         * 「入队 + 槽空就摆上来」，不推进 turnIndex / 世界时间 —— 只是把本轮写下的东西
         * 当场兑现。槽已被占 ⇒ 内部什么都不做（排队等下一位）。
         */
        const presented = presentNewlyGeneratedV2(
          res.state,
          entry.template,
          entry.lookup.withGenerated(res.state.generatedEvents),
        );
        res.triggeredEvents.push(...presented.triggered);
      }
    }

    const fresh = projectWorld(res.state, entry);
    worldStore.save(res.state);
    // 本轮收获：由基线差分得出（不落库，刷新即消失）。
    const gains = diffGains(gainBaseline, res.state, entry.lookup, entry.ui);
    // 回合叙事兜底（ADR-002 D5）：**这一回合没有 LLM invocation** 时才写模板段。
    //
    // 判据从「provider 是不是 mock」改成「这一轮有没有发起 invocation」：
    // 章节式叙事（rules.yaml 只在换章时触发）下，绝大多数回合没有 invocation，
    // 但它们同样需要正文；而配了自定义 key 的玩家 provider 不是 mock，
    // 用旧判据会整天空白。`inv` 在 invoke 之前取到，是同步事实，不依赖 trace 落盘时机。
    // 判据：**这一轮没有发起 LLM invocation** 就写模板段。
    //
    // 为什么不再看 provider：章节式叙事下绝大多数回合不触发模型，但它们仍然需要正文；
    // 而配了自定义 key 的玩家 provider 不是 mock，用旧判据会整天没有正文。
    // `inv` 是 invoke 之前取到的同步事实，不依赖 trace 落盘时机（旧判据顾忌的正是那个）。
    if (inv === undefined) {
      try {
        recordTurnNarrative(id, res.state, entry, res.snapshot.turnIndex, res.wheelResult);
      } catch (error) {
        request.log.warn({ error: error instanceof Error ? error.message : String(error) }, "turn_narrative_failed");
      }
    }
    scheduleFlavors(request, id, fresh, res.triggeredEvents);
    const snapshot = await decorateSnapshot(fresh, res.state, entry, "player", request.llmProvider);
    return {
      ok: true as const,
      turnIndex: res.snapshot.turnIndex,
      elapsed: res.elapsed,
      snapshot,
      triggeredEvents: res.triggeredEvents,
      wheelResult: res.wheelResult,
      gains,
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
      gains: tx.gains,
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
      gains: tx.gains,
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
      gains: tx.gains,
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
      gains: tx.gains,
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
    const gainBaseline = captureGainBaseline(found.world);
    const res = useItemV2(found.world, parsed.data, found.entry.template, found.entry.lookup.withGenerated(found.world.generatedEvents), found.entry.pipeline);
    worldStore.save(res.state);
    const gains = diffGains(gainBaseline, res.state, found.entry.lookup, found.entry.ui);
    if (request.llmProvider.id === "mock") {
      try {
        recordTurnNarrative(found.world.id, res.state, found.entry, res.snapshot.turnIndex, res.wheelResult);
      } catch (error) {
        request.log.warn({ error: error instanceof Error ? error.message : String(error) }, "turn_narrative_failed");
      }
    }
    scheduleFlavors(request, found.world.id, res.snapshot, res.triggeredEvents);
    const snapshot = await decorateSnapshot(res.snapshot, res.state, found.entry, "player", request.llmProvider);
    return {
      worldId: found.world.id,
      snapshot,
      gains,
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
/**
 * 世界内加点（ADR-019）：**轮外端点**，不推进回合、不触发事件。
 *
 * 校验用与开局同一个 `normalizeAllocation`（预算 / 单项上下限 / 非负整数），
 * 提交即落基础属性并清掉请求 —— 世界里不保存「剩余点数」。
 */
const allocationSchema = z
  .object({
    allocationId: z.string().min(1),
    points: z.record(z.string(), z.number()).default({}),
  })
  .strict();

app.post("/api/worlds/:id/allocation", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!getWorld(id)) return reply.code(404).send({ error: "world_not_found" });
  const parsed = allocationSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });

  // 与其它会写世界的接口共用同一把串行锁：加点虽然是轮外操作，但它与战斗指令
  // 都会改 `state.player`，不排队就可能出现「一边结算战斗、一边改基础属性」。
  // 锁内必须重取世界（锁只保证串行，不保证进临界区前读到的引用是新的）。
  return withWorldLock(id, async () => {
    const found = getWorld(id);
    if (!found) return reply.code(404).send({ error: "world_not_found" });

    /**
     * 战斗中禁止加点（2026-11-21 用户裁定）。
     *
     * 战斗单位在开打那一刻就把属性快照进了 `Combatant`（`buildUnit`），之后加点
     * **不会**改变这一场的任何数值：面板上写着「+2 体质」，HP 条却一动不动。
     * 与其让玩家以为它生效了，不如明确拒绝 —— 与「战斗中不能换装」同一条纪律：
     * 这些都是战后的动作。
     */
    if (allocationBlockedReason(found.world) === "battle") {
      return reply.code(409).send({ error: "allocation_in_battle", hint: "战斗结束之后再分配点数" });
    }

    const pending = found.world.pendingAllocation;
    if (pending === undefined) return reply.code(409).send({ error: "no_pending_allocation" });
    if (pending.id !== parsed.data.allocationId) {
      // 带上请求里的 id 与当前请求的 id 才查得动：两笔加点不会同时存在，但玩家可能开着旧页面。
      return reply
        .code(409)
        .send({ error: "allocation_mismatch", detail: `当前待办是 ${pending.id}` });
    }

    const checked = normalizeAllocation(parsed.data.points, {
      budget: pending.budget,
      targets: pending.targets,
    });
    if (!checked.ok) {
      return reply.code(400).send({ error: `allocation_${checked.code}`, detail: checked.detail });
    }

    // 落点 = 基础属性（与开局同一口径，ADR-004 D5「叠加不覆盖」），上限按模板 caps 夹。
    const caps = found.entry.template.attributes.caps;
    for (const [attribute, amount] of Object.entries(checked.points)) {
      if (amount <= 0) continue;
      const current = found.world.player.attributes[attribute];
      if (typeof current !== "number") continue;
      const cap = caps?.[attribute];
      found.world.player.attributes[attribute] =
        cap !== undefined ? Math.min(cap, current + amount) : current + amount;
    }
    delete found.world.pendingAllocation;
    worldStore.save(found.world);
    const snapshot = await decorateSnapshot(
      projectWorld(found.world, found.entry),
      found.world,
      found.entry,
      "player",
      request.llmProvider,
    );
    return { worldId: id, snapshot, spent: checked.spent };
  });
});

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
  //
  // 2026-11-21：改成走 `evaluationOutcomeFor`（与结局同一条路径）——结局卡在**终止那一刻**
  // 就已经生成过一次，归档再调一次既浪费钱、又可能给出两份不同的总结。这里只取缓存。
  const evaluationKey = evaluationCacheKey(found.world.id, found.world.turnIndex, "player");
  let summaryOutcome = evaluationOutcomeCache.get(evaluationKey);
  if (summaryOutcome === undefined) {
    summaryOutcome = await evaluationOutcomeFor(found.world, found.entry, request.llmProvider);
    evaluationOutcomeCache.set(evaluationKey, summaryOutcome);
  }
  const finalEvaluation = masked
    ? evaluation
    : finalizeEvaluationSummary(evaluation, adapterFromOutcome(summaryOutcome));

  // R2.7 · T-S1：结局叙事接真实 LLM。outcome 同时用于响应层装饰
  // `snapshot.ending.narrativeSource`（主理人裁决 3：玩家可见准绳）。
  // F3 写入侧③：结局正文在 `endingOutcomeFor` 内即落 trace（与装饰同源，不重复生成）。
  //
  // 2026-11-21：先查缓存 —— 终止那一刻的响应已经生成过一次，归档时再调一次等于让模型
  // 把同一段收尾写两遍（既烧钱，也可能给出两份不同的「盖棺」文案）。
  const endingKey = narrativeCacheKey(found.world.id, found.world.turnIndex, "player");
  let endingOutcome = endingOutcomeCache.get(endingKey);
  if (endingOutcome === undefined) {
    endingOutcome = await endingOutcomeFor(found.world, found.entry, "player", request.llmProvider);
    endingOutcomeCache.set(endingKey, endingOutcome);
  }
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
    found.entry.ui,
  );
  // 响应层装饰：纯函数、不改 state / 不改 V2Snapshot 类型；hidden 结局自动跳过
  archived.record.snapshot = decorateEndingView(archived.record.snapshot, endingOutcome);
  worldStore.seal(archived.state);
  // 归档响应只下发 public 历史 + hidden 计数（R-VS-04）；完整记录随 seal 落盘（存档事实保留全量）
  return { worldId: found.world.id, archive: projectArchiveForPlayer(archived.record) };
});

// ---------- 本地开发后台（trace / 事件编排）：仅 LIFE_SIM_ADMIN=1 时开门 ----------
if (adminEnabled()) {
  // 口令闸先挂：线上用 LIFE_SIM_ADMIN_TOKEN 开门，本地 LIFE_SIM_ADMIN=1 不设防
  registerAdminGuard(app);
  registerAdminRoutes(app, registry);
  app.log.info(
    process.env.LIFE_SIM_ADMIN_TOKEN ? "[admin] /admin 已启用（口令保护）" : "[admin] /admin 已启用（无口令，仅限本地）",
  );
} else {
  // 关着的时候明确回 403，而不是被下面的 web 兜底当成前端路由返回 index.html。
  app.get("/admin", async (_request, reply) =>
    reply.code(403).send({ error: "admin_disabled", hint: "以 LIFE_SIM_ADMIN=1 启动服务端" }),
  );
  app.get("/admin/*", async (_request, reply) =>
    reply.code(403).send({ error: "admin_disabled", hint: "以 LIFE_SIM_ADMIN=1 启动服务端" }),
  );
}

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
  const found = existsSync(resolved) && statSync(resolved).isFile();
  /**
   * 构建产物文件名自带内容哈希，换版本后旧文件就不存在了。
   * 这里**必须 404**：回退成 index.html 会让浏览器把 HTML 当 JS 解析，
   * 报一个与真实原因无关的语法错，而真正的原因是「手里那份旧页面在找旧文件」。
   */
  if (!found && urlPath.startsWith("/assets/")) {
    return reply.code(404).send({ error: "asset_not_found" });
  }
  const target = found ? resolved : path.join(webDist, "index.html");
  const ext = path.extname(target).toLowerCase();
  /**
   * HTML 每次回源：手机浏览器会启发式缓存没有 Cache-Control 的页面，
   * 结果界面改了、玩家还停在旧 bundle 上（2026-11-20 实际踩到）。
   * `/assets/*` 是哈希文件名，可以放心长缓存。
   */
  reply.header(
    "cache-control",
    urlPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache, must-revalidate",
  );
  reply.type(MIME[ext] ?? "application/octet-stream").send(readFileSync(target));
});

const port = Number(process.env.PORT ?? 3000);
// SSE 叙事流：正文可流式下发，但**结构写入仍在回合事务内**（ADR-0035 §6）。必须在 listen 前注册。
await registerNarrativeStreamRoute(app);
/**
 * 存档同步（ADR-070 第三期 · T5）：本地世界的信封备份，服务端只搬字节。
 * 刻意挂在 `worldStore` 之外 —— 同步来的档不进注册表，不会被当成"可玩世界"载入。
 */
registerSyncRoutes(app, dataDir());
await app.listen({ port, host: "0.0.0.0" });
