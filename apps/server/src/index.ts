import Fastify from "fastify";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import {
  advanceTurnV2,
  assembleArchive,
  battleActionV2,
  chooseOptionV2,
  createDefaultEndingConfig,
  createLookup,
  createRunnerContext,
  createTimeAdapter,
  equipErrorCodeOf,
  equipV2,
  evaluateLifeV2,
  playerVisibleEntries,
  projectArchiveForPlayer,
  projectSnapshotV2,
  resolveEnding,
  unequipV2,
  useItemV2,
  type TurnPipelineConfig,
} from "@life-sim/game-core";
import type { WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
import { getEndingConfig, getEvaluationConfig, getOpeningTemplates, getTemplateFingerprint, loadTemplates } from "./templates.js";
import { dataDir, hydrate, loadPersistedWorlds, worldStore } from "./store.js";

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

// ---------- 模板注册（启动期加载 YAML，校验失败拒绝启动） ----------

const templates = loadTemplates();
const lookups = new Map([...templates.entries()].map(([id, t]) => [id, createLookup(t)]));

// ---------- 存档加载（R-PS-05 / ADR-0007）：四道校验关，坏档 error 跳过不阻断 ----------

const persisted = loadPersistedWorlds(
  new Map([...templates.entries()].map(([id, t]) => [id, getTemplateFingerprint(t.meta.id) ?? "sha256:unknown"])),
);
hydrate(persisted.loaded);
if (persisted.errors.length > 0) {
  for (const e of persisted.errors) app.log.error({ dataDir: dataDir(), file: e.file, reason: e.reason }, "save_skipped");
}
app.log.info({ dataDir: dataDir(), loaded: persisted.loaded.length, skipped: persisted.errors.length }, "worlds_loaded");

/** 模板的可选分域配置（endings.yaml / evaluation.yaml）；缺失时用引擎默认配置。 */
function pipelineOf(templateId: string): TurnPipelineConfig {
  return {
    endingConfig: getEndingConfig(templateId),
    evaluationConfig: getEvaluationConfig(templateId),
  };
}

/** 投影 + 评价：评价始终来自唯一事实来源（T4-04），结局按模板集决胜结果投影。 */
function projectWorld(world: WorldStateV2, template: WorldTemplateV2, lookup: ReturnType<typeof createLookup>) {
  const cfg = pipelineOf(template.meta.id);
  return projectSnapshotV2(
    world,
    template,
    lookup,
    evaluateLifeV2(world, cfg.evaluationConfig),
    cfg.endingConfig?.endings,
  );
}

function getWorld(id: string) {
  const world = worldStore.get(id);
  if (!world) return null;
  const template = templates.get(world.templateId);
  const lookup = lookups.get(world.templateId);
  if (!template || !lookup) return null;
  return { world, template, lookup };
}

// ---------- 输入校验（Zod） ----------

const createWorldSchema = z.object({
  templateId: z.string().min(1),
  playerName: z.string().min(1).max(20),
  seed: z.number().int().optional(),
  /** R-OP-01：可选，按 openingId 选择开局；省略则用默认/首个开局。 */
  openingId: z.string().min(1).optional(),
});

const turnSchema = z.object({
  action: z.object({
    type: z.string().min(1).max(40),
    description: z.string().max(200).default(""),
  }),
  mode: z.enum(["single", "fast"]).default("single"),
  /** 主动结束这一生（playerRequested 终止信号），仍走同一轮次管线与结局决胜 */
  endLife: z.boolean().optional(),
});

const chooseSchema = z.object({ optionId: z.string().min(1).max(40) });

const battleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("skill"), skillId: z.string().min(1), targetInstanceId: z.string().optional() }),
  z.object({ type: z.literal("item"), itemId: z.string().min(1) }),
  z.object({ type: z.literal("flee") }),
]);

const useItemSchema = z.object({ itemId: z.string().min(1) });

// ---------- API ----------

app.get("/health", async () => ({ ok: true, service: "life-sim-server", protocol: "v2" }));

app.get("/api/templates", async () => ({
  templates: [...templates.values()].map((t) => ({
    id: t.meta.id,
    name: t.meta.name,
    description: t.meta.description,
    startYear: t.meta.startYear,
    openings: getOpeningTemplates(t.meta.id).map((o) => ({
      id: o.openingId,
      name: o.name,
      description: o.description,
    })),
  })),
}));

app.post("/api/worlds", async (request, reply) => {
  const parsed = createWorldSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
  }
  const template = templates.get(parsed.data.templateId);
  if (!template) {
    return reply.code(404).send({ error: "template_not_found", templateId: parsed.data.templateId });
  }
  if (
    parsed.data.openingId !== undefined &&
    !getOpeningTemplates(template.meta.id).some((o) => o.openingId === parsed.data.openingId)
  ) {
    return reply.code(404).send({ error: "opening_not_found", openingId: parsed.data.openingId });
  }
  const world = worldStore.create(parsed.data, template);
  const lookup = lookups.get(template.meta.id)!;
  return reply.code(201).send({ worldId: world.id, snapshot: projectWorld(world, template, lookup) });
});

app.get("/api/worlds/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const found = getWorld(id);
  if (!found) return reply.code(404).send({ error: "world_not_found" });
  return {
    worldId: found.world.id,
    snapshot: projectWorld(found.world, found.template, found.lookup),
  };
});

/** 推进轮次；有待决事件/进行中战斗时拒绝（前端应先调用相应交互接口）。 */
app.post("/api/worlds/:id/turns", async (request, reply) => {
  const { id } = request.params as { id: string };
  const found = getWorld(id);
  if (!found) return reply.code(404).send({ error: "world_not_found" });

  const parsed = turnSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
  }

  try {
    const res = advanceTurnV2(found.world, parsed.data, found.template, found.lookup, undefined, pipelineOf(found.template.meta.id));
    worldStore.save(res.state);
    return {
      worldId: found.world.id,
      turnIndex: res.snapshot.turnIndex,
      elapsed: res.elapsed,
      snapshot: res.snapshot,
      triggeredEvents: res.triggeredEvents,
      wheelResult: res.wheelResult,
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
    const res = chooseOptionV2(found.world, parsed.data, found.template, found.lookup, pipelineOf(found.template.meta.id));
    worldStore.save(res.state);
    return {
      worldId: found.world.id,
      snapshot: res.snapshot,
      triggeredEvents: res.triggeredEvents,
      wheelResult: res.wheelResult,
    };
  } catch (error) {
    return handleEngineError(request, reply, error);
  }
});

app.post("/api/worlds/:id/battle", async (request, reply) => {
  const { id } = request.params as { id: string };
  const found = getWorld(id);
  if (!found) return reply.code(404).send({ error: "world_not_found" });

  const parsed = battleSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
  }

  try {
    const res = battleActionV2(found.world, parsed.data, found.template, found.lookup, pipelineOf(found.template.meta.id));
    worldStore.save(res.state);
    return {
      worldId: found.world.id,
      snapshot: res.snapshot,
      triggeredEvents: res.triggeredEvents,
      wheelResult: res.wheelResult,
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
    const res = useItemV2(found.world, parsed.data, found.template, found.lookup, pipelineOf(found.template.meta.id));
    worldStore.save(res.state);
    return { worldId: found.world.id, snapshot: res.snapshot };
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
    const res = equipV2(found.world, parsed.data, found.template, found.lookup);
    worldStore.save(res.state);
    return { worldId: found.world.id, snapshot: res.snapshot };
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
    const res = unequipV2(found.world, parsed.data, found.template, found.lookup);
    worldStore.save(res.state);
    return { worldId: found.world.id, snapshot: res.snapshot };
  } catch (error) {
    return handleEquipError(request, reply, error);
  }
});

/**
 * 世界列表（R-PS-04 / design §3.5）：按 savedAt 倒序；空目录返回空数组不报 404。
 * status 由 archived / termination 推导；endingTitle 取结局模板的公开标题。
 */
app.get("/api/worlds", async () => {
  const worlds = worldStore
    .all()
    .map((w) => {
      const template = templates.get(w.templateId);
      const lookup = lookups.get(w.templateId);
      const cfg = pipelineOf(w.templateId);
      const status: "running" | "terminated" | "archived" =
        w.archived === true ? "archived" : w.termination !== null ? "terminated" : "running";
      // endingTitle：已终止时按结局模板决胜（同输入 ⇒ 同结果）；隐藏结局显示掩码标题
      let endingTitle: string | undefined;
      if (w.termination !== null && lookup) {
        const cfgEnding = cfg.endingConfig ?? createDefaultEndingConfig();
        const ctx = { state: w, lookup, rng: createRunnerContext(w.seed).rng };
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
        templateId: w.templateId,
        templateName: template?.meta.name ?? w.templateId,
        playerName: w.player.name,
        turnIndex: w.turnIndex,
        worldTime: w.worldTime,
        formattedTime: template && lookup ? createTimeAdapter(template).format(w.worldTime) : String(w.worldTime),
        status,
        endingTitle,
        savedAt: worldStore.savedAt(w.id) ?? "",
      };
    })
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
  return { worlds };
});

/** 删除世界（R-PS-04）：删文件 + 删内存条目；删除确认由前端负责。 */
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
  const world = worldStore.get(id);
  if (!world) return reply.code(404).send({ error: "world_not_found" });
  // 玩家端出口只下发 public 条目（R-VS-02 / 协议 §21.1）
  return { history: playerVisibleEntries(world.history) };
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
  const cfg = pipelineOf(found.template.meta.id);
  const endingConfig = cfg.endingConfig ?? createDefaultEndingConfig();
  const evaluation = evaluateLifeV2(found.world, cfg.evaluationConfig);
  // 归档时的结局记录：按终局状态重新决胜（与终止时刻同输入 ⇒ 同结果，确定性）
  const ctx = {
    state: found.world,
    lookup: found.lookup,
    rng: createRunnerContext(found.world.seed).rng,
  };
  const ending = resolveEnding(
    found.world,
    endingConfig.endings,
    ctx,
    endingConfig.fallback !== undefined ? { fallbackId: endingConfig.fallback } : {},
  );
  const archived = assembleArchive(
    found.world,
    found.template,
    found.lookup,
    ending,
    evaluation,
    endingConfig.endings,
  );
  worldStore.seal(archived.state);
  // 归档响应只下发 public 历史 + hidden 计数（R-VS-04）；完整记录随 seal 落盘（存档事实保留全量）
  return { worldId: found.world.id, archive: projectArchiveForPlayer(archived.record) };
});

function handleEngineError(request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply, error: unknown) {
  request.log.error(error);
  const message = error instanceof Error ? error.message : String(error);
  const interactionErrors = new Set(["pending_event_required", "battle_in_progress", "battle_not_active", "no_pending_event"]);
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
await app.listen({ port, host: "0.0.0.0" });
