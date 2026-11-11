import type { OpeningTemplate, WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { createDefaultOpeningTemplate, handoff, runOpening, type OpeningRunnerContext } from "./opening.js";
import { createRunnerContext } from "./runner-context.js";
import { createWorldV2 } from "./turn.js";

/**
 * 测试夹具：创建并交接一个「已激活」世界（openingCompleted=true）。
 * 复用 runOpening + handoff 的最小默认开局，让门禁接入后的轮次测试统一从这里取状态；
 * createWorldV2 本身保持未激活语义（ending.test.ts 依赖其 false/null/false 初值）。
 * 可选传入自定义开局，用于验证交接事件的消费。
 */
export function createActiveWorldV2(
  input: { templateId: string; playerName: string; seed?: number },
  template: WorldTemplateV2,
  worldId: string,
  opening: OpeningTemplate = createDefaultOpeningTemplate(),
): WorldStateV2 {
  const base = createWorldV2(input, template, worldId);
  const lookup = createLookup(template);
  const openingCtx: OpeningRunnerContext = {
    ...createRunnerContext(base.seed),
    lookup,
  };
  const { state: opened, run } = runOpening(base, opening, openingCtx);
  return handoff(opened, run, lookup);
}
