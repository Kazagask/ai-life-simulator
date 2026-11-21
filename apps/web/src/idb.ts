/**
 * IndexedDB 的最小封装（ADR-070 第二期）。
 *
 * 只做「键 → 任意可结构化克隆的值」的读写，不做 schema / 版本迁移策略：
 * 存档信封的兼容判定留在 `store` 之上（与 fs 适配器同一条纪律）。
 *
 * 三条边界：
 * - **不可用时静默降级**：隐私模式 / 老浏览器里 `indexedDB` 可能不存在或抛错，
 *   调用方拿到 `null` 就退回「每次都重新下载」，而不是白屏。
 * - **懒连接**：模块加载不碰 `indexedDB`（Node 里跑单测时没有这个全局）。
 * - **单事务**：`put` 是一个事务，写一半失败不会留下半份数据。
 */

const DB_NAME = "life-sim-local";
const DB_VERSION = 1;

/** 对象仓库名：模板包（现在用）/ 世界存档（引擎进浏览器时接）。 */
export const STORE_TEMPLATE_PACKAGES = "template-packages";
export const STORE_WORLDS = "worlds";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise !== null) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const name of [STORE_TEMPLATE_PACKAGES, STORE_WORLDS]) {
        if (!database.objectStoreNames.contains(name)) database.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

export interface KeyValueStore {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** 空实现：IndexedDB 不可用时用它，行为等价于「没有缓存」。 */
export const NULL_STORE: KeyValueStore = {
  get: async () => undefined,
  put: async () => {},
  delete: async () => {},
  keys: async () => [],
};

/** 事务包装：任何一步失败都回落成 `undefined` / 空，不把异常抛给 UI。 */
async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  const database = await openDb();
  if (database === null) return undefined;
  return new Promise((resolve) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(storeName, mode);
    } catch {
      resolve(undefined);
      return;
    }
    const request = run(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
    transaction.onabort = () => resolve(undefined);
  });
}

export function createIndexedDbStore(storeName: string): KeyValueStore {
  return {
    get: (key) => withStore(storeName, "readonly", (store) => store.get(key)),
    put: async (key, value) => {
      await withStore(storeName, "readwrite", (store) => store.put(value, key));
    },
    delete: async (key) => {
      await withStore(storeName, "readwrite", (store) => store.delete(key));
    },
    keys: async () => (await withStore(storeName, "readonly", (store) => store.getAllKeys()))?.map(String) ?? [],
  };
}
