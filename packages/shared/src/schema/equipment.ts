import { z } from "zod";
import { ConditionSchema } from "./common.js";

/**
 * 装备分域 Schema（协议 V2.1 §19 / R-EQ-01..06）。
 *
 * 统一动态补正（用户决策 ③）：词条不是固化数值，而是每次结算时由
 * evaluateDynamicModifier(spec, ctx) 按当前状态求值；不提供
 * modifierMode: static|dynamic 二选一，不接受自由表达式（ADR-0001/0002）。
 *
 * 定义与实例分离：EquipmentInstance 只存本局状态（owner/slot/stacks/durability），
 * 不存任何补正结果字段（R-EQ-02 / P8）。
 */

// ---------- 槽位 ----------

export const EquipmentSlotSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    allowedCategories: z.array(z.string().min(1)).min(1),
    maxCount: z.number().int().positive(),
  })
  .strict();

export type EquipmentSlot = z.infer<typeof EquipmentSlotSchema>;

// ---------- 动态补正 spec ----------

/**
 * 动态补正 spec：preset 只取协议 §10 既有白名单（fixed / scaled / stack-scaled），
 * params 按 preset 形状 strict 校验。固定值即「无条件、无层数」的退化 preset，
 * 与其余 preset 走同一求值管线。
 *
 * `attribute`：该词条作用的属性 id（attributes.order 中声明）——
 * 求值结果要并入 effectiveAttributes 累加链必须知道目标属性；
 * 协议 §19 未显式列出该字段，此处为实现期补全（记入提交说明，规格文字待对齐）。
 */
const DynamicModifierBase = {
  /** 作用的属性 id */
  attribute: z.string().min(1),
  /** 生效条件（数组内 AND）；求值于每次属性结算，条件不命中则该词条当次不生效 */
  conditions: z.array(ConditionSchema).optional(),
};

const FixedModifierSchema = z
  .object({ ...DynamicModifierBase, preset: z.literal("fixed"), params: z.object({ value: z.number() }).strict() })
  .strict();

const ScaledModifierSchema = z
  .object({
    ...DynamicModifierBase,
    preset: z.literal("scaled"),
    params: z.object({ base: z.number(), scaleBy: z.string().min(1), multiplier: z.number() }).strict(),
  })
  .strict();

const StackScaledModifierSchema = z
  .object({
    ...DynamicModifierBase,
    preset: z.literal("stack-scaled"),
    params: z.object({ base: z.number(), perStack: z.number(), status: z.string().min(1) }).strict(),
  })
  .strict();

export const DynamicModifierSpecSchema = z.discriminatedUnion("preset", [
  FixedModifierSchema,
  ScaledModifierSchema,
  StackScaledModifierSchema,
]);

export type DynamicModifierSpec = z.infer<typeof DynamicModifierSpecSchema>;

/** 动态补正条件中禁止出现的条件种类（含自由求值/递归风险的守门，报错信息含字段路径）。 */
const FORBIDDEN_CONDITION_KINDS: Record<string, string> = {
  random: "装备动态补正条件不支持 random：属性求值管线不消费 RNG（R-NFR-01 同 seed 回放），请改用确定性条件",
  attribute: "装备动态补正条件不支持 attribute：条件求值发生在属性累加链内部，按属性条件判断会递归求值；如需属性门槛请在调用侧判断",
};

/**
 * 校验动态补正 spec 的跨字段引用（在 world.ts 顶层 superRefine 中调用，
 * 报错路径由调用方提供，本函数只负责产出诊断信息；返回 null 表示通过）。
 */
export function checkDynamicModifierSpec(
  spec: DynamicModifierSpec,
  ref: { attributeIds: Set<string>; statusIds: Set<string> },
): string | null {
  if (!ref.attributeIds.has(spec.attribute)) return `未知属性：${spec.attribute}`;
  if (spec.preset === "scaled" && !ref.attributeIds.has(spec.params.scaleBy)) {
    return `未知属性：${spec.params.scaleBy}`;
  }
  if (spec.preset === "stack-scaled" && !ref.statusIds.has(spec.params.status)) {
    return `未知补正：${spec.params.status}`;
  }
  for (const cond of spec.conditions ?? []) {
    for (const kind of Object.keys(FORBIDDEN_CONDITION_KINDS)) {
      if (kind in cond) return FORBIDDEN_CONDITION_KINDS[kind];
    }
    const attr = (cond as { attribute?: string }).attribute;
    if (attr && !ref.attributeIds.has(attr)) return `未知属性：${attr}`;
    const st = (cond as { status?: string }).status;
    if (st && !ref.statusIds.has(st)) return `未知补正：${st}`;
  }
  return null;
}

// ---------- 装备定义（items.yaml 的 type: equipment 分支共用字段形状） ----------

/** 装备定义在 ItemSchema 上展开的独有字段；未知字段由 item.ts 的白名单 refine 拒绝。 */
export const EquipmentDefinitionFields = {
  slot: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  quality: z.string().min(1).optional(),
  dynamicModifier: DynamicModifierSpecSchema.optional(),
};

// ---------- 运行时实例 ----------

export const EquipmentInstanceSchema = z
  .object({
    instanceId: z.string().min(1),
    itemId: z.string().min(1),
    ownerId: z.string().min(1),
    slot: z.string().min(1),
    /** 本局层数状态（R-EQ-02）；机械含义由模板/后续迭代定义，补正值不由它固化 */
    stacks: z.number().int().positive().optional(),
    /** 本局耐久状态（R-EQ-02） */
    durability: z.number().nonnegative().optional(),
  })
  .strict();

export type EquipmentInstance = z.infer<typeof EquipmentInstanceSchema>;

// ---------- equipment.yaml 分域 ----------

export const EquipmentConfigSchema = z
  .object({
    /** 品质白名单（模板可配）；声明后装备 quality 必须取值于此 */
    qualities: z.array(z.string().min(1)).optional(),
    slots: z.array(EquipmentSlotSchema).optional(),
    initialEquipment: z
      .array(z.object({ itemId: z.string().min(1) }).strict())
      .optional(),
  })
  .strict();

export type EquipmentConfig = z.infer<typeof EquipmentConfigSchema>;
