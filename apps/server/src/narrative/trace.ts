import { randomUUID } from "node:crypto";
import {
  LlmTraceSchema,
  type ContentBlock,
  type LlmTrace,
  type WorldStateV2,
} from "@life-sim/shared";
import {
  allowedContentRefs,
  buildContentTrace,
  createContentSink,
} from "@life-sim/game-core";
import type { ReadyTemplateEntry } from "../templates.js";
import { appendTrace, worldStore } from "../store.js";

/**
 * F3 / T-07 写入侧：把服务端自己产出的叙事（结局 / 人生总结 / 后续生产消费方）
 * 送进 `ContentSink` → `LlmTrace` → append-only `<worldId>.trace.jsonl`。
 *
 * 为什么不是直接 `appendTrace`：
 * - 正文必须先过窗口校验（`allowedContentRefs`，game-core 的唯一实现），server 不能
 *   自建可见性判据（F4）；
 * - `buildContentTrace(sink, base)` 是 trace 的唯一组装入口。
 * `narrative.write` 工具已删除（2026-11-17）：服务端产出的正文直接 append 到这个 sink，
 * 与 agent-runtime 的 `<narrative-content>` 标签路径共用同一条落盘链路。
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

  const sink = createContentSink();

  /**
   * 写侧过滤 refs：与已删除的 `narrative.write` 同一集合（`allowedContentRefs`）。
   * 越窗的 ref 先摘掉、保留正文本身；整块被拒会丢掉合法叙事。
   */
  const allowed = allowedContentRefs(state, "player");
  for (const block of input.blocks) {
    const refs = (block.refs ?? []).filter((ref) => allowed.has(ref));
    const full: ContentBlock = {
      blockId: block.blockId,
      kind: block.kind ?? "narrative",
      text: block.text,
      refs,
      visibility: "public",
      targetPerspective: "player",
    };
    sink.append(full);
  }

  if (sink.list().length === 0) return null;

  const trace: LlmTrace = LlmTraceSchema.parse(
    buildContentTrace(sink, {
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
