import { loadTemplatePackage } from "@life-sim/template-loader";

/**
 * 模板包的**客户端**路径（ADR-070 第二期第一步）。
 *
 * 闭环：`GET /api/templates/:id/:version/package` → 用 `loadTemplateSource` 重跑一遍加载
 * → 自己算指纹并与包内声明比对。失败原因要能渲染成「哪个世界、为什么打不开」，
 * 所以这里一律返回结构化结果，不抛错。
 *
 * 注意：这一步**还没有**把世界搬进浏览器。它先在客户端证明「同一个模板包能独立载入」，
 * 为后面的 IndexedDB 缓存与引擎进浏览器打地基；服务端仍是唯一能起局的地方。
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
  | { ok: true; ref: TemplateRefLite; fingerprint: string }
  | { ok: false; ref: TemplateRefLite; code: TemplateCheckCode; message: string };

/** 只保留失败分支（界面只渲染失败）。 */
export type TemplateCheckFailure = Extract<TemplateCheck, { ok: false }>;

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

/** 下载 + 校验一个模板版本。 */
export async function checkTemplate(
  ref: TemplateRefLite,
  fetchImpl: typeof fetch = fetch,
): Promise<TemplateCheck> {
  let pkg: unknown;
  try {
    pkg = await fetchTemplatePackage(ref, fetchImpl);
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
  return { ok: true, ref, fingerprint: result.fingerprint };
}

/**
 * 把 `/api/templates` 里所有**可见**模板都校验一遍，只返回失败的。
 *
 * 失败不是「世界不能玩」——服务端仍然可用；它是「客户端自己载入这条路径还不通」，
 * 界面按预检结果提示，不拦操作。
 */
export async function checkVisibleTemplates(
  fetchImpl: typeof fetch = fetch,
): Promise<TemplateCheckFailure[]> {
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
    templates?: Array<{ id: string; startVersion?: string; hidden?: boolean }>;
  };
  const visible = (payload.templates ?? []).filter(
    (template) => template.hidden !== true && typeof template.startVersion === "string",
  );
  const results = await Promise.all(
    visible.map((template) => checkTemplate({ id: template.id, version: template.startVersion! }, fetchImpl)),
  );
  return results.filter((result) => !result.ok);
}
