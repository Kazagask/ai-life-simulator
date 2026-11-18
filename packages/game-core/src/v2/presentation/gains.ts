import type { TurnGain, UiConfig, WorldStateV2 } from "@life-sim/shared";
import type { TemplateLookup } from "../lookup.js";
import { resolveStyle } from "./style.js";
import { durationLabel, equipmentEffectSummaries, itemEffectSummaries, skillEffectSummaries, statusEffectSummaries } from "./effects.js";

/**
 * 回合增量（ADR-002 D4）：**基线 + 差分**，只走响应、不落库。
 *
 * 为什么不 clone 整个状态：`WorldStateV2` 里有 NPC 表、关系图、延时队列，
 * 整份 clone 的代价与世界规模成正比，而收获卡只关心玩家自己的五类字段。
 *
 * 为什么不写进 state：增量是「这一次结算发生了什么」的一次性事实，写进权威状态会引入
 * 派生字段（哪一轮的增量、要不要清理），与 ADR-002 D1 冲突。
 */
export interface GainBaseline {
  attributes: Record<string, number>;
  statuses: Array<{ id: string; stacks: number }>;
  skills: string[];
  inventory: Record<string, number>;
  equipment: Array<{ instanceId: string; itemId: string }>;
}

export function captureGainBaseline(state: WorldStateV2): GainBaseline {
  return {
    attributes: { ...state.player.attributes },
    statuses: state.player.statuses.map((s) => ({ id: s.statusId, stacks: s.stacks ?? 1 })),
    skills: [...state.player.skills],
    inventory: { ...state.player.inventory },
    equipment: (state.player.equipment ?? []).map((e) => ({ instanceId: e.instanceId, itemId: e.itemId })),
  };
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 差出本回合的收获。顺序固定（属性 → 补正 → 技能 → 物品 → 装备，同类按 id 排序），
 * 保证「同输入 ⇒ 同输出」，便于写断言与回放。
 */
export function diffGains(
  before: GainBaseline,
  after: WorldStateV2,
  lookup: TemplateLookup,
  ui?: UiConfig,
): TurnGain[] {
  const out: TurnGain[] = [];

  // ---- 属性：净值 ≠ 0 才出条目（同一条属性多段变化合并） ----
  const keys = new Set([...Object.keys(before.attributes), ...Object.keys(after.player.attributes)]);
  for (const key of [...keys].sort(byId)) {
    const prev = before.attributes[key] ?? 0;
    const next = after.player.attributes[key] ?? 0;
    if (next === prev) continue;
    out.push({
      category: "attribute",
      action: next > prev ? "up" : "down",
      id: key,
      name: lookup.attributeLabel(key),
      amount: next - prev,
    });
  }

  // ---- 补正：按 id 比层数（获得 / 失去 / 层数变化各一条） ----
  const prevStatus = new Map(before.statuses.map((s) => [s.id, s.stacks]));
  const nextStatus = new Map(after.player.statuses.map((s) => [s.statusId, s.stacks ?? 1]));
  for (const id of [...new Set([...prevStatus.keys(), ...nextStatus.keys()])].sort(byId)) {
    const prev = prevStatus.get(id);
    const next = nextStatus.get(id);
    if (prev === next) continue;
    const def = lookup.status(id);
    const style = resolveStyle(def?.style, def?.quality, ui, def?.polarity);
    out.push({
      category: "status",
      action: prev === undefined ? "gain" : next === undefined ? "lose" : next > prev ? "gain" : "lose",
      id,
      name: def?.name ?? id,
      stacks: next ?? 0,
      ...(def?.quality !== undefined ? { quality: def.quality } : {}),
      ...(style !== undefined ? { style } : {}),
      ...(def?.description !== undefined ? { description: def.description } : {}),
      ...(def !== undefined ? { effects: statusEffectSummaries(def, lookup), durationLabel: durationLabel(def) } : {}),
    });
  }

  // ---- 技能：集合差 ----
  const prevSkills = new Set(before.skills);
  const nextSkills = new Set(after.player.skills);
  for (const id of [...nextSkills].filter((s) => !prevSkills.has(s)).sort(byId)) {
    const def = lookup.skill(id);
    const style = resolveStyle(def?.style, def?.quality, ui);
    out.push({
      category: "skill",
      action: "gain",
      id,
      name: def?.name ?? id,
      ...(def?.quality !== undefined ? { quality: def.quality } : {}),
      ...(style !== undefined ? { style } : {}),
      ...(def?.description !== undefined ? { description: def.description } : {}),
      ...(def !== undefined ? { effects: skillEffectSummaries(def, lookup) } : {}),
    });
  }

  // ---- 物品：数量差 ----
  const itemKeys = new Set([...Object.keys(before.inventory), ...Object.keys(after.player.inventory)]);
  for (const id of [...itemKeys].sort(byId)) {
    const prev = before.inventory[id] ?? 0;
    const next = after.player.inventory[id] ?? 0;
    if (next === prev) continue;
    const def = lookup.item(id);
    const style = resolveStyle(def?.style, def?.quality, ui, def?.polarity);
    out.push({
      category: "item",
      action: next > prev ? "gain" : "lose",
      id,
      name: def?.name ?? id,
      amount: next - prev,
      ...(def?.quality !== undefined ? { quality: def.quality } : {}),
      ...(style !== undefined ? { style } : {}),
      ...(def?.description !== undefined ? { description: def.description } : {}),
      ...(def !== undefined
        ? { effects: def.type === "equipment" ? equipmentEffectSummaries(def, lookup) : itemEffectSummaries(def, lookup) }
        : {}),
    });
  }

  // ---- 装备：按实例 id 差（同一件换槽位不算变动） ----
  const prevEq = new Map(before.equipment.map((e) => [e.instanceId, e.itemId]));
  const nextEq = new Map((after.player.equipment ?? []).map((e) => [e.instanceId, e.itemId]));
  for (const instanceId of [...new Set([...prevEq.keys(), ...nextEq.keys()])].sort(byId)) {
    const prev = prevEq.get(instanceId);
    const next = nextEq.get(instanceId);
    if (prev === next) continue;
    const itemId = next ?? prev ?? "";
    const def = lookup.item(itemId);
    const style = resolveStyle(def?.style, def?.quality, ui, def?.polarity);
    out.push({
      category: "equipment",
      action: next !== undefined ? "equip" : "unequip",
      id: instanceId,
      name: def?.name ?? itemId,
      ...(def?.quality !== undefined ? { quality: def.quality } : {}),
      ...(style !== undefined ? { style } : {}),
      ...(def?.description !== undefined ? { description: def.description } : {}),
      ...(def !== undefined ? { effects: equipmentEffectSummaries(def, lookup) } : {}),
    });
  }

  return out;
}
