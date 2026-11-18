import { afterEach, describe, expect, it } from "vitest";
import { encryptCredentialPayload } from "../../apps/web/src/llmCrypto.ts";
import { api, startServer, type RunningServer } from "../helpers/server.ts";

/**
 * BACKLOG B-01：自定义 LLM 凭证走**非对称加密信封**。
 *
 * 这里直接 import **前端**的加密实现（`apps/web/src/llmCrypto.ts`），与服务端
 * `llm/credentialEnvelope.ts` 做真往返——只测服务端会用两端私钥/公钥漂移测不出来。
 * Node 22 自带 WebCrypto / atob，所以浏览器模块可以原样跑。
 */
describe("自定义 LLM 凭证：加密信封", () => {
  let app: RunningServer | undefined;

  afterEach(async () => {
    await app?.stop();
    app = undefined;
  });

  it("前端加密 → 服务端解密 → 换不透明 sessionId", async () => {
    app = await startServer();
    const envelope = await encryptCredentialPayload({ apiKey: "sk-test-abc", model: "test-model" });
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
    const envelope = await encryptCredentialPayload({ apiKey: "sk-test", model: "m" });
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
    const envelope = await encryptCredentialPayload({ apiKey: "sk-test" });
    await expect(api(app.baseUrl, "POST", "/api/llm-credentials", { envelope })).rejects.toThrow(/400/);
  });
});
