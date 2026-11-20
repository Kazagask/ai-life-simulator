import type { AttributeValue, TurnGain, UiConfig, WorldStateV2 } from "@life-sim/shared";
import { numericAttr } from "@life-sim/shared";
import type { TemplateLookup } from "../lookup.js";
import { resolveEntityStyle, resolveEntityTags, resolveStyle, tagIdsOf } from "./style.js";
import { resolveAttributeView } from "./attributes.js";
import { equipmentEffectSummaries, itemEffectSummaries, remainingLabel, skillEffectSummaries, statusEffectSummaries } from "./effects.js";

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
  attributes: Record<string, AttributeValue>;
  /** reset 阶梯的档位基线（ADR-003 D4）：升档时数值会被扣掉，不能只看数值差分。 */
  attributeTiers: Record<string, string>;
  statuses: Array<{ id: string; stacks: number }>;
  skills: string[];
  inventory: Record<string, number>;
  equipment: Array<{ instanceId: string; itemId: string }>;
}

export function captureGainBaseline(state: WorldStateV2): GainBaseline {
  return {
    attributes: { ...state.player.attributes },
    attributeTiers: { ...(state.player.attributeTiers ?? {}) },
    statuses: state.player.statuses.map((s) => ({ id: s.statusId, stacks: s.stacks ?? 1 })),
    skills: [...state.player.skills],
    inventory: { ...state.player.inventory },
    equipment: (state.player.equipment ?? []).map((e) => ({ instanceId: e.instanceId, itemId: e.itemId })),
  };
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 差出本回合的收获。顺序固定（属性 → 状态 → 技能 → 物品 → 装备，同类按 id 排序），
 * 保证「同输入 ⇒ 同输出」，便于写断言与回放。
 */
export function diffGains(
  before: GainBaseline,
  after: WorldStateV2,
  lookup: TemplateLookup,
  ui?: UiConfig,
): TurnGain[] {
  const out: TurnGain[] = [];

  // ---- 属性（ADR-003）：按 kind 分派；hidden 属性不出条目（它只作为 composite 的输入） ----
  const keys = new Set([...Object.keys(before.attributes), ...Object.keys(after.player.attributes)]);
  const template = lookup.template;
  for (const key of [...keys].sort(byId)) {
    const def = template.attributes.defs?.[key];
    if (def?.hidden) continue;
    const prev = before.attributes[key];
    const next = after.player.attributes[key];

    if (def?.kind === "enum") {
      if (prev === next) continue;
      const prevView = resolveAttributeView(key, before.attributes, template, ui, before.attributeTiers);
      const nextView = resolveAttributeView(key, { ...after.player.attributes }, template, ui, after.player.attributeTiers);
      if (prevView?.display === nextView?.display) continue;
      out.push({
        category: "attribute",
        action: "set",
        id: key,
        name: lookup.attributeLabel(key),
        ...(nextView?.display !== undefined ? { value: nextView.display } : {}),
        ...(nextView?.style !== undefined ? { style: nextView.style } : {}),
      });
      continue;
    }

    if (def?.kind === "composite") {
      const prevView = resolveAttributeView(key, before.attributes, template, ui, before.attributeTiers);
      const nextView = resolveAttributeView(key, { ...after.player.attributes }, template, ui, after.player.attributeTiers);
      if (prevView?.display === nextView?.display) continue;
      out.push({
        category: "attribute",
        action: "set",
        id: key,
        name: lookup.attributeLabel(key),
        ...(nextView?.display !== undefined ? { value: nextView.display } : {}),
        ...(nextView?.style !== undefined ? { style: nextView.style } : {}),
      });
      continue;
    }

    if (def?.kind === "ladder" && def.mode === "reset") {
      // reset：升档时数值会被扣掉，展示「档位变化」而不是负数差分。
      const prevTier = before.attributeTiers[key];
      const nextTier = after.player.attributeTiers?.[key];
      if (prevTier !== nextTier) {
        const view = resolveAttributeView(key, { ...after.player.attributes }, template, ui, after.player.attributeTiers);
        out.push({
          category: "attribute",
          action: "set",
          id: key,
          name: lookup.attributeLabel(key),
          ...(view?.display !== undefined ? { value: view.display } : {}),
          ...(view?.style !== undefined ? { style: view.style } : {}),
        });
        continue;
      }
    }

    const prevNum = numericAttr(prev);
    const nextNum = numericAttr(next);
    if (nextNum === prevNum) continue;
    out.push({
      category: "attribute",
      action: nextNum > prevNum ? "up" : "down",
      id: key,
      name: lookup.attributeLabel(key),
      amount: nextNum - prevNum,
    });
  }

  // ---- 状态：按 id 比层数（获得 / 失去 / 层数变化各一条） ----
  const prevStatus = new Map(before.statuses.map((s) => [s.id, s.stacks]));
  const nextStatus = new Map(after.player.statuses.map((s) => [s.statusId, s.stacks ?? 1]));
  for (const id of [...new Set([...prevStatus.keys(), ...nextStatus.keys()])].sort(byId)) {
    const prev = prevStatus.get(id);
    const next = nextStatus.get(id);
    if (prev === next) continue;
    const def = lookup.status(id);
    const instance = after.player.statuses.find((s) => s.statusId === id);
    const style = resolveEntityStyle(def, ui);
    const tags = resolveEntityTags(def, ui);
    out.push({
      category: "status",
      action: prev === undefined ? "gain" : next === undefined ? "lose" : next > prev ? "gain" : "lose",
      id,
      name: def?.name ?? id,
      stacks: next ?? 0,
      ...(def?.quality !== undefined ? { quality: def.quality } : {}),
      ...(style !== undefined ? { style } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(def?.description !== undefined ? { description: def.description } : {}),
      ...(def !== undefined
        ? {
            effects: statusEffectSummaries(def, lookup, ui),
            // 时长只能从**实例**读（ADR-009）：定义上已经没有「多久」这回事了。
            // 天赋没有时钟（ADR-018 D1）⇒ 连这一行都不下发，否则「持续：直到被移除」
            // 会让玩家以为它会掉。
            ...(instance !== undefined && def.kind !== "talent"
              ? { durationLabel: remainingLabel(instance, after.worldTime) }
              : {}),
          }
        : {}),
    });
  }

  // ---- 技能：集合差 ----
  const prevSkills = new Set(before.skills);
  const nextSkills = new Set(after.player.skills);
  for (const id of [...nextSkills].filter((s) => !prevSkills.has(s)).sort(byId)) {
    const def = lookup.skill(id);
    const style = resolveStyle(def?.style, def?.quality, ui, undefined, tagIdsOf(def));
    out.push({
      category: "skill",
      action: "gain",
      id,
      name: def?.name ?? id,
      ...(def?.quality !== undefined ? { quality: def.quality } : {}),
      ...(style !== undefined ? { style } : {}),
      ...(def?.description !== undefined ? { description: def.description } : {}),
      ...(def !== undefined ? { effects: skillEffectSummaries(def, lookup, ui) } : {}),
    });
  }

  // ---- 物品：数量差 ----
  const itemKeys = new Set([...Object.keys(before.inventory), ...Object.keys(after.player.inventory)]);
  for (const id of [...itemKeys].sort(byId)) {
    const prev = before.inventory[id] ?? 0;
    const next = after.player.inventory[id] ?? 0;
    if (next === prev) continue;
    const def = lookup.item(id);
    const style = resolveEntityStyle(def, ui);
    const tags = resolveEntityTags(def, ui);
    out.push({
      category: "item",
      action: next > prev ? "gain" : "lose",
      id,
      name: def?.name ?? id,
      amount: next - prev,
      ...(def?.quality !== undefined ? { quality: def.quality } : {}),
      ...(style !== undefined ? { style } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(def?.description !== undefined ? { description: def.description } : {}),
      ...(def !== undefined
        ? { effects: def.type === "equipment" ? equipmentEffectSummaries(def, lookup) : itemEffectSummaries(def, lookup, ui) }
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
    const style = resolveEntityStyle(def, ui);
    const tags = resolveEntityTags(def, ui);
    out.push({
      category: "equipment",
      action: next !== undefined ? "equip" : "unequip",
      id: instanceId,
      name: def?.name ?? itemId,
      ...(def?.quality !== undefined ? { quality: def.quality } : {}),
      ...(style !== undefined ? { style } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(def?.description !== undefined ? { description: def.description } : {}),
      ...(def !== undefined ? { effects: equipmentEffectSummaries(def, lookup) } : {}),
    });
  }

  return out;
}
