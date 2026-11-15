import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * 服务端最小测试集（T-06 Group B / T-07 读侧写侧 / F3 / F4）。
 * 沙箱不支持穿透 node_modules junction，workspace 包一律 alias 直连源码。
 *
 * 只收集 `*.min.test.ts`：`src/index.ts` 启动即 listen，任何测试都不得 import 它；
 * 需要断言的投影逻辑已抽到 `src/narrative/**` 的纯函数里。
 */
export default defineConfig({
  resolve: {
    alias: {
      "@life-sim/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
      "@life-sim/game-core": path.resolve(__dirname, "../../packages/game-core/src/index.ts"),
      "@life-sim/agent-runtime": path.resolve(__dirname, "../../packages/agent-runtime/src/index.ts"),
      "@life-sim/rpg-ui": path.resolve(__dirname, "../../packages/rpg-ui/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.min.test.ts"],
  },
});
