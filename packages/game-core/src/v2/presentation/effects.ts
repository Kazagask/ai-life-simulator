import { isAttributeModifier } from "@life-sim/shared";
import type {
  CombatDuration,
  EffectSummary,
  Formula,
  Item,
  SimulationDuration,
  Skill,
  StatusEffect,
  StatusInstance,
  TemplateEffect,
  UiConfig,
} from "@life-sim/shared";
import type { TemplateLookup } from "../lookup.js";
import { SimulationDurationSchema, summonLimitOfTier } from "@life-sim/shared";
import { minutesToAmount } from "../time.js";
import { fixedEffectCopy } from "./fixed-effects.js";
import {
  resolveEntityStyle,
  resolveEntityTags,
  resolveStyle,
  resolveTags,
  tagIdsOf,
} from "./style.js";

/**
 * 引用实体的详情快照：让「施加 力竭」在任意浮层里都能点开。
 *
 * `ui` 必须一路传下来：标签与自定义样式都定义在 `ui.yaml`，不传就只能解析引擎预设，
 * 模板自己写的标签会在浮层里凭空消失（玩家会以为「这个状态没标签」）。
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
    polarity?: "positive" | "negative" | "neutral";
  };
} {
  if (kind === "status") {
    const def = knownStatus(lookup, id);
    if (def === undefined) return {};
    const style = resolveEntityStyle(def, ui);
    const tags = resolveEntityTags(def, ui);
    return {
      refDetail: {
        title: def.name,
        ...(def.description !== undefined ? { description: def.description } : {}),
        effects: statusEffectSummaries(def, lookup, ui),
        // 时长**不在这里**（2026-11-20）：状态定义没有时长，实例才有；
        // 「这一发给多久」写在技能那一行自己身上（`施加 X（2 回合）`）。
        ...(style !== undefined ? { style } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        polarity: def.polarity,
      },
    };
  }
  if (kind === "item") {
    const def = lookup.item(id);
    if (def === undefined) return {};
    const style = resolveEntityStyle(def, ui);
    const tags = resolveEntityTags(def, ui);
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
  const style = resolveStyle(def.style, def.quality, ui, undefined, tagIdsOf(def));
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
 * 2. **动态状态只描述规则**：`3 + 0.2×力量` 而不是当前算出来的 7.4 —— 后者下一回合就是假话。
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

const TIME_UNIT_TEXT: Record<string, string> = {
  minute: "分钟",
  hour: "小时",
  day: "天",
  week: "周",
  month: "个月",
  year: "年",
};

/**
 * **施加点时长**的人话（ADR-018 D5）。
 *
 * 状态定义上已经没有时长——「多久」只存在于这次施加。所以这个函数要么收施加点的
 * `duration`，要么收实例（`remainingLabel`）；省略时长的（天赋 / 整场战斗）明说
 * 「直到被移除」，不许编。
 */
export function durationLabel(duration: SimulationDuration | CombatDuration): string {
  if ("rounds" in duration) return `${duration.rounds} 回合`;
  return `${duration.value} ${TIME_UNIT_TEXT[duration.unit] ?? duration.unit}`;
}

/**
 * 已挂状态的**剩余时长**（只有实例知道：绝对到期点 / 剩余回合）。
 *
 * `opts.inBattle`：同一条状态，在**战斗面板**上要说两件事（ADR-015 D2）——
 * ① 这一场里它一定会生效（战斗不推进世界时间，`expiresAt` 不会在战斗内到期）；
 * ② 打完之后它还欠多久（`expiresAt` 是绝对时刻，与这场战斗无关）。
 *
 * 不加这个口径的后果是截图里那种困惑：咒火挂着两天，战斗中打开详情写「还剩 2 天」，
 * 玩家会以为「打一场消耗两天」，或者「战斗里怎么还有天」。回合制状态（`roundsLeft`）
 * 本来就是战斗内计数，口径不变。
 */
export function remainingLabel(
  inst: StatusInstance,
  worldTime: number,
  opts?: { inBattle?: boolean },
): string {
  if (inst.expiresAt !== undefined) {
    const rest = minutesToAmount(Math.max(0, inst.expiresAt - worldTime));
    const text = `还剩 ${rest.value} ${TIME_UNIT_TEXT[rest.unit] ?? rest.unit}`;
    // 战斗内：先说「这一场不会掉」，再补上战后的余额。
    return opts?.inBattle === true ? `整场战斗有效（战后${text}）` : text;
  }
  if (inst.roundsLeft !== undefined) return `还剩 ${inst.roundsLeft} 回合`;
  return "直到被移除";
}

/**
 * 引用行：三段式（`lead` / `refName` / `trail`）+ 由它们拼出的 `text`。
 *
 * 三段是**唯一来源**：前端只给 `refName` 上样式，不再自己按标题在整句里找位置 ——
 * 文案改一个字（「施加」→「附加」）也不会让样式范围跟着漂。
 */
function refLine(
  lead: string,
  name: string,
  trail = "",
): Pick<EffectSummary, "text" | "lead" | "refName" | "trail"> {
  return { text: `${lead}${name}${trail}`, lead, refName: name, ...(trail !== "" ? { trail } : {}) };
}

/**
 * 玩家可见的状态定义（2026-11-20）：`visibility: hidden` 的状态**整条不拼**。
 *
 * 拼进技能行等于把隐藏情报（名字 + 效果）直接送到面板上；也不拼成「施加 未知效果」——
 * 那只是换一种说法告诉玩家「这里有个你查不到的东西」。
 */
function knownStatus(lookup: TemplateLookup, id: string): StatusEffect | undefined {
  const def = lookup.status(id);
  return def !== undefined && def.visibility === "known" ? def : undefined;
}

/** 状态 → 效果摘要（仿真面属性 / 行动效率 / 心情，战斗面控制 / 增减伤 / 命中 / 每回合）。 */
export function statusEffectSummaries(
  def: StatusEffect,
  lookup: TemplateLookup,
  ui?: UiConfig,
): EffectSummary[] {
  const out: EffectSummary[] = [];

  for (const [attr, value] of Object.entries(def.attributeModifiers ?? {})) {
    if (value === 0) continue;
    out.push({
      text: `${lookup.attributeLabel(attr)} ${num(value)}`,
      kind: "attr",
      tone: value > 0 ? "buff" : "debuff",
    });
  }
  /**
   * `simulation.actionEfficiency` 与 `eventConditionTag` **不上屏**（2026-11-20 裁决）：
   * 两者都还没有结算实现，拼出来就是向玩家承诺一个引擎不认的数字。
   * 协议字段保留，将来先实现结算再放回这里。
   */
  if (def.simulation?.moodDeltaPerTurn !== undefined && def.simulation.moodDeltaPerTurn !== 0) {
    const v = def.simulation.moodDeltaPerTurn;
    out.push({
      // 模拟面：**回合推进**时结算一次，与战斗回合无关（同一 panel 下两条「每回合」曾让玩家分不清）。
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
    /**
     * 战斗面的每一条都写明「战斗中」（用户 2026-11-20）：
     *
     * 同一条状态可能同时带模拟面与战斗面（咒火既是「体术 -1」也是「每回合掉 4 血」），
     * 两条都写「每回合」时，玩家没法知道哪一条是战斗回合、哪一条是世界的回合。
     * 模拟面（心情 / 属性）保留「每回合」= 回合推进，战斗面一律加前缀，两个域一眼可分。
     */
    if (combat.damageDealt !== undefined) {
      out.push({
        text: `战斗中造成伤害 ${pct(combat.damageDealt)}`,
        kind: "combat",
        tone: combat.damageDealt > 0 ? "buff" : "debuff",
      });
    }
    if (combat.damageTaken !== undefined) {
      out.push({
        text: `战斗中受到伤害 ${pct(combat.damageTaken)}`,
        kind: "combat",
        tone: combat.damageTaken > 0 ? "debuff" : "buff",
      });
    }
    if (combat.hitChance !== undefined) {
      out.push({
        text: `战斗中命中 ${pct(combat.hitChance)}`,
        kind: "combat",
        tone: combat.hitChance > 0 ? "buff" : "debuff",
      });
    }
    if (combat.evade !== undefined) {
      // 闪避是「命中之后再掷一次」的门，跟命中修正不是同一个数，不能混进上一行。
      out.push({
        text: `战斗中闪避 ${pct(combat.evade)}`,
        kind: "combat",
        tone: "buff",
      });
    }
    if (combat.crit?.chance !== undefined && combat.crit.chance > 0) {
      // 暴击是独立一层（ADR-073）：它不改命中，也不改伤害乘区，必须单独说。
      out.push({
        text: `战斗中暴击率 ${pct(combat.crit.chance)}`,
        kind: "combat",
        tone: "buff",
      });
    }
    if (combat.crit?.multiplier !== undefined && combat.crit.multiplier > 1) {
      out.push({
        text: `战斗中暴击倍率 ${combat.crit.multiplier.toFixed(2)}x`,
        kind: "combat",
        tone: "buff",
      });
    }
    for (const [resource, value] of Object.entries(combat.costMultiplier ?? {})) {
      // 「某资源消耗 -90%」改的是技能实际价格，必须在状态详情里说清楚。
      if (value === 0) continue;
      out.push({
        text: `战斗中${lookup.resourceLabel(resource)}消耗 ${pct(value)}`,
        kind: "cost",
        tone: value > 0 ? "debuff" : "buff",
      });
    }
    for (const round of combat.onRoundEnd ?? []) {
      if (round.damage !== undefined) {
        out.push({
          text: `战斗中每回合受到 ${formulaText(round.damage, lookup)} 点伤害`,
          kind: "combat",
          tone: "debuff",
        });
      }
      if (round.heal !== undefined) {
        out.push({
          text: `战斗中每回合恢复 ${formulaText(round.heal, lookup)} 点生命`,
          kind: "combat",
          tone: "buff",
        });
      }
      for (const app of round.applyStatus ?? []) {
        const statusDef = knownStatus(lookup, app.status);
        if (statusDef === undefined) continue;
        out.push({
          ...refLine("战斗中每回合施加 ", statusDef.name),
          kind: "apply",
          ref: { kind: "status", id: app.status },
          ...refDetailOf(lookup, "status", app.status, ui),
        });
      }
    }
  }

  /**
   * 战后折算（ADR-018 D4）：这条战斗态离场时会变成什么。
   * 玩家需要在**打之前**就知道「这一下会留疤」—— 藏在结算里等于事后告知。
   */
  if (def.toModifier !== undefined) {
    const after = knownStatus(lookup, def.toModifier.id);
    if (after !== undefined) {
      out.push({
        text: `战后转为「${after.name}」（每回合 ${durationLabel(def.toModifier.timePerRound)}）`,
        kind: "note",
        tone: "neutral",
      });
    }
  }

  return out;
}

/** 技能 → 效果摘要（战斗技能：消耗 / 目标 / 命中 / 伤害 / 治疗 / 施加状态 / 冷却）。 */
export function skillEffectSummaries(def: Skill, lookup: TemplateLookup, ui?: UiConfig): EffectSummary[] {
  const out: EffectSummary[] = [];
  if (def.kind === "combat") {
    /**
     * 消耗行只写**真的要付的钱**（2026-11-20 用户裁决）。
     *
     * `cost: { mp: 0 }` 在协议里是必填形状，但「这个世界没有 mp 这种资源」的模板里
     * 印成「消耗 0 点某种资源」既啰嗦又像是漏配。零消耗直接写「无消耗」；
     * 底层 `mp` 字段保留不动（它仍是成本表的一员，只是没人收）。
     */
    const paid = Object.entries(def.cost).filter(([, amount]) => amount > 0);
    out.push({
      text:
        paid.length === 0
          ? "无消耗"
          : `消耗 ${paid.map(([resource, amount]) => `${amount} ${lookup.resourceLabel(resource)}`).join(" · ")}`,
      kind: "cost",
    });
    out.push({ text: `目标：${TARGET_LABELS[def.target]}`, kind: "note" });
    if (def.hit === "guaranteed") {
      // 必中不是「命中率 100%」——它连闪避一起跳过，所以单独写一行，不跟百分比混排。
      out.push({ text: "必中：跳过命中判定与闪避", kind: "formula" });
    } else if (def.hitCheck !== undefined) {
      out.push({ text: `命中判定：基础 ${Math.round(def.hitCheck.baseChance * 100)}%`, kind: "formula" });
    }
    /**
     * 召唤参数是**技能**的（2026-11-20 用户裁决）：一次几只、这批多强。
     * 名额是**世界规则**（按档共用），单独一行说明归属 —— 都不进召唤物面板。
     */
    if (def.summon !== undefined) {
      const tier = def.summon.tier ?? "minion";
      const tierLimit = summonLimitOfTier(tier, lookup.template);
      const scale = def.summon.levelScale;
      out.push({
        text: `召唤 ${def.summon.count ?? 1} ${tier === "hero" ? "名" : "只"}${scale !== undefined ? ` · 强度 ×${scale}` : ""}`,
        kind: "note",
      });
      out.push({
        text: `名额：${tier === "hero" ? "英雄" : "杂兵"}档共用 ${tierLimit} 个位置`,
        kind: "note",
      });
    }
    if (def.recall !== undefined) {
      out.push({ text: `收回 ${def.recall.count ?? 1} 只召唤物`, kind: "note" });
    }
    if (def.damage !== undefined) out.push({ text: `伤害 ${formulaList(def.damage, lookup)}`, kind: "formula" });
    if (def.heal !== undefined) out.push({ text: `治疗 ${formulaList(def.heal, lookup)}`, kind: "formula" });
    for (const app of def.applyStatus ?? []) {
      /**
       * 「施加」必须写出收件人（ADR-006 D1）：同一个技能里可能一半挂在自己身上、
       * 一半挂在全体敌人身上（范围技能），不写就成了「谁被挂上了」全靠猜。
       *
       * 只有「跟技能目标」那一档省略 —— 上一行刚写过 `目标：…`，再重复一遍是噪音。
       */
      /**
       * 时长属于**这一次施加**（ADR-018 D5），所以写在技能这一行里，不塞进状态详情。
       * 收件人与时长共用一对括号：「（2 回合，自身）」；省略时长 = 整场战斗。
       */
      const statusDef = knownStatus(lookup, app.status);
      if (statusDef === undefined) continue;
      const durationText = app.duration === undefined ? "整场" : durationLabel(app.duration);
      const notes = [durationText, applyTargetLabel(app)].filter((t) => t !== "");
      const trail = `${app.stacks !== undefined ? ` ×${app.stacks}` : ""}${notes.length > 0 ? `（${notes.join("，")}）` : ""}`;
      out.push({
        ...refLine("施加 ", statusDef.name, trail),
        kind: "apply",
        ref: { kind: "status", id: app.status },
        ...refDetailOf(lookup, "status", app.status, ui),
      });
    }
    if (def.consumeStatus !== undefined) {
      const statusDef = knownStatus(lookup, def.consumeStatus.status);
      if (statusDef !== undefined) {
        out.push({
          ...refLine("消耗自身 ", statusDef.name),
          kind: "remove",
          ref: { kind: "status", id: def.consumeStatus.status },
          ...refDetailOf(lookup, "status", def.consumeStatus.status, ui),
        });
      }
    }
    /**
     * 冷却只在**真的有冷却**时才占一行（2026-11-20 用户裁决：「没有冷却就什么都不展示」）。
     *
     * `cooldownTurns` 在协议里是必填数字，多数模板写 0 —— 印成「冷却 0 回合」
     * 与「消耗 0 点资源」是同一类噪音：面板在描述一件永远不会发生的事。
     * 字段本身不动（它仍是结算的判据），只是零值不上屏。
     */
    if (def.cooldownTurns > 0) out.push({ text: `冷却 ${def.cooldownTurns} 回合`, kind: "cost" });
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

const TARGET_LABELS: Readonly<
  Record<"enemy" | "self" | "ally" | "all_allies" | "all_enemies" | "none", string>
> = {
  enemy: "单个敌人",
  self: "自身",
  ally: "单个友军",
  all_allies: "全体友军",
  all_enemies: "全体敌人",
  none: "无目标",
};

/**
 * 施加行的收件人后缀。`skill` 返回空串（上一行已经写了技能目标）；
 * `onSelf` 是旧写法，与 `target: self` 同义。
 */
function applyTargetLabel(app: {
  readonly target?: string | undefined;
  readonly onSelf?: boolean | undefined;
}): string {
  const target = app.target ?? (app.onSelf === true ? "self" : "skill");
  switch (target) {
    case "self":
      return "自身";
    case "all_enemies":
      return "全体敌人";
    case "all_allies":
      return "全体友方";
    default:
      return "";
  }
}

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
      const resource = str("resource");
      if (value === undefined || resource === undefined) return undefined;
      const label = lookup.resourceLabel(resource);
      return {
        text: `${value > 0 ? "恢复" : "损失"} ${Math.abs(value)} ${label}`,
        kind: "attr",
        tone: value > 0 ? "buff" : "debuff",
      };
    }
    case "setAttribute": {
      const attribute = str("attribute");
      const raw = e.value;
      if (attribute === undefined || (typeof raw !== "number" && typeof raw !== "string")) return undefined;
      const def = lookup.template.attributes.defs?.[attribute];
      const shown =
        typeof raw === "string"
          ? def?.kind === "enum"
            ? def.values.find((v) => v.id === raw)?.label ?? raw
            : raw
          : num(raw);
      return {
        text: `${lookup.attributeLabel(attribute)} ${shown}`,
        kind: "attr",
        tone: "neutral",
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
      // 这里的效果对象是宽松形状（值类型 unknown）⇒ 时长过一遍 schema 再上报。
      // 「这一次给多久」在事件效果里不是必填；这里只校验形状，不再塞进状态详情。
      SimulationDurationSchema.safeParse(e.duration);
      const statusDef = knownStatus(lookup, status);
      if (statusDef === undefined) return undefined;
      return {
        ...refLine("施加 ", statusDef.name, stacks !== undefined ? ` ×${stacks}` : ""),
        kind: "apply",
        ref: { kind: "status", id: status },
        ...refDetailOf(lookup, "status", status, ui),
      };
    }
    case "cureStatus": {
      const status = str("status");
      if (status === undefined) return undefined;
      const statusDef = knownStatus(lookup, status);
      if (statusDef === undefined) return undefined;
      return {
        ...refLine("移除 ", statusDef.name),
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
 * 装备 → 效果摘要。**动态状态只描述规则**（R-DETAIL-01 验收 3）：
 * 结算值随上下文变化，详情里给数字等于给假话。
 */
/**
 * 装备词条 → 效果摘要（2026-11-20：一件装备可以有多条，且分属性 / 战斗轴两支）。
 *
 * `label` 是词条的身份（「锋利」「缠」「强制解除术式」），数值只是它在这一件上的取值；
 * 没有 label 时整行只有数字，玩家分不清两条 +4 的区别。
 */
export function equipmentEffectSummaries(def: Item, lookup: TemplateLookup): EffectSummary[] {
  const out: EffectSummary[] = [];
  for (const mod of def.dynamicModifiers ?? []) {
    const lead = mod.label !== undefined ? `【${mod.label}】` : "";
    if (!isAttributeModifier(mod)) {
      const c = mod.combat;
      if (c.guaranteedHit === true) {
        out.push({ text: `${lead}攻击必中（无视命中与闪避）`, kind: "combat", tone: "buff" });
      }
      if (c.hitChance !== undefined) {
        out.push({ text: `${lead}命中 ${pct(c.hitChance)}`, kind: "combat", tone: "buff" });
      }
      if (c.evade !== undefined) {
        out.push({ text: `${lead}闪避 ${pct(c.evade)}`, kind: "combat", tone: "buff" });
      }
      if (c.damageDealt !== undefined) {
        out.push({ text: `${lead}造成伤害 ${pct(c.damageDealt)}`, kind: "combat", tone: "buff" });
      }
      if (c.damageTaken !== undefined) {
        out.push({
          text: `${lead}受到伤害 ${pct(c.damageTaken)}`,
          kind: "combat",
          tone: c.damageTaken > 0 ? "debuff" : "buff",
        });
      }
      continue;
    }
    const attr = lookup.attributeLabel(mod.attribute);
    const text =
      mod.preset === "fixed"
        ? `${lead}${attr} ${num(mod.params.value)}`
        : mod.preset === "scaled"
          ? `${lead}${attr} ${mod.params.base} + ${mod.params.multiplier}×${lookup.attributeLabel(mod.params.scaleBy)}（随成长）`
          : `${lead}${attr} ${mod.params.base} + ${mod.params.perStack}×${lookup.status(mod.params.status)?.name ?? mod.params.status}层数`;
    out.push({ text, kind: "attr", tone: "buff" });
  }
  return out;
}
