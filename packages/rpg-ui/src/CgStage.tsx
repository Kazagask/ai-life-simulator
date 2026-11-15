import { useEffect, useState } from "react";
import type { MediaVM } from "@life-sim/shared";
import { isCgSlot } from "./slots.js";

export interface CgStageProps {
  media: MediaVM[];
  /**
   * 内联模式：由叙事流的 `asset` 块显式引用某张资源时使用。
   * 此时不再按 `cg` 槽名前缀筛选（块引用本身就是强信号），仍保留加载失败即整块不渲染。
   */
  inline?: boolean;
}

/** 槽位判定在 `./slots.js`（纯函数，适配器也要用），此处仅保持既有导出路径可用。 */
export { isCgSlot } from "./slots.js";

/**
 * 全屏 CG 舞台：媒体列表里**第一个** CG 槽存在时全出血呈现，否则整块不渲染。
 * 图片加载失败同样整块不渲染（宁可没有插画，也不要留一条破图色带）。
 */
export function CgStage({ media, inline = false }: CgStageProps) {
  const cg: MediaVM | undefined = inline
    ? media.find((m) => m.url !== "")
    : media.find((m) => isCgSlot(m.slot) && m.url !== "");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [cg?.url, cg?.assetId]);

  if (cg === undefined || failed) return null;

  return (
    <figure className="ls-cg" data-slot={cg.slot} data-asset-id={cg.assetId}>
      <img
        className="ls-cg__img"
        src={cg.url}
        alt={cg.alt}
        decoding="async"
        onError={() => setFailed(true)}
      />
      {cg.alt !== "" && <figcaption className="ls-cg__caption">{cg.alt}</figcaption>}
    </figure>
  );
}
