import { defineConfig } from "vitest/config";
import path from "node:path";

/** workspace 包通过 alias 直连源码解析；environment node 即可（P0 不渲染 DOM）。 */
export default defineConfig({
  resolve: {
    alias: {
      "@life-sim/shared": path.resolve(__dirname, "../shared/src/index.ts"),
      "@life-sim/rpg-ui": path.resolve(__dirname, "src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.min.test.ts", "src/**/*.accept.test.ts"],
  },
});
