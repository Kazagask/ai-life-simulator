import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { api, startServer, type RunningServer } from "../helpers/server.ts";

/**
 * 开局链路（真模板 jjk-2006@3.0.0，真服务）：
 *
 *   POST /api/openings → 逐步走完 → POST /commit
 *     ⇒ 返回 `prologue`（按开局档案写的开场白）
 *     ⇒ `snapshot.slotEvent` 已经是第一幕（`ev-open-01`），不是 null
 *     ⇒ 历史第一条就是序章（刷新后仍能读回来）
 *
 * 这三条一起锁住 2026-11-19 的四号需求：「开局信息 → 一段文本 → 一个开局事件」。
 */

const REAL_TEMPLATES = path.resolve("specs/data/templates");

interface OpeningNodeView {
  nodeId: string;
  mode: "choose" | "roll" | "allocate";
  options?: Array<{ id: string }>;
  allocation?: { budget: number };
}

interface StepResponse {
  node: OpeningNodeView | null;
  done: boolean;
}

let server: RunningServer;

beforeAll(async () => {
  server = await startServer({ env: { TEMPLATES_DIR: REAL_TEMPLATES } });
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

async function commitOneOpening(): Promise<{
  worldId: string;
  prologue?: string;
  prologueSource?: "llm" | "template";
  snapshot: { turnIndex: number; slotEvent?: { eventId?: string } | null };
}> {
  const created = await api<{ sessionId: string; node: OpeningNodeView }>(
    server.baseUrl,
    "POST",
    "/api/openings",
    { templateId: "jjk-2006", templateVersion: "3.0.0", playerName: "测试者", seed: 12345 },
  );
  let node: OpeningNodeView | null = created.node;
  let done = false;
  for (let guard = 0; node !== null && !done && guard < 40; guard += 1) {
    const step =
      node.mode === "roll"
        ? { kind: "roll" as const }
        : node.mode === "allocate"
          ? { kind: "allocate" as const, allocation: {} }
          : node.mode === "input"
            ? { kind: "input" as const, value: "测试名字" }
            : { kind: "choose" as const, optionId: node.options?.[0]?.id ?? "" };
    const res = await api<StepResponse>(server.baseUrl, "POST", `/api/openings/${created.sessionId}/step`, step);
    node = res.node;
    done = res.done;
  }
  expect(done).toBe(true);
  return api(server.baseUrl, "POST", `/api/openings/${created.sessionId}/commit`);
}

describe("开局 → 序章 → 第一幕", () => {
  it("commit 回来的快照里第一幕已经上桌，序章进了历史第一条", async () => {
    const committed = await commitOneOpening();
    expect(committed.worldId.length).toBeGreaterThan(0);
    // 没配 key ⇒ mock provider ⇒ 模板兜底文案；两种来源都必须是**非空正文**。
    expect(typeof committed.prologue).toBe("string");
    expect(committed.prologue?.length ?? 0).toBeGreaterThan(0);
    expect(committed.prologueSource).toBe("template");
    // 第一幕真的在槽里（不是等玩家点一次「修炼」才出现）。
    expect(committed.snapshot.slotEvent?.eventId).toBe("ev-open-01");
    // 序章落在第 0 轮，排在所有事件之前（快照是投影，不含 history ⇒ 走独立端点）。
    const { history } = await api<{ history: Array<{ summary?: string; type?: string; turnIndex: number }> }>(
      server.baseUrl,
      "GET",
      `/api/worlds/${committed.worldId}/history`,
    );
    expect(history[0]?.type).toBe("milestone");
    expect(history[0]?.turnIndex).toBe(0);
    expect(history[0]?.summary).toBe(committed.prologue);
  }, 120_000);

  it("重载存档后序章与第一幕都还在（写进的是存档，不是响应体）", async () => {
    const committed = await commitOneOpening();
    const reloaded = await api<{ snapshot: { slotEvent?: { eventId?: string } | null } }>(
      server.baseUrl,
      "GET",
      `/api/worlds/${committed.worldId}`,
    );
    expect(reloaded.snapshot.slotEvent?.eventId).toBe("ev-open-01");
    const { history } = await api<{ history: Array<{ summary?: string }> }>(
      server.baseUrl,
      "GET",
      `/api/worlds/${committed.worldId}/history`,
    );
    expect(history[0]?.summary).toBe(committed.prologue);
  }, 120_000);

  it("第一幕能结算：选完槽清空、轮次 +1（开局不是死胡同）", async () => {
    const committed = await commitOneOpening();
    const after = await api<{ snapshot: { turnIndex: number; slotEvent?: { eventId?: string } | null } }>(
      server.baseUrl,
      "POST",
      `/api/worlds/${committed.worldId}/events/choose`,
      { optionId: "opt-open-report" },
    );
    // 判据是「开局不是死胡同」：第一幕被消费掉、轮次推进、槽里不再挂着它。
    // 槽里可能是空（可自由行动），也可能是池子摇出的日常 —— 后者取决于
    // `state.npcs` 的规模（NPC 自主行动与池子抽签共用同一条 RNG 流，
    // 2026-11-19 反派转 NPC + 定时登场后实例表变大，流位随之位移）。
    // 所以这里**不断言空槽**，只断言「换了一场戏」。
    expect(after.snapshot.turnIndex).toBeGreaterThan(committed.snapshot.turnIndex);
    expect(after.snapshot.slotEvent?.eventId ?? "").not.toBe("ev-open-01");
  }, 120_000);
});
