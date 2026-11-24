import { describe, expect, it } from "vitest";
import { checkCachedTemplates, checkTemplate, type TemplateRefLite } from "../../apps/web/src/templateClient.ts";
import type { KeyValueStore } from "../../apps/web/src/idb.ts";
import { registerServerExtensions } from "../../apps/server/src/extensions.ts";
import { loadTemplates, readDeclarativeFiles } from "../../apps/server/src/templates.ts";

/**
 * 模板包缓存（ADR-070 第二期）：下载过一次的世界，重开不再拉 320 KB。
 *
 * 缓存不是真相来源：命中要求「能自洽加载 + 指纹与服务端当前一致」；模板改过（指纹变）
 * 必须重下，否则玩家会拿着旧世界玩新档。
 */

registerServerExtensions();

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function packageOf(id = "jjk-2006", version = "3.0.0") {
  const entry = loadTemplates(silent).resolve({ id, version });
  if (entry?.status !== "ready") throw new Error(`${id}@${version} 未就绪`);
  return {
    fingerprint: entry.semanticFingerprint,
    pkg: {
      templateId: id,
      version,
      fingerprint: entry.semanticFingerprint,
      files: readDeclarativeFiles(entry.ref),
    },
  };
}

function memoryCache(): KeyValueStore & { readonly size: number } {
  const map = new Map<string, unknown>();
  return {
    get: async (key) => map.get(key),
    put: async (key, value) => {
      map.set(key, value);
    },
    delete: async (key) => {
      map.delete(key);
    },
    keys: async () => [...map.keys()],
    get size() {
      return map.size;
    },
  };
}

const ref: TemplateRefLite = { id: "jjk-2006", version: "3.0.0" };

function countingFetch(payload: unknown) {
  const calls = { count: 0 };
  const impl = (async () => {
    calls.count += 1;
    if (payload === "network-error") throw new TypeError("Failed to fetch");
    return { ok: true, status: 200, statusText: "OK", json: async () => payload } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

describe("模板包缓存", () => {
  it("第一次下载并写入缓存，第二次直接命中（不再发请求）", async () => {
    const { pkg } = packageOf();
    const cache = memoryCache();
    const { impl, calls } = countingFetch(pkg);

    const first = await checkTemplate(ref, { fetchImpl: impl, cache, expectedFingerprint: pkg.fingerprint });
    expect(first.ok && first.fromCache).toBe(false);
    expect(calls.count).toBe(1);
    expect(cache.size).toBe(1);

    const second = await checkTemplate(ref, { fetchImpl: impl, cache, expectedFingerprint: pkg.fingerprint });
    expect(second.ok && second.fromCache).toBe(true);
    expect(calls.count).toBe(1);
  });

  it("服务端指纹变了 ⇒ 缓存作废，重新下载", async () => {
    const { pkg } = packageOf();
    const cache = memoryCache();
    const { impl, calls } = countingFetch(pkg);
    await checkTemplate(ref, { fetchImpl: impl, cache, expectedFingerprint: pkg.fingerprint });

    const changed = await checkTemplate(ref, {
      fetchImpl: impl,
      cache,
      expectedFingerprint: "sha256:changed",
    });
    expect(changed.ok && changed.fromCache).toBe(false);
    expect(calls.count).toBe(2);
  });

  it("缓存内容坏了（被篡改）⇒ 不信它，回退下载", async () => {
    const { pkg } = packageOf();
    const cache = memoryCache();
    await cache.put("jjk-2006@3.0.0", { ...pkg, files: { ...pkg.files, "world.yaml": "# broken\n" } });
    const { impl, calls } = countingFetch(pkg);

    const result = await checkTemplate(ref, { fetchImpl: impl, cache, expectedFingerprint: pkg.fingerprint });
    expect(result.ok && result.fromCache).toBe(false);
    expect(calls.count).toBe(1);
  });

  it("断网且无缓存 ⇒ network 失败（人话文案）", async () => {
    const cache = memoryCache();
    const { impl } = countingFetch("network-error");
    const result = await checkTemplate(ref, { fetchImpl: impl, cache });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("network");
      expect(result.message).toContain("下载失败");
    }
  });

  it("禁用缓存（cache: null）⇒ 每次都要下载", async () => {
    const { pkg } = packageOf();
    const { impl, calls } = countingFetch(pkg);
    await checkTemplate(ref, { fetchImpl: impl, cache: null, expectedFingerprint: pkg.fingerprint });
    await checkTemplate(ref, { fetchImpl: impl, cache: null, expectedFingerprint: pkg.fingerprint });
    expect(calls.count).toBe(2);
  });

  it("offlineOnly：命中缓存不发请求，未命中也不发请求", async () => {
    const { pkg } = packageOf();
    const cache = memoryCache();
    const { impl, calls } = countingFetch(pkg);
    await checkTemplate(ref, { fetchImpl: impl, cache, expectedFingerprint: pkg.fingerprint });
    calls.count = 0;

    const hit = await checkTemplate(ref, {
      fetchImpl: impl,
      cache,
      expectedFingerprint: pkg.fingerprint,
      offlineOnly: true,
    });
    expect(hit.ok).toBe(true);
    expect(calls.count).toBe(0);

    const miss = await checkTemplate(
      { id: "jjk-2006", version: "9.9.9" },
      { fetchImpl: impl, cache, offlineOnly: true },
    );
    expect(miss.ok).toBe(false);
    expect(calls.count).toBe(0);
  });

  it("checkCachedTemplates 只走缓存（PWA 断网启动）", async () => {
    const { pkg } = packageOf();
    const cache = memoryCache();
    const { impl, calls } = countingFetch(pkg);
    await checkTemplate(ref, { fetchImpl: impl, cache });
    calls.count = 0;

    const scan = await checkCachedTemplates([{ ...ref, fingerprint: pkg.fingerprint }], {
      fetchImpl: impl,
      cache,
    });
    expect(scan.results.some((result) => result.ok)).toBe(true);
    expect(calls.count).toBe(0);
  });
});
