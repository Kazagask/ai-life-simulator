/**
 * 模板文件源（本地化迁移 · 第一期，2026-11-21）。
 *
 * 为什么要有这一层：加载器的**判定**（合并分域 → schema 校验 → 交叉引用 → 语义指纹）
 * 与「文件从哪儿来」是两件事。服务端读磁盘、浏览器读 fetch/IndexedDB 都只是换一个实现，
 * 判定逻辑一个字都不该改。
 *
 * 约定：
 * - 路径一律用**模板版本目录内的相对路径**（`world.yaml`、`assets/manifest.yaml`），
 *   分隔符固定 `/`，不带前导 `./`，不做 Windows 反斜杠转换。
 * - `list("")` 返回版本目录的**一层**子项；`list("assets")` 才返回 assets 下的子项。
 *   不做递归 —— 递归由调用方按需展开（资产扫描目前仍走服务端 fs）。
 * - `read` 只接受文件；读不到属于模板损坏，直接抛错（不返回 undefined）。
 * - 实现可以是同步的（fs）也可以是预热的（内存 / IndexedDB 缓存）。接口不承诺异步，
 *   因为加载器整条链是同步的；浏览器侧在拿到字节后先建好内存源即可。
 */
export interface TemplateSourceEntry {
  /** 相对版本目录的路径，例如 `world.yaml` / `assets/characters/x.png`。 */
  rel: string;
  kind: "file" | "dir";
}

export interface TemplateSource {
  /** 列**一层**子项；目录不存在 ⇒ 空数组（不抛错，由调用方判断「空版本目录」）。 */
  list(relDir: string): readonly TemplateSourceEntry[];
  /** 读一个文件；不存在 ⇒ 抛错。 */
  read(rel: string): string;
  /** 文件或目录是否存在。 */
  exists(rel: string): boolean;
}

/** 归一化相对路径：去掉前导 `./`、把反斜杠折成 `/`、去掉尾随 `/`。 */
export function normalizeTemplateRel(rel: string): string {
  let out = rel.replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/**
 * 内存实现：测试与「客户端预下载」共用。
 *
 * 只接受文本文件 —— 资产是二进制，这一期不进这个源（`assets/**` 的指纹与清单仍由服务端 fs 适配器
 * 负责；第二期做资产下载时会另开二进制通道）。
 */
export class MemoryTemplateSource implements TemplateSource {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>([""]);

  constructor(files: Readonly<Record<string, string>> | ReadonlyMap<string, string>) {
    const entries = files instanceof Map ? files.entries() : Object.entries(files);
    for (const [rel, content] of entries) {
      const key = normalizeTemplateRel(rel);
      this.files.set(key, content);
      // 补齐所有祖先目录，list() 才能像 fs 一样逐层列出。
      const parts = key.split("/");
      for (let i = 1; i < parts.length; i += 1) {
        this.dirs.add(parts.slice(0, i).join("/"));
      }
    }
  }

  list(relDir: string): readonly TemplateSourceEntry[] {
    const dir = normalizeTemplateRel(relDir);
    if (dir !== "" && !this.dirs.has(dir)) return [];
    const prefix = dir === "" ? "" : dir + "/";
    const seen = new Set<string>();
    const out: TemplateSourceEntry[] = [];
    for (const key of [...this.files.keys(), ...this.dirs]) {
      if (key === "" || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest === "" || rest.includes("/")) continue;
      if (seen.has(rest)) continue;
      seen.add(rest);
      out.push({ rel: rest, kind: this.files.has(key) ? "file" : "dir" });
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  read(rel: string): string {
    const key = normalizeTemplateRel(rel);
    const content = this.files.get(key);
    if (content === undefined) throw new Error(`template_source_missing: ${key}`);
    return content;
  }

  exists(rel: string): boolean {
    const key = normalizeTemplateRel(rel);
    return this.files.has(key) || this.dirs.has(key);
  }
}
