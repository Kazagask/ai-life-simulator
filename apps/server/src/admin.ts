import type { FastifyInstance, FastifyReply } from "fastify";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createTimeAdapter } from "@life-sim/game-core";
import type { LlmTrace } from "@life-sim/shared";
import type { ReadyTemplateEntry, TemplateRegistry } from "./templates.js";
import { dataDir, traceFile, worldStore } from "./store.js";

/**
 * 本地开发用后台工具（2026-11-19）。
 *
 * 两个视图：
 * - trace：把 `<worldId>.trace.jsonl` 的 invocation 序列摊平成可读时间线（模型调了什么、
 *   服务端收/拒了什么、正文长什么样、延迟与 token 花在哪）。
 * - orchestration：把模板的 events.yaml 派生成「事件 → 事件」图 + 「flag 写入/读取」索引，
 *   用来看分支、断链、结局可达性。
 *
 * **只在 `LIFE_SIM_ADMIN=1` 时注册**：trace 里是完整叙事正文（含本该被窗口挡住的原文），
 * 这个工具绝不能跟着线上部署一起开门。数据全部只读，不提供任何写接口。
 */

/* ------------------------------------------------------------------ *
 * 数据结构
 * ------------------------------------------------------------------ */

interface AdminFlagWrite {
  flag: string;
  how: string;
  optionId?: string;
}

interface AdminFlagRead {
  flag: string;
  where: "trigger" | "missWhen" | "visibleWhen" | "ending" | "unlock" | "termination";
  /** 读取点所属事件；结局 / 终止条件读旗标时没有单一事件，留空。 */
  eventId?: string;
  optionId?: string;
}

interface AdminEdge {
  from: string;
  to: string;
  type: "option" | "wheel" | "victory" | "defeat" | "flee" | "enqueue";
  label: string;
}

interface AdminOrchestration {
  template: { id: string; version: string; name: string; description: string; startYear: number };
  generatedAt: string;
  labels: Record<string, string>;
  resources: Record<string, string>;
  characters: Array<{ id: string; name: string; isEnemy: boolean; gender?: string }>;
  items: Array<{ id: string; name: string }>;
  skills: Array<{ id: string; name: string }>;
  statuses: Array<{ id: string; name: string }>;
  events: unknown[];
  edges: AdminEdge[];
  flags: Array<{
    id: string;
    writers: Array<{ eventId: string; optionId?: string; how: string }>;
    readers: AdminFlagRead[];
  }>;
  endings: unknown[];
  termination: unknown[];
  chains: unknown[];
  stats: {
    eventCount: number;
    edgeCount: number;
    flagCount: number;
    danglingEdges: AdminEdge[];
    orphanChainEvents: string[];
  };
}

/* ------------------------------------------------------------------ *
 * 模板 → 编排图
 * ------------------------------------------------------------------ */

/** 从效果里收集 flag 写入（只认闭集里的三种写法，其余形态不猜）。 */
function flagWritesOf(effects: unknown): Array<{ flag: string; how: string }> {
  if (!Array.isArray(effects)) return [];
  const out: Array<{ flag: string; how: string }> = [];
  for (const raw of effects) {
    if (raw === null || typeof raw !== "object") continue;
    const effect = raw as Record<string, unknown>;
    const id = effect.id;
    if (typeof id !== "string" || id === "") continue;
    if (effect.type === "setFlag") out.push({ flag: id, how: `setFlag = ${JSON.stringify(effect.value)}` });
    else if (effect.type === "adjustFlag") out.push({ flag: id, how: `adjustFlag ${String(effect.value)}` });
    else if (effect.type === "clearFlag") out.push({ flag: id, how: "clearFlag" });
  }
  return out;
}

/** 条件里引用的 flag。条件数组是 AND 语义，只看平层 key。 */
function flagsReadInConditions(conditions: unknown): string[] {
  if (!Array.isArray(conditions)) return [];
  const out: string[] = [];
  for (const cond of conditions) {
    if (cond === null || typeof cond !== "object") continue;
    const flag = (cond as Record<string, unknown>).flag;
    if (typeof flag === "string" && flag !== "") out.push(flag);
  }
  return [...new Set(out)];
}

function nextEventIdOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const id = (value as Record<string, unknown>).nextEventId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** 效果里的 `enqueueEvent` 也是编排的一部分（占槽之外的另一条入队路径）。 */
function enqueuedEventIds(effects: unknown): string[] {
  if (!Array.isArray(effects)) return [];
  const out: string[] = [];
  for (const raw of effects) {
    if (raw === null || typeof raw !== "object") continue;
    const effect = raw as Record<string, unknown>;
    if (effect.type === "enqueueEvent" && typeof effect.eventId === "string") out.push(effect.eventId);
  }
  return out;
}

function buildOrchestration(entry: ReadyTemplateEntry): AdminOrchestration {
  const tpl = entry.template;
  const edges: AdminEdge[] = [];
  const flags = new Map<string, { writers: Array<{ eventId: string; optionId?: string; how: string }>; readers: AdminFlagRead[] }>();

  const ensureFlag = (id: string) => {
    let row = flags.get(id);
    if (!row) {
      row = { writers: [], readers: [] };
      flags.set(id, row);
    }
    return row;
  };

  for (const event of tpl.events) {
    const trigger = event.trigger as Record<string, unknown>;
    for (const flag of flagsReadInConditions(trigger.conditions)) {
      ensureFlag(flag).readers.push({ flag, where: "trigger", eventId: event.id });
    }
    for (const flag of flagsReadInConditions(trigger.missWhen)) {
      ensureFlag(flag).readers.push({ flag, where: "missWhen", eventId: event.id });
    }

    // 事件自身的写入（选项 / 转盘分段 / 战斗结果）
    const writes = (list: Array<{ optionId?: string; effects: unknown }>) => {
      for (const item of list) {
        for (const w of flagWritesOf(item.effects)) {
          ensureFlag(w.flag).writers.push({
            eventId: event.id,
            ...(item.optionId !== undefined ? { optionId: item.optionId } : {}),
            how: w.how,
          });
        }
        for (const target of enqueuedEventIds(item.effects)) {
          edges.push({
            from: event.id,
            to: target,
            type: "enqueue",
            label: "enqueueEvent",
          });
        }
      }
    };

    if (event.kind === "normal") {
      writes(event.settle.normal.options.map((o) => ({ optionId: o.id, effects: o.effects })));
      for (const option of event.settle.normal.options) {
        for (const flag of flagsReadInConditions(option.visibleWhen)) {
          ensureFlag(flag).readers.push({ flag, where: "visibleWhen", eventId: event.id, optionId: option.id });
        }
        if (option.nextEventId) {
          edges.push({ from: event.id, to: option.nextEventId, type: "option", label: option.text });
        }
      }
    } else if (event.kind === "random") {
      writes(event.settle.random.wheel.segments.map((s) => ({ effects: s.effects })));
      for (const segment of event.settle.random.wheel.segments) {
        if (segment.nextEventId) {
          edges.push({ from: event.id, to: segment.nextEventId, type: "wheel", label: segment.label });
        }
      }
    } else {
      const outcomes: Array<[AdminEdge["type"], string, unknown]> = [
        ["victory", "胜利", event.settle.combat.onVictory],
        ["defeat", "战败", event.settle.combat.onDefeat],
        ["flee", "逃跑", event.settle.combat.onFlee],
      ];
      for (const [type, label, outcome] of outcomes) {
        if (outcome === undefined) continue;
        const effects = (outcome as Record<string, unknown>).effects;
        writes([{ effects }]);
        const next = nextEventIdOf(outcome);
        if (next) edges.push({ from: event.id, to: next, type, label });
      }
    }
  }

  const endings = (entry.endingConfig?.endings ?? []) as Array<Record<string, unknown>>;
  for (const ending of endings) {
    for (const flag of flagsReadInConditions(ending.triggerConditions)) {
      ensureFlag(flag).readers.push({ flag, where: "ending" });
    }
    for (const flag of flagsReadInConditions(ending.unlockConditions)) {
      ensureFlag(flag).readers.push({ flag, where: "unlock" });
    }
  }
  const termination = (entry.endingConfig?.terminationConditions ?? []) as Array<Record<string, unknown>>;
  for (const cond of termination) {
    const params = (cond.params ?? {}) as Record<string, unknown>;
    for (const flag of flagsReadInConditions(params.conditions)) {
      ensureFlag(flag).readers.push({ flag, where: "termination" });
    }
  }

  const eventIds = new Set(tpl.events.map((e) => e.id));
  const danglingEdges = edges.filter((e) => !eventIds.has(e.to));
  const targeted = new Set(edges.map((e) => e.to));
  const orphanChainEvents = tpl.events
    .filter((e) => e.trigger.source === "chain" && !targeted.has(e.id))
    .map((e) => e.id);

  const attributeLabels = (tpl.attributes.labels ?? {}) as Record<string, string>;
  return {
    template: {
      id: entry.ref.id,
      version: entry.ref.version,
      name: tpl.meta.name,
      description: tpl.meta.description,
      startYear: tpl.meta.startYear,
    },
    generatedAt: new Date().toISOString(),
    labels: attributeLabels,
    resources: { hp: "生命", mp: "咒力" },
    characters: tpl.characters.map((c) => ({
      id: c.id,
      name: c.identity.name,
      isEnemy: c.isEnemy === true,
      ...(c.identity.gender !== undefined ? { gender: c.identity.gender } : {}),
    })),
    items: tpl.items.map((i) => ({ id: i.id, name: i.name })),
    skills: tpl.skills.map((s) => ({ id: s.id, name: s.name })),
    statuses: tpl.statuses.map((s) => ({ id: s.id, name: s.name })),
    events: tpl.events,
    edges,
    flags: [...flags.entries()]
      .map(([id, row]) => ({ id, writers: row.writers, readers: row.readers }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    endings,
    termination,
    chains: (tpl.chains ?? []) as unknown[],
    stats: {
      eventCount: tpl.events.length,
      edgeCount: edges.length,
      flagCount: flags.size,
      danglingEdges,
      orphanChainEvents,
    },
  };
}

/* ------------------------------------------------------------------ *
 * trace 读取
 * ------------------------------------------------------------------ */

interface TraceFileSummary {
  entries: LlmTrace[];
  skippedLines: number;
  bytes: number;
  stats: {
    committed: number;
    fallback: number;
    deferred: number;
    inputTokens: number;
    outputTokens: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    maxLatencyMs: number;
    tools: Array<{ tool: string; count: number }>;
    diagnostics: Array<{ code: string; count: number }>;
    fallbackCodes: Array<{ code: string; count: number }>;
  };
}

/** 损坏行跳过而不是整份失败：append-only 文件可能被进程崩溃截断在最后一行。 */
function readTraceFile(worldId: string): TraceFileSummary {
  const file = traceFile(worldId);
  const raw = readFileSync(file, "utf-8");
  const entries: LlmTrace[] = [];
  let skippedLines = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      entries.push(JSON.parse(trimmed) as LlmTrace);
    } catch {
      skippedLines += 1;
    }
  }

  const tools = new Map<string, number>();
  const diagnostics = new Map<string, number>();
  const fallbackCodes = new Map<string, number>();
  let inputTokens = 0;
  let outputTokens = 0;
  let committed = 0;
  let fallback = 0;
  let deferred = 0;
  const latencies: number[] = [];

  for (const entry of entries) {
    if (entry.outcome === "committed") committed += 1;
    else if (entry.outcome === "fallback") fallback += 1;
    else deferred += 1;
    inputTokens += entry.inputTokens ?? 0;
    outputTokens += entry.outputTokens ?? 0;
    latencies.push(entry.latencyMs ?? 0);
    for (const call of entry.calls ?? []) tools.set(call.tool, (tools.get(call.tool) ?? 0) + 1);
    for (const code of entry.diagnostics ?? []) diagnostics.set(code, (diagnostics.get(code) ?? 0) + 1);
    if (entry.fallbackCode) fallbackCodes.set(entry.fallbackCode, (fallbackCodes.get(entry.fallbackCode) ?? 0) + 1);
  }

  latencies.sort((a, b) => a - b);
  const p95 = latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]!;
  const avg = latencies.length === 0 ? 0 : latencies.reduce((s, v) => s + v, 0) / latencies.length;

  return {
    entries,
    skippedLines,
    bytes: statSync(file).size,
    stats: {
      committed,
      fallback,
      deferred,
      inputTokens,
      outputTokens,
      avgLatencyMs: Math.round(avg),
      p95LatencyMs: p95,
      maxLatencyMs: latencies.length === 0 ? 0 : latencies[latencies.length - 1]!,
      tools: [...tools.entries()].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count),
      diagnostics: [...diagnostics.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count),
      fallbackCodes: [...fallbackCodes.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 世界列表（磁盘扫描，含不可载档）
 * ------------------------------------------------------------------ */

interface AdminWorldRow {
  id: string;
  playerName?: string;
  templateId?: string;
  templateVersion?: string;
  templateName?: string;
  turnIndex?: number;
  worldTime?: number;
  formattedTime?: string;
  status?: "running" | "terminated" | "archived";
  loadable: boolean;
  unloadableReason?: string;
  savedAt?: string;
  trace: { exists: boolean; entries: number; bytes: number };
}

function listWorlds(): AdminWorldRow[] {
  const dir = dataDir();
  if (!existsSync(dir)) return [];
  const loaded = new Map(worldStore.all().map((r) => [r.state.id, r]));
  const rows = new Map<string, AdminWorldRow>();

  for (const name of readdirSync(dir)) {
    if (name.endsWith(".trace.jsonl")) {
      const id = name.slice(0, -".trace.jsonl".length);
      const file = path.join(dir, name);
      const size = statSync(file).size;
      const lineCount = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim() !== "").length;
      const existing = rows.get(id) ?? { id, loadable: false, trace: { exists: true, entries: 0, bytes: 0 } };
      existing.trace = { exists: true, entries: lineCount, bytes: size };
      rows.set(id, existing);
    } else if (name.endsWith(".json")) {
      const id = name.slice(0, -".json".length);
      const existing = rows.get(id) ?? { id, loadable: false, trace: { exists: false, entries: 0, bytes: 0 } };
      existing.savedAt = statSync(path.join(dir, name)).mtime.toISOString();
      rows.set(id, existing);
    }
  }

  for (const row of rows.values()) {
    const record = loaded.get(row.id);
    if (record) {
      const state = record.state;
      row.loadable = true;
      row.playerName = state.player.name;
      row.templateId = record.entry.ref.id;
      row.templateVersion = record.entry.ref.version;
      row.templateName = record.entry.template.meta.name;
      row.turnIndex = state.turnIndex;
      row.worldTime = state.worldTime;
      row.status = state.archived === true ? "archived" : state.termination !== null ? "terminated" : "running";
      // 时间格式化只在可载档做得出来（需要模板历法）。
      try {
        row.formattedTime = createTimeAdapter(record.entry.template).format(state.worldTime);
      } catch {
        row.formattedTime = undefined;
      }
    }
  }

  for (const unloadable of worldStore.unloadableAll()) {
    const row = rows.get(unloadable.id);
    if (row) {
      row.unloadableReason = unloadable.reason;
      row.templateId = unloadable.templateId;
      row.templateVersion = unloadable.templateVersion;
    }
  }

  return [...rows.values()].sort((a, b) => (a.savedAt ?? "") < (b.savedAt ?? "") ? 1 : -1);
}

/* ------------------------------------------------------------------ *
 * 静态资源
 * ------------------------------------------------------------------ */

const ADMIN_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../admin");

const ADMIN_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function sendAdminAsset(reply: FastifyReply, relative: string): FastifyReply {
  const resolved = path.resolve(path.join(ADMIN_DIST, relative));
  if (!resolved.startsWith(ADMIN_DIST)) return reply.code(403).send({ error: "forbidden" });
  const target =
    existsSync(resolved) && statSync(resolved).isFile() ? resolved : path.join(ADMIN_DIST, "index.html");
  if (!existsSync(target)) {
    return reply.code(503).send({ error: "admin_dist_missing", hint: "缺少 apps/admin/index.html" });
  }
  return reply.type(ADMIN_MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream").send(readFileSync(target));
}

/* ------------------------------------------------------------------ *
 * 路由注册
 * ------------------------------------------------------------------ */

/** `LIFE_SIM_ADMIN=1` 才开门：trace 里有本该被玩家窗口挡住的原文，不能随线上一起暴露。 */
export function adminEnabled(): boolean {
  const flag = process.env.LIFE_SIM_ADMIN;
  return flag === "1" || flag === "true";
}

export function registerAdminRoutes(app: FastifyInstance, registry: TemplateRegistry): void {
  app.get("/admin", async (_request, reply) => sendAdminAsset(reply, "index.html"));
  app.get("/admin/*", async (request, reply) => {
    const wildcard = (request.params as Record<string, string>)["*"] ?? "index.html";
    return sendAdminAsset(reply, wildcard === "" ? "index.html" : wildcard);
  });

  app.get("/api/admin/health", async () => ({
    ok: true,
    dataDir: dataDir(),
    templateDir: registry.dir,
    adminDist: ADMIN_DIST,
  }));

  app.get("/api/admin/worlds", async () => ({ worlds: listWorlds() }));

  app.get("/api/admin/worlds/:id/trace", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return reply.code(400).send({ error: "invalid_world_id" });
    if (!existsSync(traceFile(id))) return reply.code(404).send({ error: "trace_not_found", worldId: id });
    const summary = readTraceFile(id);
    const record = worldStore.all().find((r) => r.state.id === id);
    const world = record
      ? {
          id,
          playerName: record.state.player.name,
          templateId: record.entry.ref.id,
          templateVersion: record.entry.ref.version,
          templateName: record.entry.template.meta.name,
          turnIndex: record.state.turnIndex,
          worldTime: record.state.worldTime,
          seed: record.state.seed,
          status:
            record.state.archived === true
              ? "archived"
              : record.state.termination !== null
                ? "terminated"
                : "running",
          flags: record.state.flags,
          slot: record.state.slot,
        }
      : { id, loadable: false };
    return { world, ...summary };
  });

  app.get("/api/admin/templates/:id/:version/orchestration", async (request, reply) => {
    const { id, version } = request.params as { id: string; version: string };
    const entry = registry.resolve({ id, version });
    if (!entry) {
      // 把拒载原因带出去：admin 的第一价值就是「为什么这个版本打不开」。
      const raw = registry.get({ id, version });
      return reply.code(404).send({
        error: "template_not_ready",
        detail: raw?.status === "invalid" ? raw.reason : "模板版本不存在或不可载入",
        reasonCode: raw?.status === "invalid" ? raw.reasonCode : undefined,
      });
    }
    return buildOrchestration(entry);
  });

  app.get("/api/admin/templates", async () => ({
    templates: registry.listTemplates(),
  }));
}
