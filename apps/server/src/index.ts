import Fastify from "fastify";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import {
  advanceTurnV2,
  battleActionV2,
  chooseOptionV2,
  createLookup,
  projectSnapshotV2,
  useItemV2,
} from "@life-sim/game-core";
import { getOpeningTemplates, loadTemplates } from "./templates.js";
import { worldStore } from "./store.js";

const app = Fastify({ logger: true });

// ---------- 模板注册（启动期加载 YAML，校验失败拒绝启动） ----------

const templates = loadTemplates();
const lookups = new Map([...templates.entries()].map(([id, t]) => [id, createLookup(t)]));

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
  return reply.code(201).send({ worldId: world.id, snapshot: projectSnapshotV2(world, template, lookup) });
});

app.get("/api/worlds/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const found = getWorld(id);
  if (!found) return reply.code(404).send({ error: "world_not_found" });
  return {
    worldId: found.world.id,
    snapshot: projectSnapshotV2(found.world, found.template, found.lookup),
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
    const res = advanceTurnV2(found.world, parsed.data, found.template, found.lookup);
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
    const res = chooseOptionV2(found.world, parsed.data, found.template, found.lookup);
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
    const res = battleActionV2(found.world, parsed.data, found.template, found.lookup);
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
    const res = useItemV2(found.world, parsed.data, found.template, found.lookup);
    worldStore.save(res.state);
    return { worldId: found.world.id, snapshot: res.snapshot };
  } catch (error) {
    return handleEngineError(request, reply, error);
  }
});

app.get("/api/worlds/:id/history", async (request, reply) => {
  const { id } = request.params as { id: string };
  const world = worldStore.get(id);
  if (!world) return reply.code(404).send({ error: "world_not_found" });
  return { history: world.history };
});

function handleEngineError(request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply, error: unknown) {
  request.log.error(error);
  const message = error instanceof Error ? error.message : String(error);
  const interactionErrors = new Set(["pending_event_required", "battle_in_progress", "battle_not_active", "no_pending_event"]);
  if (interactionErrors.has(message)) {
    return reply.code(409).send({ error: message });
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
