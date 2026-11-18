/**
 * 自定义 LLM 凭证的**客户端加密**（BACKLOG B-01）。
 *
 * 只做一件事：把 `{ apiKey, model, baseUrl }` 装进信封，服务端用配对的私钥解开
 * （`apps/server/src/llm/credentialEnvelope.ts`）。两处的信封形状与算法必须同构：
 *
 *   1. 随机生成 AES-256-GCM key + 12 字节 nonce，加密 JSON 载荷；
 *   2. 用 RSA-OAEP(SHA-256) 公钥只包那 32 字节 AES key；
 *   3. `{ v: 1, key, iv, data }` 全部 base64。
 *
 * 为什么混合而不是纯 RSA：RSA-OAEP(2048) 单块上限约 190 字节，`apiKey + model + baseUrl`
 * 很容易超；AES 加密载荷后长度不受限。
 *
 * 公钥写死在代码里是刻意为之：云端没有环境变量通道（用户 2026-11-18 裁决）。
 * 公钥本就是公开信息，放在前端 bundle 里不构成泄露；**私钥只在服务端**。
 */

const PUBLIC_KEY_DER_B64 =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoapEAMmRUaChyC54/milERXqVmbXCSxUKBsgDDGnvUJQEACz0zqOPZNaHbPJk7xCjixSunjP8/or1mZ8oT6FgHEFGV/0GpqMJOFmbxXnqF5AWAkmm6LX7wCczrEnqrF2783QXOcxvHJElpIOCccqMOFOKySa3bgDlDNf090DAeJBupDc54axqp2wnShhYv4ptgnOanEJmkGx5Y8pGQB0yr65CxMYYV5bPNHBWQTkOuo60Y/lQuLsSEo/fdjb3s6iRfFUZschWHtJRJBgT+X8eQ8Oz2AISaF0MQGm2VMBVWg0CBYANGKM195hI1DV6em14g9eRbOX/9YLYQSrN+RsUwIDAQAB";

/** 与服务端 `CredentialEnvelope` 同构。 */
export interface CredentialEnvelope {
  v: 1;
  key: string;
  iv: string;
  data: string;
}

// 返回**独立 ArrayBuffer** 的视图：WebCrypto 的 BufferSource 不接受 SharedArrayBuffer 兜底类型
// （TS 5.7 起 `Uint8Array` 带泛型参数，必须显式绑到 ArrayBuffer 上）。
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const buffer = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

let publicKeyPromise: Promise<CryptoKey> | null = null;

function publicKey(): Promise<CryptoKey> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    // 非安全上下文（http:// 局域网 IP）拿不到 WebCrypto。**宁可拒绝也不降级成明文**：
    // 静默降级会让「已经加密了」这句话变成假话。
    return Promise.reject(
      new Error("当前页面无法加密凭证（需要 HTTPS 或 localhost）。请改用安全连接后重试。"),
    );
  }
  publicKeyPromise ??= subtle.importKey(
    "spki",
    base64ToBytes(PUBLIC_KEY_DER_B64),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  return publicKeyPromise;
}

/** 把任意 JSON 载荷加密成信封（服务端唯一接受的提交格式）。 */
export async function encryptCredentialPayload(payload: unknown): Promise<CredentialEnvelope> {
  // 先做安全上下文检查（`publicKey()` 会给一句人话），再取 subtle。
  const rsa = await publicKey();
  const subtle = globalThis.crypto.subtle;
  const aes = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, aes, plain));
  const rawAesKey = new Uint8Array(await subtle.exportKey("raw", aes));
  const wrapped = new Uint8Array(await subtle.encrypt({ name: "RSA-OAEP" }, rsa, rawAesKey));
  return {
    v: 1,
    key: bytesToBase64(wrapped),
    iv: bytesToBase64(iv),
    data: bytesToBase64(ciphertext),
  };
}
