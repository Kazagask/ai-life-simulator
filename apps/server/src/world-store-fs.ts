import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { WorldStore, WorldStoreEntry } from "@life-sim/shared";

/**
 * `WorldStore` 的 fs 实现（本地化迁移 · 第一期）。
 *
 * 目录与文件格式**零迁移**：默认仓库根 `data/worlds/`，一局一文件 `<worldId>.json`，
 * `LIFE_SIM_DATA_DIR` 可覆盖为任意绝对路径（挂载 / 测试）。
 *
 * 原子写：同目录 `.tmp` + `rename`；失败删 tmp 并把错误抛给调用方（不吞异常）。
 * rename 只在同分区保证原子 —— tmp 必须与目标同目录，这条别改。
 */

/** 数据目录：默认仓库根 `data/worlds/`（按模块位置解析，不依赖 cwd）。 */
export function dataDir(): string {
  const override = process.env.LIFE_SIM_DATA_DIR;
  if (override && override.trim() !== "") return path.resolve(override);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data/worlds");
}

/** 世界 id 的防御性校验：id 是 randomUUID，但不信任任何外部输入。 */
export function assertWorldId(id: string): void {
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`invalid_world_id: ${id}`);
  }
}

export class FsWorldStore implements WorldStore {
  /** 显式传目录（测试）；缺省按 `dataDir()` **惰性**解析 —— `LIFE_SIM_DATA_DIR` 在启动前设置。 */
  constructor(private readonly dirOverride?: string) {}

  private get dir(): string {
    return this.dirOverride ?? dataDir();
  }

  /** 绝对路径（admin / trace 写入需要按 id 定位）。 */
  fileOf(id: string): string {
    assertWorldId(id);
    return path.join(this.dir, `${id}.json`);
  }

  list(): readonly WorldStoreEntry[] {
    if (!existsSync(this.dir)) return [];
    const out: WorldStoreEntry[] = [];
    for (const fileName of readdirSync(this.dir)) {
      if (!fileName.endsWith(".json")) continue; // 跳过 <id>.json.tmp 等中间文件
      const id = fileName.slice(0, -".json".length);
      let raw: string;
      try {
        raw = readFileSync(path.join(this.dir, fileName), "utf-8");
      } catch {
        // 读不了的文件仍然要出现在列表里（上层会判 envelope_json_invalid），
        // 用空串代表「存在但读不出」，detail 里会带上文件路径。
        raw = "";
      }
      out.push({ id, raw });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  read(id: string): string | undefined {
    const file = this.fileOf(id);
    try {
      return readFileSync(file, "utf-8");
    } catch {
      return undefined;
    }
  }

  has(id: string): boolean {
    return existsSync(this.fileOf(id));
  }

  write(id: string, raw: string): void {
    const target = this.fileOf(id);
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${target}.tmp`;
    try {
      writeFileSync(tmp, raw, "utf-8");
      renameSync(tmp, target);
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // 清理失败不掩盖原错误
      }
      throw error;
    }
  }

  remove(id: string): boolean {
    const file = this.fileOf(id);
    if (!existsSync(file)) return false;
    unlinkSync(file);
    return true;
  }
}
