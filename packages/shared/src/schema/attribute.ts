import { z } from "zod";

/**
 * 属性类型协议（ADR-003 D1/D2）。
 *
 * 属性值放宽为 `number | string`，**类型不在值里**，而是由模板
 * `attributes.defs[id].kind` 声明；没有 def 的属性一律视为 `number`（零迁移）。
 *
 * 为什么要一张 defs 表而不是给每个值打 tag：属性名是模板词汇、类型是模板声明；
 * 把 tag 塞进每个值会让存档膨胀，也会让「旧档没有 tag」变成迁移问题。
 *
 * 四类：
 * - `number`：数值（缺省）；
 * - `enum`：文本，值是模板声明的选项 id，展示为带样式的 label；
 * - `ladder`：阶梯，数值 + 档位；`cumulative` 累计阈值 / `reset` 本档经验池；
 * - `composite`：只读派生称号，由若干数值属性按优先序规则表求值，**不落 state**。
 */

/**
 * 属性**角色**（ADR-074）：引擎需要知道「哪个属性是暴击率 / 闪避率 / 消耗修正」，
 * 但不该替世界决定它叫什么。模板在数值属性上声明 `role`，引擎按角色找；
 * 找不到 = 这个世界没有这条通道（不是错误）。
 *
 * 这三个是**模拟器概念**（任何世界都可能有暴击/闪避/消耗），不是某个作品的词。
 */
export const ATTRIBUTE_ROLE_IDS = ["critRate", "evadeRate", "mpCostRate"] as const;
export const AttributeRoleSchema = z.enum(ATTRIBUTE_ROLE_IDS);
export type AttributeRole = z.infer<typeof AttributeRoleSchema>;

export const ATTRIBUTE_KIND_IDS = ["number", "enum", "ladder", "composite"] as const;
export const AttributeKindSchema = z.enum(ATTRIBUTE_KIND_IDS);
export type AttributeKind = z.infer<typeof AttributeKindSchema>;

/** 属性值：数值或文本（文本只出现在 enum 上）。 */
export const AttributeValueSchema = z.union([z.number(), z.string().min(1)]);
export type AttributeValue = z.infer<typeof AttributeValueSchema>;

/** 只有这两类参与数值运算（公式 / 状态 / 上限 / 条件的大小比较）。 */
export function isNumericAttributeKind(kind: AttributeKind | undefined): boolean {
  return kind === undefined || kind === "number" || kind === "ladder";
}

/**
 * 数值属性的安全读取：非 number（文本属性 / 缺失）一律 0。
 *
 * 数值面（公式、上限、状态）不看模板也知道「文本不能参与算术」，
 * 所以这里用值类型兜底；「模板是否把文本属性写进了数值面」由加载期 fail-fast 负责。
 */
export function numericAttr(value: AttributeValue | undefined): number {
  return typeof value === "number" ? value : 0;
}

const EnumValueSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    /** 样式 id：引擎预设或模板 `ui.styles` 的键（ADR-002）。 */
    style: z.string().min(1).optional(),
  })
  .strict();

const LadderTierSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    /**
     * cumulative：累计阈值（首档必须 0，严格递增）；
     * reset：本档升到下一档所需（首档也写 0 会让第一档立刻升，故 reset 下首档的 at
     * 表示「从 0 升到下一档所需」，见 schema 注释）。
     */
    at: z.number().int().nonnegative(),
    style: z.string().min(1).optional(),
  })
  .strict();

/** 复合属性的单条规则：全部条件命中即采用该条（按声明顺序取首个）。 */
const CompositeCaseSchema = z
  .object({
    when: z.record(
      z.string().min(1),
      z
        .object({
          eq: z.union([z.number(), z.string().min(1)]).optional(),
          ne: z.union([z.number(), z.string().min(1)]).optional(),
          gte: z.number().optional(),
          lte: z.number().optional(),
        })
        .strict()
        .refine((c) => c.eq !== undefined || c.ne !== undefined || c.gte !== undefined || c.lte !== undefined, {
          message: "复合属性条件需要至少一个比较操作（eq/ne/gte/lte）",
        }),
    ),
    label: z.string().min(1),
    style: z.string().min(1).optional(),
  })
  .strict();

/**
 * 派生属性（ADR-074）：值**不落存档**，由其他属性的**最终值**按线性公式算出。
 *
 * 为什么需要它：暴击率（读某个属性）、闪避率（读某个属性）、mp 消耗修正（读某个属性）
 * 这类数字不是「原始天赋」，而是几个属性运算的结果。写死一个属性名进引擎，
 * 换个世界就得改代码；写成派生声明，引擎只负责拓扑序与循环检测。
 *
 * `value = base + Σ perPoint × 依赖属性的最终值`，再夹 `min/max`，
 * 最后叠加状态/装备对**这个派生属性本身**的 `attributeModifiers`。
 */
export const DerivedAttributeSpecSchema = z
  .object({
    base: z.number().optional(),
    from: z
      .array(
        z
          .object({
            attribute: z.string().min(1),
            perPoint: z.number(),
          })
          .strict(),
      )
      .min(1),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict();
export type DerivedAttributeSpec = z.infer<typeof DerivedAttributeSpecSchema>;

const NumberAttributeDefSchema = z
  .object({
    kind: z.literal("number"),
    hidden: z.boolean().optional(),
    /**
     * 允许负值。普通属性是「量」——负的资源没有意义，所以统一夹到 0（ADR-011 D2）；
     * 但「消耗修正 / 抗性」这类是**有符号的差值**，负值才是它的正常形态
     * （`mpCostRate: -37.5` = 便宜 37.5%）。
     */
    signed: z.boolean().optional(),
    /** 声明后该属性只读：面板/战斗都按依赖顺序现算，不能 set/adjust。 */
    derived: DerivedAttributeSpecSchema.optional(),
    /** 引擎通道角色（暴击率 / 闪避率 / mp 消耗修正）；同一模板内每个角色只能有一个属性。 */
    role: AttributeRoleSchema.optional(),
  })
  .strict();

const EnumAttributeDefSchema = z
  .object({
    kind: z.literal("enum"),
    hidden: z.boolean().optional(),
    values: z.array(EnumValueSchema).min(1),
  })
  .strict();

export const LadderAttributeDefSchema = z
  .object({
    kind: z.literal("ladder"),
    hidden: z.boolean().optional(),
    /** 缺省 cumulative。 */
    mode: z.enum(["cumulative", "reset"]).default("cumulative"),
    tiers: z.array(LadderTierSchema).min(1),
  })
  .strict();

const CompositeAttributeDefSchema = z
  .object({
    kind: z.literal("composite"),
    hidden: z.boolean().optional(),
    /** 来源属性 id：必须是数值属性（number / ladder）。 */
    sources: z.array(z.string().min(1)).min(1).max(3),
    cases: z.array(CompositeCaseSchema).min(1),
    /** 无命中时的兜底称号：必填，不允许「无名可显示」。 */
    fallback: z
      .object({ label: z.string().min(1), style: z.string().min(1).optional() })
      .strict(),
  })
  .strict();

/**
 * 四种属性类型。结构校验（档位单调、来源引用）放在 union 之后的 superRefine：
 * `z.discriminatedUnion` 只接受 ZodObject，不能直接放带 superRefine 的分支。
 */
export const AttributeDefSchema = z
  .discriminatedUnion("kind", [
    NumberAttributeDefSchema,
    EnumAttributeDefSchema,
    LadderAttributeDefSchema,
    CompositeAttributeDefSchema,
  ])
  .superRefine((def, ctx) => {
    if (def.kind === "ladder") {
      const seen = new Set<string>();
      def.tiers.forEach((t, i) => {
        if (seen.has(t.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tiers", i, "id"], message: `重复档位 id：${t.id}` });
        }
        seen.add(t.id);
        if (i > 0 && t.at <= def.tiers[i - 1].at) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tiers", i, "at"], message: "档位 at 必须严格递增" });
        }
      });
      if (def.mode === "cumulative") {
        if (def.tiers[0].at !== 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tiers", 0, "at"], message: "cumulative 首档 at 必须为 0" });
        }
      } else if (def.tiers[0].at <= 0) {
        // reset：at 是「本档升到下一档所需」，0 会让第一档凭 0 经验立刻升档。
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tiers", 0, "at"], message: "reset 首档 at 必须大于 0" });
      }
    }
    if (def.kind === "composite") {
      const sources = new Set(def.sources);
      if (sources.size !== def.sources.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sources"], message: "来源属性不得重复" });
      }
      def.cases.forEach((c, i) => {
        for (const key of Object.keys(c.when)) {
          if (!sources.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["cases", i, "when", key],
              message: `条件引用了未声明的来源属性：${key}`,
            });
          }
        }
      });
    }
  });
export type AttributeDef = z.infer<typeof AttributeDefSchema>;
export type EnumAttributeDef = z.infer<typeof EnumAttributeDefSchema>;
export type LadderAttributeDef = z.infer<typeof LadderAttributeDefSchema>;
export type CompositeAttributeDef = z.infer<typeof CompositeAttributeDefSchema>;

export const AttributeDefsSchema = z.record(z.string().min(1), AttributeDefSchema);
export type AttributeDefs = z.infer<typeof AttributeDefsSchema>;
