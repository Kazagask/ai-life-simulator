import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryWorldStore } from "@life-sim/shared";
import { FsWorldStore } from "../../apps/server/src/world-store-fs.ts";

/**
 * 存档存储接口（ADR-070 第一期）：只搬字节，不判断能不能载入。
 *
 * fs 适配器必须保持**现有目录与文件格式**（`<id>.json`，原子写），否则这一期就变成了
 * 数据迁移；内存实现要和 fs 语义一致（覆盖写、幂等删、按 id 排序），
 * 这样第二期的 IndexedDB 适配器只要照着这份用例实现就能对齐。
 */

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "life-sim-store-"));
}

describe("WorldStore · fs 适配器", () => {
  it("写读列删：格式不变，原始文本逐字节保留", () => {
    const dir = tempDir();
    const store = new FsWorldStore(dir);
    const raw = '{\n  "schemaVersion": 5,\n  "中文": "值"\n}';

    expect(store.has("w1")).toBe(false);
    store.write("w1", raw);

    expect(store.has("w1")).toBe(true);
    expect(store.read("w1")).toBe(raw);
    // 磁盘上就是这一个文件，内容与写入完全一致（缩进/中文都不重排）。
    expect(readdirSync(dir)).toEqual(["w1.json"]);
    expect(readFileSync(path.join(dir, "w1.json"), "utf8")).toBe(raw);

    expect(store.list().map((e) => e.id)).toEqual(["w1"]);
    expect(store.list()[0]?.raw).toBe(raw);

    expect(store.remove("w1")).toBe(true);
    expect(store.remove("w1")).toBe(false);
    expect(store.read("w1")).toBeUndefined();
  });

  it("覆盖写是原子的：写完不留 .tmp，也不进列表", () => {
    const dir = tempDir();
    const store = new FsWorldStore(dir);
    store.write("w1", "v1");
    store.write("w1", "v2");
    expect(store.read("w1")).toBe("v2");
    expect(readdirSync(dir)).toEqual(["w1.json"]);
    expect(store.list().map((e) => e.id)).toEqual(["w1"]);
  });

  it("只看 .json：trace 与中间文件不出现在列表里", () => {
    const dir = tempDir();
    const store = new FsWorldStore(dir);
    store.write("w1", "{}");
    writeFileSync(path.join(dir, "w1.trace.jsonl"), "line\n", "utf8");
    writeFileSync(path.join(dir, "w2.json.tmp"), "half", "utf8");
    // 非 JSON 的杂物也忽略
    writeFileSync(path.join(dir, "notes.txt"), "x", "utf8");

    expect(store.list().map((e) => e.id)).toEqual(["w1"]);
  });

  it("目录不存在：list 空、read undefined，不抛错", () => {
    const store = new FsWorldStore(path.join(tempDir(), "nope"));
    expect(store.list()).toEqual([]);
    expect(store.read("w1")).toBeUndefined();
    expect(store.has("w1")).toBe(false);
  });

  it("世界 id 里的路径分隔符一律拒绝", () => {
    const store = new FsWorldStore(tempDir());
    expect(() => store.read("../evil")).toThrow(/invalid_world_id/);
    expect(() => store.write("a/b", "{}")).toThrow(/invalid_world_id/);
  });

  it("列表按 id 排序（fs 的 readdir 顺序不保证）", () => {
    const dir = tempDir();
    const store = new FsWorldStore(dir);
    for (const id of ["c", "a", "b"]) store.write(id, "{}");
    expect(store.list().map((e) => e.id)).toEqual(["a", "b", "c"]);
  });
});

describe("WorldStore · 内存实现与 fs 语义一致", () => {
  it("覆盖写 / 幂等删 / 排序", () => {
    const store = new MemoryWorldStore();
    store.write("b", "1");
    store.write("a", "2");
    store.write("b", "3");
    expect(store.read("b")).toBe("3");
    expect(store.list().map((e) => e.id)).toEqual(["a", "b"]);
    expect(store.remove("b")).toBe(true);
    expect(store.remove("b")).toBe(false);
    expect(store.has("b")).toBe(false);
  });
});
