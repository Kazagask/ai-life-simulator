import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_JSON = path.resolve(SRC_DIR, "../package.json");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const rel = (file: string): string => path.relative(SRC_DIR, file).replace(/\\/g, "/");
const isTestFile = (file: string): boolean => file.endsWith(".min.test.ts");
const isTestOnlyHelper = (file: string): boolean => rel(file).startsWith("testing/");

/** 生产代码 = 非测试、非测试夹具的 .ts。 */
const productionFiles = (): string[] =>
  sourceFiles(SRC_DIR).filter((file) => !isTestFile(file) && !isTestOnlyHelper(file));

describe("源码守卫", () => {
  it("本包绝不 import apps/server（反向依赖守卫）", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const text = readFileSync(file, "utf8");
      if (/from\s+["'][^"']*apps\/server/.test(text) || /["']@life-sim\/server["']/.test(text)) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("生产代码里没有对 WorldStateV2 字段的赋值（唯一写入口是 engineApi.dispatch）", () => {
    // 只针对「持有 WorldStateV2 的接收者」：state / worldState / this.state。
    const forbidden =
      /\b(state|worldState|this\.state)\.[A-Za-z0-9_[\]]+\s*=[^=]/;
    const offenders: Array<{ file: string; line: string }> = [];
    for (const file of productionFiles()) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (forbidden.test(line)) offenders.push({ file: rel(file), line: `${index + 1}: ${line.trim()}` });
      });
    }
    expect(offenders).toEqual([]);
  });

  it("生产代码不出现 state.x = 形式的裸写", () => {
    const offenders: string[] = [];
    for (const file of productionFiles()) {
      const text = readFileSync(file, "utf8");
      if (/\bstate\.[A-Za-z0-9_[\]]+\s*=[^=]/.test(text)) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  it("运行时依赖仍只有 shared / game-core / zod（无新增运行时依赖）", () => {
    const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      "@life-sim/game-core",
      "@life-sim/shared",
      "zod",
    ]);
    // YAML 仅在测试里读模板，必须留在 devDependencies。
    expect(pkg.dependencies?.yaml).toBeUndefined();
    expect(pkg.devDependencies?.yaml).toBeDefined();
  });

  /**
   * ADR-0038 D10 / D2：`contextHints` 是自由文本标签通道，**零解释**。
   *
   * 本清单只覆盖 `evt:`；`asset:`（曾位于 `mock.ts` 的 `hint.startsWith("asset:")`）
   * 是同类残留，已按 B-40 于本轮删除，删除后 mock 不再发 `content.referenceAsset`。
   *
   * 白名单（`evt:` / `branch:` 的形状判断）只允许出现在 `providers/legacy-hint.ts` ——
   * 那里是唯一的过渡兼容单点，且**不接线**。散在第二个地方，守卫立刻红。
   */
  const LEGACY_HINT_FILE = "providers/legacy-hint.ts";

  it("形状判断只准在 legacy-hint.ts：其余生产代码不得出现 startsWith(\"evt:\"/\"branch:\")", () => {
    const offenders: Array<{ file: string; line: string }> = [];
    const shape = /startsWith\(\s*["'](?:evt:|branch:)/;
    for (const file of productionFiles()) {
      if (rel(file) === LEGACY_HINT_FILE) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (shape.test(line)) offenders.push({ file: rel(file), line: `${index + 1}: ${line.trim()}` });
        });
    }
    expect(offenders).toEqual([]);
  });

  it("legacy-hint 的解析器除自身文件外零引用（「临时兼容」不能悄悄复活）", () => {
    const offenders: string[] = [];
    const SELF = "guards.min.test.ts";
    for (const file of sourceFiles(SRC_DIR)) {
      const name = rel(file);
      if (name === LEGACY_HINT_FILE || name === SELF) continue;
      if (/parseLegacyBranchHint/.test(readFileSync(file, "utf8"))) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
