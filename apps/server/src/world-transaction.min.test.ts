import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * ADR-0035 回合事务边界的**并发回归**（HTTP 层，跑真进程）。
 *
 * 为什么必须起真服务而不是 import `index.ts`：`index.ts` 启动即 `listen`（vitest.config 明确
 * 禁止 import），而本次要验的恰恰是「handler 有没有把写路径放进锁内」——抽成纯函数就测不到
 * 漏接锁的那条路由了。
 *
 * 旧实现的失败形态（本次修复前）：5 个并发 `/turns` 都能读到 turnIndex=N 并各自返回 200，
 * 最后落盘的是其中一个 → `turnIndex` 只前进了 1，**5 个 200 只兑现 1 次**（丢失更新）。
 * 断言 `200 数 == turnIndex 增量` 正是这条不变量。
 */

const SPEC_TEMPLATES = fileURLToPath(new URL("../../../specs/data/templates", import.meta.url));
const SERVER_DIR = fileURLToPath(new URL("../", import.meta.url));
const TSX_CLI = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));

/** 引擎 409/400 里**预期**的业务码；出现别的一律视为回归。 */
const EXPECTED_REJECTIONS = new Set([
  "pending_event_required",
  "battle_in_progress",
  "battle_not_active",
  "no_pending_event",
  "event_premise_invalidated",
  "option_not_available",
  "event_not_normal",
]);

let child: ChildProcess | null = null;
let baseUrl = "";
let dataDirPath = "";
let templatesDirPath = "";
const serverLog: string[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitReady(deadlineMs = 60_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    if (child !== null && child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode}):\n${serverLog.join("\n")}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/worlds`);
      if (res.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server not ready in ${deadlineMs}ms:\n${serverLog.join("\n")}`);
}

interface ApiResponse<T> {
  status: number;
  body: T;
}

async function api<T = Record<string, unknown>>(
  url: string,
  init?: { method?: string; body?: unknown },
): Promise<ApiResponse<T>> {
  const res = await fetch(`${baseUrl}${url}`, {
    method: init?.method ?? "GET",
    ...(init?.body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body: body as T };
}

interface SnapshotLike {
  turnIndex: number;
  llmPending?: boolean;
  slotEvent: { eventId: string; kind: string; options?: Array<{ id: string }> } | null;
}

async function snapshot(worldId: string): Promise<SnapshotLike> {
  const res = await api<{ snapshot: SnapshotLike }>(`/api/worlds/${worldId}`);
  if (res.status !== 200) throw new Error(`GET world failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.snapshot;
}

async function createWorld(playerName: string): Promise<string> {
  const res = await api<{ worldId?: string; error?: string }>("/api/worlds", {
    method: "POST",
    body: { templateId: "demo-agentic", templateVersion: "1.0.0", playerName, seed: 7 },
  });
  if (res.status !== 201 || res.body.worldId === undefined) {
    throw new Error(`create world failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.worldId;
}

/** 自由行动（`act-rest` 是模板自带的常驻点击面，不依赖任何 LLM 产物）。 */
function turn(worldId: string) {
  return api<{ turnIndex?: number; error?: string }>(`/api/worlds/${worldId}/turns`, {
    method: "POST",
    body: { action: { type: "act-rest", description: "" } },
  });
}

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  dataDirPath = mkdtempSync(path.join(tmpdir(), "life-sim-tx-data-"));
  templatesDirPath = mkdtempSync(path.join(tmpdir(), "life-sim-tx-templates-"));
  // 拷一份模板快照：并行 worker 可能正在改 `specs/`，读取期间被替换会让本测试无谓变红。
  cpSync(path.join(SPEC_TEMPLATES, "demo-agentic"), path.join(templatesDirPath, "demo-agentic"), {
    recursive: true,
  });

  child = spawn(process.execPath, [TSX_CLI, "src/index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      LIFE_SIM_DATA_DIR: dataDirPath,
      TEMPLATES_DIR: templatesDirPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk: Buffer) => {
    const text = String(chunk);
    if (serverLog.length < 200) serverLog.push(text.trim().slice(0, 300));
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  await waitReady();
}, 90_000);

afterAll(async () => {
  if (child !== null) {
    const proc = child;
    child = null;
    if (proc.exitCode === null) {
      const exited = new Promise((resolve) => proc.once("exit", resolve));
      proc.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
  }
  if (dataDirPath !== "") rmSync(dataDirPath, { recursive: true, force: true });
  if (templatesDirPath !== "") rmSync(templatesDirPath, { recursive: true, force: true });
});

describe("ADR-0035 · 并发写请求的事务边界", () => {
  it("5 个并发 /turns：无 500、无丢失更新、非 200 全是预期业务码", async () => {
    const worldId = await createWorld("并发甲");
    const before = (await snapshot(worldId)).turnIndex;

    const results = await Promise.all(Array.from({ length: 5 }, () => turn(worldId)));

    // (a) 没有 500 / 500 级：引擎异常必须落进 handleEngineError 的 400/409，不能变成崩溃。
    const serverErrors = results.filter((r) => r.status >= 500);
    expect(serverErrors, `server errors: ${JSON.stringify(serverErrors)}`).toEqual([]);

    // (c) 非 200 只能是预期业务码（不是 internal_error / 引擎抛未映射错误）。
    const unexpected = results.filter((r) => {
      if (r.status === 200) return false;
      if (r.status !== 409 && r.status !== 400) return true;
      return !EXPECTED_REJECTIONS.has(String(r.body?.error ?? ""));
    });
    expect(unexpected, `unexpected rejections: ${JSON.stringify(unexpected)}\n${serverLog.slice(-12).join("\n")}`).toEqual([]);

    // (b) 每个 200 都真实兑现了一次推进 —— 锁内重取 + 串行结算的核心不变量。
    const accepted = results.filter((r) => r.status === 200).length;
    const after = (await snapshot(worldId)).turnIndex;
    expect(after - before).toBe(accepted);
    expect(accepted).toBeGreaterThan(0);
  }, 60_000);

  it("5 个并发 /events/choose：至多 1 个成功，其余是 409 业务码，无 500", async () => {
    const worldId = await createWorld("并发乙");

    // 推到「normal 事件待决」：轮盘用同一条 /turns 确认（ADR-0034 §8-⑩）。
    let slot: SnapshotLike["slotEvent"] = null;
    for (let i = 0; i < 12 && (slot === null || slot.kind !== "normal"); i += 1) {
      await turn(worldId);
      slot = (await snapshot(worldId)).slotEvent;
    }
    expect(slot, "12 轮内没有出现 normal 事件待决，模板节奏可能变了").not.toBeNull();
    const optionId = slot?.options?.[0]?.id;
    expect(optionId, "待决事件没有可选项").toBeTruthy();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api<{ error?: string }>(`/api/worlds/${worldId}/events/choose`, {
          method: "POST",
          body: { optionId },
        }),
      ),
    );

    expect(results.filter((r) => r.status >= 500)).toEqual([]);
    const unexpected = results.filter(
      (r) => r.status !== 200 && !EXPECTED_REJECTIONS.has(String(r.body?.error ?? "")),
    );
    expect(unexpected, `unexpected rejections: ${JSON.stringify(unexpected)}`).toEqual([]);
    // 一个槽只能被结算一次：串行后其余请求读到的是「槽已换人 / 槽已空」。
    const accepted = results.filter((r) => r.status === 200).length;
    expect(accepted, `choices accepted: ${JSON.stringify(results.map((r) => r.status))}`).toBe(1);

    // 被选中的那个事件不该还挂在槽里（后继事件可以是同一条链上的另一个 id）。
    const pendingAfter = (await snapshot(worldId)).slotEvent;
    expect(pendingAfter?.eventId).not.toBe(slot?.eventId);
  }, 90_000);
});
