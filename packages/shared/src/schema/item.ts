import { z } from "zod";
import { EffectSchema, type Effect } from "./common.js";
import { EquipmentDefinitionFields, type DynamicModifierSpec } from "./equipment.js";

/**
 * 物品 Schema：消耗品/材料/关键物品/装备。
 * 使用效果为效果 DSL；战斗内/外可用性分开声明。
 *
 * 装备分支（协议 V2.1 §19 / R-EQ-01..06）：type: equipment 时必须声明
 * slot/category/quality，可带 dynamicModifier（统一动态补正，无 static|dynamic 二选一）。
 * 禁止字段（modifierMode / formula / expression / attributeModifiers.perStack 等）
 * 不静默忽略——加载期给出含字段路径与处理建议的可诊断错误。
 */

/** 物品全部合法键（含装备分支）；未知键在 refine 中逐个报错，不静默丢弃。 */
const ITEM_KEYS = [
  "id",
  "type",
  "name",
  "description",
  "stackable",
  "usableInBattle",
  "usableOutsideBattle",
  "use",
  "slot",
  "category",
  "quality",
  "dynamicModifier",
] as const;

/** 明确禁止的键与其诊断信息（出现即拒绝并给路径，不得静默忽略）。 */
const FORBIDDEN_ITEM_KEYS: Record<string, string> = {
  modifierMode:
    "装备词条统一动态补正，不提供 modifierMode（static|dynamic）二选一（R-EQ-04 / 协议 §19）；请删除该字段，固定值直接用 dynamicModifier preset: fixed 表达",
  formula: "装备不支持自由表达式公式（ADR-0001/0002 拒绝自由表达式 DSL）；请改用 dynamicModifier 的 preset 白名单",
  expression: "装备不支持自由表达式（ADR-0001/0002 拒绝自由表达式 DSL）；请改用 dynamicModifier 的 preset 白名单",
  attributeModifiers:
    "S3 #18 通用属性补正模型本轮不支持（含 perStack 按层数属性修正）；请改用 dynamicModifier 表达动态补正",
  perStack:
    "S3 #18 通用属性补正模型本轮不支持（perStack 按层数属性修正）；请改用 dynamicModifier 的 preset: stack-scaled",
};

const ItemShape = z
  .object({
    id: z.string().min(1),
    type: z.enum(["consumable", "material", "key", "equipment"]),
    name: z.string().min(1),
    description: z.string().optional(),
    stackable: z.boolean(),
    usableInBattle: z.boolean(),
    usableOutsideBattle: z.boolean(),
    use: z.array(EffectSchema).optional(),
    ...EquipmentDefinitionFields,
  })
  .passthrough();

/** 干净输出类型（不含 passthrough 的索引签名），transform 后的 Item 以此为准。 */
type ItemClean = {
  id: string;
  type: "consumable" | "material" | "key" | "equipment";
  name: string;
  description?: string;
  stackable: boolean;
  usableInBattle: boolean;
  usableOutsideBattle: boolean;
  use?: Effect[];
  slot?: string;
  category?: string;
  quality?: string;
  dynamicModifier?: DynamicModifierSpec;
};

export const ItemSchema = ItemShape.superRefine((item, ctx) => {
  const add = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

  // 未知键逐个报错（禁止键给专门诊断，其余给通用提示），绝不静默忽略
  for (const key of Object.keys(item)) {
    if ((ITEM_KEYS as readonly string[]).includes(key)) continue;
    const forbidden = FORBIDDEN_ITEM_KEYS[key];
    if (forbidden) add([key], forbidden);
    else add([key], `物品不支持的未知字段：${key}`);
  }
  // 嵌套的 attributeModifiers.perStack（S3 #18）
  const nested = (item as Record<string, unknown>).attributeModifiers;
  if (nested && typeof nested === "object" && "perStack" in (nested as object)) {
    add(["attributeModifiers", "perStack"], FORBIDDEN_ITEM_KEYS.attributeModifiers);
  }

  // 装备分支：必备字段 + 互斥校验
  if (item.type === "equipment") {
    if (!item.slot) add(["slot"], "type: equipment 必须声明 slot");
    if (!item.category) add(["category"], "type: equipment 必须声明 category");
    if (!item.quality) add(["quality"], "type: equipment 必须声明 quality");
    if (item.stackable && (item.dynamicModifier || item.slot)) {
      add(["stackable"], "装备不建议 stackable：实例携带本局状态（槽位/层数/耐久），叠加语义未定义");
    }
  } else {
    // 非装备物品不得携带装备字段，避免静默失效
    for (const key of ["slot", "category", "quality", "dynamicModifier"] as const) {
      if (item[key] !== undefined) add([key], `仅 type: equipment 可声明 ${key}`);
    }
  }

  // 消耗品仍必须有 use 效果
  if (item.type === "consumable" && !(item.use && item.use.length > 0)) {
    add(["use"], "consumable 物品必须定义 use 效果");
  }
}).transform((item) => {
  // 未知键已在 refine 报错；此处只保留合法键，保证输出类型干净
  const out: Record<string, unknown> = {};
  for (const key of ITEM_KEYS) {
    if (key in item) out[key] = item[key];
  }
  return out as ItemClean;
});

export type Item = ItemClean;
