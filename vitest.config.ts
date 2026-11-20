import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/** 测试只从包入口 import；alias 与根 tsconfig 的 paths 保持同一组。 */
export default defineConfig({
  resolve: {
    alias: {
      "@life-sim/shared": `${root}packages/shared/src/index.ts`,
      "@life-sim/game-core": `${root}packages/game-core/src/index.ts`,
      "@life-sim/agent-runtime": `${root}packages/agent-runtime/src/index.ts`,
      "@life-sim/rpg-ui": `${root}packages/rpg-ui/src/index.ts`,
      "@life-sim/ext-family/ui": `${root}extensions/family/src/ui/index.ts`,
      "@life-sim/ext-family": `${root}extensions/family/src/index.ts`,
    },
  },
  test: {
    // 根 test/ 是引擎级用例；extensions/* 带自己的 test/（扩展搬家后留在包内，见 docs/EXTENSIONS.md §4）
    include: ["test/**/*.test.ts", "extensions/**/test/**/*.test.ts"],
    environment: "node",
    // 接口测试各自起服务；串行文件避免端口/全局 env 互相踩。
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
