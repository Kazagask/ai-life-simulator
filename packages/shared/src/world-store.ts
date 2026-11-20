/**
 * 存档存储接口（本地化迁移 · 第一期，2026-11-21）。
 *
 * 只搬**字节**，不判断「这份档能不能载入」：
 * 信封解析、`schemaVersion`、模板版本解析、语义指纹比对、state schema ——
 * 全部留在 store 之上的 `loadPersistedWorlds`。理由：判定只有一处，
 * 换存储（fs → IndexedDB）不该连带抄一遍拒载逻辑。
 *
 * 约定：
 * - `id` 是世界 id（= 文件名基名），调用方保证不含路径分隔符；
 * - `write` 必须是**原子**的（fs: tmp + rename；IndexedDB: 单事务），
 *   半截文件比丢一次保存更糟；
 * - `list` 只返回**存档文件**，不含 trace / 临时文件；
 * - 读不到 / 不存在都返回 `undefined`，不抛错（错误分类由上层做）。
 */
export interface WorldStoreEntry {
  id: string;
  /** 原始文本。解析留给上层 —— 解析失败要能报「哪个文件坏了」。 */
  raw: string;
}

export interface WorldStore {
  list(): readonly WorldStoreEntry[];
  read(id: string): string | undefined;
  has(id: string): boolean;
  /** 原子写；失败抛错，不吞异常。 */
  write(id: string, raw: string): void;
  /** 删掉一份存档；返回是否真的删了。 */
  remove(id: string): boolean;
}

/**
 * 内存实现：测试与「客户端预热」共用。
 *
 * 与 fs 语义保持一致：`write` 覆盖、`remove` 幂等返回布尔、`list` 按 id 排序
 * （fs 的 `readdir` 顺序不保证，排序放在实现里，调用方不必自己排）。
 */
export class MemoryWorldStore implements WorldStore {
  private readonly files = new Map<string, string>();

  list(): readonly WorldStoreEntry[] {
    return [...this.files.entries()]
      .map(([id, raw]) => ({ id, raw }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  read(id: string): string | undefined {
    return this.files.get(id);
  }

  has(id: string): boolean {
    return this.files.has(id);
  }

  write(id: string, raw: string): void {
    this.files.set(id, raw);
  }

  remove(id: string): boolean {
    return this.files.delete(id);
  }
}
