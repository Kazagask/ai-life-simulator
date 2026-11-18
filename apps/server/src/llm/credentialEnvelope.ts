import { createDecipheriv, createPrivateKey, privateDecrypt, constants, type KeyObject } from "node:crypto";

/**
 * 凭证信封（BACKLOG B-01）：前端用**公钥**加密，服务端用**私钥**解密。
 *
 * 为什么需要这一层：自定义 LLM 的 `apiKey` 原本以明文 JSON 提交。虽然走 HTTPS，
 * 但它会出现在浏览器 DevTools / 代理调试 / 任何 TLS 终止点之后的可读请求体里。
 * 加一层信封后，wire 上只有密文，明文只在两端的进程内短暂存在。
 *
 * ## 为什么是混合加密（RSA + AES-GCM）而不是纯 RSA
 *
 * RSA-OAEP(2048) 单块只能加密约 190 字节，而 `apiKey + model + baseUrl` 很容易超
 * （尤其 baseUrl 长的自建网关）。所以：随机 AES-256-GCM 加密载荷，RSA-OAEP 只包那 32 字节的
 * AES key。长度不受限，且两种算法都是标准库能力（浏览器 WebCrypto / Node crypto）。
 *
 * ## 密钥为什么写死在代码里
 *
 * 云端部署没有环境变量通道（用户 2026-11-18 裁决，明确接受这个代价）。
 * 换密钥 = 改这两处常量并重新发布；滚轮换钥需要前后端同时上线，**不支持**灰度混跑
 * （旧的私钥解不开新公钥加密的信封，反之亦然）。第一版就用这一把。
 *
 * 🔴 不变量：解密失败一律返回 `null`，调用方只回 `invalid_credentials`——
 * 不区分「格式错 / 解密失败 / 内容不合法」，避免把这里变成探测 oracle；
 * 密文与明文都**不得**进日志。
 */
const PRIVATE_KEY_DER_B64 =
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQChqkQAyZFRoKHILnj+aKURFepWZtcJLFQoGyAMMae9QlAQALPTOo49k1ods8mTvEKOLFK6eM/z+ivWZnyhPoWAcQUZX/Qamowk4WZvFeeoXkBYCSabotfvAJzOsSeqsXbvzdBc5zG8ckSWkg4Jxyow4U4rJJrduAOUM1/T3QMB4kG6kNznhrGqnbCdKGFi/im2Cc5qcQmaQbHljykZAHTKvrkLExhhXls80cFZBOQ66jrRj+VC4uxISj992NvezqJF8VRmxyFYe0lEkGBP5fx5Dw7PYAhJoXQxAabZUwFVaDQIFgA0YozX3mEjUNXp6bXiD15Fs5f/1gthBKs35GxTAgMBAAECggEADQqbZhrcm7f4b8R7+JNVhD1/Ls1+BFyXRLhSIK8IHTw9EYVqUZxpfsMlI7yYrXp5k1bfrPDztEwBVFA74UAWF0icGjIY6DqBGrU02mTrJV8bvrOs8c+JrttJoGI/KnBwK/kvmVxXMUtgiBWr3JMSBBPGMV8dv8wekcqGgk9Tykd8RL7pizp9U/ezW7VmDnsHiaGIGsUi6Lij/UFZgH3OszDlkeDo4O/W4M4osnobeFQxUF8YR3TE0wX4IkWsbzwI9IJB4oAwtyeKnbj/k6SW9Rffxg8QnMVh3zwXf9aeASWc1pOEPMKPpKFZoSNoANQsfLyCB91dJCJpmFpSvz//mQKBgQDWuBuDueD7GCVhCPqpJi4NXyOeYTtsX0amoSTdc90WXQwL5xV8r8oeS+HO13Sfh8Uy50Lz4XQRjIFNVGRrqKLviYmSK0S31EmFnCTZtVqtBXKCCefgwP+9SyMdKepfHEKuOVTOkPrSVmXNL0wpLrdljDMRmmLk0mY4/hto4hfLmwKBgQDAvvs84HXzNPUQGgugLXV82m01pXr4ZFzxhx/j8tc9a7lew5dWDcnd0y4Y14GZWEfW7M6JnhJIJ0zdVCX33uxoxus0tMVkz5E1Gzk1buZQox0gEyupzi6uPacCrfE9gilbWS9AGmeF/Z4kFyenJKro+4ubbQyme56xArl2KuS5qQKBgBdI4dr4FljEdpE+Swh61nWmwpMTUkFfV6cMRJYrUWdycbL8vUzHN3Dvo64tmT0PmSf7Ajy2T0Lz7LW5GCbAo+K8FIogXRReVhbCJxDg5NNsis1lS5sI8vLRKh6og/0KcIS6POMlv719lw6YOXch1MuTV5pqFp1f36wAinJmSlRPAoGALLlkBLk0xU1JfAX/IpjJxUHNy3/ta8umAWlQTg1gQmFHrySFbjNe3vkMnjkLWnCwor9qIWaraVCtNkI7WSvCAYH+u8kicIT1dbQubyafjKB8tp+cJxevn0CxCx8fdh1IyWiFXUODOAUkd81jpxYMDmmn+FWydMMEjKBMNo43apkCgYEAxg387F3GWJJ4wCksJsr+GfE9kQUPVvSguVHGJ+r2UhWm4/DYQ8I97CxvE7i4flwMlnw3RTgEKJJaKagbGIh1ZUTa6GXtG+kCJ8PvmxXRnVcqQmzAfv8vOSxOIuZUYZswwdkei99NEG6RvfPCcAM65xo6TTu2NR3JbNOXg1kC808=";

let cachedKey: KeyObject | null = null;
function privateKey(): KeyObject {
  cachedKey ??= createPrivateKey({
    key: Buffer.from(PRIVATE_KEY_DER_B64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return cachedKey;
}

/** 前端提交的信封（`apps/web/src/llmCrypto.ts` 生成，两处必须同构）。 */
export interface CredentialEnvelope {
  v: 1;
  /** base64：被 RSA-OAEP(SHA-256) 加密的 32 字节 AES-256 key。 */
  key: string;
  /** base64：12 字节 GCM nonce。 */
  iv: string;
  /** base64：AES-256-GCM 密文（尾部 16 字节是 auth tag，WebCrypto 的约定）。 */
  data: string;
}

/** 请求体是否是信封（服务端**只接受**信封；明文 JSON 一律 400）。 */
export function isCredentialEnvelope(body: unknown): body is { envelope: CredentialEnvelope } {
  if (typeof body !== "object" || body === null) return false;
  const env = (body as { envelope?: unknown }).envelope;
  if (typeof env !== "object" || env === null) return false;
  const e = env as Record<string, unknown>;
  return e.v === 1 && typeof e.key === "string" && typeof e.iv === "string" && typeof e.data === "string";
}

/**
 * 解开信封，返回里面的原始 JSON 值（调用方再用 zod 校验形状）。
 *
 * 任何一步失败（形状不对 / base64 坏 / RSA 解不开 / GCM 校验失败 / 不是合法 JSON）
 * 都返回 `null`——**不抛错**，因为调用方对外只能表达「凭证无效」这一种结果。
 */
export function openCredentialEnvelope(body: unknown): unknown | null {
  if (!isCredentialEnvelope(body)) return null;
  const { key, iv, data } = body.envelope;
  try {
    const rawAesKey = privateDecrypt(
      { key: privateKey(), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(key, "base64"),
    );
    const payload = Buffer.from(data, "base64");
    // WebCrypto 把 auth tag 拼在密文尾部；Node 需要显式拆出来。
    if (payload.length <= 16) return null;
    const tag = payload.subarray(payload.length - 16);
    const ciphertext = payload.subarray(0, payload.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", rawAesKey, Buffer.from(iv, "base64"));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return JSON.parse(plain) as unknown;
  } catch {
    return null;
  }
}
