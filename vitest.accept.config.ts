import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * test:accept 专用：只跑新最小集（*.min.test.ts），跨四包一次性执行。
 * workspace 包通过 alias 直连源码（沙箱不支持穿透 node_modules junction）。
 */
export default defineConfig({
  resolve: {
    alias: {
      "@life-sim/shared": path.resolve(__dirname, "packages/shared/src/index.ts"),
      "@life-sim/game-core": path.resolve(__dirname, "packages/game-core/src/index.ts"),
      "@life-sim/agent-runtime": path.resolve(__dirname, "packages/agent-runtime/src/index.ts"),
      "@life-sim/rpg-ui": path.resolve(__dirname, "packages/rpg-ui/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    /** 只扫 packages/ 与 apps/：避免根目录既有软链 test-junc -> packages/shared 重复收集同一批用例。 */
    include: ["packages/**/*.min.test.ts", "apps/**/*.min.test.ts"],
    exclude: ["**/node_modules/**", "**/legacy-tests/**", "test-junc/**"],
  },
});
