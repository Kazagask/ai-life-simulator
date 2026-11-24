import { useEffect, useRef, useState } from "react";
import type { BattleCommand } from "@life-sim/shared";
import { BattleFxLayer } from "./BattleFxLayer.js";
import type { BattleVM, StatusVM } from "@life-sim/shared";

export interface BattleBoardProps {
  /** 战斗展示模型（来自 `toBattleVM`，不含引擎规则细节）。 */
  battle: BattleVM;
  /** 资源条标签：来自模板 `labels.resources`；缺省回退 hp / mp。 */
  labels?: { hp?: string; mp?: string };
  /** 请求在飞：所有按钮置灰（引擎侧 busy 锁兜底，视觉也要一致）。 */
  busy?: boolean;
  /** 战斗命令（技能 / 道具 / 逃跑 / 空过），组件内部不发请求。 */
  onCommand: (command: BattleCommand) => void;
  /**
   * ADR-077：战斗结束后**不再**由宿主推进（那会让世界在最后一击的动画没播完时就前移）。
   * 结束态由组件自己渲染战评，玩家点「继续」时发 `{type:"leave"}`。
   */
  /**
   * 点开某条状态的详情（玩家 / 友军 / 敌人身上的都算）。
   * 不传 ⇒ 芯片只读（自定义前端没有浮层时也不会出现「点了没反应」）。
   */
  onSelectStatus?: (status: StatusVM) => void;
}

/**
 * 状态芯片（战斗内唯一实现：玩家、友军、敌人共用）。
 *
 * 战斗态一律换成语义色（增益绿 / 异常红 / 中性灰）：打法上先看这个，
 * 身份色（神话 / 传说）留在详情浮层里看。没有语义标签的纯天赋才退回身份色。
 */
function StatusChips({
  statuses,
  onSelect,
}: {
  statuses: readonly StatusVM[];
  onSelect?: (status: StatusVM) => void;
}) {
  if (statuses.length === 0) return null;
  return (
    <span className="enemy-status ls-battle-chips">
      {statuses.map((s) => {
        /**
         * 战斗芯片只读**正负**（一等字段，2026-11-20）：后端不再下发 `battleStyle`，
         * 也不再拿 tags 猜增益/异常。层数 `×N` 与名字同色（同一段文本）。
         */
        // 实线 = 天赋（身份），虚线 = 会掉的东西（修正 / 战斗状态），与个人页同一套语言。
        const cls = `ls-battle-status ls-tone--${s.polarity} ls-battle-status--${s.kind}`;
        /**
         * 战斗芯片**不写成长进度**（2026-11-24 用户裁决）：战中是「现在有什么效果」的时刻，
         * 进度是养成数据，去状态详情看（那里按阶梯展示 1/4 → 4/8 → 8/8 已完成）。
         */
        const label = s.stacks > 1 ? `${s.name} ×${s.stacks}` : s.name;
        return onSelect === undefined ? (
          <span key={s.id} className={cls}>
            {label}
          </span>
        ) : (
          <button key={s.id} type="button" className={cls} onClick={() => onSelect(s)}>
            {label}
          </button>
        );
      })}
    </span>
  );
}

/**
 * 战斗面板（事件区的 combat 分支）。
 *
 * 三条只读约束（都是引擎语义，前端不许自己重算）：
 *  - `canAct === false`（`cannot_act` 类状态压制，如眩晕）：引擎**不报错**，只记一行
 *    「你无法行动。」并跳过玩家动作、照常推进回合 ⇒ 前端必须主动告知，否则玩家看到的是
 *    「点了技能、什么都没变、回合没了」。用覆盖层盖住整个行动区，并保留一个「硬撑」出口
 *    （`{type:"pass"}`，不消耗 MP / 道具 / 冷却，只消耗一个战斗回合）。
 *  - `canUseItems === false`（`bound_items`）与 `canFlee === false`（`flee_not_allowed`）
 *    同样由投影层用与引擎**同一个**控制判定算出，这里只按结论置灰 + 写原因，不查状态表。
 *  - 逃跑按钮**常显但可禁用**（D-12）：不给按钮会让玩家以为「没有逃跑这个选项」。
 */

/** 我方资源条（生命 / 主资源 / 自定义）。整块可被「选自己」的按钮包住。 */
function PlayerResources({ resources }: { resources: BattleVM["player"]["resources"] }) {
  return (
    <>
      {resources.map((r) => {
        const max = Math.max(1, r.max);
        const danger = r.dangerAt > 0 && r.value / max <= r.dangerAt;
        const usePips = r.display === "pips" && r.max <= 12;
        const fillClass = r.key === "hp" ? "hp" : r.key === "mp" ? "mp" : "res";
        return (
          <div className="attr" key={r.key} data-key={r.key} data-tone={danger ? "danger" : "normal"}>
            <span className="attr-name">{r.label}</span>
            {usePips ? (
              <div className="ls-bar__pips" role="img" aria-label={`${r.label} ${r.value}/${r.max}`}>
                {Array.from({ length: Math.round(r.max) }, (_, i) => (
                  <span key={i} className={`ls-pip${i < Math.round(r.value) ? " is-filled" : ""}`} />
                ))}
              </div>
            ) : (
              <div className="bar">
                <div className={`bar-fill ${fillClass}`} style={{ width: `${(r.value / max) * 100}%` }} />
              </div>
            )}
            <span className="attr-value">
              {r.value}/{r.max}
            </span>
          </div>
        );
      })}
    </>
  );
}

/**
 * 战斗单位卡（敌 / 友 / 中立共用）。
 *
 * 两件事只在这里做：`tier === "minion"` 加小框类（ADR-012 D2），有专属资源池就画一条
 * （ADR-012 D9：术式储备这种「只有他会烧」的东西，不该在每个人头上画一条空槽）。
 */
function UnitCard({
  unit,
  kind,
  selected,
  onSelect,
  onSelectStatus,
}: {
  unit: BattleVM["enemies"][number];
  kind: "enemy" | "ally" | "neutral";
  selected?: boolean;
  onSelect?: (id: string) => void;
  onSelectStatus?: (status: StatusVM) => void;
}) {
  const cls = [
    kind,
    unit.tier === "minion" ? "minion" : "",
    !unit.alive ? "dead" : "",
    unit.departed === true ? "departed" : "",
    selected ? "targeting" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const body = (
    <>
      <strong>{unit.name}</strong>
      {unit.summonerName !== undefined && (
        <span className="unit-summoner">召唤者：{unit.summonerName}</span>
      )}
      {unit.deathReason !== undefined && <span className="unit-death-reason">{unit.deathReason}</span>}
      {unit.departed === true && <span className="unit-departed">已离场</span>}
      <div className="bar">
        <div className={`bar-fill ${kind}-hp`} style={{ width: `${(unit.hp / Math.max(1, unit.maxHp)) * 100}%` }} />
      </div>
      <span className="attr-value">
        {unit.hp}/{unit.maxHp}
      </span>
      {(unit.resources ?? []).length > 0 && (
        <div className="unit-res">
          {(unit.resources ?? []).map((r) => (
            <span className="unit-res-item" key={r.key}>
              <span className="unit-res-name">{r.label}</span>
              <div className="bar bar-sm">
                <div className="bar-fill res" style={{ width: `${(r.value / Math.max(1, r.max)) * 100}%` }} />
              </div>
              <span className="attr-value">
                {r.value}/{r.max}
              </span>
            </span>
          ))}
        </div>
      )}
      <StatusChips statuses={unit.statuses} {...(onSelectStatus !== undefined ? { onSelect: onSelectStatus } : {})} />
    </>
  );
  // 友军平时不可点选（不需要对它下指令）；只有存在「友军单体」技能时才变成可选目标
  // （ADR-012 D6 补）。没给 `onSelect` 就保持只读，旧前端行为不变。
  if (kind === "ally" && onSelect === undefined) return <div className={cls} data-unit-id={unit.id}>{body}</div>;
  return (
    <button className={cls} data-unit-id={unit.id} disabled={!unit.alive} onClick={() => onSelect?.(unit.id)}>
      {body}
    </button>
  );
}

export function BattleBoard({
  battle: b,
  busy = false,
  onCommand,
  onSelectStatus,
}: BattleBoardProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<string>("");
  /**
   * 友军目标（2026-11-20 用户裁决）：**开局不选**，`null` 就是「还没选」。
   *
   * 不能再用空串表示「自己」——那样「没选」与「选了自己」在契约上分不开。
   * 现在自己也是一个真实 id（`b.player.id`），由点击顶部状态框选中。
   */
  const [allyTarget, setAllyTarget] = useState<string | null>(null);

  /** 资源不足判定（ADR-003 D9）：与引擎同一份 costs 清单，前端不自己猜 MP。 */
  const valueOfResource = (key: string): number =>
    b.player.resources.find((r) => r.key === key)?.value ?? 0;
  const canPay = (costs: { resource: string; amount: number }[]): boolean =>
    costs.every((c) => valueOfResource(c.resource) >= c.amount);
  const costText = (costs: { label: string; amount: number }[]): string =>
    costs.length === 0 ? "无消耗" : costs.map((c) => `${c.label} ${c.amount}`).join(" · ");

  const locked = !b.over && !b.player.canAct;
  // 原因只从投影里已有的 statuses 读，不自造文案、不改引擎：眩晕的名字就来自模板。
  const stunName = b.player.statuses.find((s) => s.id === "stun")?.name;
  const [lockedTapped, setLockedTapped] = useState(false);
  useEffect(() => {
    if (!locked) setLockedTapped(false);
  }, [locked]);

  /**
   * 敌方目标池（ADR-012 D5）：中立与敌方**同侧** —— 对目标判定来说它本来就是一伙的
   * （`campsOf` 把中立并进双方的 `hostile`），所以 UI 也不再分成两个阵营。
   */
  const hostileUnits = [
    ...b.enemies.map((u) => ({ unit: u, kind: "enemy" as const })),
    ...b.neutrals.map((u) => ({ unit: u, kind: "neutral" as const })),
  ];
  const targets = hostileUnits.map((h) => h.unit).filter((e) => e.alive);
  // 开局自动选敌方第一个（用户 2026-11-20）；当前目标不在了就回落到首位。
  const effectiveTarget = target && targets.some((e) => e.id === target) ? target : targets[0]?.id;

  /**
   * 有友军单体技能时，友军卡片才变成可选目标（平时点它没有语义，不该变成可点）。
   * 友军**开局不选**（`null`）；自己与存活友军都算候选，选中的人不在了就回到「还没选」。
   */
  const needsAlly = b.player.skills.some((s) => s.target === "ally");
  const allyTargets = b.allies.filter((a) => a.alive);
  const effectiveAlly =
    allyTarget === b.player.id || allyTargets.some((a) => a.id === allyTarget) ? allyTarget : null;
  /** 再点一次同一只 = 取消（回到「还没选」），否则选完就没路可退。 */
  const toggleAllyTarget = (id: string): void =>
    setAllyTarget((cur) => (cur === id ? null : id));
  const allyTargetName =
    effectiveAlly === b.player.id
      ? "自己"
      : (allyTargets.find((a) => a.id === effectiveAlly)?.name ?? null);
  const enemyTargetName = targets.find((e) => e.id === effectiveTarget)?.name;

  return (
    <div className={`battle-body ${b.over ? "battle-over" : ""}`} ref={boardRef}>
      <div className="row">
        <h3>⚔ 战斗 · 第 {b.round} 回合</h3>
        {b.crits > 0 && <span className="tag crit">暴击 ×{b.crits}</span>}
        {b.over && (
          <span className={`tag ${b.over}`}>
            {b.over === "victory" ? "胜利" : b.over === "defeat" ? "败北" : "撤离"}
          </span>
        )}
      </div>

      {/*
        我方资源（ADR-003 D10：含自定义资源）。
        有友军单体技能时，这一块整体就是「选自己」的落点（用户 2026-11-20 裁决：
        去掉「自己」那张友军卡）。**不做差异化展示、不加提示文案** ——
        它就是资源面板，只是可点；选中与否由技能按钮与友军卡片的反馈说明。
        状态芯片仍独立可点（在按钮外面，不会误触）。
      */}
      <div
        className={`battle-self${needsAlly && effectiveAlly === b.player.id ? " is-selected" : ""}`}
        data-unit-id={b.player.id}
      >
        {needsAlly ? (
          <button
            type="button"
            className="battle-self__pick"
            onClick={() => setAllyTarget(b.player.id)}
            aria-pressed={effectiveAlly === b.player.id}
            aria-label="把友军单体技能的目标选为自己"
            title="选择自己为目标"
          >
            <PlayerResources resources={b.player.resources} />
          </button>
        ) : (
          <PlayerResources resources={b.player.resources} />
        )}
        {/*
          自身状态（2026-11-19 用户反馈「战斗时自己的状态没展示」）。
          数据一直在 `battle.player.statuses` 里（投影已把战斗内 + 世界层状态合并去重），
          只是这一块之前只画了两条资源条。
        */}
        <StatusChips
          statuses={b.player.statuses}
          {...(onSelectStatus !== undefined ? { onSelect: onSelectStatus } : {})}
        />
      </div>

      {b.allies.length > 0 && (
        <div className="ally-list">
          <span className="muted">友军</span>
          {b.allies
            .filter((a) => a.tier !== "minion")
            .map((a) => (
              <UnitCard
                key={a.id}
                unit={a}
                kind="ally"
                selected={needsAlly && a.departed !== true && effectiveAlly === a.id}
                {...(needsAlly && a.departed !== true ? { onSelect: toggleAllyTarget } : {})}
                {...(onSelectStatus !== undefined ? { onSelectStatus } : {})}
              />
            ))}
          {b.allies.some((a) => a.tier === "minion") && (
            <div className="minion-grid">
              {b.allies
                .filter((a) => a.tier === "minion")
                .map((a) => (
                  <UnitCard
                    key={a.id}
                    unit={a}
                    kind="ally"
                    selected={needsAlly && effectiveAlly === a.id}
                    {...(needsAlly ? { onSelect: toggleAllyTarget } : {})}
                    {...(onSelectStatus !== undefined ? { onSelectStatus } : {})}
                  />
                ))}
            </div>
          )}
        </div>
      )}

      {/*
        敌方与第三方**共用一个目标框**（用户 2026-11-20）：对目标判定来说中立与敌方同侧，
        UI 再分一个「第三方」阵营只会让人以为技能选不到它。中立卡保留自己的配色，
        选中态与敌方一致（红边）。
      */}
      <div className="enemy-list">
        {hostileUnits
          .filter(({ unit }) => unit.tier !== "minion")
          .map(({ unit, kind }) => (
            <UnitCard
              key={unit.id}
              unit={unit}
              kind={kind}
              selected={effectiveTarget === unit.id && unit.alive}
              onSelect={setTarget}
              {...(onSelectStatus !== undefined ? { onSelectStatus } : {})}
            />
          ))}
        {hostileUnits.some(({ unit }) => unit.tier === "minion") && (
          <div className="minion-grid">
            {hostileUnits
              .filter(({ unit }) => unit.tier === "minion")
              .map(({ unit, kind }) => (
                <UnitCard
                  key={unit.id}
                  unit={unit}
                  kind={kind}
                  selected={effectiveTarget === unit.id && unit.alive}
                  onSelect={setTarget}
                  {...(onSelectStatus !== undefined ? { onSelectStatus } : {})}
                />
              ))}
          </div>
        )}
      </div>

      {b.fallen.length > 0 && (
        <div className="fallen-list">
          <span className="muted">已退场</span>
          {b.fallen.map((unit) => (
            /**
             * 边框按**它自己的阵营**上色（2026-11-20 用户裁决）：
             * 以前这里写死 `kind="ally"`，于是敌方献祭的咒灵也是一圈蓝边，
             * 看起来像「我方损失」。中立同理（灰边）。
             */
            <UnitCard key={unit.id} unit={unit} kind={unit.side ?? "neutral"} />
          ))}
        </div>
      )}

      {!b.over && (
        <>
          <div className="battle-action-zone">
            <div className="battle-actions">
              {b.player.skills.map((skill) => {
                /**
                 * ADR-015：`seal` 由内核下发（判据就是 `canUseSkill`）。
                 * 有封印 ⇒ 置灰**并且在按钮上写出原因**：只置灰不说原因，
                 * 玩家只会得出「点了没反应」。
                 */
                const seal = skill.seal;
                /**
                 * 合法目标（2026-11-20）：**先选目标、再放技能；不是合法目标就不能放**。
                 *
                 * 判据全部来自内核下发的 `legalTargets`（`enemy` / `ally` 才有这份清单）：
                 * 前端只做 `includes`，不重算阵营、不自己读 DSL —— 否则 `legalTarget`
                 * 新增谓词时，面板和引擎会各说一套。
                 */
                const chosen =
                  skill.target === "ally"
                    ? effectiveAlly
                    : skill.target === "enemy"
                      ? effectiveTarget
                      : undefined;
                const targetIssue =
                  skill.legalTargets === undefined
                    ? undefined
                    : chosen === undefined || chosen === null
                      ? "请选择目标"
                      : skill.legalTargets.includes(chosen)
                        ? undefined
                        : "不是合法目标";
                const blocked =
                  busy ||
                  locked ||
                  seal !== undefined ||
                  skill.cooldownLeft > 0 ||
                  !canPay(skill.costs) ||
                  targetIssue !== undefined;
                const reason = seal?.text ?? targetIssue;
                return (
                <button
                  key={skill.id}
                  className={`action${seal !== undefined ? " is-sealed" : ""}${
                    targetIssue !== undefined ? " is-illegal" : ""
                  }`}
                  disabled={blocked}
                  aria-disabled={blocked}
                  {...(reason !== undefined
                    ? {
                        // 悬停解释要和按钮上的字对得上：封印优先；否则非法目标用 DSL 的解释。
                        title:
                          seal !== undefined
                            ? seal.text
                            : (skill.legalTargetNote ?? reason),
                      }
                    : {})}
                  onClick={() =>
                    onCommand({
                      type: "skill",
                      skillId: skill.id,
                      // 只有「单个敌人 / 单个友军」才传目标：`self` / `all_enemies` / `all_allies` / `none`
                      // 由引擎按声明决定收件人，前端多传一个 id 只会让「这一发到底打谁」变得可疑。
                      ...(chosen !== undefined && chosen !== null ? { targetInstanceId: chosen } : {}),
                    })
                  }
                >
                  <strong>{skill.name}</strong>
                  <span>
                    {costText(skill.costs)}
                    {skill.cooldownLeft > 0 ? ` · 冷却 ${skill.cooldownLeft}` : ""}
                  </span>
                  {reason !== undefined && <span className="action-seal">{reason}</span>}
                </button>
                );
              })}
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
              {/*
                跳过回合**常显**（2026-11-20 用户裁决）：资源不足、技能全灰、道具被禁、
                退路封死时，面板上会一个能点的都没有 —— 那不是「难」，是卡死。
                引擎的 `{type:"pass"}` 本来就不花 MP / 道具 / 冷却，只是以前只在
                `cannot_act` 覆盖层里露出一个入口，覆盖层之外无路可走。
              */}
              <button
                className="action pass"
                disabled={busy || locked}
                aria-disabled={busy || locked}
                onClick={() => onCommand({ type: "pass" })}
              >
                <strong>跳过回合</strong>
                <span>放弃这次行动，硬撑过去</span>
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
          <p className="muted target-hint">
            点敌人或第三方切换目标（当前：{enemyTargetName ?? "无"}）
            {needsAlly
              ? `；友军单体技能需先选目标：点友军卡片，或点自己的状态框（当前：${allyTargetName ?? "未选"}）`
              : ""}
          </p>
        </>
      )}

      {/*
        ADR-077：战斗结束 = 停在战斗界面。
        技能区换成战评，玩家点「继续」才发 leave（引擎在那一刻才收场 / 推进世界）。
        样式对齐「结束这一生」：一个虚线框的次要按钮，不做主色 CTA ——
        战评是给玩家看结果的，不是催他赶路。
      */}
      {b.over && (
        <section className="battle-eval" aria-label="战斗评价">
          <div className="battle-eval__head">
            <h4>战斗评价</h4>
            {b.evaluation?.grade !== undefined && (
              <span className="battle-eval__grade">{b.evaluation.grade}</span>
            )}
            <span className={`battle-eval__outcome ${b.over}`}>
              {b.over === "victory" ? "胜利" : b.over === "defeat" ? "败北" : "撤离"}
            </span>
          </div>

          {b.evaluation === undefined ? (
            <p className="battle-eval__hint">这一场没有留下战评（旧档或旧引擎）。</p>
          ) : (
            <>
              <div className="battle-eval__grid">
                <div>
                  <span>回合</span>
                  <b>{b.evaluation.rounds}</b>
                </div>
                <div>
                  <span>造成伤害</span>
                  <b>{b.evaluation.player.damageDealt}</b>
                </div>
                <div>
                  <span>承受伤害</span>
                  <b>{b.evaluation.player.damageTaken}</b>
                </div>
                <div>
                  <span>暴击</span>
                  <b>{b.evaluation.player.crits}</b>
                </div>
                <div>
                  <span>击破</span>
                  <b>{b.evaluation.player.kills}</b>
                </div>
              </div>

              {b.evaluation.enemies.length > 0 && (
                <ul className="battle-eval__enemies">
                  {b.evaluation.enemies.map((e) => (
                    <li key={e.ref}>
                      <span className="name">{e.name}</span>
                      <span className="meta">
                        {e.defeated ? "已击破" : "仍在"} · 输出 {e.damageByPlayer}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          <button className="battle-leave" disabled={busy} onClick={() => onCommand({ type: "leave" })}>
            继续
          </button>
        </section>
      )}

      {/* ADR-076：四层特效层。只负责画，判断全在投影期。 */}
      <BattleFxLayer fx={b.fx} boardRef={boardRef} />

      <div className="battle-log">
        {b.log.map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      </div>
    </div>
  );
}
