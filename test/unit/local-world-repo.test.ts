import { describe, expect, it } from "vitest";
import type { WorldStateV2 } from "@life-sim/shared";
import type { KeyValueStore } from "../../apps/web/src/idb.ts";
import {
  createIndexedWorldRepo,
  createMemoryWorldRepo,
  isDrifted,
  isLocalWorldRecord,
  type LocalWorldRecord,
} from "../../apps/web/src/local/worldRepo.ts";

/**
 * T2：本地世界仓库（ADR-070 第三期）。
 *
 * 守三件事：
 * 1. 仓库只搬字节 —— 坏记录被跳过，不让列表整体打不开；
 * 2. 降级不抛错 —— IndexedDB 不可用时用内存实现，UI 拿到的是"空"而不是异常；
 * 3. 指纹漂移是读出来的事实，不是仓库状态。
 */

const state = { id: "w1", turnIndex: 3 } as unknown as WorldStateV2;

function recordOf(id: string, savedAt: string, fingerprint = "sha256:aa"): LocalWorldRecord {
  return {
    id,
    formatVersion: 1,
    savedAt,
    ref: { id: "jjk-2006", version: "3.0.0" },
    fingerprint,
    state,
  };
}

/** 假的键值存储：与 IndexedDB 适配器同一契约（get/put/delete/keys）。 */
function fakeStore(initial: Record<string, unknown> = {}): KeyValueStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    map,
    get: async (key) => map.get(key),
    put: async (key, value) => {
      map.set(key, value);
    },
    delete: async (key) => {
      map.delete(key);
    },
    keys: async () => [...map.keys()],
  };
}

describe("本地世界仓库", () => {
  it("内存实现：写入 / 读回 / 删除 / 按 savedAt 倒序", async () => {
    const repo = createMemoryWorldRepo();
    await repo.write(recordOf("a", "2026-11-21T10:00:00.000Z"));
    await repo.write(recordOf("b", "2026-11-21T12:00:00.000Z"));
    expect((await repo.list()).map((r) => r.id)).toEqual(["b", "a"]);
    expect((await repo.read("a"))?.state).toEqual(state);
    await repo.remove("a");
    expect(await repo.read("a")).toBeUndefined();
  });

  it("IndexedDB 实现：读写删走同一契约，列表排序与内存实现一致", async () => {
    const store = fakeStore();
    const repo = createIndexedWorldRepo(store);
    await repo.write(recordOf("a", "2026-11-21T10:00:00.000Z"));
    await repo.write(recordOf("b", "2026-11-21T12:00:00.000Z"));
    expect((await repo.list()).map((r) => r.id)).toEqual(["b", "a"]);
    await repo.remove("b");
    expect(store.map.has("b")).toBe(false);
  });

  it("坏记录被跳过：一条脏数据不该让整个列表打不开", async () => {
    const store = fakeStore({
      good: recordOf("good", "2026-11-21T10:00:00.000Z"),
      legacy: { id: "legacy", formatVersion: 0 },
      junk: "not-a-record",
    });
    const repo = createIndexedWorldRepo(store);
    expect((await repo.list()).map((r) => r.id)).toEqual(["good"]);
    expect(await repo.read("legacy")).toBeUndefined();
    expect(await repo.read("junk")).toBeUndefined();
  });

  it("IndexedDB 不存在（单测环境）：缺省实现退化为空仓库，不抛错", async () => {
    const repo = createIndexedWorldRepo();
    await expect(repo.list()).resolves.toEqual([]);
    await expect(repo.read("nope")).resolves.toBeUndefined();
  });

  it("指纹漂移是读出来的判据，不是仓库状态", async () => {
    const repo = createMemoryWorldRepo([recordOf("a", "2026-11-21T10:00:00.000Z", "sha256:old")]);
    const record = (await repo.read("a"))!;
    expect(isDrifted(record, "sha256:old")).toBe(false);
    expect(isDrifted(record, "sha256:new")).toBe(true);
  });

  it("形状校验：formatVersion 不是 1 的一律不认（旧形状不许当新档读）", () => {
    expect(isLocalWorldRecord(recordOf("a", "2026-11-21T10:00:00.000Z"))).toBe(true);
    expect(isLocalWorldRecord({ ...recordOf("a", "x"), formatVersion: 2 })).toBe(false);
    expect(isLocalWorldRecord({ ...recordOf("a", "x"), ref: undefined })).toBe(false);
  });
});
