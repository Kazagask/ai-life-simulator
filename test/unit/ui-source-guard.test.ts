import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `@life-sim/rpg-ui` 的源码守卫。
 *
 * 这个包是**可被自定义前端复用**的展示层：一旦某个组件 import 了引擎快照类型或宿主的
 * api/store，复用就断了（对方被迫连引擎一起引入），字段改名也会同时改到组件。
 * 所以用一条静态扫描把红线焊死，而不是靠评审记得。
 *
 * 唯一允许碰引擎快照的是 `adapter.ts`（快照 → ViewModel 的搬运只有这一处）。
 */

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/rpg-ui/src");
const EXT_UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../extensions/family/src/ui");
const ADAPTER = "adapter.ts";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function read(dir: string): Array<{ name: string; text: string }> {
  return sourceFiles(dir).map((full) => ({
    name: path.relative(dir, full).split(path.sep).join("/"),
    text: readFileSync(full, "utf8"),
  }));
}

const files = read(SRC_DIR);

describe("rpg-ui 源码守卫", () => {
  it("除 adapter.ts 外，组件源码不出现引擎快照类型 V2Snapshot", () => {
    const offenders = files.filter((f) => f.name !== ADAPTER && f.text.includes("V2Snapshot")).map((f) => f.name);
    expect(offenders).toEqual([]);
    // 反向控制：adapter 里**确实**有它 —— 否则这条守卫可能是因为扫描路径错了而空转。
    expect(files.some((f) => f.name === ADAPTER && f.text.includes("V2Snapshot"))).toBe(true);
  });

  it("不 import 宿主 api / store，也不在组件里发请求（组件只吃 props）", () => {
    const offenders = files
      .filter((f) => /from\s+["']\.\.\/api["']/.test(f.text) || /from\s+["']@life-sim\/web/.test(f.text) || /\bfetch\s*\(/.test(f.text))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it("只依赖 shared 的类型与 react，不 import 服务端 / 引擎实现包", () => {
    const allowed = /^(@life-sim\/shared|react|react-dom|\.{1,2}\/)/;
    const offenders: string[] = [];
    for (const file of files) {
      for (const match of file.text.matchAll(/^\s*import[^;]*?from\s+["']([^"']+)["']/gm)) {
        const spec = match[1] ?? "";
        if (!allowed.test(spec)) offenders.push(`${file.name} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * 扩展自带前端的边界（`docs/EXTENSIONS.md` §7.1 第 2 条）。
 *
 * 组件搬进 `extensions/family/src/ui` 之后，**可以**读 `vm.extensions.family`（那是它自己的
 * 切片），但红线不变：不许碰引擎快照 `V2Snapshot`、不许碰宿主 api/store、不许自己发请求。
 * 与 rpg-ui 的守卫分开写，是因为两个包的允许清单不同（扩展可以依赖宿主 UI 包与 zod）。
 */
describe("扩展前端（family）源码守卫", () => {
  const extFiles = read(EXT_UI_DIR);

  it("不出现引擎快照类型 V2Snapshot —— 扩展只拿 vm.extensions.family 这一格", () => {
    const offenders = extFiles.filter((f) => f.text.includes("V2Snapshot")).map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it("不 import 宿主 api / store，也不在组件里发请求（组件只吃 vm）", () => {
    const offenders = extFiles
      .filter((f) => /from\s+["']\.\.\/api["']/.test(f.text) || /from\s+["']@life-sim\/web/.test(f.text) || /\bfetch\s*\(/.test(f.text))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it("只依赖 shared / rpg-ui（槽类型） / react / zod 与相对路径", () => {
    const allowed = /^(@life-sim\/(shared|rpg-ui)|react|react-dom|zod|\.{1,2}\/)/;
    const offenders: string[] = [];
    for (const file of extFiles) {
      for (const match of file.text.matchAll(/^\s*import[^;]*?from\s+["']([^"']+)["']/gm)) {
        const spec = match[1] ?? "";
        if (!allowed.test(spec)) offenders.push(`${file.name} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
