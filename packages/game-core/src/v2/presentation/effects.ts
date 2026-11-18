import type {
  EffectSummary,
  Formula,
  Item,
  Skill,
  StatusEffect,
  TemplateEffect,
  UiConfig,
} from "@life-sim/shared";
import type { TemplateLookup } from "../lookup.js";
import { fixedEffectCopy } from "./fixed-effects.js";
import { resolveStyle, resolveTags } from "./style.js";

/**
 * 引用实体的详情快照：让「施加 力竭」在任意浮层里都能点开。
 *
 * `ui` 必须一路传下来：标签与自定义样式都定义在 `ui.yaml`，不传就只能解析引擎预设，
 * 模板自己写的标签会在浮层里凭空消失（玩家会以为「这个补正没标签」）。
 */
function refDetailOf(
  lookup: TemplateLookup,
  kind: "status" | "item" | "skill",
  id: string,
  ui: UiConfig | undefined,
): {
  refDetail?: {
    title: string;
    description?: string;
    effects?: EffectSummary[];
    durationLabel?: string;
    style?: ReturnType<typeof resolveStyle>;
    tags?: ReturnType<typeof resolveTags>;
  };
} {
  if (kind === "status") {
    const def = lookup.status(id);
    if (def === undefined) return {};
    const style = resolveStyle(def.style, def.quality, ui, def.polarity, def.tags);
    const tags = resolveTags(def.tags, ui);
    return {
      refDetail: {
        title: def.name,
        ...(def.description !== undefined ? { description: def.description } : {}),
        effects: statusEffectSummaries(def, lookup, ui),
        durationLabel: durationLabel(def),
        ...(style !== undefined ? { style } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      },
    };
  }
  if (kind === "item") {
    const def = lookup.item(id);
    if (def === undefined) return {};
    const style = resolveStyle(def.style, def.quality, ui, def.polarity, def.tags);
    const tags = resolveTags(def.tags, ui);
    return {
      refDetail: {
        title: def.name,
        ...(def.description !== undefined ? { description: def.description } : {}),
        effects:
          def.type === "equipment"
            ? equipmentEffectSummaries(def, lookup)
            : itemEffectSummaries(def, lookup, ui),
        ...(style !== undefined ? { style } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      },
    };
  }
  const def = lookup.skill(id);
  if (def === undefined) return {};
  const style = resolveStyle(def.style, def.quality, ui);
  return {
    refDetail: {
      title: def.name,
      ...(def.description !== undefined ? { description: def.description } : {}),
      effects: skillEffectSummaries(def, lookup, ui),
      ...(style !== undefined ? { style } : {}),
    },
  };
}

/**
 * 效果摘要（ADR-002 D3）：把**定义**翻译成玩家能读的条目。
 *
 * 三条纪律：
 * 1. **只做展示**：不参与结算，不读运行时状态；同一定义永远得到同一串文本。
 * 2. **动态补正只描述规则**：`3 + 0.2×咒力` 而不是当前算出来的 7.4 —— 后者下一回合就是假话。
 * 3. **控制语义走引擎文案表**（`fixed-effects.ts`），`kind: "control"` ⇒ 前端加下划线。
 */

const pct = (v: number): string => `${v > 0 ? "+" : ""}${Math.round(v * 1000) / 10}%`;
const num = (v: number): string => `${v > 0 ? "+" : ""}${v}`;

/** 公式 → 人话（不含当前值，只描述规则）。 */
export function formulaText(f: Formula, lookup: TemplateLookup): string {
  switch (f.preset) {
    case "fixed":
      return `${f.value}`;
    case "scaled":
      return `${f.base} + ${f.multiplier}×${lookup.attributeLabel(f.scaleBy)}`;
    case "stack-scaled":
      return `${f.base} + ${f.perStack}×${lookup.status(f.status)?.name ?? f.status}层数`;
    default:
      return "—";
  }
}

function formulaList(list: readonly Formula[] | undefined, lookup: TemplateLookup): string {
  if (list === undefined || list.length === 0) return "—";
  return list.map((f) => formulaText(f, lookup)).join(" + ");
}

/**
 * 补正持续时间的人话（**不含「持续：」前缀**——展示层统一加，否则会读出
 * 「持续：持续到被移除」，用户 2026-11-18 截图里正是这句）。
 */
export function durationLabel(def: StatusEffect): string {
  return "turns" in def.duration ? `${def.duration.turns} 回合` : "直到被移除";
}

/** 补正 → 效果摘要（仿真面属性 / 行动效率 / 心情，战斗面控制 / 增减伤 / 命中 / 每回合）。 */
export function statusEffectSummaries(
  def: StatusEffect,
  lookup: TemplateLookup,
  ui?: UiConfig,
): EffectSummary[] {
  const out: EffectSummary[] = [];

  for (const [attr, value] of Object.entries(def.simulation?.attributeModifiers ?? {})) {
    if (value === 0) continue;
    out.push({
      text: `${lookup.attributeLabel(attr)} ${num(value)}`,
      kind: "attr",
      tone: value > 0 ? "buff" : "debuff",
    });
  }
  for (const [action, value] of Object.entries(def.simulation?.actionEfficiency ?? {})) {
    if (value === 0) continue;
    out.push({
      text: `${lookup.action(action)?.label ?? action} 效率 ${pct(value)}`,
      kind: "combat",
      tone: value > 0 ? "buff" : "debuff",
    });
  }
  if (def.simulation?.moodDeltaPerTurn !== undefined && def.simulation.moodDeltaPerTurn !== 0) {
    const v = def.simulation.moodDeltaPerTurn;
    out.push({
      text: `每回合 ${lookup.moodLabel()} ${num(v)}`,
      kind: "combat",
      tone: v > 0 ? "buff" : "debuff",
    });
  }

  const combat = def.combat;
  if (combat !== undefined) {
    for (const control of combat.control ?? []) {
      const copy = fixedEffectCopy(control);
      // note 给一句人话：只写「无法行动」玩家不知道是不是这一回合，说明补足语义。
      out.push({ text: copy.label, kind: "control", note: copy.hint });
    }
    if (combat.damageDealt !== undefined) {
      out.push({
        text: `造成伤害 ${pct(combat.damageDealt)}`,
        kind: "combat",
        tone: combat.damageDealt > 0 ? "buff" : "debuff",
      });
    }
    if (combat.damageTaken !== undefined) {
      out.push({
        text: `受到伤害 ${pct(combat.damageTaken)}`,
        kind: "combat",
        tone: combat.damageTaken > 0 ? "debuff" : "buff",
      });
    }
    if (combat.hitChance !== undefined) {
      out.push({
        text: `命中 ${pct(combat.hitChance)}`,
        kind: "combat",
        tone: combat.hitChance > 0 ? "buff" : "debuff",
      });
    }
    for (const round of combat.onRoundEnd ?? []) {
      if (round.damage !== undefined) {
        out.push({ text: `每回合受到 ${formulaText(round.damage, lookup)} 点伤害`, kind: "combat", tone: "debuff" });
      }
      if (round.heal !== undefined) {
        out.push({ text: `每回合恢复 ${formulaText(round.heal, lookup)} 点生命`, kind: "combat", tone: "buff" });
      }
      for (const app of round.applyStatus ?? []) {
        out.push({
          text: `每回合施加 ${lookup.status(app.status)?.name ?? app.status}`,
          kind: "apply",
          ref: { kind: "status", id: app.status },
          ...refDetailOf(lookup, "status", app.status, ui),
        });
      }
    }
  }

  return out;
}

/** 技能 → 效果摘要（战斗技能：消耗 / 目标 / 命中 / 伤害 / 治疗 / 施加补正 / 冷却）。 */
export function skillEffectSummaries(def: Skill, lookup: TemplateLookup, ui?: UiConfig): EffectSummary[] {
  const out: EffectSummary[] = [];
  if (def.kind === "combat") {
    out.push({ text: `消耗 ${def.cost.mp} ${lookup.resourceLabel("mp")}`, kind: "cost" });
    out.push({ text: `目标：${TARGET_LABELS[def.target]}`, kind: "note" });
    if (def.hitCheck !== undefined) {
      out.push({ text: `命中判定：基础 ${Math.round(def.hitCheck.baseChance * 100)}%`, kind: "formula" });
    }
    if (def.damage !== undefined) out.push({ text: `伤害 ${formulaList(def.damage, lookup)}`, kind: "formula" });
    if (def.heal !== undefined) out.push({ text: `治疗 ${formulaList(def.heal, lookup)}`, kind: "formula" });
    for (const app of def.applyStatus ?? []) {
      out.push({
        text: `施加 ${lookup.status(app.status)?.name ?? app.status}${app.stacks !== undefined ? ` ×${app.stacks}` : ""}`,
        kind: "apply",
        ref: { kind: "status", id: app.status },
        ...refDetailOf(lookup, "status", app.status, ui),
      });
    }
    if (def.consumeStatus !== undefined) {
      out.push({
        text: `消耗自身 ${lookup.status(def.consumeStatus.status)?.name ?? def.consumeStatus.status}`,
        kind: "remove",
        ref: { kind: "status", id: def.consumeStatus.status },
        ...refDetailOf(lookup, "status", def.consumeStatus.status, ui),
      });
    }
    out.push({ text: `冷却 ${def.cooldownTurns} 回合`, kind: "cost" });
    return out;
  }

  if (def.unlocksOptions !== undefined && def.unlocksOptions.length > 0) {
    out.push({ text: `解锁选项：${def.unlocksOptions.join(" / ")}`, kind: "note" });
  }
  if (def.efficiency !== undefined) {
    out.push({
      text: `${def.efficiency.key} 效率 ${pct(def.efficiency.bonus)}`,
      kind: "combat",
      tone: def.efficiency.bonus > 0 ? "buff" : "debuff",
    });
  }
  if (def.proficiency !== undefined) {
    out.push({ text: `熟练度上限 ${def.proficiency.maxLevel}（每次使用 +${def.proficiency.growthPerUse}）`, kind: "note" });
  }
  return out;
}

const TARGET_LABELS: Readonly<Record<"enemy" | "self" | "ally" | "all_enemies", string>> = {
  enemy: "单个敌人",
  self: "自身",
  ally: "友方",
  all_enemies: "全体敌人",
};

/** 物品 `use` 效果 → 人话（消耗品详情 / 收获卡详情共用）。 */
export function itemEffectSummaries(def: Item, lookup: TemplateLookup, ui?: UiConfig): EffectSummary[] {
  const out: EffectSummary[] = [];
  for (const effect of def.use ?? []) {
    const line = effectSummaryOf(effect, lookup, ui);
    if (line !== undefined) out.push(line);
  }
  return out;
}

function effectSummaryOf(
  effect: TemplateEffect,
  lookup: TemplateLookup,
  ui: UiConfig | undefined,
): EffectSummary | undefined {
  // `TemplateEffect` 是「闭合 DSL ∪ 开放形（catchall unknown）」的联合，字段类型不可直接读；
  // 这里按类型值逐项窄化，未知形态一律返回 undefined（展示层不该因为一条读不懂的效果崩掉）。
  const e = effect as unknown as Record<string, unknown>;
  const type = typeof e.type === "string" ? e.type : "";
  const value = typeof e.value === "number" ? e.value : undefined;
  const str = (key: string): string | undefined => (typeof e[key] === "string" ? (e[key] as string) : undefined);

  switch (type) {
    case "adjustResource": {
      const resource = str("resource") === "mp" ? "mp" : "hp";
      if (value === undefined) return undefined;
      const label = lookup.resourceLabel(resource);
      return {
        text: `${value > 0 ? "恢复" : "损失"} ${Math.abs(value)} ${label}`,
        kind: "attr",
        tone: value > 0 ? "buff" : "debuff",
      };
    }
    case "adjustAttribute": {
      const attribute = str("attribute");
      if (attribute === undefined || value === undefined) return undefined;
      return {
        text: `${lookup.attributeLabel(attribute)} ${num(value)}`,
        kind: "attr",
        tone: value > 0 ? "buff" : "debuff",
      };
    }
    case "adjustMood":
      if (value === undefined) return undefined;
      return {
        text: `${lookup.moodLabel()} ${num(value)}`,
        kind: "attr",
        tone: value > 0 ? "buff" : "debuff",
      };
    case "applyStatus": {
      const status = str("status");
      if (status === undefined) return undefined;
      const stacks = typeof e.stacks === "number" ? e.stacks : undefined;
      return {
        text: `施加 ${lookup.status(status)?.name ?? status}${stacks !== undefined ? ` ×${stacks}` : ""}`,
        kind: "apply",
        ref: { kind: "status", id: status },
        ...refDetailOf(lookup, "status", status, ui),
      };
    }
    case "cureStatus": {
      const status = str("status");
      if (status === undefined) return undefined;
      return {
        text: `移除 ${lookup.status(status)?.name ?? status}`,
        kind: "remove",
        ref: { kind: "status", id: status },
        ...refDetailOf(lookup, "status", status, ui),
      };
    }
    case "grantItem": {
      const itemId = str("itemId");
      const count = typeof e.count === "number" ? e.count : undefined;
      if (itemId === undefined) return undefined;
      return { text: `获得 ${lookup.item(itemId)?.name ?? itemId}${count !== undefined ? ` ×${count}` : ""}`, kind: "note" };
    }
    default:
      return undefined;
  }
}

/**
 * 装备 → 效果摘要。**动态补正只描述规则**（R-DETAIL-01 验收 3）：
 * 结算值随上下文变化，详情里给数字等于给假话。
 */
export function equipmentEffectSummaries(def: Item, lookup: TemplateLookup): EffectSummary[] {
  const mod = def.dynamicModifier;
  if (mod === undefined) return [];
  const attr = lookup.attributeLabel(mod.attribute);
  const text =
    mod.preset === "fixed"
      ? `${attr} ${num(mod.params.value)}`
      : mod.preset === "scaled"
        ? `${attr} ${mod.params.base} + ${mod.params.multiplier}×${lookup.attributeLabel(mod.params.scaleBy)}（随成长）`
        : `${attr} ${mod.params.base} + ${mod.params.perStack}×${lookup.status(mod.params.status)?.name ?? mod.params.status}层数`;
  return [{ text, kind: "attr", tone: "buff" }];
}
