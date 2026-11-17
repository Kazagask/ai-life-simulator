import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@life-sim/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
      "@life-sim/rpg-ui": path.resolve(__dirname, "../../packages/rpg-ui/src/index.ts"),
      // 扩展前端入口（`docs/EXTENSIONS.md` §7）：只取 `/ui`，不把引擎侧实现打进浏览器包。
      "@life-sim/ext-family/ui": path.resolve(__dirname, "../../extensions/family/src/ui/index.ts"),
    },
  },
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
