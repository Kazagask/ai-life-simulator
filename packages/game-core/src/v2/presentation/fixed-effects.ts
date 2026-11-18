import type { ControlSemantics } from "@life-sim/shared";

/**
 * 固定效果（控制语义）的统一文案（ADR-002 D3 / R-FX-01）。
 *
 * 为什么在引擎而不是前端：同一句「无法行动」会出现在战斗面板、补正详情、收获卡三处；
 * 放在前端就是三份拷贝，改一次文案要改三处、漏一处就是不一致。
 *
 * 「固定效果」= 没有数值增减形态、只有状态位含义的控制效果；展示层据此加下划线
 * （`EffectSummary.kind === "control"`），与「咒力 +4」这类数值条目区分开。
 */
export interface FixedEffectCopy {
  label: string;
  hint: string;
}

export const FIXED_EFFECT_COPY: Readonly<Record<ControlSemantics, FixedEffectCopy>> = {
  cannot_act: { label: "无法行动", hint: "本回合不能执行任何动作" },
  cannot_use_skills: { label: "无法使用技能", hint: "战斗中不能施放技能" },
  cannot_use_items: { label: "无法使用物品", hint: "战斗中不能使用道具" },
  cannot_attack: { label: "无法攻击", hint: "战斗中不能进行攻击行动" },
  cannot_flee: { label: "无法逃跑", hint: "战斗中不能撤退" },
  forced_target_self: { label: "被迫成为目标", hint: "敌方的攻击会优先指向该角色" },
};

export function fixedEffectCopy(control: ControlSemantics): FixedEffectCopy {
  return FIXED_EFFECT_COPY[control];
}
