import type { BattleState, SkillSealVM, WorldStateV2 } from "@life-sim/shared";
import { canUseSkill, summonLost } from "./battle.js";
import type { TemplateLookup } from "./lookup.js";

/**
 * 技能封印（ADR-015）：**技能还在手上，但现在用不了，以及为什么**。
 *
 * 从前「用不了」只有一种表达——把技能从面板上拿掉（ADR-013 D3 就是这么处理永久失去的
 * 英雄召唤的）。那是个错误的方向：玩家看不到这一招，就无法区分「我没学过」和「我学过但
 * 现在不行」，只能反复怀疑自己点错了（用户 2026-11-20 反馈：虹龙被献祭之后，技能页里
 * 那一栏还在，点了却什么也不发生）。
 *
 * 所以判据与文案都收在这里，只有一份：
 *  - `skillSealOf`：**持久**条件（只看世界观存档，不看这一场战斗）——技能页与战斗面板共用；
 *  - `battleSealOf`：这一回合能不能放（直接问 `canUseSkill`，与引擎拒绝同源）。
 *
 * 拒绝的原因翻成人话时**要带名字**：`「虹龙」已经不在了` 比 `召唤物已失去` 有用得多。
 * 取名一律走 `lookup`（模板驱动），不在这里写任何作品专名。
 */

/**
 * 引擎的拒绝理由 → 给玩家看的一句话。
 *
 * `summon_lost` 取被点名的角色卡名字。`summon_limit` 已经不在这张表里了（ADR-016 D3）：
 * 满员不再是拒绝的理由 —— 后面的会把前面的顶下去。拿不到定义时退回中性说法，
 * 展示层不该因为模板写错而崩。
 */
function sealTextOf(
  reason: string,
  state: WorldStateV2,
  lookup: TemplateLookup,
  skillId: string,
): string {
  const skill = lookup.skill(skillId);
  const summon = skill?.kind === "combat" ? skill.summon : undefined;
  switch (reason) {
    case "summon_lost": {
      const ref = summon?.ref;
      // 角色卡的名字在 `identity.name`（`Character` 是「身份 + 公开/私密资料」两层的形状）。
      const name = ref !== undefined ? lookup.character(ref)?.identity.name ?? ref : "召唤物";
      return `「${name}」已经不在了（阵亡或被献祭），本局再也召不出来`;
    }
    case "sacrifice_empty":
      return "场上没有可以献祭的召唤物";
    case "recall_empty":
      return "场上没有可以收回的召唤物";
    case "not_enough_mp":
      // 资源名归模板（`statusBar[].label`）：引擎不替某个世界给它起名。
      return `${lookup.resourceLabel("mp")}不足`;
    case "cannot_attack":
      return "现在做不出攻击";
    case "cannot_use_skills":
      return "现在用不了技能";
    default:
      if (reason.startsWith("not_enough_resource:")) {
        return `${lookup.resourceLabel(reason.slice("not_enough_resource:".length))}不足`;
      }
      // `skill_not_found` / `caster_not_found` / 未来新增的理由：说「放不出来」但不编原因。
      return "现在放不出这一招";
  }
}

/**
 * **持久**封印：只由世界观存档决定，与「在不在战斗里」无关。
 *
 * 目前只有一条判据——英雄档召唤物永久失去（ADR-013 D3）。放在这里而不是散在各处，
 * 是因为它有四个消费者（技能页、战斗面板、投影过滤、测试），各写一遍就会漂。
 */
export function skillSealOf(
  state: WorldStateV2,
  skillId: string,
  lookup: TemplateLookup,
): SkillSealVM | undefined {
  const skill = lookup.skill(skillId);
  if (skill === undefined || skill.kind !== "combat") return undefined;
  if (summonLost(state, skill.summon)) {
    return { code: "summon_lost", text: sealTextOf("summon_lost", state, lookup, skillId) };
  }
  return undefined;
}

/**
 * 这一回合的封印：直接问 `canUseSkill`（唯一判定入口），把 `reason` 翻成人话。
 *
 * `skill_on_cooldown` 不下发：冷却已经有自己的展示位（按钮上写「冷却 N」），
 * 再盖一层「封印」只会让同一件事看着像两件事。
 */
export function battleSealOf(
  state: WorldStateV2,
  battle: BattleState,
  casterId: string,
  skillId: string,
  lookup: TemplateLookup,
): SkillSealVM | undefined {
  const gate = canUseSkill(state, battle, casterId, skillId, lookup);
  if (gate.ok) return undefined;
  if (gate.reason === "skill_on_cooldown") return undefined;
  return { code: gate.reason, text: sealTextOf(gate.reason, state, lookup, skillId) };
}
