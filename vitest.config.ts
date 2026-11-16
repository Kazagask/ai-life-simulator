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
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // 接口测试各自起服务；串行文件避免端口/全局 env 互相踩。
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
