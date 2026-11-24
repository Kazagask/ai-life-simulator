import { loadTemplatePackage, type TemplateBundle } from "@life-sim/template-loader";
import type { WorldTemplateV2 } from "@life-sim/shared";
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
  | {
      ok: true;
      ref: TemplateRefLite;
      fingerprint: string;
      /** 旧算法的语义指纹：只给「旧存档一次性升级」用（见 `worldRepo.fingerprintVerdict`）。 */
      legacyFingerprint: string;
      fromCache: boolean;
      /** 模板本体（兼容既有调用点）。 */
      template: WorldTemplateV2;
      /**
       * 完整运行时包（开局 DAG / 结局 / 评价 / 规则 / 设定 / UI）。
       * 本地起世界要用它 —— 只有 `template` 是起不来的（开局与结局都不在里面）。
       */
      bundle: TemplateBundle;
      /** 原始包（模板同步上行用；缓存命中时可能没有）。 */
      package?: unknown;
    }
  | { ok: false; ref: TemplateRefLite; code: TemplateCheckCode; message: string };

/** 只保留失败分支（界面只渲染失败）。 */
export type TemplateCheckFailure = Extract<TemplateCheck, { ok: false }>;

export interface TemplateCheckOptions {
  fetchImpl?: typeof fetch;
  /** `null` = 禁用缓存；缺省 = IndexedDB。 */
  cache?: KeyValueStore | null;
  /** 服务端当前指纹：与缓存不一致就重下。缺省 = 仍用缓存（但只信它的自洽性）。 */
  /** 期望的**语义**指纹（存档漂移判定用；老服务端只有这一条） */
  expectedFingerprint?: string;
  /** 期望的**包**指纹（含 ui.yaml）：缓存新鲜度以它为准 */
  expectedPackageFingerprint?: string;
  /** 离线模式：只读 IndexedDB 缓存，**绝不发网络请求**（PWA 断网启动用）。 */
  offlineOnly?: boolean;
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
  const expectedPackage = options.expectedPackageFingerprint;

  if (cache !== null) {
    const cached = await cache.get(key).catch(() => undefined);
    if (cached !== undefined) {
      const result = loadTemplatePackage(cached);
      /**
       * 能自洽加载 + 与当前指纹一致 ⇒ 直接用。
       *
       * **优先比包指纹**（含 ui.yaml）：语义指纹刻意不含 ui，只比它的话
       * 纯表现改动永远不会让缓存失效 —— 演练场看得见新特效、游戏里还是旧包。
       * 老服务端不下发包指纹时退回语义指纹。
       */
      const fresh = result.ok
        ? expectedPackage !== undefined
          ? result.packageFingerprint === expectedPackage
          : expected === undefined || result.fingerprint === expected
        : false;
      if (result.ok && fresh) {
        return {
          ok: true,
          ref,
          fingerprint: result.fingerprint,
          legacyFingerprint: result.legacyFingerprint,
          fromCache: true,
          template: result.template,
          bundle: result.bundle,
          ...(cached !== undefined ? { package: cached } : {}),
        };
      }
    }
  }

  let pkg: unknown;
  if (options.offlineOnly === true) {
    return {
      ok: false,
      ref,
      code: "network",
      message: "离线模式：本地没有这个模板版本的缓存",
    };
  }
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
  return {
    ok: true,
    ref,
    fingerprint: result.fingerprint,
    legacyFingerprint: result.legacyFingerprint,
    fromCache: false,
    template: result.template,
    bundle: result.bundle,
    package: pkg,
  };
}

/**
 * 把 `/api/templates` 里所有**可见**模板都校验一遍，只返回失败的。
 *
 * 失败不是「世界不能玩」——服务端仍然可用；它是「客户端自己载入这条路径还不通」，
 * 界面按预检结果提示，不拦操作。
 */
export interface TemplateScanResult {
  results: TemplateCheck[];
  failures: TemplateCheckFailure[];
}

export async function checkVisibleTemplates(
  options: TemplateCheckOptions = {},
): Promise<TemplateScanResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl("/api/templates");
  if (!res.ok) {
    const failure: TemplateCheckFailure = {
      ok: false,
      ref: { id: "?", version: "?" },
      code: "network",
      message: `模板列表请求失败（${res.status}）`,
    };
    return { results: [failure], failures: [failure] };
  }
  const payload = (await res.json()) as {
    templates?: Array<{
      id: string;
      startVersion?: string;
      hidden?: boolean;
      versions?: Array<{
        version: string;
        loadable?: boolean;
        fingerprint?: string;
        packageFingerprint?: string;
      }>;
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
        {
          ...options,
          expectedFingerprint: version?.fingerprint,
          ...(version?.packageFingerprint !== undefined
            ? { expectedPackageFingerprint: version.packageFingerprint }
            : {}),
        },
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
  return {
    results,
    failures: results.filter((result): result is TemplateCheckFailure => !result.ok),
  };
}

/**
 * 离线启动：只从 IndexedDB 取模板包，一个网络请求都不发。
 *
 * refs 来自两处：本地存档记录（`record.ref` + `record.fingerprint`）与上次成功启动记下的
 * `last-template`。命中缓存且指纹自洽就直接注册本地引擎 —— 这是「断网还能继续玩」的关键；
 * 没有这条，PWA 只是能打开一个空壳。
 */
export async function checkCachedTemplates(
  refs: readonly { id: string; version: string; fingerprint?: string }[],
  options: TemplateCheckOptions = {},
): Promise<TemplateScanResult> {
  const results = await Promise.all(
    refs.map((ref) =>
      checkTemplate(
        { id: ref.id, version: ref.version },
        { ...options, expectedFingerprint: ref.fingerprint, offlineOnly: true },
      ),
    ),
  );
  for (const result of results) {
    if (result.ok) {
      // 这条日志也是「本地优先」的体温计：先出现它、再出现「下载 / 缓存」，就说明没等网络。
      console.info(`[template] ${result.ref.id}@${result.ref.version} 本地缓存命中`);
    }
  }
  return {
    results,
    failures: results.filter((result): result is TemplateCheckFailure => !result.ok),
  };
}
