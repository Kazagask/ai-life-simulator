import type { WorldStateV2 } from "@life-sim/shared";
import { createIndexedDbStore, STORE_WORLDS, type KeyValueStore } from "../idb";

/**
 * 本地世界仓库（ADR-070 第三期 · T2）。
 *
 * 为什么**不复用** `@life-sim/shared` 的 `WorldStore`：那个接口是**同步**的（fs 语义），
 * IndexedDB 是异步。为了让客户端能存，把服务端 10 个调用点全改成 `await` 是纯亏 ——
 * 两边各留一个接口，判定（信封 / 版本 / 指纹 / schema）都在**调用方**，与 ADR 同一条纪律。
 *
 * 三条边界：
 * - 只搬字节：`read` 不判断「这个档还能不能玩」，只判断「这条记录是不是这个仓库的形状」。
 * - 不可用即降级：IndexedDB 不存在 / 打开失败 ⇒ 内存实现，行为等价于「这次会话里能玩，
 *   刷新即丢」，绝不抛给 UI。
 * - 指纹漂移是**读出来的事实**：`isDrifted(record, currentFingerprint)` 由调用方在拿到
 *   当前模板指纹后判，仓库不缓存「当前模板是谁」。
 */

export interface LocalWorldRecord {
  id: string;
  /** 本地信封版本：形状变了才升，与 `schemaVersion`（世界状态协议）不是一件事。 */
  formatVersion: 1;
  /** 最后一次本地写入时间（ISO）。冲突裁决用它。 */
  savedAt: string;
  ref: { id: string; version: string };
  /** 建局时模板的语义指纹：与当前模板不同 ⇒ 这档要按旧模板拒载，不许静默按新模板解释。 */
  fingerprint: string;
  /**
   * 指纹算法版本（2026-11-24）：
   * - 缺省 / 1 = 旧算法（语义指纹**含** `assets/manifest.yaml`）；
   * - 2 = 新算法（不含 manifest，见 `semanticFingerprintOf`）。
   *
   * 只有旧档需要走「双哈希」兼容通道；升级一次之后就只校验 v2。
   */
  fingerprintVersion?: number;
  state: WorldStateV2;
  /** 最后一次成功同步到远端的时刻；缺省 = 从没同步过（纯本地档）。 */
  syncedAt?: string;
}

export interface LocalWorldRepo {
  list(): Promise<LocalWorldRecord[]>;
  read(id: string): Promise<LocalWorldRecord | undefined>;
  write(record: LocalWorldRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

/** 记录形状校验：IndexedDB 里可能躺着上一版形状 / 别人的键，读不出来就当没有。 */
export function isLocalWorldRecord(value: unknown): value is LocalWorldRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<LocalWorldRecord>;
  return (
    typeof record.id === "string" &&
    record.formatVersion === 1 &&
    typeof record.savedAt === "string" &&
    typeof record.fingerprint === "string" &&
    typeof record.ref === "object" &&
    record.ref !== null &&
    typeof record.ref.id === "string" &&
    typeof record.ref.version === "string" &&
    typeof record.state === "object" &&
    record.state !== null
  );
}

/** 指纹漂移判据：唯一实现点（服务端拒载用的是同一个事实，只是文案不同）。 */
export function isDrifted(record: LocalWorldRecord, currentFingerprint: string): boolean {
  return record.fingerprint !== currentFingerprint;
}

/** 当前算法版本。写档时打上，读档时据此决定要不要走 legacy 兼容。 */
export const FINGERPRINT_VERSION = 2;

/**
 * 旧档兼容判据（2026-11-24）。
 *
 * 返回 `"ok"`（指纹已对上）/ `"upgrade"`（旧算法命中，需要就地升级）/ `"drift"`。
 *
 * **安全性依据**：`"upgrade"` 成立的条件是「存档值 == 当前模板用**同一套旧算法**算出的值」，
 * 说明当前模板在旧算法眼里就是当年那份；旧算法覆盖的是机制文件 + manifest 的**超集**
 * ⇒ 机制文件逐个未变 ⇒ 不会放行真实漂移。
 *
 * 带 `fingerprintVersion: 2` 的档**只**走 v2 比较，不再回落 legacy —— 双哈希只是一次性通道。
 */
export function fingerprintVerdict(
  record: LocalWorldRecord,
  current: { v2: string; legacy?: string },
): "ok" | "upgrade" | "drift" {
  const version = record.fingerprintVersion;
  /**
   * 未知版本（未来版 / 脏数据）⇒ **拒载**，不猜、不降级。
   * 版本只能加，不能往回解释；否则「新档被旧算法重新打标」会掩盖真正的漂移。
   */
  if (version !== undefined && version !== 1 && version !== FINGERPRINT_VERSION) return "drift";

  if (version === FINGERPRINT_VERSION) {
    // 已升级过的档：只认 v2。值不对就是漂移，不再回落 legacy。
    return record.fingerprint === current.v2 ? "ok" : "drift";
  }

  /**
   * 未标记版本（旧档）：
   * - 值已经是 v2（可能上次升级写了一半 / 老档本来就没有 manifest）⇒ 仍返回 `upgrade`，
   *   让调用方补写 `fingerprintVersion: 2`。**不返回 ok** —— 否则这条档永远不带版本号，
   *   双哈希通道会一直开着。
   * - 值是 legacy ⇒ `upgrade`；都不命中 ⇒ `drift`。
   */
  if (record.fingerprint === current.v2) return "upgrade";
  if (current.legacy !== undefined && record.fingerprint === current.legacy) return "upgrade";
  return "drift";
}

/** 把一条旧档就地升级成新指纹（只改指纹字段，不动 state）。 */
export function upgradeRecord(record: LocalWorldRecord, v2: string): LocalWorldRecord {
  return { ...record, fingerprint: v2, fingerprintVersion: FINGERPRINT_VERSION };
}

/** 列表排序：`savedAt` 倒序（与 `GET /api/worlds` 同口径），同刻按 id 稳定。 */
function sortRecords(records: LocalWorldRecord[]): LocalWorldRecord[] {
  return records.sort((a, b) =>
    a.savedAt === b.savedAt ? a.id.localeCompare(b.id) : a.savedAt < b.savedAt ? 1 : -1,
  );
}

/** 内存实现：单测默认 / IndexedDB 不可用时的降级。 */
export function createMemoryWorldRepo(seed: readonly LocalWorldRecord[] = []): LocalWorldRepo {
  const map = new Map<string, LocalWorldRecord>(seed.map((record) => [record.id, record]));
  return {
    list: async () => sortRecords([...map.values()]),
    read: async (id) => map.get(id),
    write: async (record) => {
      map.set(record.id, record);
    },
    remove: async (id) => {
      map.delete(id);
    },
  };
}

/**
 * IndexedDB 实现（缺省用 `life-sim-local` 的 `worlds` 仓库）。
 *
 * 写入用 `structuredClone` 友好的原对象；读取时逐条过形状校验 —— 一条坏记录不该
 * 让整个列表打不开（宁可少一档，也不要白屏）。
 */
export function createIndexedWorldRepo(store: KeyValueStore = createIndexedDbStore(STORE_WORLDS)): LocalWorldRepo {
  return {
    list: async () => {
      const keys = await store.keys();
      const records: LocalWorldRecord[] = [];
      for (const key of keys) {
        const value = await store.get(key);
        if (isLocalWorldRecord(value)) records.push(value);
      }
      return sortRecords(records);
    },
    read: async (id) => {
      const value = await store.get(id);
      return isLocalWorldRecord(value) ? value : undefined;
    },
    write: async (record) => {
      await store.put(record.id, record);
    },
    remove: async (id) => {
      await store.delete(id);
    },
  };
}
