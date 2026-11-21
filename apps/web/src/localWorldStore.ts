import type { WorldStateV2 } from "@life-sim/shared";
import { createIndexedDbStore, STORE_WORLDS } from "./idb";

/**
 * 浏览器侧的本地世界记录（ADR-070 第二期）。
 *
 * 刻意**不是**服务端信封的翻版：服务端信封带 `schemaVersion` / `templateFingerprint` 的
 * 拒载判定，那套判定仍归 `store` 层。这里只回答「这个世界的状态存在本机哪里」，
 * `formatVersion` 是**本地存储格式**的版本，不是存档协议版本。
 *
 * 等 `WorldStore` 接口异步化（与引擎进浏览器同一刀），这份记录就是 IndexedDB 适配器的
 * 最小数据形状。
 */
export interface LocalWorldRecord {
  id: string;
  /** 本地存储格式版本（不是存档 `schemaVersion`）。 */
  formatVersion: 1;
  savedAt: string;
  templateId: string;
  templateVersion: string;
  /** 语义指纹：模板换过 ⇒ 本地世界不可再续（与旧档拒载同一条纪律）。 */
  templateFingerprint: string;
  state: WorldStateV2;
}

const store = createIndexedDbStore(STORE_WORLDS);

export async function saveLocalWorld(record: LocalWorldRecord): Promise<void> {
  await store.put(record.id, record);
}

export async function loadLocalWorld(id: string): Promise<LocalWorldRecord | undefined> {
  return (await store.get(id)) as LocalWorldRecord | undefined;
}

export async function listLocalWorldIds(): Promise<string[]> {
  return store.keys();
}
