/**
 * 构建后生成 `dist/sw.js`（PWA）。
 *
 * 为什么不在 `public/` 里放一个固定 `sw.js`：Service Worker 的更新判据是**脚本字节变化**。
 * 文件名固定、内容固定 ⇒ 新部署永远不会触发更新。这里把本次构建的 HTML 与 assets 摘要
 * 写进 `CACHE_VERSION`，并预缓存当次的入口资源；任何一次构建都会得到不同的 sw.js。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dist = path.resolve("dist");
const index = readFileSync(path.join(dist, "index.html"), "utf8");
const assetUrls = [...index.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);

const digest = createHash("sha256").update(index);
for (const url of assetUrls) {
  digest.update(readFileSync(path.join(dist, url.slice(1))));
}
const version = digest.digest("hex").slice(0, 16);

// `/` 与 `/index.html` 都要：导航回退用 index.html；分享码门禁下 `/` 可能 403，逐个 catch。
const precache = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  ...assetUrls,
].filter((url, i, all) => all.indexOf(url) === i);

const sw = `/* 自动生成，请改 apps/web/scripts/build-sw.mjs */
const CACHE_VERSION = ${JSON.stringify(version)};
const CACHE_NAME = "life-sim-" + CACHE_VERSION;
const PRECACHE = ${JSON.stringify(precache, null, 2)};
const APP_SHELL = "/index.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        PRECACHE.map((url) =>
          // 默认 cache 模式：hashed assets 刚从页面加载过，直接复用 HTTP 缓存，
          // 不为了预缓存再下载一遍 1MB（首访体验优先）。
          cache.add(url).catch(() => undefined),
        ),
      );
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("life-sim-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // 数据面（模板包 / 存档 / trace / 云 SDK）一律走网络：本地已有 IndexedDB 兜底，不能让 SW 缓存旧数据。
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.cloud/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(APP_SHELL, fresh.clone()).catch(() => undefined);
            return fresh;
          }
          // 403（分享码过期）/ 5xx：有缓存就先用缓存把界面撑起来，别把错误页当应用。
          const cached = await caches.match(APP_SHELL);
          if (cached) return cached;
          return fresh;
        } catch {
          return (
            (await caches.match(APP_SHELL)) ||
            (await caches.match(request)) ||
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, response.clone()).catch(() => undefined);
        }
        return response;
      })(),
    );
    return;
  }

  // manifest / 图标 / 其它同源静态：先给缓存，同时后台更新。
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(request, response.clone()))
              .catch(() => undefined);
          }
          return response;
        })
        .catch(() => null);
      return cached || (await network) || Response.error();
    })(),
  );
});
`;

writeFileSync(path.join(dist, "sw.js"), sw);
console.log(`[sw] ${version} · ${precache.length} 个预缓存资源`);
