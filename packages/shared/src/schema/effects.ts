import { z } from "zod";
import { ResolvedStyleSchema } from "./style.js";

/**
 * 表现层数据（ADR-002 D3 / D4）：**只读投影**，不参与判定、不进 `WorldStateV2`。
 *
 * 放在 `schema/` 而不是 `contract/`，是因为内核快照（`V2Snapshot`）与前端契约
 * （`view-model.ts`）都要用同一份形状；两处各写一份必然漂移。
 */

/**
 * 一条展示用效果。**由定义派生**（`presentation/effects.ts`），不是结算结果。
 *
 * `kind` 决定渲染：
 * - `control` ⇒ 固定效果（下划线，如「无法行动」）；
 * - `attr` / `combat` / `cost` / `formula` ⇒ 数值或公式条目（可带 +/- 与色彩）；
 * - `apply` / `remove` ⇒ 施加 / 移除补正（可点开补正详情）；
 * - `note` ⇒ 说明性文字。
 */
export const EffectSummarySchema = z
  .object({
    text: z.string(),
    kind: z.enum(["attr", "combat", "control", "apply", "remove", "cost", "formula", "note"]),
    /** 观感：增益 / 减益 / 中性（前端绿 / 红 / 灰）。 */
    tone: z.enum(["buff", "debuff", "neutral"]).optional(),
    /**
     * 关联实体（可选）：`施加 重伤` 这类条目要能点开补正详情（R-DETAIL-02/03）。
     * 只有展示层需要，内核不解释。
     */
    ref: z
      .object({ kind: z.enum(["status", "item", "skill"]), id: z.string() })
      .strict()
      .optional(),
  })
  .strict();
export type EffectSummary = z.infer<typeof EffectSummarySchema>;

/**
 * 一回合里的一条收获（ADR-002 D4）。
 *
 * `action` 与 `amount` 一起读：
 * - 属性：`up` / `down` + 净值；
 * - 物品：`gain` / `lose` + 数量；
 * - 补正：`gain` / `lose` + 最终层数 `stacks`；
 * - 装备：`equip` / `unequip`；
 * - 技能：`gain`。
 */
export const TurnGainSchema = z
  .object({
    category: z.enum(["attribute", "status", "skill", "item", "equipment"]),
    action: z.enum(["gain", "lose", "up", "down", "equip", "unequip"]),
    /** 属性 key / statusId / skillId / itemId / 装备 instanceId。 */
    id: z.string(),
    /** 展示名（已按模板标签解析）。 */
    name: z.string(),
    amount: z.number().optional(),
    stacks: z.number().optional(),
    quality: z.string().optional(),
    style: ResolvedStyleSchema.optional(),
  })
  .strict();
export type TurnGain = z.infer<typeof TurnGainSchema>;

/** 五个写操作响应里统一追加的字段名（服务端与前端共用同一常量，避免拼错）。 */
export const TURN_GAINS_FIELD = "gains" as const;
