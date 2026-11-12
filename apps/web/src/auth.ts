import type { CloudError, CloudSession, CloudUser } from "@tencent-ai/workbuddy-cloud-sdk";
import { cloud, logCloudFailure } from "./cloud";

/**
 * 账号登录（WorkBuddy 账号登录 / ADR-0025 决策 4）。
 *
 * 一个身份源：只做 `workbuddy` 这一个 provider。**不做**邮箱 / 短信兜底、不做匿名登录、
 * 不造 localStorage 假会话 —— 「同一自然人两个 uid、档案分裂」比登录失败更糟。
 * 认证也**不阻塞游戏**：未登录可以完整玩，只有「档案」页签要求登录。
 */

/** 启动期认证结果：`error` 是给玩家的可关闭提示，不是渲染错误（认证失败不能白屏）。 */
export interface AuthBootstrapResult {
  session: CloudSession | null;
  error: string | null;
}

/** 回调带 `error` 时的专用文案：玩家在授权页取消 / 授权未通过，不是「入口点错」。 */
const AUTHORIZATION_NOT_COMPLETED = "授权未完成：你取消了登录，或授权未通过。";

/** 回调 / 登录失败的玩家文案：先按稳定 `kind` 分支，再看 HTTP status，最后才兜底。 */
function authFailureText(error: CloudError | null): string {
  if (!error) return "登录未完成，请重试。";
  if (error.kind === "network") return "网络异常，登录未完成，请重试。";
  if (error.kind === "unauthenticated" || error.code === "invalid_grant") {
    return "登录状态已失效，请重新登录。";
  }
  if (error.kind === "credits-exhausted") return "云服务额度不足，登录暂不可用。";
  if (error.status === 401) return "当前域名与云服务不匹配，请联系管理员。";
  return "登录未完成，请重试。";
}

/** 普通启动：只恢复会话，不调任何 OAuth handler（不是回调就不该兑换）。 */
async function readSession(stage: string): Promise<CloudSession | null> {
  try {
    const { data, error } = await cloud.auth.getSession();
    if (error) {
      logCloudFailure(stage, error);
      return null;
    }
    return data ?? null;
  } catch {
    logCloudFailure(stage, null);
    return null;
  }
}

/**
 * 清掉 OAuth 回调留在地址栏上的参数。
 *
 * **只删回调自己的键**（`code` / `state` / `provider` / `error` / `error_description`），
 * 其余 query 一律保留（`?sharecode=` 是本应用过外部门禁的凭据）。绝不能
 * `location.href = "/"` 或只写回 `pathname`：那样 sharecode 当场丢失，页面在 JS 之前就被拦下。
 *
 * `error` / `error_description` 必须一起删：玩家拒绝授权时回调只有这两个键，
 * 留着会让**每次刷新**都重走同一条失败分支、重弹同一条提示。
 */
function clearCallbackParams(url: URL): void {
  for (const key of ["code", "state", "provider", "error", "error_description"]) {
    url.searchParams.delete(key);
  }
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

/**
 * 启动期第一步：先处理 OAuth 回调，再谈会话恢复（顺序是硬要求）。
 *
 * - URL 无 `code` / `error` ⇒ 普通启动，只 `getSession()` 恢复会话。
 * - 有 ⇒ **按 `provider` 分派且只调一个 handler**。本项目只有 `workbuddy`，
 *   所以**绝不**无条件调 `handleWechatWebCallback`：它没有 provider 判断，
 *   会对 workbuddy 回调报 `wechat callback requires provider=wechat`，
 *   把一次成功登录显示成失败。
 * - 任何异常都在这里收口，不冒泡到渲染层（白屏 = 认证阻塞游戏）。
 */
export async function bootstrapAuth(): Promise<AuthBootstrapResult> {
  try {
    const url = new URL(location.href);
    const hasError = url.searchParams.has("error");
    const hasCallback = url.searchParams.has("code") || hasError;

    if (!hasCallback) return { session: await readSession("auth:startup"), error: null };

    const provider = url.searchParams.get("provider");
    if (provider !== "workbuddy") {
      // 不是本应用的登录方式（或回调缺 provider）：停在未登录态，提示可关闭的一条话。
      clearCallbackParams(url);
      logCloudFailure("auth:callback-provider", null);
      // 带 error 的回调已是「授权被拒/未通过」的终局：不能复用「缺少登录方式」这句话，
      // 否则玩家会以为自己点错了入口，实际上是他自己在授权页点了取消。
      return {
        session: null,
        error: hasError ? AUTHORIZATION_NOT_COMPLETED : "授权回调缺少有效的登录方式，请重新登录。",
      };
    }

    if (typeof cloud.auth.handleWorkBuddyCallback !== "function") {
      // 加载到的 SDK 缺少该方法：报加载不匹配，不当作「空回调」放过。
      logCloudFailure("auth:callback-handler-missing", null);
      return { session: null, error: "暂时无法确认登录，请稍后重试或联系应用管理员。" };
    }

    const { data, error } = await cloud.auth.handleWorkBuddyCallback();
    if (error) {
      logCloudFailure("auth:callback-exchange", error);
      // 失败的 code 已是一次性消耗品，留着只会在刷新时反复报错：清掉回调参数即可重试登录。
      clearCallbackParams(url);
      // 带 error 的回调本身就是「授权未完成」，比泛化的「登录未完成，请重试」准确。
      return { session: null, error: hasError ? AUTHORIZATION_NOT_COMPLETED : authFailureText(error) };
    }
    if (data) {
      // 成功：先清 URL 再进游戏，否则下一次刷新会用已消耗的 code 再兑换一次。
      clearCallbackParams(url);
      return { session: data, error: null };
    }
    // 空结果不是失败（例如玩家直接访问 / 收藏了落地页）：照常恢复已有会话。
    clearCallbackParams(url);
    return { session: await readSession("auth:callback-empty"), error: null };
  } catch {
    logCloudFailure("auth:bootstrap", null);
    return { session: null, error: "登录状态确认失败，可稍后重试。" };
  }
}

/**
 * 登录按钮：`signInWithOAuth` 只返回地址，跳转由调用方做，且**必须同 tab**。
 *
 * PKCE 证明存在当前标签页的 `sessionStorage` 里，`window.open` / `_blank` / iframe
 * 打开的页面读不到它，兑换必然失败（`workbuddy callback has no local PKCE verifier`）。
 *
 * `redirectTo` 取站点根路径（静态托管没有 history fallback，子路径 404 会让 code 直接丢失），
 * 并**保留业务 query**（含 `sharecode`）—— 它在登录往返中只能靠 `redirectTo` 带出去。
 *
 * 返回 `null` 表示已发起跳转；返回字符串是要展示的失败文案。
 */
export async function signInWithWorkBuddy(): Promise<string | null> {
  try {
    const back = new URL(location.href);
    back.pathname = "/";
    // 不转发回调参数：残留的 code / state / error 会和这次登录撞车。
    for (const key of ["code", "state", "provider", "error", "error_description"]) {
      back.searchParams.delete(key);
    }

    const { data, error } = await cloud.auth.signInWithOAuth({
      provider: "workbuddy",
      redirectTo: back.toString(),
    });
    if (error) {
      logCloudFailure("auth:sign-in", error);
      return authFailureText(error);
    }
    location.assign(data.url);
    return null;
  } catch {
    logCloudFailure("auth:sign-in-throw", null);
    return "登录暂时不可用，请稍后重试。";
  }
}

/** 退出登录：失败只返回文案，不影响正在进行的游戏。 */
export async function signOutOfWorkBuddy(): Promise<string | null> {
  try {
    const { error } = await cloud.auth.signOut();
    if (error) {
      logCloudFailure("auth:sign-out", error);
      return "退出登录未完成，请稍后重试。";
    }
    return null;
  } catch {
    logCloudFailure("auth:sign-out-throw", null);
    return "退出登录未完成，请稍后重试。";
  }
}

/** 邮箱掩码：`abcd@example.com` → `a***@example.com`（邮箱不进页面原文、更不进日志）。 */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/** 手机号掩码：`13812345678` → `138****5678`。 */
function maskPhone(phone: string): string {
  return phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : "***";
}

/**
 * 「已登录：<who>」里的显示名。
 *
 * `user.name`（WorkBuddy 昵称）可直接显示；邮箱 / 手机号必须掩码；三者都没有时给通用
 * 占位而不是空标签（`name` / `avatarUrl` 都是可选字段，不要求它们存在才算登录成功）。
 */
export function userDisplayName(user: CloudUser | null | undefined): string {
  if (!user) return "已登录用户";
  if (user.name) return user.name;
  if (user.email) return maskEmail(user.email);
  if (user.phone) return maskPhone(user.phone);
  return "已登录用户";
}
