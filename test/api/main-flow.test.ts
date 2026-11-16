import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createP0, playP0ToEnding } from "../helpers/p0-flow.ts";
import { startServer, type RunningServer } from "../helpers/server.ts";
import { fixtureEntry } from "../helpers/world.ts";

describe("API 主循环 + 双开局", () => {
  let server: RunningServer;

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("主循环：转盘确认 → 战斗 → 选择 → 结局", async () => {
    const world = await createP0(server.baseUrl, "op-gojo");
    const snapshot = await playP0ToEnding(server.baseUrl, world.worldId, "opt-good");
    expect(snapshot.status).toBe("terminated");
    const declared = fixtureEntry().endingConfig?.endings.map((ending) => ending.endingId) ?? [];
    expect(declared).toContain(snapshot.ending?.endingId);
  });

  it("op-gojo / op-yuji 各跑到结局，且结局不同", async () => {
    const gojo = await createP0(server.baseUrl, "op-gojo", "甲");
    const gojoEnd = await playP0ToEnding(server.baseUrl, gojo.worldId, "opt-good", "ev:start-gojo");
    const yuji = await createP0(server.baseUrl, "op-yuji", "乙");
    const yujiEnd = await playP0ToEnding(server.baseUrl, yuji.worldId, "opt-bad", "ev:start-yuji");

    expect(gojoEnd.ending?.endingId).toBe("end-good");
    expect(yujiEnd.ending?.endingId).toBe("end-bad");
    expect(gojoEnd.ending?.endingId).not.toBe(yujiEnd.ending?.endingId);
  });
});
