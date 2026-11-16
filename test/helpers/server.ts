import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(".");
const TSX_CLI = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
const FIXTURE_TEMPLATES = path.join(ROOT, "test/fixtures/templates");

export interface RunningServer {
  baseUrl: string;
  dataDir: string;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl: string, child: ChildProcess, logs: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server_exited:${child.exitCode}\n${logs()}`);
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server_health_timeout\n${logs()}`);
}

/**
 * 起真服务（独立进程），端口随机 32xx，数据目录独立。
 * `dataDir` 可复用（存档重启测试）；默认临时目录，stop 时清掉。
 */
export async function startServer(options?: {
  dataDir?: string;
  env?: Record<string, string>;
}): Promise<RunningServer> {
  const ownsDataDir = options?.dataDir === undefined;
  const dataDir = options?.dataDir ?? mkdtempSync(path.join(tmpdir(), "life-sim-api-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  const child = spawn(process.execPath, [TSX_CLI, "apps/server/src/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      LIFE_SIM_DATA_DIR: dataDir,
      TEMPLATES_DIR: FIXTURE_TEMPLATES,
      ...options?.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });

  await waitForHealth(baseUrl, child, () => output);

  return {
    baseUrl,
    dataDir,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 3_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      if (ownsDataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function api<T>(
  baseUrl: string,
  method: string,
  pathname: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new Error(`${method} ${pathname} => ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}
