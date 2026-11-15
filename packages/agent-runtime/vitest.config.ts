import { defineConfig } from "vitest/config";
import path from "node:path";

/** workspace 包通过 alias 直连源码解析（沙箱不支持穿透 node_modules junction）。 */
export default defineConfig({
  resolve: {
    alias: {
      "@life-sim/shared": path.resolve(__dirname, "../shared/src/index.ts"),
      "@life-sim/game-core": path.resolve(__dirname, "../game-core/src/index.ts"),
      "@life-sim/agent-runtime": path.resolve(__dirname, "src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.min.test.ts", "src/**/*.accept.test.ts"],
  },
});
