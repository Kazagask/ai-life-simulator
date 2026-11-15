import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { probeLlmConnectivity, scrub } from "./probe.js";

/**
 * 连通性探测的三态判定与**密钥不泄漏**（R2.8 · R-LLM-07）。
 *
 * 用本地 mock HTTP server 走真实 `fetch`：注入 stub fetch 会绕开 URL 拼接、header、
 * 超时信号这几处最容易写错的地方，测不出「真发生过一次请求」。
 */

/** 故意带 `sk-` 前缀：断言用的 key 本身也必须被 `sk-` 规则命中。 */
const API_KEY = "sk-test-abcdef1234567890";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
}

interface Mock {
  baseUrl: string;
  requests: CapturedRequest[];
}

/** 起一个 mock 端点；`handler` 拿到请求体后自行决定状态码 / 延迟 / 不回包。 */
async function startMock(
  handler: (req: CapturedRequest, res: import("node:http").ServerResponse) => void,
): Promise<Mock> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const captured: CapturedRequest = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(captured);
      handler(captured, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

function json(res: import("node:http").ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** 正向断言：整个响应体里既无 key 原文、也无 `sk-` 形态残留。 */
function expectNoLeak(result: unknown): void {
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(API_KEY);
  expect(serialized).not.toContain("sk-test");
  expect(serialized).not.toMatch(/sk-[A-Za-z0-9_-]{4,}/);
}

describe("probeLlmConnectivity", () => {
  it("连通：发出最小真实请求（max_tokens:1 / stream:false），返回 model 与延迟", async () => {
    const mock = await startMock((_req, res) => {
      json(res, 200, { choices: [{ message: { role: "assistant", content: "pong" } }] });
    });

    const result = await probeLlmConnectivity({ apiKey: API_KEY, model: "gpt-4o-mini", baseUrl: mock.baseUrl });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model).toBe("gpt-4o-mini");
      expect(typeof result.latencyMs).toBe("number");
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expectNoLeak(result);

    // 请求本身必须落在 /chat/completions，且是一次真正的最小调用。
    expect(mock.requests).toHaveLength(1);
    const request = mock.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/chat/completions");
    expect(request.authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.max_tokens).toBe(1);
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
  });

  it("baseUrl 尾部斜杠被剥掉（与真实调用同一判据），不会拼出 //chat/completions", async () => {
    const mock = await startMock((_req, res) => {
      json(res, 200, { choices: [{ message: { content: "ok" } }] });
    });

    await probeLlmConnectivity({ apiKey: API_KEY, model: "m", baseUrl: `${mock.baseUrl}//` });

    expect(mock.requests[0]?.url).toBe("/v1/chat/completions");
  });

  it("鉴权失败：401 ⇒ ok:false reason=unauthorized，且上游回显的 key 被抹掉", async () => {
    const mock = await startMock((_req, res) => {
      json(res, 401, {
        error: {
          type: "invalid_api_key",
          // 刁钻场景：provider 把 key 原文抄回错误体（真实上游常见回显尾号/原文）。
          message: `Incorrect API key provided: ${API_KEY}`,
        },
      });
    });

    const result = await probeLlmConnectivity({ apiKey: API_KEY, model: "m", baseUrl: mock.baseUrl });

    expect(result).toEqual({ ok: false, reason: "unauthorized", detail: "HTTP 401 (invalid_api_key)" });
    expectNoLeak(result);
  });

  it("超时：到点即返回 reason=timeout，detail 只有毫秒数", async () => {
    // 永不回包：探测必须自己踩刹车，而不是等 server 发善心。
    const mock = await startMock(() => {});

    const result = await probeLlmConnectivity(
      { apiKey: API_KEY, model: "m", baseUrl: mock.baseUrl },
      { timeoutMs: 60 },
    );

    expect(result).toEqual({ ok: false, reason: "timeout", detail: "timeout after 60ms" });
    expectNoLeak(result);
  });

  it("网络不可达：连接被拒 ⇒ reason=network", async () => {
    const mock = await startMock(() => {});
    const deadPort = new URL(mock.baseUrl).port;

    // 先把端口关掉，再打过去：唯一稳定的「确定性网络失败」构造方式。
    const server = servers.pop()!;
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });

    const result = await probeLlmConnectivity({
      apiKey: API_KEY,
      model: "m",
      baseUrl: `http://127.0.0.1:${deadPort}/v1`,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("network");
    expectNoLeak(result);
  });

  it("响应不可解析：200 但非 JSON ⇒ reason=bad_response", async () => {
    const mock = await startMock((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>gateway</html>");
    });

    const result = await probeLlmConnectivity({ apiKey: API_KEY, model: "m", baseUrl: mock.baseUrl });

    expect(result).toEqual({ ok: false, reason: "bad_response", detail: "HTTP 200 (invalid JSON)" });
    expectNoLeak(result);
  });

  it("上游错误 type 超长且含 key ⇒ detail ≤300 字符且零泄漏", async () => {
    const longType = `${API_KEY}-${"x".repeat(400)}`;
    const mock = await startMock((_req, res) => {
      json(res, 500, { error: { type: longType } });
    });

    const result = await probeLlmConnectivity({ apiKey: API_KEY, model: "m", baseUrl: mock.baseUrl });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("bad_response");
      expect(result.detail.length).toBeLessThanOrEqual(300);
    }
    expectNoLeak(result);
  });
});

describe("scrub", () => {
  it("抹掉 key 原文与一切 sk- 形态，压平空白并截断到 300 字符", () => {
    const dirty = `${API_KEY}\n\n  other sk-live-999999 ${"y".repeat(400)}`;
    const clean = scrub(dirty, API_KEY);

    expect(clean).not.toContain(API_KEY);
    expect(clean).not.toContain("sk-live-999999");
    expect(clean).not.toContain("y".repeat(300));
    expect(clean.length).toBeLessThanOrEqual(300);
    expect(clean.startsWith("[redacted]")).toBe(true);
  });
});
