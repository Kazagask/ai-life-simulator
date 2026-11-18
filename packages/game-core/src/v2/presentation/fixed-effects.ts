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
  // 底层效果**只描述战斗中的能力限制**，不含回合数——持续几回合是**补正**的字段
  // （`duration` / `combat.battleRounds`），塞进效果里会和补正自己的说明打架（用户 2026-11-18）。
  cannot_act: { label: "战斗中无法行动", hint: "跳过该角色的行动阶段" },
  cannot_use_skills: { label: "战斗中无法使用技能", hint: "仍可进行普通攻击" },
  cannot_use_items: { label: "战斗中无法使用物品", hint: "仍可使用技能" },
  cannot_attack: { label: "战斗中无法攻击", hint: "仍可使用技能与道具" },
  cannot_flee: { label: "战斗中无法逃跑", hint: "战斗只能以一方倒下结束" },
  forced_target_self: { label: "被迫成为敌方目标", hint: "敌方攻击会优先指向该角色" },
};

export function fixedEffectCopy(control: ControlSemantics): FixedEffectCopy {
  return FIXED_EFFECT_COPY[control];
}
