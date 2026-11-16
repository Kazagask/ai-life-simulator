import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createP0 } from "../helpers/p0-flow.ts";
import { api, startServer } from "../helpers/server.ts";

describe("API 存档：重启后世界还在且能继续推", () => {
  it("同一 LIFE_SIM_DATA_DIR 重启，turnIndex 保留", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "life-sim-persist-"));
    try {
      const first = await startServer({ dataDir });
      const world = await createP0(first.baseUrl, "op-gojo");
      const turn = await api<{ snapshot: { turnIndex: number } }>(
        first.baseUrl,
        "POST",
        `/api/worlds/${world.worldId}/turns`,
        { action: { type: "patrol", description: "" }, mode: "single" },
      );
      expect(turn.snapshot.turnIndex).toBe(1);
      await first.stop();

      const second = await startServer({ dataDir });
      try {
        const loaded = await api<{ snapshot: { turnIndex: number } }>(
          second.baseUrl,
          "GET",
          `/api/worlds/${world.worldId}`,
        );
        expect(loaded.snapshot.turnIndex).toBe(1);
        // 重启后槽里还挂着开局事件：选掉它，证明世界能继续推进。
        const next = await api<{ snapshot: { turnIndex: number } }>(
          second.baseUrl,
          "POST",
          `/api/worlds/${world.worldId}/events/choose`,
          { optionId: "opt-go" },
        );
        expect(next.snapshot.turnIndex).toBe(2);
      } finally {
        await second.stop();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
