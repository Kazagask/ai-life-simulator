/**
 * 可移植云端冒烟 —— 零外部依赖（API 部分只用 Node 22 内置 fetch）。
 *
 *   node apps/server/smoke/cloud.smoke.mjs
 *   LIFE_SIM_BASE_URL=http://127.0.0.1:8080 node apps/server/smoke/cloud.smoke.mjs
 *   CHROME_PATH=/usr/bin/chromium RUN_UI=1 node apps/server/smoke/cloud.smoke.mjs
 *
 * 环境变量：
 *   LIFE_SIM_BASE_URL  服务基址，默认 http://127.0.0.1:3000（末尾斜杠自动去掉）
 *   RUN_UI=1           额外跑竖屏 UI 检查（需要 puppeteer-core + Chrome/Chromium）
 *   CHROME_PATH        Chrome/Chromium 可执行文件；不传则按各平台常见路径探测
 *
 * 设计约束：
 *   - 每次新建一个世界，不复用旧存档（旧档按指纹策略会被拒载）
 *   - 不写任何文件、不改任何状态、不调用任何 LLM
 *   - UI 部分是可选增强，缺依赖 / 缺浏览器记 SKIP，不算 FAIL
 *
 * 判据 ⑤（GET /api/worlds/:id 含 eventFlavors 键）用于确认服务跑的是
 * R2.7（含）之后的代码；R2.7 之前的服务没有这个响应字段。
 */
import { existsSync } from "node:fs";

const BASE = (process.env.LIFE_SIM_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const RUN_UI = process.env.RUN_UI === "1";
const results = [];

const pass = (name, detail = "") => results.push({ ok: true, name, detail });
const fail = (name, detail = "") => results.push({ ok: false, name, detail });
const skip = (name, detail = "") => results.push({ ok: null, name, detail });

async function request(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // 非 JSON（例如 index.html），保留原文
  }
  return { status: res.status, body, text };
}

async function check(name, fn) {
  try {
    const detail = await fn();
    if (detail === undefined) throw new Error("check returned undefined");
    pass(name, detail);
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) {
    return existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  }
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

// ① 健康检查
await check("① GET /health", async () => {
  const { status, body } = await request("/health");
  if (status !== 200) throw new Error(`status=${status}`);
  if (body?.ok !== true) throw new Error(`body.ok=${String(body?.ok)}`);
  return `${status} ok=true service=${body?.service ?? "?"} protocol=${body?.protocol ?? "?"}`;
});

// ② 模板加载（specs/data/templates 是运行时资产）
await check("② GET /api/templates", async () => {
  const { status, text } = await request("/api/templates");
  if (status !== 200) throw new Error(`status=${status}`);
  if (!text.includes("jjk-2006")) throw new Error("jjk-2006 未出现在模板列表");
  return `${status} jjk-2006 已加载`;
});

// ③ 静态产物（未 pnpm build 时服务端返回 503 web_dist_missing）
await check("③ GET / 静态产物", async () => {
  const { status, text } = await request("/");
  if (status === 503 && text.includes("web_dist_missing")) {
    throw new Error("apps/web/dist 缺失 —— 先跑 pnpm build");
  }
  if (status !== 200) throw new Error(`status=${status}`);
  const assets = [...text.matchAll(/assets\/[^"'\s>]+/g)].map((m) => m[0]);
  if (assets.length === 0) throw new Error("index.html 中没有 assets/ 引用");
  return `${status} 资源 ${assets.length} 个（${assets[0]}）`;
});

// ④ 新建世界（绝不复用旧存档）
let worldId = null;
await check("④ POST /api/worlds 新建世界", async () => {
  const { status, body } = await request("/api/worlds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateId: "jjk-2006", playerName: "云端冒烟", seed: 7 }),
  });
  if (status !== 201 && status !== 200) throw new Error(`status=${status} body=${JSON.stringify(body).slice(0, 160)}`);
  worldId = body?.worldId ?? body?.snapshot?.worldId ?? null;
  if (!worldId) throw new Error("响应中没有 worldId");
  return `${status} worldId=${worldId}`;
});

// ⑤ HEAD 代码判据 + 零回归弱断言
await check("⑤ GET /api/worlds/:id 含 eventFlavors", async () => {
  if (!worldId) throw new Error("④ 未产出 worldId，无法继续");
  const { status, body } = await request(`/api/worlds/${worldId}`);
  if (status !== 200) throw new Error(`status=${status}`);
  if (!Object.hasOwn(body ?? {}, "eventFlavors")) {
    throw new Error("缺 eventFlavors —— 服务很可能跑的是 R2.7 之前的旧代码");
  }
  const flavors = body.eventFlavors ?? {};
  if (typeof flavors !== "object" || Array.isArray(flavors)) {
    throw new Error("eventFlavors 不是对象");
  }
  return `${status} eventFlavors 键存在，当前 ${Object.keys(flavors).length} 条`;
});

// ⑥ 默认 Mock 基线（信息项，不构成对服务端的强断言）
const llmEnv = Object.keys(process.env)
  .filter((k) => k.startsWith("LIFE_SIM_LLM_") || k.startsWith("LIFE_SIM_WORKBUDDY_"))
  .sort();
if (llmEnv.length === 0) {
  pass("⑥ 零回归基线", "无 LIFE_SIM_LLM_* / LIFE_SIM_WORKBUDDY_* ⇒ 预期 provider=mock、叙事恒 template、不调 complete()");
} else {
  pass("⑥ 零回归基线", `检测到 ${llmEnv.join(", ")} —— 叙事可能走真实 provider，请确认这是有意的`);
}

// ⑦ 可选：竖屏 UI 无运行时错误
if (!RUN_UI) {
  skip("⑦ 竖屏 UI 检查", "RUN_UI 未开启（设置 RUN_UI=1 且提供 Chrome 可启用）");
} else {
  const chrome = findChrome();
  if (!chrome) {
    skip("⑦ 竖屏 UI 检查", "找不到 Chrome/Chromium，请设置 CHROME_PATH");
  } else {
    await check("⑦ 竖屏 UI 检查", async () => {
      if (!worldId) throw new Error("④ 未产出 worldId，无法继续");
      let puppeteer;
      try {
        puppeteer = (await import("puppeteer-core")).default;
      } catch {
        throw new Error("puppeteer-core 未安装");
      }
      const browser = await puppeteer.launch({
        executablePath: chrome,
        headless: "new",
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 430, height: 932, isMobile: true, hasTouch: true });
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.evaluateOnNewDocument((id) => {
          localStorage.setItem("life-sim:worldId", id);
        }, worldId);
        await page.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 20_000 });
        const textLen = (await page.evaluate(() => document.body.innerText.length)) ?? 0;
        if (errors.length > 0) throw new Error(`pageerror ${errors.length} 条: ${errors.slice(0, 3).join(" | ")}`);
        if (textLen === 0) throw new Error("页面无可见文本");
        return `430x932 渲染正常，文本 ${textLen} 字，pageerror 0`;
      } finally {
        await browser.close();
      }
    });
  }
}

// 汇总
console.log(`\nBASE = ${BASE}\n`);
for (const r of results) {
  const tag = r.ok === true ? "PASS" : r.ok === false ? "FAIL" : "SKIP";
  console.log(`${tag}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
const failed = results.filter((r) => r.ok === false).length;
console.log(failed === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failed})`);
if (failed > 0) process.exitCode = 1;
