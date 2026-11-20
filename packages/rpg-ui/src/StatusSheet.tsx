import { useEffect } from "react";
import type { EffectSummaryVM, ResolvedStyle, ResolvedTag, StatusVM } from "@life-sim/shared";
import { EffectList } from "./EffectList.js";
import { StatusChip } from "./StatusChip.js";
import { StyledName, styleBoxClassName, styleBoxInline } from "./StyledName.js";
import { TagChips } from "./TagChips.js";

/** 浮层内容（状态 / 技能 / 物品 / 装备共用一套排版）。 */
export interface DetailSheetData {
  title: string;
  /** 副标题：类型 / 层数这类**中性**小字（不要放品质——那是标签的活）。 */
  subtitle?: string;
  /** 标签（品级 / 增益减益）：带各自样式，渲染在标题上方。 */
  tags?: ResolvedTag[];
  /** 说明正文。 */
  description?: string;
  /** 一行元信息（持续时间 / 消耗 / 冷却…）。 */
  meta?: string;
  style?: ResolvedStyle;
  effects?: EffectSummaryVM[];
  /**
   * 常驻状态（召唤物的被动，如魔虚罗的法轮）：渲染成与个人页同一套状态芯片，
   * 点开是状态浮层（再叠一层），不在这里复述效果。
   */
  chips?: StatusVM[];
  /**
   * 分节：一段一个标题 + 自己的一组效果（召唤物的技能表用它）。
   * 与 `effects` 不是二选一 —— 顶部可有整体效果，下面再按技能分节。
   */
  groups?: DetailSheetGroup[];
}

/** 浮层里的一个分节（「一个技能一行」）。 */
export interface DetailSheetGroup {
  title: string;
  style?: ResolvedStyle;
  /** 技能的说明：不上屏占行（那会破坏「一行一个技能」），作为该行的悬停提示。 */
  description?: string;
  effects?: EffectSummaryVM[];
}

export interface DetailSheetProps {
  detail: DetailSheetData | null;
  onClose: () => void;
  /** 点开浮层里的引用条目（施加 / 移除某状态）。 */
  onOpenRef?: (effect: EffectSummaryVM) => void;
  /** 点开常驻状态芯片（再叠一层状态浮层）。 */
  onOpenChip?: (status: StatusVM) => void;
}

/**
 * 详情浮层（ADR-002 / R-DETAIL-04、R-DETAIL-05）。
 *
 * 毛玻璃不是纯视觉：竖屏卡片密集，纯不透明遮罩会把「我现在在哪」切断；半透明 + 背景模糊
 * 保留上下文。`@supports` 兜底到高不透明底，避免旧内核上出现糊字。
 *
 * 关闭三件套：Esc / 点遮罩 / 关闭按钮。同一时刻只开一个（由宿主只传一个 detail 保证）。
 */
export function DetailSheet({ detail, onClose, onOpenRef, onOpenChip }: DetailSheetProps) {
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
            <TagChips tags={detail.tags} />
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

        {/* 常驻状态：与个人页同一套芯片；点开是状态浮层（叠在这层之上）。 */}
        {detail.chips !== undefined && detail.chips.length > 0 && (
          <div className="ls-sheet__chips">
            <span className="ls-sheet__chips-label">状态</span>
            <span className="status-chips">
              {detail.chips.map((status) => (
                <StatusChip
                  key={status.id}
                  status={status}
                  {...(onOpenChip !== undefined ? { onSelect: onOpenChip } : {})}
                />
              ))}
            </span>
          </div>
        )}

        <EffectList effects={detail.effects} onOpenRef={onOpenRef} />
        {detail.effects === undefined || detail.effects.length === 0 ? (
          detail.groups === undefined || detail.groups.length === 0 ? (
            <p className="ls-sheet__meta">（没有可展示的效果）</p>
          ) : null
        ) : null}

        {/* 分节：召唤物的技能表 —— 一行一个技能，效果与状态详情同一套排版。 */}
        {detail.groups?.map((group, i) => (
          <section className="ls-sheet__group" key={`${group.title}-${i}`}>
            <div className="ls-sheet__group-head">
              <h4 {...(group.description !== undefined ? { title: group.description } : {})}>
                <StyledName name={group.title} style={group.style} />
              </h4>
              <EffectList effects={group.effects} inline onOpenRef={onOpenRef} />
            </div>
          </section>
        ))}
      </section>
    </div>
  );
}

/** `StatusVM` → 浮层内容（宿主在别处也要展示状态详情时复用它，避免两套排版）。 */
export function statusToDetail(status: StatusVM): DetailSheetData {
  // 品质（quality）是**引擎里的选择器**，不是给玩家看的词：玩家看到的是 tags 里的「神话」。
  const subtitle = status.stacks > 1 ? `×${status.stacks}` : undefined;
  /**
   * 天赋不写「持续」（ADR-018 D1）：它没有时钟，写「直到被移除」等于替引擎
   * 承诺一件永远不会发生的事。状态与战斗态才需要这一行。
   */
  const meta = status.kind !== "talent" && status.durationLabel !== undefined ? `持续：${status.durationLabel}` : undefined;
  return {
    title: status.name,
    ...(status.tags !== undefined && status.tags.length > 0 ? { tags: status.tags } : {}),
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(status.description !== undefined ? { description: status.description } : {}),
    ...(meta !== undefined ? { meta } : {}),
    ...(status.style !== undefined ? { style: status.style } : {}),
    ...(status.effects !== undefined ? { effects: status.effects } : {}),
  };
}

export interface StatusSheetProps {
  /** 要展示的状态；`null` ⇒ 不渲染。 */
  status: StatusVM | null;
  onClose: () => void;
  /** 点开内部引用的其它状态（如「每回合施加 流血」）。 */
  onOpenRef?: (effect: EffectSummaryVM) => void;
}

/** 状态详情的便捷包装：把 `StatusVM` 摊平成 `DetailSheetData`。 */
export function StatusSheet({ status, onClose, onOpenRef }: StatusSheetProps) {
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
