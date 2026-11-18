import { useEffect, useState } from "react";
import type { BattleCommand } from "@life-sim/shared";
import type { BattleVM } from "@life-sim/shared";
import { StyledName, styleBoxClassName, styleBoxInline } from "./StyledName.js";

export interface BattleBoardProps {
  /** 战斗展示模型（来自 `toBattleVM`，不含引擎规则细节）。 */
  battle: BattleVM;
  /** 资源条标签：来自模板 `labels.resources`；缺省回退 hp / mp。 */
  labels?: { hp?: string; mp?: string };
  /** 请求在飞：所有按钮置灰（引擎侧 busy 锁兜底，视觉也要一致）。 */
  busy?: boolean;
  /** 战斗命令（技能 / 道具 / 逃跑 / 空过），组件内部不发请求。 */
  onCommand: (command: BattleCommand) => void;
  /** 战斗结束后「离开战场」的推进函数。 */
  onContinue: () => void;
}

/**
 * 战斗面板（事件区的 combat 分支）。
 *
 * 三条只读约束（都是引擎语义，前端不许自己重算）：
 *  - `canAct === false`（`cannot_act` 类补正压制，如眩晕）：引擎**不报错**，只记一行
 *    「你无法行动。」并跳过玩家动作、照常推进回合 ⇒ 前端必须主动告知，否则玩家看到的是
 *    「点了技能、什么都没变、回合没了」。用覆盖层盖住整个行动区，并保留一个「硬撑」出口
 *    （`{type:"pass"}`，不消耗 MP / 道具 / 冷却，只消耗一个战斗回合）。
 *  - `canUseItems === false`（`bound_items`）与 `canFlee === false`（`flee_not_allowed`）
 *    同样由投影层用与引擎**同一个**控制判定算出，这里只按结论置灰 + 写原因，不查补正表。
 *  - 逃跑按钮**常显但可禁用**（D-12）：不给按钮会让玩家以为「没有逃跑这个选项」。
 */
export function BattleBoard({ battle: b, labels, busy = false, onCommand, onContinue }: BattleBoardProps) {
  const [target, setTarget] = useState<string>("");

  const locked = !b.over && !b.player.canAct;
  // 原因只从投影里已有的 statuses 读，不自造文案、不改引擎：眩晕的名字就来自模板。
  const stunName = b.player.statuses.find((s) => s.id === "stun")?.name;
  const [lockedTapped, setLockedTapped] = useState(false);
  useEffect(() => {
    if (!locked) setLockedTapped(false);
  }, [locked]);

  const aliveEnemies = b.enemies.filter((e) => e.alive);
  const effectiveTarget = target && aliveEnemies.some((e) => e.id === target) ? target : aliveEnemies[0]?.id;

  return (
    <div className={`battle-body ${b.over ? "battle-over" : ""}`}>
      <div className="row">
        <h3>⚔ 战斗 · 第 {b.round} 回合</h3>
        {b.over && (
          <span className={`tag ${b.over}`}>
            {b.over === "victory" ? "胜利" : b.over === "defeat" ? "败北" : "撤离"}
          </span>
        )}
      </div>

      {/* 我方资源：战斗内以战斗镜像为准，消耗实时可见 */}
      <div className="battle-self">
        <div className="attr">
          <span className="attr-name">{labels?.hp ?? "hp"}</span>
          <div className="bar">
            <div className="bar-fill hp" style={{ width: `${(b.player.hp / Math.max(1, b.player.maxHp)) * 100}%` }} />
          </div>
          <span className="attr-value">{b.player.hp}/{b.player.maxHp}</span>
        </div>
        <div className="attr">
          <span className="attr-name">{labels?.mp ?? "mp"}</span>
          <div className="bar">
            <div className="bar-fill mp" style={{ width: `${(b.player.mp / Math.max(1, b.player.maxMp)) * 100}%` }} />
          </div>
          <span className="attr-value">{b.player.mp}/{b.player.maxMp}</span>
        </div>
      </div>

      {b.allies.length > 0 && (
        <div className="ally-list">
          <span className="muted">友军</span>
          {b.allies.map((a) => (
            <div key={a.id} className={`ally ${!a.alive ? "dead" : ""}`}>
              <strong>{a.name}</strong>
              <div className="bar">
                <div className="bar-fill ally-hp" style={{ width: `${(a.hp / Math.max(1, a.maxHp)) * 100}%` }} />
              </div>
              <span className="attr-value">{a.hp}/{a.maxHp}</span>
              {a.statuses.length > 0 && (
                <span className="enemy-status ls-battle-chips">
                  {a.statuses.map((s) => {
                    // 战斗态一律换成语义色（增益绿 / 异常红 / 中性灰）：打法上先看这个，
                    // 身份色（神话 / 传说）留在详情浮层里看。没有语义标签的纯天赋才退回身份色。
                    const st = s.battleStyle ?? s.style;
                    const box = styleBoxClassName(st);
                    return (
                      <span
                        key={s.id}
                        className={`ls-battle-status${box === undefined ? "" : ` ${box}`}`}
                        style={styleBoxInline(st)}
                      >
                        <StyledName name={s.name} style={st} />
                        {s.stacks > 1 ? `×${s.stacks}` : ""}
                      </span>
                    );
                  })}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="enemy-list">
        {b.enemies.map((e) => (
          <button
            key={e.id}
            className={`enemy ${!e.alive ? "dead" : ""} ${effectiveTarget === e.id && e.alive ? "targeting" : ""}`}
            disabled={!e.alive}
            onClick={() => setTarget(e.id)}
          >
            <strong>{e.name}</strong>
            <div className="bar">
              <div className="bar-fill enemy-hp" style={{ width: `${(e.hp / Math.max(1, e.maxHp)) * 100}%` }} />
            </div>
            <span className="attr-value">{e.hp}/{e.maxHp}</span>
            {e.statuses.length > 0 && (
              <span className="enemy-status ls-battle-chips">
                {e.statuses.map((s) => {
                  const st = s.battleStyle ?? s.style;
                  const box = styleBoxClassName(st);
                  return (
                    <span
                      key={s.id}
                      className={`ls-battle-status${box === undefined ? "" : ` ${box}`}`}
                      style={styleBoxInline(st)}
                    >
                      <StyledName name={s.name} style={st} />
                      {s.stacks > 1 ? `×${s.stacks}` : ""}
                    </span>
                  );
                })}
              </span>
            )}
          </button>
        ))}
      </div>

      {!b.over && (
        <>
          <div className="battle-action-zone">
            <div className="battle-actions">
              {b.player.skills.map((skill) => (
                <button
                  key={skill.id}
                  className="action"
                  disabled={busy || locked || skill.cooldownLeft > 0 || b.player.mp < skill.costMp}
                  aria-disabled={busy || locked || skill.cooldownLeft > 0 || b.player.mp < skill.costMp}
                  onClick={() => onCommand({ type: "skill", skillId: skill.id, targetInstanceId: effectiveTarget })}
                >
                  <strong>{skill.name}</strong>
                  <span>
                    {skill.costMp > 0 ? `${labels?.mp ?? "mp"} ${skill.costMp}` : "无消耗"}
                    {skill.cooldownLeft > 0 ? ` · 冷却 ${skill.cooldownLeft}` : ""}
                  </span>
                </button>
              ))}
              {b.player.items.map((item) => (
                <button
                  key={item.itemId}
                  className="action"
                  // canUseItems 由投影层用与引擎**同一个**控制判定算出，前端不自己查 status id。
                  disabled={busy || locked || !b.player.canUseItems}
                  aria-disabled={busy || locked || !b.player.canUseItems}
                  onClick={() => onCommand({ type: "item", itemId: item.itemId })}
                >
                  <strong>{item.name} ×{item.count}</strong>
                  <span>{b.player.canUseItems ? "使用道具" : "受制于人，用不了道具"}</span>
                </button>
              ))}
              {/* 逃跑按钮常显但按 canFlee 禁用：原因写在按钮上，不只靠置灰。 */}
              <button
                className="action flee"
                disabled={busy || locked || !b.player.canFlee}
                aria-disabled={busy || locked || !b.player.canFlee}
                onClick={() => onCommand({ type: "flee" })}
              >
                <strong>逃跑</strong>
                <span>{b.player.canFlee ? "尝试脱离战斗" : "退路已被封死"}</span>
              </button>
            </div>

            {/*
              眩晕等 cannot_act 压制：用覆盖层盖住整个行动区，而不是逐个置灰
              （三者同时不可用，逐个禁用会让人以为是三个独立问题）。覆盖层保留一个明确的
              推进出口：引擎在该分支只记一行日志、跳过玩家动作、照常推进回合，必须有人提交
              一次命令回合才会前进，否则眩晕永不到期、战斗卡死。
            */}
            {locked && (
              <div
                className={`battle-locked ${lockedTapped ? "is-tapped" : ""}`}
                role="status"
                aria-live="polite"
                aria-disabled="true"
                onClick={() => setLockedTapped(true)}
              >
                <strong className="battle-locked-title">无法行动{stunName ? ` · ${stunName}` : ""}</strong>
                <p className="battle-locked-sub">
                  {lockedTapped
                    ? "已确认：本回合你没有任何可执行的动作。"
                    : "技能、道具、逃跑本回合全部不可用，只能硬撑过去。"}
                </p>
                <button
                  className="primary battle-locked-pass"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCommand({ type: "pass" });
                  }}
                >
                  硬撑过这一回合
                </button>
              </div>
            )}
          </div>
          {!locked && !b.player.canFlee && <p className="battle-limit-hint">此战无法逃离：局势不允许脱身。</p>}
          {!locked && !b.player.canUseItems && <p className="battle-limit-hint">你被束缚住了：本回合无法使用道具。</p>}
          <p className="muted target-hint">点击敌人选择目标（默认最前者）</p>
        </>
      )}

      {b.over && (
        <button className="primary" disabled={busy} onClick={onContinue}>
          离开战场，继续前行
        </button>
      )}

      <div className="battle-log">
        {b.log.map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      </div>
    </div>
  );
}
