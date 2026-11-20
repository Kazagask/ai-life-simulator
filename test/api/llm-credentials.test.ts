import { afterEach, describe, expect, it } from "vitest";
import { encryptCredentialPayload, type CredentialEnvelope } from "../../apps/web/src/llmCrypto.ts";
import { allowsPlaintextCredentials } from "../../apps/server/src/llm/credentialEnvelope.ts";
import { api, startServer, type RunningServer } from "../helpers/server.ts";

/**
 * BACKLOG B-01：自定义 LLM 凭证走**非对称加密信封**。
 *
 * 这里直接 import **前端**的加密实现（`apps/web/src/llmCrypto.ts`），与服务端
 * `llm/credentialEnvelope.ts` 做真往返——只测服务端会用两端私钥/公钥漂移测不出来。
 * Node 22 自带 WebCrypto / atob，所以浏览器模块可以原样跑。
 */
/** 测试里恒在 Node = 安全上下文，所以拿到的必然是 `v: 1`；显式收窄给类型看。 */
async function encrypted(payload: unknown): Promise<CredentialEnvelope> {
  const envelope = await encryptCredentialPayload(payload);
  if (envelope.v !== 1) throw new Error("期望 v: 1 信封");
  return envelope;
}

describe("自定义 LLM 凭证：加密信封", () => {
  let app: RunningServer | undefined;

  afterEach(async () => {
    await app?.stop();
    app = undefined;
  });

  it("前端加密 → 服务端解密 → 换不透明 sessionId", async () => {
    app = await startServer();
    const envelope = await encrypted({ apiKey: "sk-test-abc", model: "test-model" });
    const res = await api<{ sessionId: string }>(app.baseUrl, "POST", "/api/llm-credentials", { envelope });
    expect(typeof res.sessionId).toBe("string");
    expect(res.sessionId.length).toBeGreaterThan(10);
    // 不透明：sessionId 不携带任何凭证信息
    expect(res.sessionId).not.toContain("sk-test-abc");
  });

  it("明文 JSON 一律 400（不接受降级提交）", async () => {
    app = await startServer();
    await expect(
      api(app.baseUrl, "POST", "/api/llm-credentials", { apiKey: "sk-x", model: "m" }),
    ).rejects.toThrow(/400/);
  });

  it("密文被篡改 ⇒ 400（GCM 校验失败，不吐原因）", async () => {
    app = await startServer();
    const envelope = await encrypted({ apiKey: "sk-test", model: "m" });
    const bytes = Buffer.from(envelope.data, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    await expect(
      api(app.baseUrl, "POST", "/api/llm-credentials", {
        envelope: { ...envelope, data: bytes.toString("base64") },
      }),
    ).rejects.toThrow(/400/);
  });

  it("解出来的内容缺字段 ⇒ 400", async () => {
    app = await startServer();
    const envelope = await encrypted({ apiKey: "sk-test" });
    await expect(api(app.baseUrl, "POST", "/api/llm-credentials", { envelope })).rejects.toThrow(/400/);
  });

  /**
   * 局域网 HTTP（`http://192.168.x.x`）拿不到 WebCrypto，只能走 `v: 0` 明文信封。
   * 这一档必须**只对私有来源**开：公网部署要是也收，那就是一个静默的降级口。
   */
  it("v: 0 明文信封：私有来源接受，公网来源拒绝", async () => {
    app = await startServer();
    // 测试服务跑在 127.0.0.1 ⇒ 私有来源 ⇒ 接受
    const res = await api<{ sessionId: string }>(app.baseUrl, "POST", "/api/llm-credentials", {
      envelope: { v: 0, plain: { apiKey: "sk-lan", model: "m" } },
    });
    expect(typeof res.sessionId).toBe("string");

    // 判定函数本身：公网 IP / 公网域名一律 false
    expect(allowsPlaintextCredentials({ ip: "203.0.113.9", hostname: "sim.example.com" })).toBe(false);
    expect(allowsPlaintextCredentials({ ip: "::ffff:192.168.1.9", hostname: "192.168.1.9:8190" })).toBe(true);
    expect(allowsPlaintextCredentials({ ip: "127.0.0.1", hostname: "localhost:8190" })).toBe(true);
  });
});
