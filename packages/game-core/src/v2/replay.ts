import type { WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { advanceTurnV2, createWorldV2 } from "./turn.js";
import { createRunnerContext } from "./runner-context.js";

/** 回放指令：与 advanceTurnV2 的 command 参数同形。 */
export interface ReplayCommand {
  action: { type: string; description?: string };
  mode?: "single" | "fast";
}

/** 一份完整回放的输入：同初始状态 + 同指令序列 + 同 seed。 */
export interface ReplaySpec {
  seed: number;
  playerName: string;
  worldId: string;
  template: WorldTemplateV2;
  commands: ReplayCommand[];
}

/**
 * 执行一次完整回放，返回最终世界状态。
 * 纯函数式：每次调用都新建 state / lookup / RunnerContext，
 * 不读写任何模块级可变状态，也不修改传入的 spec.template。
 * 供阶段 3–6 的 P1 属性测试复用；断言「不含阶段序列」由调用方负责。
 */
export function replay(spec: ReplaySpec): WorldStateV2 {
  const template = structuredClone(spec.template);
  const lookup = createLookup(template);
  const ctx = createRunnerContext(spec.seed);
  const state = createWorldV2(
    { templateId: template.meta.id, playerName: spec.playerName, seed: spec.seed },
    template,
    spec.worldId,
    ctx,
  );
  let current: WorldStateV2 = state;
  for (const command of spec.commands) {
    current = advanceTurnV2(current, command, template, lookup, ctx).state;
  }
  return current;
}
