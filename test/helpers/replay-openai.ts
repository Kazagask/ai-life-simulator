import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

export interface RecordedCall {
  tool: string;
  args: unknown;
}

export interface RecordedInvocation {
  invocationId: string;
  calls: RecordedCall[];
  contentBlocks?: Array<{ kind: string; text?: string }>;
}

export interface ReplayOpenAi {
  baseUrl: string;
  close: () => Promise<void>;
}

interface FakeOptions {
  /** 录制文件（一行一条 invocation）。 */
  fixture: string;
  /** 负向对照：不吐标签正文（用于 narrative_tag_missing）。 */
  noTag?: boolean;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 把录制的 trace 行按 invocationId 建表；录制文件来自 mock 真实跑的一局。 */
export function loadRecordedInvocations(fixture: string): RecordedInvocation[] {
  const text = readFileSync(path.resolve(fixture), "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RecordedInvocation);
}

function taggedContent(entry: RecordedInvocation): string {
  return (entry.contentBlocks ?? [])
    .filter((block) => block.kind === "narrative" && (block.text ?? "").length > 0)
    .map((block) => `<narrative-content>\n${block.text}\n</narrative-content>`)
    .join("\n");
}

function wireName(tool: string): string {
  return tool.replace(/\./g, "_");
}

function toolCallsFor(entry: RecordedInvocation): unknown[] {
  return entry.calls.map((call, index) => ({
    index,
    id: `call_${index}`,
    type: "function",
    function: { name: wireName(call.tool), arguments: JSON.stringify(call.args) },
  }));
}

/**
 * 起一个 OpenAI 兼容的假 provider：按请求体里的 `invocationId` 取录制结果。
 * 同一 invocation 第一次返回正文 + 工具调用，第二次返回空（让 loop 自然退出）。
 */
export async function startReplayOpenAi(options: FakeOptions): Promise<ReplayOpenAi> {
  const entries = loadRecordedInvocations(options.fixture);
  const byInvocation = new Map(entries.map((entry) => [entry.invocationId, entry]));
  const served = new Map<string, number>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.writeHead(404).end("not found");
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      res.writeHead(400).end("bad json");
      return;
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    let invocationId = "";
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = asRecord(messages[i]);
      if (message?.role !== "user" || typeof message.content !== "string") continue;
      try {
        const parsed = JSON.parse(message.content) as Record<string, unknown>;
        if (typeof parsed.invocationId === "string") invocationId = parsed.invocationId;
      } catch {
        // 非结构化 user 段（结局/总结）不参与记录回放
      }
      break;
    }

    const entry = byInvocation.get(invocationId);
    const used = served.get(invocationId) ?? 0;
    served.set(invocationId, used + 1);
    const first = used === 0 && entry !== undefined;
    const content = first
      ? options.noTag === true
        ? "这是一段没有标签的正文，不应进入玩家侧。"
        : taggedContent(entry)
      : "";
    const toolCalls = first && options.noTag !== true ? toolCallsFor(entry) : [];

    if (body.stream === true) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunkSize = 20;
      for (let i = 0; i < content.length; i += chunkSize) {
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: content.slice(i, i + chunkSize) } }],
          })}\n\n`,
        );
        // 模拟真实网络：同步全吐会让订阅者只看到合并后的一帧。
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      if (toolCalls.length > 0) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls } }] })}\n\n`);
      }
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }],
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              ...(content.length > 0 ? { content } : {}),
              ...(toolCalls.length > 0
                ? {
                    tool_calls: toolCalls.map((call) => {
                      const item = call as {
                        id: string;
                        type: string;
                        function: { name: string; arguments: string };
                      };
                      return { id: item.id, type: item.type, function: item.function };
                    }),
                  }
                : {}),
            },
            finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
