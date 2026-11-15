import { useEffect, useState } from "react";
import type { MediaVM } from "@life-sim/shared";

export interface PortraitProps {
  media: MediaVM;
}

/** 立绘回退块：图片缺失 / 加载失败时用名字首字占位，不留破图。 */
function PortraitFallback({ media }: PortraitProps) {
  const initial = media.alt.trim().slice(0, 1) || "？";
  return (
    <div className="ls-portrait__fallback" role="img" aria-label={media.alt} data-asset-id={media.assetId}>
      <span aria-hidden="true">{initial}</span>
    </div>
  );
}

/**
 * 立绘：一张资源卡（`<img>` + alt）。
 *
 * 约束：**不得硬编码资源路径**——`url` / `alt` 全部来自服务端媒体投影（MediaVM），
 * 组件只负责「能加载就显示、失败就优雅回退」。`url` 为空视同加载失败。
 */
export function Portrait({ media }: PortraitProps) {
  const [failed, setFailed] = useState(media.url === "");

  // 换了一张图就重置失败态，否则同一位置换人后仍显示上一个占位块。
  useEffect(() => {
    setFailed(media.url === "");
  }, [media.url, media.assetId]);

  if (failed) return <PortraitFallback media={media} />;

  return (
    <figure className="ls-portrait" data-asset-id={media.assetId}>
      <img
        className="ls-portrait__img"
        src={media.url}
        alt={media.alt}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
      <figcaption className="ls-portrait__caption">{media.alt}</figcaption>
    </figure>
  );
}
