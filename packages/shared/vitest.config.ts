import { defineConfig } from "vitest/config";
import path from "node:path";

/** 旧测试已整体迁到 legacy-tests/ 并保留原文；本配置只收集新最小集。 */
export default defineConfig({
  resolve: {
    alias: {
      "@life-sim/shared": path.resolve(__dirname, "src/index.ts"),
      "@life-sim/game-core": path.resolve(__dirname, "../game-core/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.min.test.ts", "src/**/*.accept.test.ts"],
  },
});
