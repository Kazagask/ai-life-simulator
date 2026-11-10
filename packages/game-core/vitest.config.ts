import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * 沙箱环境不支持穿透 node_modules junction（untrusted mount point），
 * workspace 包一律通过 alias 直连源码解析。
 */
export default defineConfig({
  resolve: {
    alias: {
      "@life-sim/shared": path.resolve(__dirname, "../shared/src/index.ts"),
      "@life-sim/game-core": path.resolve(__dirname, "src/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
