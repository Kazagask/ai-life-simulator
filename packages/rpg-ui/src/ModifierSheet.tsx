import { useEffect } from "react";
import type { EffectSummaryVM, ResolvedStyle, StatusVM } from "@life-sim/shared";
import { EffectList } from "./EffectList.js";
import { StyledName } from "./StyledName.js";

/** 浮层内容（补正 / 技能 / 物品 / 装备共用一套排版）。 */
export interface DetailSheetData {
  title: string;
  /** 副标题：品质 / 类型 / 层数（右对齐的小字）。 */
  subtitle?: string;
  /** 说明正文。 */
  description?: string;
  /** 一行元信息（持续时间 / 消耗 / 冷却…）。 */
  meta?: string;
  style?: ResolvedStyle;
  effects?: EffectSummaryVM[];
}

export interface DetailSheetProps {
  detail: DetailSheetData | null;
  onClose: () => void;
  onOpenRef?: (ref: NonNullable<EffectSummaryVM["ref"]>) => void;
}

/**
 * 详情浮层（ADR-002 / R-DETAIL-04、R-DETAIL-05）。
 *
 * 毛玻璃不是纯视觉：竖屏卡片密集，纯不透明遮罩会把「我现在在哪」切断；半透明 + 背景模糊
 * 保留上下文。`@supports` 兜底到高不透明底，避免旧内核上出现糊字。
 *
 * 关闭三件套：Esc / 点遮罩 / 关闭按钮。同一时刻只开一个（由宿主只传一个 detail 保证）。
 */
export function DetailSheet({ detail, onClose, onOpenRef }: DetailSheetProps) {
  useEffect(() => {
    if (detail === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, onClose]);

  if (detail === null) return null;

  return (
    <div className="ls-sheet" role="dialog" aria-modal="true" aria-label={`详情：${detail.title}`}>
      <button type="button" className="ls-sheet__backdrop" aria-label="关闭" onClick={onClose} />
      <section className="ls-sheet__card">
        <header className="ls-sheet__head">
          <div>
            {detail.subtitle !== undefined && <span className="ls-sheet__quality">{detail.subtitle}</span>}
            <h3>
              <StyledName name={detail.title} style={detail.style} />
            </h3>
          </div>
          <button type="button" className="ls-sheet__close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        {detail.meta !== undefined && <p className="ls-sheet__meta">{detail.meta}</p>}
        {detail.description !== undefined && detail.description !== "" && (
          <p className="ls-sheet__desc">{detail.description}</p>
        )}

        <EffectList effects={detail.effects} onOpenRef={onOpenRef} />
        {detail.effects === undefined || detail.effects.length === 0 ? (
          <p className="ls-sheet__meta">（没有可展示的效果）</p>
        ) : null}
      </section>
    </div>
  );
}

/** `StatusVM` → 浮层内容（宿主在别处也要展示补正详情时复用它，避免两套排版）。 */
export function statusToDetail(status: StatusVM): DetailSheetData {
  const subtitle = [status.quality, status.stacks > 1 ? `×${status.stacks}` : undefined]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");
  return {
    title: status.name,
    ...(subtitle !== "" ? { subtitle } : {}),
    ...(status.description !== undefined ? { description: status.description } : {}),
    ...(status.durationLabel !== undefined ? { meta: `持续：${status.durationLabel}` } : {}),
    ...(status.style !== undefined ? { style: status.style } : {}),
    ...(status.effects !== undefined ? { effects: status.effects } : {}),
  };
}

export interface ModifierSheetProps {
  /** 要展示的补正；`null` ⇒ 不渲染。 */
  status: StatusVM | null;
  onClose: () => void;
  /** 点开内部引用的其它补正（如「每回合施加 流血」）。 */
  onOpenRef?: (ref: { kind: "status" | "item" | "skill"; id: string }) => void;
}

/** 补正详情的便捷包装：把 `StatusVM` 摊平成 `DetailSheetData`。 */
export function ModifierSheet({ status, onClose, onOpenRef }: ModifierSheetProps) {
  if (status === null) {
    return <DetailSheet detail={null} onClose={onClose} {...(onOpenRef !== undefined ? { onOpenRef } : {})} />;
  }
  return (
    <DetailSheet
      detail={statusToDetail(status)}
      onClose={onClose}
      {...(onOpenRef !== undefined ? { onOpenRef } : {})}
    />
  );
}
