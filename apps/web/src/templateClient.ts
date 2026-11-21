import { loadTemplatePackage } from "@life-sim/template-loader";
import { createIndexedDbStore, STORE_TEMPLATE_PACKAGES, type KeyValueStore } from "./idb";

/**
 * 模板包的**客户端**路径（ADR-070 第二期）。
 *
 * 闭环：`GET /api/templates/:id/:version/package` → 用 `loadTemplateSource` 重跑一遍加载
 * → 自己算指纹并与包内声明比对 → 通过就写进 IndexedDB。
 *
 * 缓存判据是**服务端当前指纹**（`/api/templates` 的 `versions[].fingerprint`）：
 * 缓存里的包只要还能自洽加载、且指纹与当前一致，就直接用；模板改过（指纹变）则重下。
 * 拿不到指纹时退回「每次都下载」——缓存是加速，不是真相来源。
 *
 * 注意：这一步**还没有**把世界搬进浏览器。它先在客户端证明「同一个模板包能独立载入」，
 * 为后面的 IndexedDB 存档与引擎进浏览器打地基；服务端仍是唯一能起局的地方。
 */

export interface TemplateRefLite {
  id: string;
  version: string;
}

export type TemplateCheckCode =
  | "network"
  | "package_invalid"
  | "template_invalid"
  | "fingerprint_mismatch";

export type TemplateCheck =
  | { ok: true; ref: TemplateRefLite; fingerprint: string; fromCache: boolean }
  | { ok: false; ref: TemplateRefLite; code: TemplateCheckCode; message: string };

/** 只保留失败分支（界面只渲染失败）。 */
export type TemplateCheckFailure = Extract<TemplateCheck, { ok: false }>;

export interface TemplateCheckOptions {
  fetchImpl?: typeof fetch;
  /** `null` = 禁用缓存；缺省 = IndexedDB。 */
  cache?: KeyValueStore | null;
  /** 服务端当前指纹：与缓存不一致就重下。缺省 = 仍用缓存（但只信它的自洽性）。 */
  expectedFingerprint?: string;
}

let defaultCache: KeyValueStore | null = null;
function cacheOf(options: TemplateCheckOptions): KeyValueStore | null {
  if (options.cache !== undefined) return options.cache;
  defaultCache ??= createIndexedDbStore(STORE_TEMPLATE_PACKAGES);
  return defaultCache;
}

const cacheKeyOf = (ref: TemplateRefLite): string => `${ref.id}@${ref.version}`;

/** 拉一个模板包（不校验）。网络错误向上抛，由 `checkTemplate` 归到 `network`。 */
export async function fetchTemplatePackage(
  ref: TemplateRefLite,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const url = `/api/templates/${encodeURIComponent(ref.id)}/${encodeURIComponent(ref.version)}/package`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`.trim());
  }
  return res.json();
}

/** 下载 + 校验一个模板版本（优先用缓存）。 */
export async function checkTemplate(
  ref: TemplateRefLite,
  options: TemplateCheckOptions = {},
): Promise<TemplateCheck> {
  const cache = cacheOf(options);
  const key = cacheKeyOf(ref);
  const expected = options.expectedFingerprint;

  if (cache !== null) {
    const cached = await cache.get(key).catch(() => undefined);
    if (cached !== undefined) {
      const result = loadTemplatePackage(cached);
      // 能自洽加载 + 与当前指纹一致 ⇒ 直接用；模板改过（指纹不同）就当缓存作废。
      if (result.ok && (expected === undefined || result.fingerprint === expected)) {
        return { ok: true, ref, fingerprint: result.fingerprint, fromCache: true };
      }
    }
  }

  let pkg: unknown;
  try {
    pkg = await fetchTemplatePackage(ref, options.fetchImpl ?? fetch);
  } catch (error) {
    // 浏览器对「连接被拒 / 中断」统一抛 TypeError("Failed to fetch")：对玩家是黑话，换成一句人话。
    const message =
      error instanceof TypeError
        ? "下载失败（网络或服务端不可用）"
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, ref, code: "network", message };
  }
  const result = loadTemplatePackage(pkg);
  if (!result.ok) {
    return { ok: false, ref, code: result.code, message: result.message };
  }
  if (cache !== null) {
    // 写缓存失败不影响本次结果：下次再下就是。
    await cache.put(key, pkg).catch(() => {});
  }
  return { ok: true, ref, fingerprint: result.fingerprint, fromCache: false };
}

/**
 * 把 `/api/templates` 里所有**可见**模板都校验一遍，只返回失败的。
 *
 * 失败不是「世界不能玩」——服务端仍然可用；它是「客户端自己载入这条路径还不通」，
 * 界面按预检结果提示，不拦操作。
 */
export async function checkVisibleTemplates(
  options: TemplateCheckOptions = {},
): Promise<TemplateCheckFailure[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl("/api/templates");
  if (!res.ok) {
    return [
      {
        ok: false,
        ref: { id: "?", version: "?" },
        code: "network",
        message: `模板列表请求失败（${res.status}）`,
      },
    ];
  }
  const payload = (await res.json()) as {
    templates?: Array<{
      id: string;
      startVersion?: string;
      hidden?: boolean;
      versions?: Array<{ version: string; loadable?: boolean; fingerprint?: string }>;
    }>;
  };
  const visible = (payload.templates ?? []).filter(
    (template) => template.hidden !== true && typeof template.startVersion === "string",
  );
  const results = await Promise.all(
    visible.map((template) => {
      const version = template.versions?.find((entry) => entry.version === template.startVersion);
      return checkTemplate(
        { id: template.id, version: template.startVersion! },
        { ...options, expectedFingerprint: version?.fingerprint },
      );
    }),
  );
  for (const result of results) {
    if (result.ok) {
      console.info(
        `[template] ${result.ref.id}@${result.ref.version} 校验通过（${result.fromCache ? "缓存" : "下载"}）`,
      );
    } else {
      console.warn(`[template] ${result.ref.id}@${result.ref.version} 校验失败`, result);
    }
  }
  return results.filter((result): result is TemplateCheckFailure => !result.ok);
}
