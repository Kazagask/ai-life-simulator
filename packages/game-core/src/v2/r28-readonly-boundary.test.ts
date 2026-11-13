import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

/**
 * R2.8 · T-TG-12（R-TG-17 只读边界）+ 需要「真进程 / 真 HTTP」才能验的部分：
 *   · R-TG-04 启动期 fail-fast（进程退出码只能靠子进程验）
 *   · R-TG-01 AC② 两级列表 + `startVersion` 语义
 *   · R-TG-10 AC③ `GET /api/worlds/:id` ⇒ 409 `world_unloadable`
 *   · R-TG-14 AC③ 提交不属于所选版本的 `openingId` ⇒ 400 + `allowed[]`；多版本缺版本号 ⇒ 400 + `versions[]`
 *   · R-TG-16 AC⑦ / R-TG-15 AC⑧ 静态红线（`setInterval` / `fs.watch` / `eval` / `vm` 零命中）
 *
 * 为什么必须拉起真进程：`apps/server/src/index.ts` 在模块顶层 `app.listen()`，没有导出 app 工厂；
 * 为了不给它「为了测试而改造生产代码」，本文件用**子进程 + 真端口 + 真 HTTP**验。
 * 所有子进程都被强制注入 `TEMPLATES_DIR` 与 `LIFE_SIM_DATA_DIR`（指向 `os.tmpdir()` 的副本），
 * 并在 `startServer()` 里对这两个变量做断言——**任何一次误用默认路径都会被立刻打断**，
 * 不会碰到仓库的 `data/worlds`（65 份）与 `specs/data/templates`。
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * 本文件的用例要**拉起真进程**（tsx 冷启动 1–2s，全量并行跑测试时会被 CPU 争抢放大）。
 * 只在本文件内放宽超时，不动 `vitest.config.ts` 的全局默认值（其他用例的 5s 默认照旧）。
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const SERVER_DIR = path.join(REPO_ROOT, "apps", "server");
const REAL_TEMPLATES = path.join(REPO_ROOT, "specs", "data", "templates");

const requireFromServer = createRequire(path.join(SERVER_DIR, "src", "index.ts"));
function tsxCli(): string {
  try {
    return requireFromServer.resolve("tsx/cli");
  } catch {
    return path.join(SERVER_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  }
}

interface HttpResult {
  status: number;
  json: unknown;
  text: string;
}

function httpCall(base: string, method: string, urlPath: string, body?: unknown): Promise<HttpResult> {
  const url = new URL(urlPath, base);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        agent: false,
        headers:
          payload === undefined
            ? undefined
            : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          text += chunk as string;
        });
        res.on("end", () => {
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const children = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  children.clear();
  await delay(50);
});

interface ServerHandle {
  base: string;
  output(): string;
  stop(): Promise<void>;
}

interface ServerOptions {
  templatesDir: string;
  worldsDir: string;
}

/** 拉起真服务；健康检查通过才返回。`TEMPLATES_DIR` / `LIFE_SIM_DATA_DIR` 缺失直接抛（防止误碰真实目录）。 */
async function startServer(options: ServerOptions): Promise<ServerHandle> {
  if (!options.templatesDir || !options.worldsDir) throw new Error("必须显式指定临时 TEMPLATES_DIR / LIFE_SIM_DATA_DIR");
  const port = 35000 + Math.floor(Math.random() * 12000);
  const child = spawn(process.execPath, [tsxCli(), "src/index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      TEMPLATES_DIR: options.templatesDir,
      LIFE_SIM_DATA_DIR: options.worldsDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  child.stdout?.setEncoding("utf-8");
  child.stderr?.setEncoding("utf-8");
  child.stdout?.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    output += chunk;
  });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i += 1) {
    if (child.exitCode !== null) throw new Error(`服务启动即退出（exit=${child.exitCode}）：\n${output}`);
    try {
      const health = await httpCall(base, "GET", "/health");
      if (health.status === 200) {
        return {
          base,
          output: () => output,
          stop: () =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null) return resolve();
              child.once("exit", () => resolve());
              child.kill();
            }),
        };
      }
    } catch {
      /* 还没起来 */
    }
    await delay(100);
  }
  child.kill();
  throw new Error(`服务 20s 内未就绪：\n${output}`);
}

/** 拉起一个**预期会失败**的服务，返回退出码与输出。 */
async function runServerToExit(options: ServerOptions, timeoutMs = 30000): Promise<{ code: number | null; output: string }> {
  if (!options.templatesDir || !options.worldsDir) throw new Error("必须显式指定临时 TEMPLATES_DIR / LIFE_SIM_DATA_DIR");
  const child = spawn(process.execPath, [tsxCli(), "src/index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(35000 + Math.floor(Math.random() * 12000)),
      TEMPLATES_DIR: options.templatesDir,
      LIFE_SIM_DATA_DIR: options.worldsDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  child.stdout?.setEncoding("utf-8");
  child.stderr?.setEncoding("utf-8");
  child.stdout?.on("data", (c: string) => {
    output += c;
  });
  child.stderr?.on("data", (c: string) => {
    output += c;
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`期望启动失败，但 ${timeoutMs}ms 内进程仍在运行（像是起来了）：\n${output}`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

// ---------- 夹具 ----------

interface Fixture {
  root: string;
  templatesDir: string;
  worldsDir: string;
  versionDir: string;
}

/** `mkdtemp` + 复制真实模板，返回临时夹具路径。`ids` 可造多个模板目录。 */
function makeFixture(ids: readonly string[] = ["jjk-2006"]): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "r28-server-"));
  const templatesDir = path.join(root, "templates");
  const worldsDir = path.join(root, "worlds");
  mkdirSync(worldsDir, { recursive: true });
  for (const id of ids) {
    const target = path.join(templatesDir, id, "1.0.0");
    cpSync(path.join(REAL_TEMPLATES, "jjk-2006", "1.0.0"), target, { recursive: true });
    if (id !== "jjk-2006") {
      const worldYaml = path.join(target, "world.yaml");
      const text = readFileSync(worldYaml, "utf-8");
      writeFileSync(worldYaml, text.replace(/^  id: jjk-2006$/m, `  id: ${id}`), "utf-8");
    }
  }
  return { root, templatesDir, worldsDir, versionDir: path.join(templatesDir, "jjk-2006", "1.0.0") };
}

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(abs, out);
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(abs);
  }
  return out;
}

/** 去掉注释，避免「文档里提到 `new Function`」被误判成调用点。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function concatenatedSource(dirs: readonly string[]): string {
  return dirs
    .flatMap((dir) => walkSourceFiles(dir))
    .map((file) => `\n/* ==== ${path.relative(REPO_ROOT, file)} ==== */\n${readFileSync(file, "utf-8")}`)
    .join("\n");
}

const SERVER_SRC = path.join(SERVER_DIR, "src");
const GAME_CORE_SRC = path.join(REPO_ROOT, "packages", "game-core", "src");
const SHARED_SRC = path.join(REPO_ROOT, "packages", "shared", "src");
const WEB_SRC = path.join(REPO_ROOT, "apps", "web", "src");

// ═══════════════════════════════════════════════════════════════════════════
describe("R-TG-17 ①：静态断言 —— 服务端不存在任何模板写入面", () => {
  it("只读端点唯一：`/api/templates` 只有 GET，无 PUT / PATCH / DELETE / POST 注册", () => {
    const source = concatenatedSource([SERVER_SRC]);
    expect(source).toMatch(/app\.get\(\s*["']\/api\/templates["']/);
    expect(source).not.toMatch(/app\.(post|put|patch|delete)\(\s*["'][^"']*\/api\/templates/);
    // 也没有 `/api/templates/imports` 之类的派生路径
    expect(source).not.toMatch(/api\/templates\//);
  });

  it("无 multipart 依赖、无导入 bodyLimit、无 LIFE_SIM_ENV / TEMPLATE_IMPORT_TOKEN / base64 载荷", () => {
    const source = concatenatedSource([SERVER_SRC]);
    const pkg = readFileSync(path.join(SERVER_DIR, "package.json"), "utf-8");
    expect(pkg).not.toMatch(/multipart/i);
    expect(source).not.toMatch(/multipart/i);
    expect(source).not.toMatch(/bodyLimit/i);
    expect(source).not.toMatch(/LIFE_SIM_ENV/);
    expect(source).not.toMatch(/TEMPLATE_IMPORT_TOKEN/);
    expect(source).not.toMatch(/base64/i);
    expect(source).not.toMatch(/["'`]encoding["'`]/);
  });

  it("前端无上传控件（`<input type=\"file\">` 零命中）", () => {
    const source = concatenatedSource([WEB_SRC]);
    expect(source).not.toMatch(/type\s*=\s*["']file["']/i);
    expect(source).not.toMatch(/FormData/);
    expect(source).not.toMatch(/multipart/i);
  });
});

describe("R-TG-16 AC⑦ / R-TG-15 AC⑧ / AC⑨：静态红线", () => {
  it("`setInterval` / `fs.watch` / `watchFile` 在服务端与内核零命中（热加载必须请求驱动）", () => {
    const source = concatenatedSource([SERVER_SRC, GAME_CORE_SRC, SHARED_SRC]);
    expect(source).not.toMatch(/setInterval/);
    expect(source).not.toMatch(/\bwatchFile\b/);
    expect(source).not.toMatch(/\bwatch\s*\(/);
    expect(source).not.toMatch(/fs\.watch/);
  });

  it("`eval` / `new Function` / `node:vm` 零命中（code 角色只忽略、不执行）", () => {
    const source = stripComments(concatenatedSource([SERVER_SRC, GAME_CORE_SRC, SHARED_SRC]));
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/\bnew\s+Function\b/);
    expect(source).not.toMatch(/["'`]node:vm["'`]/);
  });

  it("AC⑨ 结构断言：`versionMaxMtime` 不 stat 目录本身（只 stat 文件）", () => {
    const source = readFileSync(path.join(SERVER_SRC, "templates.ts"), "utf-8");
    expect(source).toMatch(/function versionMaxMtime/);
    expect(source).not.toMatch(/statSync\s*\(\s*versionDir\s*\)/);
    expect(source).toMatch(/entry\.isFile\(\)/);
  });
});

describe("R-TG-17 ②：HTTP 实测 —— 四个写方法在模板路径上全部 404/405", () => {
  it("POST/PUT/PATCH/DELETE 各一条路径，无一被接受", async () => {
    const fixture = makeFixture();
    const server = await startServer(fixture);
    try {
      const probes: Array<[string, string]> = [
        ["POST", "/api/templates/imports"],
        ["POST", "/api/templates"],
        ["PUT", "/api/templates"],
        ["PATCH", "/api/templates"],
        ["DELETE", "/api/templates"],
        ["PUT", "/api/templates/jjk-2006"],
        ["PATCH", "/api/templates/jjk-2006"],
        ["DELETE", "/api/templates/jjk-2006"],
        ["PUT", "/api/templates/jjk-2006/1.0.0"],
        ["DELETE", "/api/templates/jjk-2006/1.0.0"],
      ];
      const observed: Array<{ method: string; path: string; status: number }> = [];
      for (const [method, urlPath] of probes) {
        const res = await httpCall(server.base, method, urlPath, method === "GET" ? undefined : { any: 1 });
        observed.push({ method, path: urlPath, status: res.status });
        expect([404, 405]).toContain(res.status);
      }
      // 只读端点本身仍然可用（不是「整组 404」这种假绿）
      const list = await httpCall(server.base, "GET", "/api/templates");
      expect(list.status).toBe(200);
      console.log(
        `\n[R-TG-17 写方法探针]\n${observed
          .map((o) => `${o.method.padEnd(7)} ${o.path.padEnd(30)} → ${o.status}`)
          .join("\n")}\nGET     /api/templates                 → ${list.status}\n`,
      );
    } finally {
      await server.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe("R-TG-01 AC② / R-TG-14：两级列表、startVersion 语义、openingId 归属", () => {
  it("多版本：两级结构 + startVersion = 补 0 后最高可载版本（不是 versions[0]）+ 缺版本号 400 + 跨版本 openingId 400", async () => {
    const fixture = makeFixture(["jjk-2006", "tpl-single"]);
    // 造第二个版本 2.0.0，并把它只保留 `op-2006-kyoto` 一个开局
    const v2 = path.join(fixture.templatesDir, "jjk-2006", "2.0.0");
    cpSync(fixture.versionDir, v2, { recursive: true });
    const openingYaml = path.join(v2, "opening.yaml");
    const openings = parse(readFileSync(openingYaml, "utf-8")) as Array<{ openingId: string }>;
    writeFileSync(
      openingYaml,
      stringify(openings.filter((o) => o.openingId !== "op-2006-tokyo")),
      "utf-8",
    );

    const server = await startServer(fixture);
    try {
      const list = await httpCall(server.base, "GET", "/api/templates");
      expect(list.status).toBe(200);
      type VersionSummary = {
        version: string;
        loadable: boolean;
        openings?: Array<{ id: string }>;
      };
      type TemplateSummaryJson = { id: string; name: string; startVersion?: string; versions: VersionSummary[] };
      const templates = (list.json as { templates: TemplateSummaryJson[] }).templates;
      const jjk = templates.find((t) => t.id === "jjk-2006")!;

      expect(jjk.versions.map((v) => v.version)).toEqual(["1.0.0", "2.0.0"]);
      // AC②：startVersion 是「最高可载版本」，不是 versions[0]
      expect(jjk.startVersion).toBe("2.0.0");
      expect(jjk.versions[0]!.version).toBe("1.0.0");
      expect(jjk.versions.every((v) => v.loadable)).toBe(true);
      // 两版本的 openings 确实不同（跨版本切换才有意义）
      expect(jjk.versions.find((v) => v.version === "1.0.0")!.openings!.map((o) => o.id).sort()).toEqual([
        "op-2006-kyoto",
        "op-2006-tokyo",
      ]);
      expect(jjk.versions.find((v) => v.version === "2.0.0")!.openings!.map((o) => o.id)).toEqual([
        "op-2006-kyoto",
      ]);
      // 玩家端投影不含 hidden 私有信息
      expect(list.text).not.toMatch(/hidden/i);

      // 多版本缺 templateVersion ⇒ 400 + versions[]
      const missing = await httpCall(server.base, "POST", "/api/worlds", {
        templateId: "jjk-2006",
        playerName: "缺版本",
      });
      expect(missing.status).toBe(400);
      expect(missing.json).toMatchObject({
        error: "template_version_required",
        versions: ["1.0.0", "2.0.0"],
      });

      // AC③：openingId 属于另一个版本 ⇒ 400 + allowed[]
      const cross = await httpCall(server.base, "POST", "/api/worlds", {
        templateId: "jjk-2006",
        templateVersion: "2.0.0",
        playerName: "跨版本开局",
        openingId: "op-2006-tokyo",
      });
      expect(cross.status).toBe(400);
      expect(cross.json).toMatchObject({ error: "opening_not_found", allowed: ["op-2006-kyoto"] });

      // 单版本模板隐式取该版本（回归：单版本建局路径仍然可用）
      const single = await httpCall(server.base, "POST", "/api/worlds", {
        templateId: "tpl-single",
        playerName: "单版本",
        openingId: "op-2006-tokyo",
      });
      expect(single.status).toBe(201);
      const body = single.json as { worldId: string; snapshot: { templateName?: string } };
      expect(body.worldId).toBeTruthy();

      // 正例：多版本显式带对版本号 + 该版本自己的 openingId ⇒ 201
      const ok = await httpCall(server.base, "POST", "/api/worlds", {
        templateId: "jjk-2006",
        templateVersion: "1.0.0",
        playerName: "正例",
        openingId: "op-2006-tokyo",
      });
      expect(ok.status).toBe(201);
    } finally {
      await server.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("P2 复验：`1.0.0`/`2`/`10` 三版本的排序 = 补 0 全序，且 `/api/templates` 与 400 的 `versions[]` 两处一致", async () => {
    // 旧实现（`index.ts:361-364` 字符串序）给出的是 ["1.0.0","10","2"]：`"10" < "2"` 按字典序，
    // 而 A-3 要求补 0 后全序（`2` < `10`）。修复后两处都必须走 `compareVersions`。
    const fixture = makeFixture();
    for (const version of ["2", "10"]) {
      cpSync(fixture.versionDir, path.join(fixture.templatesDir, "jjk-2006", version), { recursive: true });
    }

    const server = await startServer(fixture);
    try {
      const list = await httpCall(server.base, "GET", "/api/templates");
      expect(list.status).toBe(200);
      const jjk = (
        list.json as {
          templates: Array<{ id: string; startVersion?: string; versions: Array<{ version: string }> }>;
        }
      ).templates.find((t) => t.id === "jjk-2006")!;
      const listOrder = jjk.versions.map((v) => v.version);
      expect(listOrder).toEqual(["1.0.0", "2", "10"]);
      // startVersion 取补 0 后最高可载版本 ⇒ 10（不是字符串最大 / 也不是 versions[0]）
      expect(jjk.startVersion).toBe("10");

      const missing = await httpCall(server.base, "POST", "/api/worlds", {
        templateId: "jjk-2006",
        playerName: "排序复验",
      });
      expect(missing.status).toBe(400);
      const apiOrder = (missing.json as { versions: string[] }).versions;
      expect(apiOrder).toEqual(["1.0.0", "2", "10"]);
      // 两处必须同一套排序，不允许各说各话
      expect(apiOrder).toEqual(listOrder);
    } finally {
      await server.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe("R-TG-10 AC①/③：存在但不可载的世界 ⇒ 列表可见 + 409 + 可删除", () => {
  it("指纹被人为改动后重启：GET /:id 返 409 world_unloadable；列表带 reason；DELETE 可删", async () => {
    const fixture = makeFixture();
    const first = await startServer(fixture);
    let worldId = "";
    try {
      const created = await httpCall(first.base, "POST", "/api/worlds", {
        templateId: "jjk-2006",
        templateVersion: "1.0.0",
        playerName: "将被改坏",
        openingId: "op-2006-tokyo",
      });
      expect(created.status).toBe(201);
      worldId = (created.json as { worldId: string }).worldId;
    } finally {
      await first.stop();
    }

    // 把信封指纹改成对不上的值（模拟「模板被人改过」），重启后应判 template_content_drift
    const file = path.join(fixture.worldsDir, `${worldId}.json`);
    const envelope = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    writeFileSync(
      file,
      JSON.stringify({ ...envelope, templateFingerprint: `sha256:${"0".repeat(64)}` }, null, 2),
      "utf-8",
    );

    const second = await startServer(fixture);
    try {
      const detail = await httpCall(second.base, "GET", `/api/worlds/${worldId}`);
      expect(detail.status).toBe(409); // **不得** 404、不得静默消失
      expect(detail.json).toMatchObject({ error: "world_unloadable", reason: "template_content_drift" });
      expect(String((detail.json as { detail?: string }).detail ?? "")).toContain("jjk-2006@1.0.0");

      const list = await httpCall(second.base, "GET", "/api/worlds");
      expect(list.status).toBe(200);
      // 列表是**一条数组**，用 `loadable` 区分可载 / 存在但不可载（R-TG-10 AC①）
      const rows = (list.json as { worlds: Array<Record<string, unknown>> }).worlds;
      const row = rows.find((u) => u.id === worldId);
      expect(row).toMatchObject({ reason: "template_content_drift", loadable: false });
      expect(String(row!.detail ?? "")).toContain("jjk-2006@1.0.0");

      const removed = await httpCall(second.base, "DELETE", `/api/worlds/${worldId}`);
      expect([200, 204]).toContain(removed.status);
      expect(existsSync(file)).toBe(false);
    } finally {
      await second.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe("R-TG-04：启动期 fail-fast（进程退出码只能靠子进程验）", () => {
  it("`meta.id` ≠ 目录名 ⇒ 进程非 0 退出，错误信息同时含目录名与实际 meta.id", async () => {
    const fixture = makeFixture();
    const worldYaml = path.join(fixture.versionDir, "world.yaml");
    writeFileSync(
      worldYaml,
      readFileSync(worldYaml, "utf-8").replace(/^  id: jjk-2006$/m, "  id: wrong-id"),
      "utf-8",
    );

    const { code, output } = await runServerToExit(fixture);
    expect(code).not.toBe(0);
    expect(output).toContain("wrong-id");
    expect(output).toContain("jjk-2006");
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("yaml 语法坏掉 ⇒ 进程非 0 退出，错误含文件名", async () => {
    const fixture = makeFixture();
    writeFileSync(path.join(fixture.versionDir, "events.yaml"), "events: [\n  - id: 坏\n", "utf-8");

    const { code, output } = await runServerToExit(fixture);
    expect(code).not.toBe(0);
    expect(output).toMatch(/events\.yaml/);
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("整个 templates 目录零模板 ⇒ 进程非 0 退出（B-4 边界：没有任何模板就别启动）", async () => {
    const fixture = makeFixture(["jjk-2006"]);
    rmSync(path.join(fixture.templatesDir, "jjk-2006"), { recursive: true, force: true });

    const { code, output } = await runServerToExit(fixture);
    expect(code).not.toBe(0);
    expect(output).toContain("no_templates_found_in");
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("空版本目录（`1.1.0/` 内零 yaml）⇒ 服务照常启动 + 日志 template_version_empty（B-4 #3）", async () => {
    const fixture = makeFixture();
    mkdirSync(path.join(fixture.templatesDir, "jjk-2006", "1.1.0"), { recursive: true }); // 空版本目录

    const server = await startServer(fixture);
    try {
      const list = await httpCall(server.base, "GET", "/api/templates");
      expect(list.status).toBe(200);
      const templates = (list.json as { templates: Array<{ id: string; versions: Array<{ version: string }> }> })
        .templates;
      // 空目录不算版本；1.0.0 仍在（「mkdir 了还没 cp 完」不得触发 fail-fast）
      expect(templates.map((t) => t.id)).toEqual(["jjk-2006"]);
      expect(templates[0]!.versions.map((v) => v.version)).toEqual(["1.0.0"]);
      expect(server.output()).toContain("template_version_empty");
    } finally {
      await server.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 60000);

  it("非法版本名目录（`v2/` 内 11 个合法 yaml）⇒ 进程非 0 退出 + 错误含 template_version_dir_invalid 与目录名", async () => {
    // R-TG-04 六形态之一 / R-TG-01 AC③ / design B-4 #1：启动期必须拒绝启动。
    // 必须是**子进程退出码**断言——启动期 throw 让进程退出，进程内断言 throw 验不到「服务不得带着它起来」。
    const fixture = makeFixture();
    cpSync(fixture.versionDir, path.join(fixture.templatesDir, "jjk-2006", "v2"), { recursive: true });

    const { code, output } = await runServerToExit(fixture);
    expect(code).not.toBe(0);
    expect(output).toContain("template_version_dir_invalid");
    expect(output).toContain(`"v2"`);
    // 可诊断四件：<id>、目录名、期望正则、完整路径
    expect(output).toContain("jjk-2006");
    expect(output).toContain("^\\d+(\\.\\d+){0,2}$");
    expect(output).toContain(path.join(fixture.templatesDir, "jjk-2006", "v2"));
    rmSync(fixture.root, { recursive: true, force: true });
  }, 60000);

  it("边界现状：**空的**非法名目录（`beta/`）同样拒绝启动（当前实现从严格；如需放宽须先改需求）", async () => {
    // 与上一条的区别只在「目录里有没有 yaml」：B-4 #3 的空目录豁免只适用于**名字合法**的版本目录
    // （`1.1.0/`）。名字都不合法的目录连「版本目录」都不是，因此不走豁免。
    // 这里把它钉成可执行事实：若将来产品决定「空的非法名目录也忽略」，本用例会红，逼一次显式决策。
    const fixture = makeFixture();
    mkdirSync(path.join(fixture.templatesDir, "jjk-2006", "beta"), { recursive: true });

    const { code, output } = await runServerToExit(fixture);
    expect(code).not.toBe(0);
    expect(output).toContain("template_version_dir_invalid");
    expect(output).toContain(`"beta"`);
    rmSync(fixture.root, { recursive: true, force: true });
  }, 60000);
});
