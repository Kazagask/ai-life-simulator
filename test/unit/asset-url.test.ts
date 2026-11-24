import { describe, expect, it } from "vitest";
import { assetUrl, mediaOfActor, withAssetUrls } from "../../apps/web/src/assets.ts";

/**
 * 媒体 URL 拼装（2026-11-24 · 角色媒体 · T-07）。
 *
 * 这条用例守的就是「**UI 层不许自己拼路径**」：assetId → url 只有 `assets.ts` 一个实现点，
 * 版本参数来自 `assetFingerprint`（换图即换 URL，SW 与浏览器都不会命中旧缓存）。
 */

const ref = { id: "jjk-2006", version: "3.0.0" };

describe("assetUrl", () => {
  it("同源相对路径 + encodeURIComponent", () => {
    expect(assetUrl(ref, "gojo.student.avatar")).toBe(
      "/api/templates/jjk-2006/3.0.0/assets/gojo.student.avatar",
    );
  });

  it("有 assetFingerprint 时加 8 位版本参数", () => {
    expect(assetUrl(ref, "a", "sha256:0123456789abcdef")).toBe(
      "/api/templates/jjk-2006/3.0.0/assets/a?v=sha256:0",
    );
  });

  it("空指纹 / 未提供 ⇒ 不加 ?v=（离线起的模板没有指纹）", () => {
    expect(assetUrl(ref, "a", "")).toBe("/api/templates/jjk-2006/3.0.0/assets/a");
    expect(assetUrl(ref, "a")).toBe("/api/templates/jjk-2006/3.0.0/assets/a");
  });
});

describe("withAssetUrls", () => {
  it("补 url 与 alt（alt 取人物名，供占位符用首字）", () => {
    const out = withAssetUrls(
      [{ slot: "avatar.npc-a", assetId: "a.avatar" }],
      ref,
      "sha256:deadbeefcafe",
      (id) => (id === "npc-a" ? "五条悟" : undefined),
    );
    expect(out).toEqual([
      {
        slot: "avatar.npc-a",
        assetId: "a.avatar",
        url: "/api/templates/jjk-2006/3.0.0/assets/a.avatar?v=sha256:d",
        alt: "五条悟",
      },
    ]);
  });

  it("没有 media ⇒ 空数组（组件走占位符，不报错）", () => {
    expect(withAssetUrls(undefined, ref, undefined, () => "x")).toEqual([]);
  });
});

describe("mediaOfActor", () => {
  const media = withAssetUrls([{ slot: "avatar.npc-a", assetId: "x" }], ref, undefined, () => "A");
  it("按 actorId + 槽位取", () => {
    expect(mediaOfActor(media, "npc-a", "avatar")?.assetId).toBe("x");
    expect(mediaOfActor(media, "npc-b", "avatar")).toBeUndefined();
  });
});
