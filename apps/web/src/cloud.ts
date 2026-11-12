import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";

/**
 * WorkBuddy 云服务公开配置（ADR-0025）。
 *
 * 这三个值都是**半公开**的：`endpoint` 是本应用的发布域名，`publishableKey` 只标识
 * 「哪个应用」、不携带权限（安全性由服务端 Origin 精确匹配提供）。它们可以打进前端
 * 产物，但**不得打进日志**。
 *
 * `endpoint` 只允许来自这里的字面量：不从 `location.origin` 推断、不读 env。
 * 本应用靠 `?sharecode=` 过外部门禁，页面域名与数据面域名不是同一套约定，
 * 推断出来的地址会被服务端 Origin 匹配拒掉，而且只在发布后才会暴露。
 */
export const publicConfig = {
  endpoint: "https://cursed-wheel-life.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_6BjykHXBJu8kLx2VWyxeie_I7MAez9dWS9kX2gSAQspWyAYiHMDSRL9",
} as const;

/**
 * 全仓唯一的云客户端实例（Auth / Database / Storage / LLM 共用）。
 *
 * 单例是 SDK 的契约：登录后共享请求层自动把最新会话带给 Database 请求，
 * 造第二个实例就会出现「一个登了一个没登」。**不要在别处再调 `createWorkBuddyCloud`**。
 */
export const cloud = createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
  publishableKey: publicConfig.publishableKey,
});

/**
 * 云调用失败的统一日志：**只记 `stage` + `code` / `status`**。
 *
 * 不记原始错误对象、不记请求体、不记整行数据，也不记 token / 邮箱 / 手机号——
 * 云端错误体可能把 token 前缀或身份字段带出来。`stage` 指明是哪一段调用，
 * 配合 `code`（PostgREST / OAuth2 原始码）与 HTTP `status` 足够定位问题。
 */
export function logCloudFailure(stage: string, failure: { code?: string; status?: number } | null): void {
  console.error(
    "[WorkBuddy Cloud] request failed",
    JSON.stringify({ stage, code: failure?.code ?? "", status: failure?.status ?? 0 }),
  );
}
