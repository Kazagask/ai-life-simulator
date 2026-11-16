import { randomUUID } from "node:crypto";
import {
  LlmTraceSchema,
  type ContentBlock,
  type LlmTrace,
  type WorldStateV2,
} from "@life-sim/shared";
import {
  RpgEngineAPI,
  buildContentTrace,
  projectSnapshotV2,
  visibleFactRefs,
} from "@life-sim/game-core";
import type { ReadyTemplateEntry } from "../templates.js";
import { appendTrace, worldStore } from "../store.js";

/**
 * F3 / T-07 写入侧：把服务端自己产出的叙事（结局 / 人生总结 / 后续生产消费方）
 * 送进 `ContentSink` → `LlmTrace` → append-only `<worldId>.trace.jsonl`。
 *
 * 为什么必须走 `RpgEngineAPI.dispatch` 而不是直接 `appendTrace`：
 * - `narrative.write` 是唯一的正文写入口，窗口校验（`allowedContentRefs`）在引擎内完成，
 *   server 不能自建可见性判据（F4）；
 * - 回程对象（`sink`）由引擎持有，`buildContentTrace(sink, base)` 才能拿到真正的内容块。
 *
 * 硬不变量：
 * - 正文**只**进 trace，`WorldStateV2` 只留下 `traceRef`（`trace:${invocationId}`）；
 * - `traceRef` 只在 `recordNarrative` 里铸造一次（不调 `agent.submit`，避免第二处写入点）；
 * - 没有块落进 sink（例如全部被窗口拒收）⇒ 不写空 trace、不铸造 traceRef。
 */

export interface NarrativeBlockInput {
  blockId: string;
  text: string;
  kind?: ContentBlock["kind"];
  /** 该块引用的事实；越窗的 ref 在写侧就被过滤掉（读侧仍有第二道防线）。 */
  refs?: readonly string[];
}

export interface RecordNarrativeInput {
  reason: string;
  blocks: readonly NarrativeBlockInput[];
}

/**
 * 记录一批玩家窗口叙事块，返回本次铸造的 `traceRef`（无块写入时返回 null）。
 * 调用方不必自己 append / 改 state：本函数负责落 trace、置 `state.traceRef`、并持久化引用锚
 * （已归档世界只读，不落盘）。
 */
export function recordNarrative(
  state: WorldStateV2,
  entry: ReadyTemplateEntry,
  input: RecordNarrativeInput,
): string | null {
  if (input.blocks.length === 0) return null;
  const turnIndex = state.turnIndex;
  const worldTime = state.worldTime;
  const invocationId = `narr:${state.id}:${turnIndex}:${randomUUID()}`;
  const templateRef = `${entry.ref.id}@${entry.ref.version}`;

  const engineApi = new RpgEngineAPI({
    state,
    projectSnapshot: (s) =>
      projectSnapshotV2(s, entry.template, entry.lookup),
  });

  // 写侧也过滤一遍 refs：`narrative.write` 会以 `allowedContentRefs` 拒收越窗引用，
  // 但整块被拒会丢掉合法正文；这里先把不可见 ref 摘掉，保留正文本身。
  const visible = visibleFactRefs(state, "player");
  const calls = input.blocks.map((block, index) => {
    const refs = (block.refs ?? []).filter((ref) => visible.has(ref));
    const args: ContentBlock = {
      blockId: block.blockId,
      kind: block.kind ?? "narrative",
      text: block.text,
      refs,
      visibility: "public",
      targetPerspective: "player",
    };
    return {
      callId: `${invocationId}#${index}`,
      tool: "narrative.write",
      args,
      refs,
    };
  });

  engineApi.dispatch(calls, {
    turnIndex,
    worldTime,
    invocationId,
    perspective: "world",
    targetPerspective: "player",
  });

  if (engineApi.sink.list().length === 0) return null;

  const trace: LlmTrace = LlmTraceSchema.parse(
    buildContentTrace(engineApi.sink, {
      invocationId,
      turnIndex,
      worldTime,
      reason: input.reason,
      toolProfile: "narrative",
      templateRef,
    }),
  );
  appendTrace(state.id, trace);
  state.traceRef = `trace:${invocationId}`;

  // traceRef 是存档事实（F3）：立即把引用锚落进信封；归档世界只读，跳过落盘。
  if (state.archived !== true) worldStore.save(state);
  return state.traceRef;
}
