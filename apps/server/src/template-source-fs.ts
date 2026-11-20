import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  normalizeTemplateRel,
  type TemplateSource,
  type TemplateSourceEntry,
} from "@life-sim/shared";

/**
 * `TemplateSource` 的服务端实现（本地化迁移 · 第一期）。
 *
 * 这一层只做「相对路径 → 磁盘」的翻译，不做任何模板判定。目录扫描（版本发现、mtime、
 * 资产）仍由 `templates.ts` 直接读 fs —— 那是**服务端适配器**的职责，等第二期做客户端
 * 下载时再拆。
 */
export class FsTemplateSource implements TemplateSource {
  constructor(private readonly root: string) {}

  /** 绝对路径（给仍需直接读盘的资产扫描用；声明式加载不该调它）。 */
  abs(rel: string): string {
    return path.join(this.root, normalizeTemplateRel(rel));
  }

  list(relDir: string): readonly TemplateSourceEntry[] {
    const dir = this.abs(relDir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .map((entry) => ({
        rel: entry.name,
        kind: entry.isDirectory() ? ("dir" as const) : ("file" as const),
      }))
      .sort((a, b) => a.rel.localeCompare(b.rel));
  }

  read(rel: string): string {
    const file = this.abs(rel);
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      throw new Error(
        `template_source_unreadable: ${normalizeTemplateRel(rel)}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
  }

  exists(rel: string): boolean {
    return existsSync(this.abs(rel));
  }
}
