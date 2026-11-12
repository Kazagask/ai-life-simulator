import { buildEventFlavorRequest } from "@life-sim/game-core";
import { EventFlavorOutputSchema } from "@life-sim/shared";
import { generateNarrative } from "./generate.js";
import type { LLMProvider } from "../llm/provider.js";

/**
 * R2.7 · 事件 flavor 的**非权威**服务端缓存（R-LLM-05 / R-NAR-03 / ADR-0027 决策 5）。
 *
 * - 只作展示用途：绝不写 `WorldStateV2`、绝不进 replay、绝不落盘；
 * - 键完全确定性（无随机、无真实时间）；`eventInstanceId` 在代码里不存在，故用
 *   `worldId | turnIndex | worldTime | eventId | occurrenceIndex` 组合；
 * - 生成是 `fire-and-forget`：不 await、不阻塞当轮结算；失败 / 超时静默回退模板。
 */

/** 与 `V2TurnResult.triggeredEvents` 同形的只读事件视图。 */
export interface TriggeredEventLike {
  readonly id: string;
  readonly title: string;
  readonly narrative: string;
}

const flavorCache = new Map<string, string>();

/** 确定性缓存键：同一 (世界, 轮次, 世界时间, 事件, 出现序号) 恒得同一键。 */
export function flavorKey(
  worldId: string,
  turnIndex: number,
  worldTime: number,
  eventId: string,
  occurrenceIndex: number,
): string {
  return `${worldId}|${turnIndex}|${worldTime}|${eventId}|${occurrenceIndex}`;
}

/** 供测试复位；生产不会调用（缓存随进程生命周期存在，非权威）。 */
export function clearFlavorCache(): void {
  flavorCache.clear();
}

/** 按 `eventId` 键下发本轮已缓存的 flavor；无缓存返回 `{}`（前端缺省模板文案）。 */
export function getFlavorsForEvents(
  worldId: string,
  turnIndex: number,
  worldTime: number,
  events: readonly TriggeredEventLike[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const occurrences = new Map<string, number>();
  for (const event of events) {
    const index = occurrences.get(event.id) ?? 0;
    occurrences.set(event.id, index + 1);
    const flavor = flavorCache.get(flavorKey(worldId, turnIndex, worldTime, event.id, index));
    if (flavor !== undefined && out[event.id] === undefined) out[event.id] = flavor;
  }
  return out;
}

/** 供 `GET /api/worlds/:id`：读该世界全部已缓存 flavor（展示用，缺省 `{}`）。 */
export function getFlavors(worldId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, flavor] of flavorCache) {
    if (!key.startsWith(`${worldId}|`)) continue;
    const eventId = key.split("|")[3];
    if (eventId !== undefined && out[eventId] === undefined) out[eventId] = flavor;
  }
  return out;
}

export interface ScheduleEventFlavorsArgs {
  worldId: string;
  turnIndex: number;
  worldTime: number;
  events: readonly TriggeredEventLike[];
  provider: LLMProvider;
  timeoutMs?: number;
  /** 可诊断回调（服务端日志，绝不含 key / token / session）；不传则仅静默回退。 */
  onDiagnostic?: (diagnostic: string) => void;
}

const DEFAULT_FLAVOR_TIMEOUT_MS = 3000;

/**
 * 事件结算后调用：**同步返回、绝不 await LLM**。
 * 内部 async IIFE 逐条生成，只有 `source === "llm"` 才写缓存；
 * template / fallback / 抛错一律保留模板文案、不写缓存、不抛到调用栈。
 */
export function scheduleEventFlavors(args: ScheduleEventFlavorsArgs): void {
  const { worldId, turnIndex, worldTime, events, provider, timeoutMs, onDiagnostic } = args;
  if (events.length === 0) return;
  const occurrences = new Map<string, number>();
  const jobs = events.map((event) => {
    const index = occurrences.get(event.id) ?? 0;
    occurrences.set(event.id, index + 1);
    return { event, index };
  });

  void (async () => {
    for (const { event, index } of jobs) {
      const request = buildEventFlavorRequest({
        eventId: event.id,
        title: event.title,
        narrative: event.narrative,
        worldTime,
        turnIndex,
      });
      const outcome = await generateNarrative(request, EventFlavorOutputSchema, provider, {
        timeoutMs: timeoutMs ?? DEFAULT_FLAVOR_TIMEOUT_MS,
      });
      if (outcome.diagnostic !== null) onDiagnostic?.(outcome.diagnostic);
      if (outcome.source !== "llm") continue;
      // 再过一次 strict schema 得到带类型的 flavor（不写任何状态字段）。
      const parsed = EventFlavorOutputSchema.safeParse(outcome.data);
      if (!parsed.success) continue;
      flavorCache.set(flavorKey(worldId, turnIndex, worldTime, event.id, index), parsed.data.flavor);
    }
  })().catch((err: unknown) => {
    onDiagnostic?.(`事件 flavor 后台生成异常：${err instanceof Error ? err.message : String(err)}`);
  });
}
