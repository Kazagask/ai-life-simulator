import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { registerSyncRoutes } from "../../apps/server/src/sync.ts";

/**
 * T5：存档同步端点（ADR-070 第三期）。
 *
 * 服务端**只搬字节**：形状不对 400，id 非法 400，没写过 404；写进去什么，读出来就是什么
 * （不做 schema、不做指纹、不做投影 —— 判定属于有模板的客户端）。
 */

async function withServer(run: (base: string, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "life-sim-sync-"));
  const app = Fastify({ logger: false });
  registerSyncRoutes(app, dir);
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    await run(`http://127.0.0.1:${address.port}`, dir);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const envelope = {
  templateId: "jjk-2006",
  templateVersion: "3.0.0",
  fingerprint: "sha256:abc",
  savedAt: "2026-11-22T00:00:00.000Z",
  state: { id: "local-1", turnIndex: 3 },
};

describe("存档同步端点", () => {
  it("写进去什么，读出来就是什么（逐字段）", async () => {
    await withServer(async (base) => {
      const put = await fetch(`${base}/api/sync/worlds/local-1`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      });
      expect(put.status).toBe(200);

      const got = (await (await fetch(`${base}/api/sync/worlds/local-1`)).json()) as typeof envelope;
      expect(got).toEqual(envelope);
    });
  });

  it("没写过的 id ⇒ 404；非法 id ⇒ 400；形状不对 ⇒ 400", async () => {
    await withServer(async (base) => {
      expect((await fetch(`${base}/api/sync/worlds/nope`)).status).toBe(404);
      expect((await fetch(`${base}/api/sync/worlds/${encodeURIComponent("../etc/passwd")}`)).status).toBe(400);
      const bad = await fetch(`${base}/api/sync/worlds/x`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateId: "t" }),
      });
      expect(bad.status).toBe(400);
    });
  });

  it("列表只报 id，不解释内容", async () => {
    await withServer(async (base) => {
      for (const id of ["a", "b"]) {
        await fetch(`${base}/api/sync/worlds/${id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...envelope, state: { id } }),
        });
      }
      const list = (await (await fetch(`${base}/api/sync/worlds`)).json()) as { worlds: Array<{ id: string }> };
      expect(list.worlds.map((w) => w.id).sort()).toEqual(["a", "b"]);
    });
  });
});
