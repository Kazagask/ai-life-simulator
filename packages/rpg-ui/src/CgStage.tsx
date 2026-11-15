import { useEffect, useState } from "react";
import type { MediaVM } from "@life-sim/shared";

export interface CgStageProps {
  media: MediaVM[];
}

/**
 * 全屏 CG 槽位命名约定：`slot` 以 `cg` 起头（`cg` / `cg.opening` / `cg-battle` …）。
 *
 * 为什么要约定：`MediaVM` 不带 `kind`（资源清单的 kind 不下发到展示层），
 * 前端只有 `slot` 这一个稳定信号；模板侧把全屏插画槽统一冠以 `cg` 前缀即可自动上屏。
 */
export function isCgSlot(slot: string): boolean {
  return /^cg(?![a-z0-9])/i.test(slot);
}

/**
 * 全屏 CG 舞台：媒体列表里**第一个** CG 槽存在时全出血呈现，否则整块不渲染。
 * 图片加载失败同样整块不渲染（宁可没有插画，也不要留一条破图色带）。
 */
export function CgStage({ media }: CgStageProps) {
  const cg: MediaVM | undefined = media.find((m) => isCgSlot(m.slot) && m.url !== "");
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
