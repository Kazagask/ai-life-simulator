import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createP0 } from "../helpers/p0-flow.ts";
import { api, startServer } from "../helpers/server.ts";

interface WorldRow {
  id: string;
  loadable: boolean;
  reason?: string;
}

describe("API 拒载：坏档可见、不崩服务", () => {
  it("schemaVersion 不匹配 ⇒ 列表 loadable:false", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "life-sim-bad-"));
    try {
      writeFileSync(
        path.join(dataDir, "bad-world.json"),
        JSON.stringify({
          schemaVersion: 3,
          templateId: "p0",
          templateVersion: "1.0.0",
          savedAt: new Date().toISOString(),
          state: {},
        }),
      );
      const server = await startServer({ dataDir });
      try {
        const rows = await api<{ worlds: WorldRow[] }>(server.baseUrl, "GET", "/api/worlds");
        const bad = rows.worlds.find((row) => row.id === "bad-world");
        expect(bad?.loadable).toBe(false);
        expect(bad?.reason).toBe("envelope_schema_version_unsupported");
      } finally {
        await server.stop();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("模板指纹漂移 ⇒ 列表 loadable:false", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "life-sim-drift-"));
    try {
      const first = await startServer({ dataDir });
      const world = await createP0(first.baseUrl, "op-gojo");
      await first.stop();

      const file = path.join(dataDir, `${world.worldId}.json`);
      const envelope = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      envelope.templateFingerprint = "stale-fingerprint";
      writeFileSync(file, JSON.stringify(envelope));

      const second = await startServer({ dataDir });
      try {
        const rows = await api<{ worlds: WorldRow[] }>(second.baseUrl, "GET", "/api/worlds");
        const row = rows.worlds.find((item) => item.id === world.worldId);
        expect(row?.loadable).toBe(false);
        expect(row?.reason).toBe("template_content_drift");
      } finally {
        await second.stop();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
