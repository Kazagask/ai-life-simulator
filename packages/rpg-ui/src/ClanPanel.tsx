import { useState } from "react";
import type { ClanVM } from "@life-sim/shared";

/**
 * 宗族面板（`docs/CLAN-DESIGN.md` §2.4 / §3）。
 *
 * 只吃 `ClanVM`：成员数、在世人數、家主有没有卡、你与本族的关系**全部是服务端口径**。
 * 组件不读快照、不按关系边自己数人 —— 前端只有出边，数出来的血缘不等于族表（§3 的要点）。
 *
 * 竖屏优先：一族一张卡片，不画图、不横滚。大事记用原生 `<details>` 折叠（默认收起）。
 * 交互只有一条：点有卡的家主交给宿主开卡；无卡只给一行非模态提示（与 `RelationList` 的
 * `rel-nocard` 同口径）。选中态归宿主。
 */

/** 文案常量表：组件不写死任何世界观专名（族名/郡望/族学名全部来自数据）。 */
const LABELS = {
  title: "宗族",
  empty: "这个世界还没有可查的宗族。",
  status: {
    active: "存续",
    extinct: "已绝",
    exiled: "流徙",
  } as Record<string, string>,
  prestige: (n: number): string => `声望 ${n}`,
  seat: (seat: string): string => `郡望 ${seat}`,
  head: "家主",
  headVacant: "家主之位空悬",
  deceased: "已故",
  noCard: "无档案",
  counts: (living: number, total: number): string => `在世 ${living} 人 · 成员 ${total} 人`,
  /** 已有死亡记录时补一句解释，免得「成员数 > 在世人数」看起来像 bug。 */
  countsWithDead: (dead: number): string => `其中已故 ${dead} 人`,
  relation: {
    head: "你是家主",
    member: "你在族中",
    affine: "姻亲",
    outsider: "族外",
  } as Record<ClanVM["selfRelation"], string>,
  legacies: "族学",
  legacyLocked: "未解锁",
  history: (n: number): string => `大事记（${n}）`,
  historyEmpty: "尚无记载。",
} as const;

export interface ClanPanelProps {
  clans: ClanVM[];
  /** 点一个有档案的家主：宿主负责打开那张卡（本组件不导航）。 */
  onSelectNpc?: (id: string) => void;
  /** 面板标题（缺省「宗族」）。 */
  title?: string;
}

function ClanCard({ clan, onSelectNpc }: { clan: ClanVM; onSelectNpc?: (id: string) => void }) {
  const [notice, setNotice] = useState<string | null>(null);
  const isSelfClan = clan.selfRelation === "head" || clan.selfRelation === "member";
  const dead = clan.memberCount - clan.livingCount;
  const head = clan.head;
  // 新史在上：state 里是 append-only 正序，展示反转一份，不改原数组。
  const history = [...clan.history].reverse();

  const selectHead = (): void => {
    if (head === undefined) return;
    if (!head.hasCard) {
      setNotice(`${head.name} · ${LABELS.noCard}`);
      return;
    }
    onSelectNpc?.(head.id);
  };

  return (
    <section
      className={`ls-clan__card${isSelfClan ? " ls-clan__card--self" : ""}${
        clan.status === "extinct" ? " ls-clan__card--extinct" : ""
      }`}
      aria-label={clan.name}
    >
      <header className="ls-clan__card-head">
        <h4 className="ls-clan__name">{clan.name}</h4>
        <span className={`ls-clan__status ls-clan__status--${clan.status}`}>
          {LABELS.status[clan.status] ?? clan.status}
        </span>
      </header>

      <p className="ls-clan__meta">
        <span className="ls-clan__prestige">{LABELS.prestige(clan.prestige)}</span>
        {clan.seat !== undefined && <span className="ls-clan__seat">{LABELS.seat(clan.seat)}</span>}
        <span className="ls-clan__relation">{LABELS.relation[clan.selfRelation]}</span>
      </p>

      <p className="ls-clan__meta">
        {head === undefined ? (
          <span className="ls-clan__headline ls-clan__headline--vacant">{LABELS.headVacant}</span>
        ) : (
          <span className="ls-clan__headline">
            {LABELS.head}
            {": "}
            {head.hasCard && !head.isSelf ? (
              <button type="button" className="ls-clan__head-name" onClick={selectHead}>
                {head.name}
              </button>
            ) : (
              <span className={`ls-clan__head-name${head.hasCard ? "" : " ls-clan__head-name--nocard"}`}>
                {head.name}
              </span>
            )}
            {!head.hasCard && <span className="ls-clan__nocard">{LABELS.noCard}</span>}
            {!head.alive && <span className="ls-clan__dead">{LABELS.deceased}</span>}
          </span>
        )}
      </p>

      <p className="ls-clan__counts">
        {LABELS.counts(clan.livingCount, clan.memberCount)}
        {dead > 0 && <span className="ls-clan__dead-note"> · {LABELS.countsWithDead(dead)}</span>}
      </p>

      {clan.legacies !== undefined && clan.legacies.length > 0 && (
        <div className="ls-clan__legacies">
          <h5 className="ls-clan__section-title">{LABELS.legacies}</h5>
          <ul className="ls-clan__legacy-list">
            {clan.legacies.map((legacy) => (
              <li
                key={legacy.id}
                className={`ls-clan__legacy${legacy.unlocked ? " ls-clan__legacy--unlocked" : ""}`}
              >
                {legacy.name}
                {!legacy.unlocked && <span className="ls-clan__legacy-lock">{LABELS.legacyLocked}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {notice !== null && <p className="ls-clan__notice">{notice}</p>}

      <details className="ls-clan__history">
        <summary className="ls-clan__history-summary">{LABELS.history(clan.history.length)}</summary>
        {history.length === 0 ? (
          <p className="ls-clan__history-empty">{LABELS.historyEmpty}</p>
        ) : (
          <ul className="ls-clan__history-list">
            {history.map((entry, i) => (
              <li key={`${entry.at}-${entry.kind}-${i}`} className="ls-clan__history-item">
                <time className="ls-clan__history-at">{entry.formattedAt}</time>
                <span className="ls-clan__history-text">{entry.text}</span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}

export function ClanPanel({ clans, onSelectNpc, title }: ClanPanelProps) {
  return (
    <section className="ls-clan">
      <header className="ls-clan__head">
        <h3 className="ls-clan__title">{title ?? LABELS.title}</h3>
      </header>

      {clans.length === 0 ? (
        <p className="ls-clan__empty">{LABELS.empty}</p>
      ) : (
        <ul className="ls-clan__list">
          {clans.map((clan) => (
            <li key={clan.id} className="ls-clan__item">
              <ClanCard clan={clan} onSelectNpc={onSelectNpc} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
