import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * 存档同步（ADR-070 第三期 · T5）：服务端**只搬字节**。
 *
 * 本地世界以「信封」形式上传，这里不做 schema、不做指纹、不做投影 —— 那些判定属于
 * 客户端（它才有模板）。服务端只保证：按 id 原子写入、按 id 读回、能列目录。
 *
 * 刻意**不进** `worldStore` 注册表：那边一旦载入就会按模板解释状态，而同步来的档不一定
 * 是服务端认识的模板版本；把两种档混在一起，重启时会把"同步备份"当成"可玩世界"。
 */

const ID_PATTERN = /^[A-Za-z0-9:_-]{1,80}$/;

export interface SyncEnvelope {
  /** 客户端信封（`{ templateId, templateVersion, fingerprint, savedAt, state }`）。 */
  readonly templateId: string;
  readonly templateVersion: string;
  readonly fingerprint: string;
  readonly savedAt: string;
  readonly state: unknown;
}

function isEnvelope(value: unknown): value is SyncEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Partial<SyncEnvelope>;
  return (
    typeof e.templateId === "string" &&
    typeof e.templateVersion === "string" &&
    typeof e.fingerprint === "string" &&
    typeof e.savedAt === "string" &&
    typeof e.state === "object" &&
    e.state !== null
  );
}

export function registerSyncRoutes(app: FastifyInstance, root: string): void {
  const dirOf = (): string => path.join(root, "sync");

  const fileOf = (id: string): string | null => {
    if (!ID_PATTERN.test(id)) return null;
    return path.join(dirOf(), `${id}.json`);
  };

  app.put("/api/sync/worlds/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const file = fileOf(id);
    if (file === null) return reply.code(400).send({ error: "invalid_world_id" });
    if (!isEnvelope(request.body)) return reply.code(400).send({ error: "invalid_envelope" });
    try {
      mkdirSync(dirOf(), { recursive: true });
      // 原子写：先写临时文件再 rename（与 fs 世界仓库同一条纪律），中途失败不留半份。
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(request.body), "utf8");
      renameSync(tmp, file);
      return { synced: id, savedAt: (request.body as SyncEnvelope).savedAt };
    } catch (error) {
      return reply
        .code(500)
        .send({ error: "sync_write_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/sync/worlds/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const file = fileOf(id);
    if (file === null) return reply.code(400).send({ error: "invalid_world_id" });
    try {
      return JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch {
      return reply.code(404).send({ error: "sync_not_found" });
    }
  });

  app.get("/api/sync/worlds", async () => {
    try {
      const ids = readdirSync(dirOf())
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length));
      return { worlds: ids.map((id) => ({ id })) };
    } catch {
      return { worlds: [] };
    }
  });
}
