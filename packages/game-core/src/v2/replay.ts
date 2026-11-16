import type {
  ApiCall,
  CallLogEntry,
  DispatchContext,
  Rules,
  WorldStateV2,
  WorldTemplateV2,
} from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { advanceTurnV2, createWorldV2 } from "./turn.js";
import { createRunnerContext } from "./runner-context.js";
import { createDefaultOpeningTemplate, handoff, runOpening, type OpeningRunnerContext } from "./opening.js";
import { RpgEngineAPI } from "../api/engine-api.js";
import type { TemplateLookup } from "./lookup.js";

/** 回放指令：与 advanceTurnV2 的 command 参数同形。 */
export interface ReplayCommand {
  action: { type: string; description?: string };
  mode?: "single" | "fast";
}

/**
 * 档 1 的一条 LLM 回放项：某轮次需要重放的 `dispatch()` 调用链。
 * trace 是 append-only 的叙事 / 调用落点；回放按 `turnIndex` 精确重放，**不发起网络**。
 */
export interface LlmReplayEntry {
  turnIndex: number;
  calls: ApiCall[];
}

/** 一份完整回放的输入：同初始状态 + 同指令序列 + 同 seed。 */
export interface ReplaySpec {
  seed: number;
  playerName: string;
  worldId: string;
  template: WorldTemplateV2;
  commands: ReplayCommand[];
  /**
   * ADR-0037 D15：模板规则。**传了才会种 `fallbackDag`** —— 生产路径建世界时种，
   * 回放不种就会得到"同 seed 但空 DAG"的另一个世界，确定性硬约束被破坏。
   */
  rules?: Rules;
  /** 档 1：按轮次重放的 dispatch 调用（trace 回放，零网络）。 */
  llmTrace?: LlmReplayEntry[];
  /** 档 2：可重建调用链的 callLog。 */
  callLog?: CallLogEntry[];
}

interface ReplayInit {
  template: WorldTemplateV2;
  lookup: TemplateLookup;
  ctx: ReturnType<typeof createRunnerContext>;
  state: WorldStateV2;
}

/** 共用初始化：每次新建 state / lookup / RunnerContext，不读写模块级可变状态。 */
function initReplay(spec: ReplaySpec): ReplayInit {
  const template = structuredClone(spec.template);
  const lookup = createLookup(template);
  const ctx = createRunnerContext(spec.seed);
  const state = createWorldV2(
    { templateId: template.meta.id, playerName: spec.playerName, seed: spec.seed },
    template,
    spec.worldId,
    ctx,
    spec.rules,
  );
  // T2-02 门禁：createWorldV2 产出 openingCompleted=false，首条指令会被 NOT_ACTIVE 拒绝。
  // 与 store.create 同样先交接激活；默认开局不改变轮次/时间/事件，保证逐字段可复现。
  const openingCtx: OpeningRunnerContext = {
    ...createRunnerContext(spec.seed),
    lookup,
  };
  const { state: opened, run } = runOpening(state, createDefaultOpeningTemplate(), openingCtx);
  return { template, lookup, ctx, state: handoff(opened, run, lookup) };
}

/**
 * 执行一次完整回放，返回最终世界状态。
 * 纯函数式：不读写任何模块级可变状态，也不修改传入的 spec.template。
 * 不传 llmTrace / callLog 时行为与阶段 3–6 P1 属性测试一致（零回归）。
 */
export function replay(spec: ReplaySpec): WorldStateV2 {
  const { template, lookup, ctx, state } = initReplay(spec);
  let current: WorldStateV2 = state;
  for (const command of spec.commands) {
    current = advanceTurnV2(current, command, template, lookup, ctx).state;
  }
  return current;
}

/**
 * 档 1（v2 §8.1）：同 seed + commands[] + llmTrace[] ⇒ 逐字段相等且**网络 0**。
 * 每轮 `advanceTurnV2` 之后按 `llmTrace[turnIndex]` 重放 `dispatch()`（纯函数、不发起网络）；
 * 改 1 条 trace ⇒ 状态必然不同（确定性反例必红）。`advanceTurnV2` 不传 gateway ⇒ 无 LLM 回调。
 */
export function replayWithLlm(spec: ReplaySpec): WorldStateV2 {
  const { template, lookup, ctx, state } = initReplay(spec);
  let current: WorldStateV2 = state;
  const traceByTurn = new Map<number, ApiCall[]>(
    (spec.llmTrace ?? []).map((e) => [e.turnIndex, e.calls]),
  );
  for (const command of spec.commands) {
    current = advanceTurnV2(current, command, template, lookup, ctx).state;
    const calls = traceByTurn.get(current.turnIndex);
    if (calls && calls.length > 0) {
      const api = new RpgEngineAPI({ state: current });
      const dispatchCtx: DispatchContext = {
        turnIndex: current.turnIndex,
        worldTime: current.worldTime,
        targetPerspective: "player",
      };
      api.dispatch(calls, dispatchCtx); // 纯同步、零网络；权威写入只在 engine-api.ts
    }
  }
  return current;
}

/** 档 2：从 callLog 重建调用链（工具名序列），供取证 / 调用链复现。 */
export function callChainFromLog(callLog: readonly CallLogEntry[]): string[] {
  return callLog.map((e) => e.tool);
}
