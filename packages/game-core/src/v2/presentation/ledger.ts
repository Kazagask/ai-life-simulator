import type { StatusTotalVM, StatusTotalSourceVM, V2Player, WorldStateV2 } from "@life-sim/shared";
import type { TemplateLookup } from "../lookup.js";
import { effectiveAttributesOfActor } from "../engine.js";

/**
 * 状态合计（ADR-018 D8）：**一张账本，一个出口**。
 *
 * 为什么需要它：状态的数值散在 `effectiveAttributes` / 战斗结算 / 装备 / 心情档位里各读各的，
 * 「我身上一共加了多少」没有任何地方能看见。面板上只列名字，玩家只能靠猜。
 *
 * 三条硬规矩：
 * 1. **账本必须就是结算用的那个数**，不是"再算一遍给 UI 看"。属性通道的 `total` 直接取
 *    `effectiveAttributes - 基础值`，与战斗/自由行动用的是同一次合成，所以不会与结算分叉。
 * 2. **必须包含装备与心情**：只累加状态的总值会撒谎。它们的贡献不重算（重算等于把
 *    `equipment.ts` 的条件求值抄第二遍），而是用「总值 − 状态合计」的**残差**表达，
 *    单列一行「装备 / 心情」。抄一份迟早抄歪，减法不会。
 * 3. **不下发零值通道**：竖屏空间有限，写「伤害 +0%」只增加噪音。
 *
 * 战斗通道（增减伤 / 命中 / 消耗 / 每回合 / 控制）只可能来自状态，所以是精确值。
 */

interface ChannelDraft {
  id: string;
  label: string;
  /** `attr` 数值 / `percent` 百分比 / `dot` 每回合伤害 / `control` 控制语义（文本） */
  format: "attr" | "percent" | "dot" | "control";
  total: number;
  sources: StatusTotalSourceVM[];
  controls?: string[];
}

const CONTROL_LABELS: Record<string, string> = {
  cannot_act: "无法行动",
  cannot_use_skills: "无法使用技能",
  cannot_use_items: "无法使用道具",
  cannot_attack: "无法攻击",
  cannot_flee: "无法逃走",
  forced_target_self: "强制以自己为目标",
};

export function statusTotalsOf(
  state: WorldStateV2,
  lookup: TemplateLookup,
  actor: V2Player = state.player,
): StatusTotalVM[] {
  const template = lookup.template;
  const channels: ChannelDraft[] = [];
  const base: Record<string, number> = {};
  for (const [key, value] of Object.entries(actor.attributes)) {
    if (typeof value === "number") base[key] = value;
  }

  // ---------- 属性：总值取真算出来的有效值，状态逐条归因，差额记「装备 / 心情」 ----------
  const eff = effectiveAttributesOfActor(state, lookup, actor);
  const attrStatusSum: Record<string, number> = {};
  for (const key of Object.keys(base)) {
    const sources: StatusTotalSourceVM[] = [];
    let sum = 0;
    for (const inst of actor.statuses) {
      const def = lookup.status(inst.statusId);
      const delta = def?.attributeModifiers?.[key];
      if (delta === undefined || delta === 0 || def?.visibility !== "known") continue;
      const value = delta * Math.max(1, inst.stacks);
      sum += value;
      attrStatusSum[key] = (attrStatusSum[key] ?? 0) + value;
      sources.push({ name: def.name, value, ...(inst.stacks > 1 ? { stacks: inst.stacks } : {}) });
    }
    const total = (eff[key] ?? base[key] ?? 0) - (base[key] ?? 0);
    if (total === 0) continue;
    const residual = total - sum;
    if (residual !== 0) sources.push({ name: "装备 / 心情", value: residual });
    channels.push({ id: `attr:${key}`, label: lookup.attributeLabel(key), format: "attr", total, sources });
  }

  // ---------- 战斗通道：只可能来自状态，精确 ----------
  const combatSum = (key: "damageDealt" | "damageTaken" | "hitChance" | "evade"): ChannelDraft | undefined => {
    const sources: StatusTotalSourceVM[] = [];
    let sum = 0;
    for (const inst of actor.statuses) {
      const def = lookup.status(inst.statusId);
      const raw = def?.combat?.[key];
      if (raw === undefined || raw === 0 || def?.visibility !== "known") continue;
      const value = def.combat?.stacksPerLayer === true ? raw * Math.max(1, inst.stacks) : raw;
      sum += value;
      sources.push({ name: def.name, value, ...(inst.stacks > 1 ? { stacks: inst.stacks } : {}) });
    }
    if (sum === 0) return undefined;
    return { id: `combat:${key}`, label: "", format: "percent", total: sum, sources };
  };

  const combatLabels: Array<[("damageDealt" | "damageTaken" | "hitChance" | "evade"), string]> = [
    ["damageDealt", "造成伤害"],
    ["damageTaken", "受到伤害"],
    ["hitChance", "命中"],
    ["evade", "闪避"],
  ];
  for (const [key, label] of combatLabels) {
    const channel = combatSum(key);
    if (channel !== undefined) channels.push({ ...channel, label });
  }

  // ---------- 资源消耗 ----------
  for (const resource of Object.keys(template.resources)) {
    const sources: StatusTotalSourceVM[] = [];
    let sum = 0;
    for (const inst of actor.statuses) {
      const def = lookup.status(inst.statusId);
      const raw = def?.combat?.costMultiplier?.[resource];
      if (raw === undefined || raw === 0 || def?.visibility !== "known") continue;
      const value = def.combat?.stacksPerLayer === true ? raw * Math.max(1, inst.stacks) : raw;
      sum += value;
      sources.push({ name: def.name, value, ...(inst.stacks > 1 ? { stacks: inst.stacks } : {}) });
    }
    if (sum === 0) continue;
    channels.push({
      id: `cost:${resource}`,
      label: `${lookup.resourceLabel(resource)}消耗`,
      format: "percent",
      total: sum,
      sources,
    });
  }

  // ---------- 每回合持续伤害 ----------
  let dot = 0;
  const dotSources: StatusTotalSourceVM[] = [];
  const controls = new Set<string>();
  for (const inst of actor.statuses) {
    const def = lookup.status(inst.statusId);
    if (def === undefined || def.visibility !== "known") continue;
    for (const round of def.combat?.onRoundEnd ?? []) {
      // 只汇总定值伤害：公式可能要属性/装备参与，面板上算一遍就会与战斗不一致。
      if (round.damage?.preset === "fixed") {
        dot += round.damage.value * Math.max(1, inst.stacks);
        dotSources.push({ name: def.name, value: round.damage.value * Math.max(1, inst.stacks) });
      }
    }
    for (const control of def.combat?.control ?? []) controls.add(control);
  }
  if (dot > 0) channels.push({ id: "dot", label: "每回合伤害", format: "dot", total: dot, sources: dotSources });
  if (controls.size > 0) {
    channels.push({
      id: "control",
      label: "行动限制",
      format: "control",
      total: controls.size,
      sources: [...controls].map((c) => ({ name: CONTROL_LABELS[c] ?? c, value: 0 })),
      controls: [...controls],
    });
  }

  return channels.map(({ controls: _ignored, ...rest }) => rest);
}
