import { describe, expect, it, vi } from "vitest";
import { stableStringify, type WorldStateV2 } from "@life-sim/shared";
import {
  createSyncQueue,
  isSyncOrigin,
  toSaveRow,
  toTemplateRow,
  toTraceRow,
} from "../../apps/web/src/cloudSync.ts";

/**
 * 云端同步的纯逻辑（ADR-071）：门禁判据、行构造、上行队列。
 *
 * 真正的网络链路只能在发布域 + 登录态下验证，所以这里守住「不发请求也该对」的那一半：
 * 判据、形状（尤其**不发送 owner_id**）、去重语义。
 */

describe("云同步 · 判据与形状", () => {
  it("只在发布域可用：localhost / 隧道一律 false", () => {
    expect(isSyncOrigin("https://cursed-wheel-life.app.workbuddy.host")).toBe(true);
    expect(isSyncOrigin("https://cursed-wheel-life.app.workbuddy.host/some/path")).toBe(true);
    expect(isSyncOrigin("http://localhost:3000")).toBe(false);
    expect(isSyncOrigin("https://random.trycloudflare.com")).toBe(false);
    expect(isSyncOrigin("not a url")).toBe(false);
  });

  it("存档行：payload 与索引同一条，且**不含 owner_id**", () => {
    const row = toSaveRow({
      worldId: "local-1",
      templateId: "jjk-2006",
      templateVersion: "3.0.0",
      fingerprint: "sha256:x",
      protocolVersion: 5,
      savedAt: "2026-11-22T10:00:00.000Z",
      turnIndex: 7,
      status: "running",
      worldName: "咒术回战",
      playerName: "七海",
      payload: { id: "local-1", turnIndex: 7 } as unknown as WorldStateV2,
      payloadSha256: "a".repeat(64),
      sizeBytes: 1024,
      updatedAt: "2026-11-22T10:00:01.000Z",
    });
    expect("owner_id" in row).toBe(false);
    expect(row.world_id).toBe("local-1");
    expect(row.turn_index).toBe(7);
    expect(row.payload).toEqual({ id: "local-1", turnIndex: 7 });
    expect(row.visibility).toBe("private");
  });

  it("模板行：整包一格，指纹与传输哈希是两件事", () => {
    const pkg = {
      templateId: "jjk-2006",
      version: "3.0.0",
      fingerprint: "sha256:y",
      files: { "world.yaml": "abc", "lore.md": "de" },
    };
    const row = toTemplateRow(pkg);
    // size_bytes 是**整包**（要存进 jsonb 的那份）的 UTF-8 字节数，不是各文件正文之和。
    expect(row.size_bytes).toBe(new TextEncoder().encode(stableStringify(pkg)).length);
    expect(row.payload?.files["lore.md"]).toBe("de");
    expect(row.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.fingerprint).toBe("sha256:y");
  });

  it("trace 行：save_id / save_sha256 锚到具体那一版存档", () => {
    const row = toTraceRow({
      worldId: "w",
      turnIndex: 3,
      invocationId: "inv-1",
      trace: { outcome: "committed" },
      saveId: 42,
      saveSha256: "b".repeat(64),
    });
    expect(row.save_id).toBe(42);
    expect(row.save_sha256).toBe("b".repeat(64));
    expect(row.invocation_id).toBe("inv-1");
    expect(row.turn_index).toBe(3);
    expect(row.trace_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("trace 没有存档时 two anchors 为 null（LLM 失败 / 还没写档）", () => {
    const row = toTraceRow({ worldId: "w", turnIndex: 1, invocationId: "inv-2", trace: {} });
    expect(row.save_id).toBeNull();
    expect(row.save_sha256).toBeNull();
  });
});

describe("云同步 · 上行队列", () => {
  it("同一个键只留最后一条；发送按入队顺序串行", async () => {
    const sent: string[] = [];
    const queue = createSyncQueue<string>(async (item) => {
      sent.push(item);
      return true;
    }, (item) => item.split(":")[0]!);

    queue.push("a:1");
    queue.push("a:2");
    queue.push("b:1");
    await queue.idle();

    expect(sent).toContain("b:1");
    expect(sent.at(-1)).toBe("b:1");
    // a 的中间态被折叠，但最后一次一定在
    expect(sent).toContain("a:2");
    expect(sent).not.toContain("a:1");
    expect(queue.pending()).toBe(0);
  });

  it("单条失败不阻断后续（云端不可用不该卡住本地）", async () => {
    const ok = vi.fn(async (item: string) => {
      if (item === "bad") throw new Error("offline");
      return true;
    });
    const queue = createSyncQueue<string>(ok, (item) => item);
    queue.push("bad");
    queue.push("good");
    await queue.idle();
    expect(ok).toHaveBeenCalledWith("good");
  });
});
