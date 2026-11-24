import type {
  BattleEvent,
  BattleFxCast,
  BattleFxHit,
  BattleFxView,
  BattleState,
  FxEffect,
  FxOverride,
  FxPresentation,
  FxResult,
  ImpactPreset,
  TracePreset,
} from "@life-sim/shared";

/**
 * 战斗表现层的**唯一解析实现**（ADR-076 §1）。
 *
 * 为什么在投影期解析、而不是让前端各路自己合并：
 * 同一个暴击在手机、桌面、回放里必须是同一套结果；多端各算一遍必然漂移。
 * 前端拿到的每个字段都是终值，它只负责画。
 *
 * 级联（低 → 高，只覆盖**写了的字段**）：
 *   P0 引擎默认 → P1 `ui.presentation.defaults` → P2 `units[actorId]`
 *   → P3 `skills[skillId]` → P4 `hooks[hookId]`（改写这一击的钩子）→ P5 `events[eventId]`
 */

/** 语义色（P0 默认）。技能色只染轨迹，数字永远是这一套（ADR-076 §5）。 */
const SEMANTIC = {
  damage: "#FF6B7F",
  heal: "#58E3A7",
  buff: "#7EC6FF",
  debuff: "#B387FF",
  miss: "#A0A8B8",
  immune: "#E6C97A",
  /**
   * 献祭：紫（2026-11-24 用户裁决）。烧自己人换伤害，既不是治疗也不是增益 ——
   * 之前它和「减益」共用紫色是巧合，现在有名字了。
   */
  sacrifice: "#B387FF",
  /**
   * 兜底蓝：收灵 / 召唤 / 一切「既不是伤害、也不是治疗、也不是增益」的事件。
   * 没有这一档时，收灵会被当成伤害染成红色 —— 那是错的事实，不只是错的颜色。
   */
  spirit: "#6FA8FF",
} as const;

/** 字号 / 描边阶梯（ADR-076 §4.2 / §5）：粗细只表达强度，不表达种类。 */
const LADDER = {
  normal: { size: 28, stroke: 1.4 },
  crit: { size: 36, stroke: 1.8 },
  finisher: { size: 42, stroke: 2.4 },
} as const;

/**
 * 取模板定义（ADR-078）：命中 / 施放都只带 **id**，指向 `presentation.effects`。
 * 没定义的 id（内置几何）返回 undefined，渲染层走内置实现。
 */
function defOf(fx: FxPresentation | undefined, preset: string | null): FxEffect | undefined {
  if (fx === undefined || preset === null) return undefined;
  return fx.effects?.[preset];
}

/** 一个 cast 最多带几段（更早的没人看，白占快照体积）。 */
const MAX_CASTS = 6;

/** 逐层合并：只覆盖写了的键（`suffix` / `label` 做一层深合并）。 */
function mergeOverrides(list: Array<FxOverride | undefined>): FxOverride {
  const out: FxOverride = {};
  for (const layer of list) {
    if (!layer) continue;
    if (layer.cast) out.cast = { ...out.cast, ...layer.cast };
    if (layer.trace) out.trace = { ...out.trace, ...layer.trace };
    if (layer.impact) out.impact = { ...out.impact, ...layer.impact };
    if (layer.result) {
      out.result = {
        ...out.result,
        ...layer.result,
        ...(layer.result.suffix ? { suffix: { ...out.result?.suffix, ...layer.result.suffix } } : {}),
        ...(layer.result.label ? { label: { ...out.result?.label, ...layer.result.label } } : {}),
        ...(layer.result.critLabel ? { critLabel: { ...out.result?.critLabel, ...layer.result.critLabel } } : {}),
      };
    }
  }
  return out;
}

function overridesFor(
  fx: FxPresentation | undefined,
  keys: { actorId: string; skillId?: string; hookId?: string; eventId: string },
): FxOverride {
  if (!fx) return {};
  return mergeOverrides([
    fx.defaults,
    fx.units?.[keys.actorId],
    keys.skillId !== undefined ? fx.skills?.[keys.skillId] : undefined,
    keys.hookId !== undefined ? fx.hooks?.[keys.hookId] : undefined,
    fx.events?.[keys.eventId],
  ]);
}

/** 后缀阶梯（ADR-076 §6）：`!` 暴击，`!!` 被钩子放大 —— 文本由模板给，内核只给档位。 */
function suffixOf(critTier: 1 | 2 | undefined, result: FxResult): string {
  if (critTier === 2) return result.suffix?.critTier2 ?? "!!";
  if (critTier === 1) return result.suffix?.crit ?? "!";
  return "";
}

function labelsOf(critTier: 1 | 2 | undefined, hookId: string | undefined, result: FxResult): BattleFxHit["labels"] {
  const out: BattleFxHit["labels"] = [];
  const hookLabel = critTier === 2 ? result.label : undefined;
  const hookLabelled = hookLabel?.text !== undefined;
  if (hookLabel !== undefined && hookLabel.text !== undefined) {
    out.push({
      id: hookId ?? "hook",
      text: hookLabel.text,
      ...(hookLabel.latin !== undefined ? { latin: hookLabel.latin } : {}),
    });
  }
  /**
   * 放大暴击已经有钩子自己的 `label` 时，**不再叠 `critLabel`**：
   * 两条会压在同一块，而且信息重复 —— 钩子的名字本身就说明这是一次被放大的暴击。
   */
  if (critTier !== undefined && result.critLabel?.text !== undefined && !hookLabelled) {
    out.push({
      id: "crit",
      text: result.critLabel.text,
      ...(result.critLabel.latin !== undefined ? { latin: result.critLabel.latin } : {}),
    });
  }
  return out;
}

function hitOf(
  event: Exclude<BattleEvent, { kind: "hook" }>,
  merged: FxOverride,
): BattleFxHit | null {
  const seq = event.seq ?? 0;
  const result = merged.result ?? {};
  const impactPreset = (merged.impact?.preset ?? null) as ImpactPreset | null;

  if (event.kind === "summon") {
    // 登场：目标就是新生成的那只，没有数字（ADR-076 §3.7）
    return {
      seq,
      targetId: event.summonId,
      kind: "summon",
      outcome: "hit",
      color: SEMANTIC.spirit,
      size: 0,
      stroke: 0,
      labels: [],
      impact: (impactPreset ?? "arrive") as ImpactPreset,
    };
  }

  if (event.kind === "recall") {
    return {
      seq,
      targetId: event.target,
      kind: "depart",
      outcome: "hit",
      color: SEMANTIC.spirit,
      // 收灵是**把东西拉回来**：轨迹方向与普通攻击相反
      reverse: true,
      size: 0,
      stroke: 0,
      labels: [],
      impact: (impactPreset ?? "depart") as ImpactPreset,
    };
  }

  if (event.kind === "miss") {
    // 未命中：没有受击段（impact = null）。前端据此画断线 / 斩空 + MISS
    return {
      seq,
      targetId: event.target,
      kind: "miss",
      outcome: "miss",
      color: SEMANTIC.miss,
      size: LADDER.normal.size,
      stroke: LADDER.normal.stroke,
      labels: [],
      impact: null,
    };
  }

  if (event.kind === "cancel") {
    if (event.target === undefined) return null;
    return {
      seq,
      targetId: event.target,
      kind: "immune",
      outcome: "immune",
      color: SEMANTIC.immune,
      size: LADDER.normal.size,
      stroke: LADDER.normal.stroke,
      labels: [],
      impact: (impactPreset ?? "shield") as ImpactPreset,
    };
  }

  if (event.kind === "sacrifice") {
    // 献祭：没有数字、没有轨迹，只有消散（漩涡第一段）
    return {
      seq,
      targetId: event.target,
      kind: "sacrifice",
      outcome: "hit",
      color: SEMANTIC.sacrifice,
      size: 0,
      stroke: 0,
      labels: [],
      impact: "dissolve",
    };
  }

  if (event.kind === "buff") {
    // 增益 / 减益：没有数字、没有受击，只有一条「往身上收」的轨迹。
    // 颜色按 2026-11-23 用户裁决：增益红（与伤害同色），减益紫。
    return {
      seq,
      targetId: event.target,
      kind: "buff",
      outcome: "hit",
      color: event.polarity === "negative" ? SEMANTIC.debuff : SEMANTIC.damage,
      size: 0,
      stroke: 0,
      labels: [],
      impact: null,
    };
  }

  const heal = event.kind === "heal";
  const critTier = event.kind === "damage" ? event.critTier : undefined;
  const tier = critTier === 2 ? LADDER.finisher : critTier === 1 ? LADDER.crit : LADDER.normal;
  const hookId = event.kind === "damage" ? event.amplifiedBy : undefined;

  return {
    seq,
    targetId: event.target,
    kind: heal ? "heal" : "damage",
    outcome: "hit",
    amount: event.amount,
    text: `${heal ? "+" : "-"}${event.amount}${suffixOf(critTier, result)}`,
    ...(critTier !== undefined ? { critical: true, critTier } : {}),
    color: heal ? SEMANTIC.heal : SEMANTIC.damage, // 数字不染色
    size: result.sizePx ?? tier.size,
    stroke: result.strokePx ?? tier.stroke,
    labels: labelsOf(critTier, hookId, result),
    impact: (impactPreset ?? (heal ? "none" : "burst")) as ImpactPreset,
  };
}

type Group = {
  actorId: string;
  skillId?: string;
  events: Array<Exclude<BattleEvent, { kind: "hook" }>>;
};

/**
 * `BattleState.events` → 四层 VM。
 *
 * 分组规则：**同一 actor + 同一 skillId + 连续 seq** 才算一次施放。
 * 用 seq 连续而不是「同一 actor」：一场里同一角色会连打两招，只按 actor 合并会把两招
 * 并成一段动画；而多目标技能的事件本来就是连续 seq，正好归一段。
 */
export function resolveBattleFx(battle: BattleState, fx: FxPresentation | undefined): BattleFxView {
  const all = battle.events ?? [];
  const groups: Group[] = [];

  for (const event of all) {
    if (event.kind === "hook") continue; // 纯日志行，不单独成段
    const seq = event.seq ?? 0;
    const prev = groups.at(-1);
    const prevLast = prev?.events.at(-1);
    const contiguous = prevLast !== undefined && (prevLast.seq ?? 0) === seq - 1;
    /**
     * 分段的另一半：**同一回合**。
     * 只按「actor + skillId + 连续 seq」分，会让「连续两轮用同一招」并成一段 ——
     * 木桩不回击时两轮之间一条事件都没有，seq 正好连上，于是每打一次就把上一次重播一遍。
     * 旧档没有 `round`（两边都 undefined），退回老行为。
     */
    const prevRound = (prevLast as { round?: number } | undefined)?.round;
    const sameRound = prevRound === undefined || event.round === undefined || prevRound === event.round;
    if (prev !== undefined && prev.actorId === event.actor && prev.skillId === event.skillId && contiguous && sameRound) {
      prev.events.push(event);
    } else {
      groups.push({
        actorId: event.actor,
        ...(event.skillId !== undefined ? { skillId: event.skillId } : {}),
        events: [event],
      });
    }
  }

  const casts: BattleFxCast[] = [];
  for (const group of groups) {
    // P4 的键取「这一组里第一个放大暴击的钩子」：同一施放里各目标的钩子通常一致
    const hookId = group.events.find((e): e is Extract<BattleEvent, { kind: "damage" }> => e.kind === "damage" && e.amplifiedBy !== undefined)?.amplifiedBy;
    const merged = overridesFor(fx, {
      actorId: group.actorId,
      ...(group.skillId !== undefined ? { skillId: group.skillId } : {}),
      ...(hookId !== undefined ? { hookId } : {}),
      eventId: battle.eventId,
    });

    const hits = group.events
      .map((event) => hitOf(event, merged))
      .filter((h): h is BattleFxHit => h !== null);
    if (hits.length === 0) continue;
    for (const hit of hits) {
      const impactDef = defOf(fx, hit.impact);
      if (impactDef !== undefined) hit.def = impactDef;
    }

    const heal = hits.every((h) => h.kind === "heal");
    /**
     * `summon` 没有轨迹（登场即到达）；`depart` **有**（收灵要把那只拉回来）。
     * 以前两者都归到 `none`，收灵就变成「凭空消失一下」——用户报的「没有箭头轨迹」。
     */
    const summonish = hits.every((h) => h.kind === "summon" || h.kind === "sacrifice");
    const allSelf = hits.every((h) => h.targetId === group.actorId);
    const traceDefault: TracePreset = summonish
      ? "none"
      : allSelf
        ? "updraft" // 自己对自己：没有飞行，只有上升
        : hits.length > 1
          ? "fan"
          : "arrow";
    /**
     * 施放级轨迹色：非伤害段用**这一击自己的语义色**（治疗绿 / 增益红 / 献祭紫 / 收灵蓝），
     * 伤害段才用伤害红。以前只要不是治疗一律红，收灵也被染成红色。
     */
    const traceColor = merged.trace?.color ?? (heal ? SEMANTIC.heal : hits[0]!.kind === "damage" ? SEMANTIC.damage : hits[0]!.color);

    // 逐目标轨迹：全体治疗要「自己上行 + 友军扇形」，一条 cast 级轨迹表达不了。
    for (const hit of hits) {
      const selfHit = hit.targetId === group.actorId;
      hit.trace = {
        preset:
          hit.kind === "summon"
            ? "none"
            : hit.kind === "sacrifice"
              ? hits.length > 1
                ? "fan"
                : "arrow"
            : selfHit
              ? "updraft"
              : hits.length > 1
                ? "fan"
                : "arrow",
        color: merged.trace?.color ?? hit.color,
      };
      const hitTraceDef = defOf(fx, hit.trace.preset);
      if (hitTraceDef !== undefined) hit.trace = { ...hit.trace, def: hitTraceDef };
    }

    casts.push({
      seq: hits.at(-1)!.seq,
      eventId: battle.eventId,
      actorId: group.actorId,
      ...(group.skillId !== undefined ? { skillId: group.skillId } : {}),
      cast: {
        preset: merged.cast?.preset ?? null,
        color: merged.cast?.color ?? traceColor,
        durationMs: merged.cast?.durationMs ?? 0,
        ...(defOf(fx, merged.cast?.preset ?? null) !== undefined
          ? { def: defOf(fx, merged.cast?.preset ?? null)! }
          : {}),
      },
      trace: {
        preset: merged.trace?.preset ?? traceDefault,
        color: traceColor,
        width: merged.trace?.width ?? 2,
        durationMs: merged.trace?.durationMs ?? 300,
        ...(defOf(fx, merged.trace?.preset ?? traceDefault) !== undefined
          ? { def: defOf(fx, merged.trace?.preset ?? traceDefault)! }
          : {}),
      },
      hits,
    });
  }

  return {
    seq: battle.eventSeq ?? all.at(-1)?.seq ?? 0,
    casts: casts.slice(-MAX_CASTS),
  };
}
