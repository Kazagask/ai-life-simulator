import { useState } from "react";
import type {
  EffectSummaryVM,
  SkillVM,
  StatusVM,
  SummonUnitVM,
  SummonVM,
} from "@life-sim/shared";
import { EffectList } from "./EffectList.js";
import { DetailSheet, type DetailSheetData } from "./StatusSheet.js";
import { StyledName } from "./StyledName.js";

export interface SkillListProps {
  skills: SkillVM[];
  /** 点开技能里引用的状态（「施加 力竭」）：宿主决定用浮层还是跳转。 */
  onOpenStatus?: (effect: EffectSummaryVM) => void;
  /** 点开召唤物的常驻状态芯片（如魔虚罗的法轮）：宿主叠一层状态浮层。 */
  onOpenModifier?: (status: StatusVM) => void;
}

/**
 * 技能描述里那段可点的召唤文案：前缀是技能参数，名字单独加粗。
 * 英雄档也写「名」而不写「名英雄」（用户 2026-11-20）——档位已经由浮窗副标题说明。
 */
function summonPrefix(summon: SummonVM): string {
  const unit = summon.unit.tier === "hero" ? `${summon.count} 名` : `${summon.count} 只`;
  return `召唤 ${unit} · `;
}

/**
 * 召唤物详情 → 浮层数据。
 *
 * 与状态详情共用 `DetailSheet`（用户 2026-11-20 裁决「同款样式」）：
 * 顶部是召唤物本体（档位 / 一次召唤 / 上限 / 强度），下面按技能分节，
 * **一行一个技能**，每个技能带自己的效果条目 —— 效果摘要来自投影
 * （`skillEffectSummaries`），前端不重算。
 *
 * 技能里若施加状态，该条目仍是 `EffectList` 的可点引用，宿主会把状态浮窗
 * **叠在这层之上**（现有 `onOpenStatus` 栈），不需要在这里再写一套。
 */
function summonToDetail(unit: SummonUnitVM): DetailSheetData {
  /**
   * 这个浮层是**召唤物面板**，不是技能面板（用户 2026-11-20）：
   * 「一次几只 / 强度 / 档位名额」都是技能参数与世界规则，写在技能自己的效果行里；
   * 这里只描述它是谁、带什么技能与状态。
   */
  return {
    title: unit.name,
    subtitle: unit.tier === "hero" ? "英雄召唤物" : "召唤物",
    ...(unit.description !== undefined ? { description: unit.description } : {}),
    // 常驻状态（被动）不并进技能表：它是「这个东西一直带着什么」，不是它会使什么招。
    ...(unit.statuses.length > 0 ? { chips: unit.statuses } : {}),
    ...(unit.skills.length > 0
      ? {
          groups: unit.skills.map((skill) => ({
            title: skill.name,
            ...(skill.style !== undefined ? { style: skill.style } : {}),
            ...(skill.description !== undefined ? { description: skill.description } : {}),
            ...(skill.effects !== undefined ? { effects: skill.effects } : {}),
          })),
        }
      : {}),
  };
}

/** 卡片上的一行摘要：优先消耗 / 冷却，没有就退回「通用 / 战斗」。 */
function skillMeta(skill: SkillVM): string {
  // 零消耗写「无消耗」（2026-11-20）：只认「消耗」开头会把这一行整条漏掉。
  const cost = skill.effects?.find(
    (e) => e.kind === "cost" && (e.text.startsWith("消耗") || e.text === "无消耗"),
  );
  const cooldown = skill.effects?.find((e) => e.kind === "cost" && e.text.startsWith("冷却"));
  const parts = [cost?.text, cooldown?.text].filter((t): t is string => t !== undefined);
  if (parts.length > 0) return parts.join(" · ");
  return skill.kind === "combat" ? "战斗技能" : "通用技能";
}

/**
 * 技能面板（用户 2026-11-18 裁决）：**一行两个**技能卡，点开在下方看详情。
 *
 * 为什么不复用通用毛玻璃浮层：技能是**常驻**能力，玩家会反复对照（耗多少、冷却几回合），
 * 浮层每次都要点开 / 关闭反而更慢；就地展开能一边看列表一边看细节。
 *
 * 卡片只放「选哪个」需要的信息（名字 + 消耗 / 冷却），完整效果留给下方详情。
 *
 * ADR-015（2026-11-20）：**封印的技能也留在网格里**，卡面写「封印」，详情里写原因。
 * 从列表里删掉会让玩家无法区分「没学过」和「学过但没了」——这正是虹龙被献祭之后
 * 那一栏还在、点开却什么也没发生的原因。
 */
export function SkillList({ skills, onOpenStatus, onOpenModifier }: SkillListProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [summonOpen, setSummonOpen] = useState(false);
  const selected = skills.find((s) => s.id === selectedId) ?? null;

  if (skills.length === 0) {
    return (
      <section className="card">
        <p className="muted">尚未习得技能。</p>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="ls-skill-grid">
        {skills.map((skill) => {
          const seal = skill.seal;
          const active = skill.id === selectedId;
          return (
            <button
              key={skill.id}
              type="button"
              className={`ls-skill-card${active ? " is-active" : ""}${seal === undefined ? "" : " is-sealed"}`}
              onClick={() => {
                setSummonOpen(false);
                setSelectedId((prev) => (prev === skill.id ? null : skill.id));
              }}
              aria-pressed={active}
              {...(seal !== undefined ? { title: seal.text } : {})}
            >
              <StyledName name={skill.name} style={skill.style} className="ls-skill-card__name" />
              <span className="ls-skill-card__meta">{skillMeta(skill)}</span>
              {seal !== undefined && <span className="ls-skill-card__seal">封印</span>}
            </button>
          );
        })}
      </div>

      {selected !== null && (
        <div className="ls-skill-detail">
          <div className="ls-skill-detail__head">
            <h3>
              <StyledName name={selected.name} style={selected.style} />
            </h3>
            <button
              type="button"
              className="ls-skill-detail__close"
              onClick={() => setSelectedId(null)}
              aria-label="收起"
            >
              ✕
            </button>
          </div>
          {(selected.description !== undefined && selected.description !== "") ||
          selected.summon !== undefined ? (
            <p className="ls-skill-detail__desc">
              {selected.description}
              {selected.summon !== undefined && (
                <>
                  {selected.description !== undefined && selected.description !== "" ? " " : ""}
                  <button
                    type="button"
                    className="ls-skill-summon-link"
                    onClick={() => setSummonOpen(true)}
                  >
                    {summonPrefix(selected.summon)}
                    <strong>{selected.summon.unit.name}</strong>
                  </button>
                </>
              )}
            </p>
          ) : null}
          {/* 封印原因放在效果之前：它是「这一招现在有什么用」的前提。 */}
          {selected.seal !== undefined && (
            <p className="ls-skill-detail__seal">封印：{selected.seal.text}</p>
          )}
          <EffectList
            effects={selected.effects}
            {...(onOpenStatus !== undefined ? { onOpenRef: onOpenStatus } : {})}
          />
          {selected.effects === undefined || selected.effects.length === 0 ? (
            <p className="muted">这个技能没有可直接展示的效果。</p>
          ) : null}

          {summonOpen && selected.summon !== undefined && (
            <DetailSheet
              detail={summonToDetail(selected.summon.unit)}
              onClose={() => setSummonOpen(false)}
              {...(onOpenStatus !== undefined ? { onOpenRef: onOpenStatus } : {})}
              {...(onOpenModifier !== undefined ? { onOpenChip: onOpenModifier } : {})}
            />
          )}
        </div>
      )}
    </section>
  );
}
