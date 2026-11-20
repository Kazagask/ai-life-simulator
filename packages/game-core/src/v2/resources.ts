import {
  numericAttr,
  type AttributeValue,
  type RegenAmount,
  type V2Player,
  type WorldTemplateV2,
} from "@life-sim/shared";

/**
 * 「身上带资源的人」的最小结构（ADR-010 D1）。
 *
 * 玩家与 NPC 都能满足它：`V2Player` 的 `resources`/`growthLevel` 必填、`V2Npc` 的同名
 * 字段可选 —— 都可选化后是同一个形状。这样资源公式只有一份，不为 NPC 写第二套。
 */
export type ResourceHolder = Pick<V2Player, "hp" | "mp" | "attributes"> & {
  resources?: Record<string, number>;
  growthLevel?: number;
  /** 专属池上限（ADR-012 D9：来自 `characters[].resources`，不在 `template.resources` 里）。 */
  resourceMax?: Record<string, number>;
};

/**
 * 资源公式与自定义资源读写（ADR-003 D8/D9）。
 *
 * 为什么把 `computeMax` 放这里：资源上限公式同时服务 hp/mp 与自定义资源；
 * 放在 engine.ts 会让 resources → engine → resources 形成循环。
 * `engine.ts` 继续 re-export `computeMax`，既有调用点（战斗 / 测试）不用改。
 */

/**
 * 资源上限公式：`base + perLevel × growthLevel + Σ perAttribute[attr] × 基础属性值`。
 * 属性贡献使用**基础属性**（不含状态/心情档位修正）：上限若随临时状态波动，
 * 回血 clamp 与扣除语义都会漂移。
 */
export function computeMax(
  def: { base: number; perLevel?: number; perAttribute?: Record<string, number> },
  growthLevel: number,
  baseAttrs: Record<string, AttributeValue>,
  floor: number,
): number {
  let value = def.base + (def.perLevel ?? 0) * growthLevel;
  for (const [attr, coef] of Object.entries(def.perAttribute ?? {})) {
    value += coef * numericAttr(baseAttrs[attr]);
  }
  return Math.max(floor, Math.round(value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** 某个资源的当前上限（hp 下限 1，其余 0；cap 为硬顶）。缺 `growthLevel` 按 0。 */
export function resourceMax(holder: ResourceHolder, template: WorldTemplateV2, key: string): number {
  const def = template.resources[key];
  if (def === undefined) return 0;
  const floor = key === "hp" ? 1 : 0;
  const raw = computeMax(def, holder.growthLevel ?? 0, holder.attributes, floor);
  return def.cap !== undefined ? Math.max(floor, Math.min(raw, def.cap)) : raw;
}

/**
 * 战斗单位（敌人 / 友军）的资源上限（ADR-003 D12）。
 *
 * 敌人没有 `V2Player` 那套成长字段：`createBattle` 已把 `levelScale` 折进 `attributes`，
 * 所以这里 growthLevel 固定 0，与 `maxHpValue` / `maxMpValue` 的算法一致。
 */
export function combatUnitResourceMax(
  template: WorldTemplateV2,
  attributes: Record<string, AttributeValue>,
  key: string,
): number {
  const def = template.resources[key];
  if (def === undefined) return 0;
  const floor = key === "hp" ? 1 : 0;
  const raw = computeMax(def, 0, attributes, floor);
  return def.cap !== undefined ? Math.max(floor, Math.min(raw, def.cap)) : raw;
}

/**
 * 回复量求值（ADR-003 D12）：常数直接返回，加权式算 `base + Σ coef × 基础属性值`。
 *
 * 用**基础属性**：与资源上限 `perAttribute` 同口径，回复量不该被临时状态放大/缩小。
 * 结果四舍五入到整数；负数在 schema 已被拒，这里再兜一次 0。
 */
export function resolveRegenAmount(
  spec: RegenAmount | undefined,
  baseAttrs: Record<string, AttributeValue>,
): number {
  if (spec === undefined) return 0;
  if (typeof spec === "number") return Math.max(0, Math.round(spec));
  let value = spec.base;
  for (const [attr, coef] of Object.entries(spec.perAttribute ?? {})) {
    value += coef * numericAttr(baseAttrs[attr]);
  }
  return Math.max(0, Math.round(value));
}

/** 当前值：hp/mp 走同名字段，其余走 `resources` 映射（缺键 = 0）。 */
export function resourceValue(holder: ResourceHolder, key: string): number {
  if (key === "hp") return holder.hp;
  if (key === "mp") return holder.mp;
  return holder.resources?.[key] ?? 0;
}

/** 自定义资源的初始值：`initial` 缺省 = 上限，再按 [0, max] 夹取。 */
export function customResourceInitial(player: V2Player, template: WorldTemplateV2, key: string): number {
  const def = template.resources[key];
  if (def === undefined) return 0;
  const max = resourceMax(player, template, key);
  return clamp(Math.round(def.initial ?? max), 0, max);
}

/**
 * 建世界期初始化自定义资源（hp/mp 不进这个映射）。
 * 只在 `createWorldV2` 调用一次；旧档由 schema 默认 `{}` 承担。
 */
export function initPlayerResources(player: V2Player, template: WorldTemplateV2): void {
  player.resources = {};
  for (const key of Object.keys(template.resources)) {
    if (key === "hp" || key === "mp") continue;
    player.resources[key] = customResourceInitial(player, template, key);
  }
}

/**
 * 模拟域的资源增减：hp 下限 1（死亡线由战斗/结局承担），其余 0。
 *
 * 除 `template.resources` 的全局资源外，也认**专属池**（ADR-012 D9）：键与上限都来自
 * `characters[].resources`，所以「咒灵数量」这种只有某个人有的条也能被事件效果加减
 * （夏油做完一趟任务多吞一只咒灵 —— 这是唯一能涨的途径，它不随休息回补）。
 * 两边都不认识这个 key 时**不写**（加载期已拒载，这里只做防御）。
 */
export function adjustResourceValue(
  holder: ResourceHolder,
  template: WorldTemplateV2,
  key: string,
  delta: number,
): void {
  if (key === "hp") {
    if (template.resources.hp === undefined) return;
    holder.hp = clamp(holder.hp + delta, 1, resourceMax(holder, template, "hp"));
    return;
  }
  if (key === "mp") {
    if (template.resources.mp === undefined) return;
    holder.mp = clamp(holder.mp + delta, 0, resourceMax(holder, template, "mp"));
    return;
  }
  const exclusive = holder.resourceMax?.[key];
  const global = template.resources[key] !== undefined;
  if (!global && exclusive === undefined) return;
  const max = exclusive ?? resourceMax(holder, template, key);
  holder.resources ??= {};
  holder.resources[key] = clamp((holder.resources[key] ?? 0) + delta, 0, max);
}
