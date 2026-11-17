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

const files = sourceFiles(SRC_DIR).map((full) => ({
  name: path.relative(SRC_DIR, full).split(path.sep).join("/"),
  text: readFileSync(full, "utf8"),
}));

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
