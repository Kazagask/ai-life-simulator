import type { FastifyInstance, FastifyReply } from "fastify";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { simulateDuel, type SimActorSpec, type SimDuelSpec } from "./admin/sim.js";
import type { TemplateRegistry } from "./templates.js";
import { dataDir, traceFile, worldStore } from "./store.js";
import { buildOrchestration, diagnoseOrchestration, listWorlds, readTraceFile } from "./admin-data.js";
import { buildNpcLine } from "./admin-lines.js";
import { registerLiveBattleRoutes } from "./admin/battle.js";

/**
 * 本地开发用后台工具（2026-11-19）。
 *
 * 三个视图：
 * - trace：把 `<worldId>.trace.jsonl` 的 invocation 序列摊平成可读时间线（模型调了什么、
 *   服务端收/拒了什么、正文长什么样、延迟与 token 花在哪）。
 * - orchestration：把模板的 events.yaml 派生成「事件 → 事件」图 + 「flag 写入/读取」索引，
 *   用来看分支、断链、结局可达性。
 * - sim（战斗木桩）：把表单翻译成 `SimDuelSpec` 交给 `simulateDuel`，量技能消耗 / 伤害 /
 *   命中率。这一栏**不放任何战斗规则**，数字全部来自真实的 `performBattleAction`。
 *
 * 数据层在 `admin-data.ts`（无 HTTP 依赖），同一份推导也被 `cli/inspect.ts` 用作命令行体检。
 *
 * **只在 `LIFE_SIM_ADMIN=1` 时注册**：trace 里是完整叙事正文（含本该被窗口挡住的原文），
 * 这个工具绝不能跟着线上部署一起开门。数据全部只读，不提供任何写接口。
 */

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
  if (resolved !== ADMIN_DIST && !resolved.startsWith(ADMIN_DIST + path.sep)) {
    return reply.code(403).send({ error: "forbidden" });
  }
  const target =
    existsSync(resolved) && statSync(resolved).isFile() ? resolved : path.join(ADMIN_DIST, "index.html");
  if (!existsSync(target)) {
    return reply.code(503).send({ error: "admin_dist_missing", hint: "缺少 apps/admin/index.html" });
  }
  return reply.type(ADMIN_MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream").send(readFileSync(target));
}

/* ------------------------------------------------------------------ *
 * 战斗木桩（第三视图）：请求体 → SimDuelSpec
 * ------------------------------------------------------------------ */

/**
 * 表单是自由文本，所以这里做一次白名单收窄：只取内核认得的字段，
 * 数值夹进合理区间（一局木桩不该被 `repeat: 1e9` 拖死服务端）。
 * **不在这里做任何战斗解释** —— 建世界、挑技能、结算全部走 `simulateDuel`。
 */
const SIM_MAX_DUELS = 200;
const SIM_MAX_ROUNDS = 100;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = finiteNumber(raw);
    if (n !== undefined) out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return out.length > 0 ? out : undefined;
}

function actorSpecOf(value: unknown): SimActorSpec | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const ref = typeof raw.ref === "string" && raw.ref.length > 0 ? raw.ref : undefined;

  const rawDummy = raw.dummy;
  let dummy: NonNullable<SimActorSpec["dummy"]> | undefined;
  if (rawDummy !== null && typeof rawDummy === "object" && !Array.isArray(rawDummy)) {
    const d = rawDummy as Record<string, unknown>;
    const hp = finiteNumber(d.hp);
    const attributes = numberRecord(d.attributes);
    const statuses = stringList(d.statuses);
    dummy = {
      ...(typeof d.name === "string" && d.name.length > 0 ? { name: d.name } : {}),
      ...(hp !== undefined ? { hp: Math.max(1, Math.round(hp)) } : {}),
      ...(attributes !== undefined ? { attributes } : {}),
      ...(statuses !== undefined ? { statuses } : {}),
    };
  }

  const attributes = numberRecord(raw.attributes);
  const skills = stringList(raw.skills);
  const statuses = stringList(raw.statuses);
  const equipment = stringList(raw.equipment);
  const spec: SimActorSpec = {
    ...(ref !== undefined ? { ref } : {}),
    ...(dummy !== undefined ? { dummy } : {}),
    ...(attributes !== undefined ? { attributes } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(statuses !== undefined ? { statuses } : {}),
    ...(equipment !== undefined ? { equipment } : {}),
  };
  if (spec.ref === undefined && spec.dummy === undefined) return null;
  return spec;
}

function simSpecOf(value: unknown): SimDuelSpec | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const left = actorSpecOf(raw.left);
  const right = actorSpecOf(raw.right);
  if (left === null || right === null) return null;
  const repeat = Math.min(SIM_MAX_DUELS, Math.max(1, Math.round(finiteNumber(raw.repeat) ?? 20)));
  const maxRounds = Math.min(SIM_MAX_ROUNDS, Math.max(1, Math.round(finiteNumber(raw.maxRounds) ?? 30)));
  const seed = finiteNumber(raw.seed);
  return {
    left,
    right,
    repeat,
    maxRounds,
    ...(seed !== undefined ? { seed: Math.round(seed) } : {}),
    ...(raw.stance === "coverage" ? { stance: "coverage" as const } : {}),
  };
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
    const orchestration = buildOrchestration(entry);
    return { ...orchestration, issues: diagnoseOrchestration(orchestration) };
  });

  app.get("/api/admin/templates/:id/:version/npc/:npcId", async (request, reply) => {
    const { id, version, npcId } = request.params as { id: string; version: string; npcId: string };
    const entry = registry.resolve({ id, version });
    if (!entry) return reply.code(404).send({ error: "template_not_ready" });
    const line = buildNpcLine(buildOrchestration(entry), npcId);
    if (!line) return reply.code(404).send({ error: "npc_not_found", npcId });
    return line;
  });

  /**
   * 木桩表单的候选项：角色 / 状态 / 属性键。全部取自**同一个已载入模板**，
   * 前端不缓存、不硬编码 id —— 模板一改，下拉就跟着变。
   */
  app.get("/api/admin/templates/:id/:version/roster", async (request, reply) => {
    const { id, version } = request.params as { id: string; version: string };
    const entry = registry.resolve({ id, version });
    if (!entry) return reply.code(404).send({ error: "template_not_ready" });
    const template = entry.template;
    return {
      templateId: template.meta.id,
      templateVersion: version,
      characters: template.characters.map((c) => ({
        id: c.id,
        name: c.identity.name,
        isEnemy: c.isEnemy === true,
        visibility: c.visibility ?? "public",
        skills: [...(c.skills ?? [])],
        equipment: [...(c.equipment ?? [])],
        statuses: [...(c.statuses ?? [])],
        attributes: { ...c.attributes },
        traits: [...(c.private?.traits ?? [])],
      })),
      statuses: template.statuses.map((s) => ({ id: s.id, name: s.name })),
      skills: template.skills.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
      items: template.items.map((i) => ({ id: i.id, name: i.name, slot: i.slot })),
      equipmentSlots: (template.equipment?.slots ?? []).map((s) => ({ id: s.id, label: s.label })),
      traits: [...new Set(template.characters.flatMap((c) => c.private?.traits ?? []))].sort(),
      attributeKeys: [...template.attributes.order],
      attributeLabels: { ...(template.attributes.labels ?? {}) },
      attributeDefaults: { ...template.attributes.defaults },
    };
  });

  /** 跑一场木桩。纯粹是 `simulateDuel` 的一层 HTTP 皮：没有规则、没有缓存、没有落盘。 */
  app.post("/api/admin/sim", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const templateId = typeof body.templateId === "string" ? body.templateId : undefined;
    const version = typeof body.version === "string" ? body.version : undefined;
    if (templateId === undefined || version === undefined) {
      return reply.code(400).send({ error: "bad_request", detail: "需要 templateId 与 version" });
    }
    const entry = registry.resolve({ id: templateId, version });
    if (!entry) return reply.code(404).send({ error: "template_not_ready", detail: `${templateId}@${version}` });
    const spec = simSpecOf(body.spec);
    if (spec === null) {
      return reply.code(400).send({ error: "bad_spec", detail: "left 与 right 各需要一个 ref 或 dummy" });
    }
    try {
      return simulateDuel(entry.template, spec);
    } catch (error) {
      // 角色 id 打错是最常见的失败：把内核的原文带回前端，比 500 好查。
      return reply.code(400).send({
        error: "sim_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/admin/templates", async () => ({
    templates: registry.listTemplates(),
  }));

  // 实时演练场：与木桩共用同一份 spec 解析器，但一回合一回合地走真实战斗管线。
  registerLiveBattleRoutes(app, registry, simSpecOf);
}
