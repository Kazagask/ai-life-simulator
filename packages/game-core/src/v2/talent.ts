import type { StatusEffect, StatusInstance, TalentTier } from "@life-sim/shared";

/**
 * 成长型天赋的读取层（ADR-075 §7）。
 *
 * 这里只有**纯函数**：阶判定、进度读取、以及"按实例取一份有效定义"。
 * 写入（`advanceTalent`）在 `engine.ts` —— 它要发 `grant` 效果，天然依赖效果分发，
 * 放这里会形成 engine ↔ talent 的循环。
 *
 * 为什么要 `statusFor`：阶效果是**替换**，同一个天赋在不同进度下其实是不同的"定义"。
 * 所有读 `attributeModifiers / combat / quality` 的地方都必须经过它，否则面板与结算会各读一份。
 */

export interface ActiveTalentTier {
  index: number;
  tier: TalentTier;
}

/** 当前进度（实例优先，其次定义上的 `initial`，缺省 0）。 */
export function talentProgressOf(def: StatusEffect, inst?: StatusInstance): number {
  if (inst?.progress !== undefined) return inst.progress;
  return def.progress?.initial ?? 0;
}

/** 当前阶：满足 `at <= progress` 的最高一阶；没有阶梯 / 一阶未到 ⇒ undefined。 */
export function activeTierOf(def: StatusEffect, inst?: StatusInstance): ActiveTalentTier | undefined {
  if (def.kind !== "talent" || def.tiers === undefined || def.tiers.length === 0) return undefined;
  const progress = talentProgressOf(def, inst);
  let index = -1;
  for (let i = 0; i < def.tiers.length; i += 1) {
    if (def.tiers[i]!.at <= progress) index = i;
    else break;
  }
  return index >= 0 ? { index, tier: def.tiers[index]! } : undefined;
}

/** 进度已经覆盖的阶数（用于 `applyStatus` 初始化 `tiersApplied`，防止旧阶被补发）。 */
export function settledTierCount(def: StatusEffect, progress: number): number {
  if (def.tiers === undefined) return 0;
  let count = 0;
  for (const tier of def.tiers) {
    if (tier.at <= progress) count += 1;
    else break;
  }
  return count;
}

/**
 * 按实例取有效定义：当前阶的 `attributeModifiers / combat / quality` 覆盖定义上的同名项。
 *
 * **按面覆盖，不是整体清空**：阶里写了属性面就换属性面，写了战斗面就换战斗面；
 * 没写的面沿用基础定义。否则「只改品质」的阶会把天赋自带的常驻钩子一并抹掉。
 * 同一面内是替换（要累加就把总数写在那一阶）—— 这是 ADR-075 §7 的口径。
 */
export function statusFor(
  def: StatusEffect | undefined,
  inst?: StatusInstance,
): StatusEffect | undefined {
  if (def === undefined) return undefined;
  const active = activeTierOf(def, inst);
  if (active === undefined) return def;
  const { effects, tier } = active.tier;
  return {
    ...def,
    ...(effects.attributeModifiers !== undefined ? { attributeModifiers: effects.attributeModifiers } : {}),
    ...(effects.combat !== undefined ? { combat: effects.combat } : {}),
    quality: tier,
  };
}
