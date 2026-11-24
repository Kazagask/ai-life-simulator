import { useEffect, useState } from "react";
import type { MediaVM } from "@life-sim/shared";

/**
 * 人物头像（2026-11-24 · UI Polish 1.0）。
 *
 * 一个组件收掉三种状态，**布局完全一致**：
 * - 有图且能加载 ⇒ 圆形裁切显示；
 * - 没有图（模板没配皮肤 / 老存档）⇒ 名字首字 + 主题底色；
 * - 图加载失败（404 / 断网 / 资源被删）⇒ 同样退首字，不出现破图。
 *
 * 尺寸只用预设（`xs/sm/md/lg`），不做任意像素：头像大小是版式的一部分，
 * 各处各写一个数字就再也统一不回去了。
 */
export type AvatarSize = "xs" | "sm" | "md" | "lg";

export interface CharacterAvatarProps {
  /** 解析好的媒体槽；缺省 = 没有素材。 */
  media?: MediaVM | undefined;
  /** 人物名：首字占位符与无障碍标签都用它。 */
  name: string;
  size?: AvatarSize;
  /** `theme` = 主题主色描边（自己 / 重点），`muted` = 弱描边（普通人物）。 */
  tone?: "theme" | "muted";
  className?: string;
}

export function CharacterAvatar({ media, name, size = "sm", tone = "muted", className }: CharacterAvatarProps) {
  const [failed, setFailed] = useState(false);
  // 换了一张图就重置失败态，否则同一位置换人后仍显示上一个占位首字。
  useEffect(() => {
    setFailed(false);
  }, [media?.url, media?.assetId]);

  const initial = name.trim().slice(0, 1) || "？";
  const showImage = media !== undefined && media.url !== "" && !failed;
  const classes = ["ls-avatar", `ls-avatar--${size}`, `ls-avatar--${tone}`, className].filter(Boolean).join(" ");

  return (
    <span className={classes} role="img" aria-label={name} data-asset-id={media?.assetId ?? ""}>
      {showImage ? (
        <img
          className="ls-avatar__img"
          src={media.url}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="ls-avatar__initial" aria-hidden="true">
          {initial}
        </span>
      )}
    </span>
  );
}
