import { describe, expect, it } from "vitest";
import { registerServerExtensions } from "../../apps/server/src/extensions.ts";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * 隐藏模板（`world.yaml` `meta.hidden: true`，2026-11-20）。
 *
 * 语义只有一条：**注册表收录、列表端点不列**。注册表照样收录是因为 `inspect` 与体检
 * 要看得见测试田；按 id 建局也照样可用（`POST /api/worlds` 不看这个字段）。
 */

const silent = { warn: () => undefined, error: () => undefined, info: () => undefined };
registerServerExtensions();
const registry = loadTemplates(silent);

describe("隐藏模板", () => {
  it("瓦勒蒙带 hidden 标记，正常模板没有", () => {
    const list = registry.listTemplates();
    expect(list.find((t) => t.id === "valmont")?.hidden).toBe(true);
    expect(list.find((t) => t.id === "jjk-2006")?.hidden).toBeUndefined();
  });

  it("隐藏不等于不可载：按 id 仍然 ready", () => {
    expect(registry.resolve({ id: "valmont", version: "1.0.0" })?.status).toBe("ready");
  });
});
