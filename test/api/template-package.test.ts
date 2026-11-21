import { describe, expect, it } from "vitest";
import { loadTemplatePackage } from "@life-sim/template-loader";
import { api, startServer } from "../helpers/server.ts";

/**
 * `GET /api/templates/:id/:version/package`（ADR-070 第二期）。
 *
 * 用夹具模板起真服务：断言端点形状、文件正文、以及「客户端拿到这个 JSON 就能校验通过」。
 * 这里不测 jjk（真模板很重），jjk 的对照在 `test/unit/template-package.test.ts`。
 */

describe("模板包端点", () => {
  it("返回文件正文 + 指纹，客户端能独立校验", async () => {
    const server = await startServer();
    try {
      const pkg = await api<{
        templateId: string;
        version: string;
        fingerprint: string;
        files: Record<string, string>;
      }>(server.baseUrl, "GET", "/api/templates/p0/1.0.0/package");

      expect(pkg.templateId).toBe("p0");
      expect(pkg.version).toBe("1.0.0");
      expect(pkg.fingerprint.startsWith("sha256:")).toBe(true);
      expect(pkg.files["world.yaml"]).toBeTruthy();
      expect(pkg.files["lore.md"]).toContain("##");

      const result = loadTemplatePackage(pkg);
      expect(result.ok, result.ok ? "ok" : `${result.code}: ${result.message}`).toBe(true);
      if (result.ok) expect(result.fingerprint).toBe(pkg.fingerprint);
    } finally {
      await server.stop();
    }
  });

  it("未知版本 ⇒ 404（不给半份模板）", async () => {
    const server = await startServer();
    try {
      const res = await fetch(`${server.baseUrl}/api/templates/p0/9.9.9/package`);
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
