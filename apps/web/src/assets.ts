import type { MediaVM } from "@life-sim/shared";

/**
 * 媒体 URL 的唯一拼装点（2026-11-24 · 迭代 character-media · T-07）。
 *
 * 分工：
 * - **引擎**只给 `assetId`（`snapshot.media`），它不认识 origin / 版本号；
 * - **这里**把 assetId 拼成同源相对路径，并在知道 `assetFingerprint` 时追加 `?v=`。
 *
 * `?v=` 的作用：模板作者换了一张图（`assetFingerprint` 变）⇒ URL 变 ⇒ 浏览器与 SW 都不会命中旧缓存。
 * 不知道指纹（离线起的模板）就不加 —— 那种情况下也刷不到新图，加个假版本号只会更难排查。
 */

export interface TemplateRefLite {
  id: string;
  version: string;
}

export function assetUrl(ref: TemplateRefLite, assetId: string, assetFingerprint?: string): string {
  const base = `/api/templates/${encodeURIComponent(ref.id)}/${encodeURIComponent(ref.version)}/assets/${encodeURIComponent(assetId)}`;
  const version = assetFingerprint !== undefined && assetFingerprint !== "" ? assetFingerprint.slice(0, 8) : undefined;
  return version === undefined ? base : `${base}?v=${version}`;
}

export interface MediaSlotRef {
  slot: string;
  assetId: string;
}

/** 槽名约定与 `packages/rpg-ui/src/slots.ts` 一致：`avatar.<actorId>` / `portrait.<actorId>` / `cg*`。 */
export function actorIdOfSlot(slot: string, prefix: "avatar" | "portrait"): string | undefined {
  const head = `${prefix}.`;
  return slot.startsWith(head) ? slot.slice(head.length) : undefined;
}

/**
 * 给引擎下发的媒体槽补上 `url` / `alt`（`alt` 用于加载失败时的文字头像）。
 *
 * 只认**能解析到 actorId** 的槽：拿不到名字的槽直接丢弃，避免出现「有图无 alt」的破图位。
 */
export function withAssetUrls(
  media: ReadonlyArray<MediaSlotRef> | undefined,
  ref: TemplateRefLite,
  assetFingerprint: string | undefined,
  nameOf: (actorId: string) => string | undefined,
): MediaVM[] {
  if (media === undefined) return [];
  const out: MediaVM[] = [];
  for (const item of media) {
    const actorId = actorIdOfSlot(item.slot, "avatar") ?? actorIdOfSlot(item.slot, "portrait");
    const alt = actorId === undefined ? "" : (nameOf(actorId) ?? actorId);
    out.push({ slot: item.slot, assetId: item.assetId, url: assetUrl(ref, item.assetId, assetFingerprint), alt });
  }
  return out;
}

/** 从媒体列表里取某人的某个槽（找不到返回 undefined，组件自己退占位符）。 */
export function mediaOfActor(media: ReadonlyArray<MediaVM> | undefined, actorId: string, slot: "avatar" | "portrait"): MediaVM | undefined {
  return media?.find((m) => m.slot === `${slot}.${actorId}`);
}
