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
/**
 * 模板媒体缓存（2026-11-24 · 迭代 character-media）。
 *
 * 名字故意不带 life-sim- 前缀：下面的 activate 会删掉所有 life-sim-* 旧缓存，
 * 带前缀等于每次部署都把图片清空一次。
 */
const MEDIA_CACHE = "character-media";
/** 容量上限（字节）：128 MB。超了按写入时间 FIFO 淘汰到 80%。 */
const MEDIA_MAX_BYTES = 128 * 1024 * 1024;
/** 只拦「模板媒体」这一种 GET：/api/templates/:id/:version/assets/:assetId */
const MEDIA_PATH = /^\\/api\\/templates\\/[^/]+\\/[^/]+\\/assets\\/[^/]+$/;
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

/** 同一 URL 的后台刷新去重：十张图同时打开时不该发十个请求、写十次同一个 key。 */
const mediaInflight = new Map();

/** 把响应写进媒体缓存，并给它打上写入时间（FIFO 淘汰靠它，不靠 LRU 猜）。 */
async function putMedia(request, response) {
  const cacheControl = response.headers.get("cache-control") || "";
  if (cacheControl.includes("no-store")) return;
  const cache = await caches.open(MEDIA_CACHE);
  const stamped = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
  stamped.headers.set("x-cached-at", String(Date.now()));
  await cache.put(request, stamped);
  await trimMedia(cache);
}

/** FIFO 淘汰：按 x-cached-at 升序删到 80% 以下。 */
async function trimMedia(cache) {
  const requests = await cache.keys();
  const entries = [];
  let total = 0;
  for (const request of requests) {
    const response = await cache.match(request);
    if (!response) continue;
    const size = Number(response.headers.get("content-length") || 0);
    total += size;
    entries.push({ request, size, at: Number(response.headers.get("x-cached-at") || 0) });
  }
  if (total <= MEDIA_MAX_BYTES) return;
  entries.sort((a, b) => a.at - b.at);
  const target = MEDIA_MAX_BYTES * 0.8;
  for (const entry of entries) {
    if (total <= target) break;
    await cache.delete(entry.request);
    total -= entry.size;
  }
}

/** SWR：有缓存先给缓存（同时后台刷新），没有就等网络；404 顺手清掉缓存条目。 */
function mediaStrategy(request, event) {
  const revalidate = () => {
    const existing = mediaInflight.get(request.url);
    if (existing) return existing;
    const task = fetch(request)
      .then(async (response) => {
        if (response.status === 404) {
          const cache = await caches.open(MEDIA_CACHE);
          await cache.delete(request);
          return response;
        }
        if (response.ok) await putMedia(request, response.clone());
        return response;
      })
      .catch(() => undefined)
      .finally(() => mediaInflight.delete(request.url));
    mediaInflight.set(request.url, task);
    return task;
  };

  return (async () => {
    const cache = await caches.open(MEDIA_CACHE);
    const cached = await cache.match(request);
    if (cached) {
      // 后台刷新必须 waitUntil：否则 SW 随时可能被回收，写一半留下坏条目。
      event.waitUntil(revalidate());
      return cached;
    }
    const fresh = await revalidate();
    return fresh || Response.error();
  })();
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /**
   * 模板媒体：**独立 Cache Storage + stale-while-revalidate**。
   *
   * 为什么不是永久 cache-first：同一个 assetId 的图会被模板作者替换（assetFingerprint 变了，
   * 客户端会在 URL 上加 ?v=）；SWR 保证下一次访问能刷到新图，又不会让玩家对着白屏等网络。
   */
  if (MEDIA_PATH.test(url.pathname)) {
    event.respondWith(mediaStrategy(request, event));
    return;
  }

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
