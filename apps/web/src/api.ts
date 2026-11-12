import type {
  BattleCommand,
  EndingView,
  HistoryEntryV2,
  TimeAmount,
  V2Snapshot,
  WheelResultView,
} from "@life-sim/shared";

const BASE = "";

/** R2.7 / R-NAR-03：叙事来源（与 shared 的 NarrativeSourceSchema 同值域，前端只做展示判定）。 */
export type NarrativeSource = "template" | "llm" | "fallback";

/**
 * R2.7 / R-NAR-03：事件 flavor 展示文案表。键为事件 id，值为服务端异步生成并已校验的
 * **展示**文案。fire-and-forget 结果，可能缺失、可能为空对象；非权威缓存、不进存档 / replay。
 * 前端不得依赖它存在，只用于当次渲染。
 */
export type EventFlavorMap = Record<string, string>;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  // 只有带 body 时才声明 Content-Type：空 body + application/json 会被 Fastify 判为 400
  const headers = init?.body !== undefined ? { "Content-Type": "application/json" } : undefined;
  const res = await fetch(`${BASE}${url}`, {
    ...init,
    ...(headers ? { headers } : {}),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      // Fastify 的错误体是 { statusCode, code, error, message }。
      // error 只是一句通用短语（如 "Unsupported Media Type"），真正能定位问题的是
      // message（带具体 Content-Type）与 code（FST_ERR_CTP_*），三者一起展示。
      const body = (await res.json()) as { error?: string; message?: string; code?: string };
      const parts = [body.error ?? `${res.status}`];
      if (body.message && body.message !== body.error) parts.push(body.message);
      if (body.code) parts.push(body.code);
      detail = parts.join(" ｜ ");
    } catch {
      /* 忽略解析失败 */
    }
    const error = new Error(`请求失败：${detail}`) as Error & { status: number };
    error.status = res.status;
    throw error;
  }
  return (await res.json()) as T;
}

export interface OpeningSummary {
  id: string;
  name: string;
  description: string;
}

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  startYear: number;
  openings: OpeningSummary[];
}

export interface WorldSummary {
  id: string;
  templateId: string;
  templateName: string;
  playerName: string;
  turnIndex: number;
  worldTime: number;
  formattedTime: string;
  status: "running" | "terminated" | "archived";
  endingTitle?: string;
  savedAt: string;
}

export interface InteractionResponse {
  worldId: string;
  snapshot: V2Snapshot;
  /** 服务端目前只下发 `eventFlavors` map；`flavor` 为可选占位，缺省完全等同当前行为。 */
  triggeredEvents: Array<{ id: string; title: string; narrative: string; flavor?: string }>;
  wheelResult: WheelResultView | null;
  /** R2.7 / R-NAR-03：可选，异步生成、可能为空对象或整字段缺失。前端不得依赖它存在。 */
  eventFlavors?: EventFlavorMap;
}

/** `eventFlavors` 经 `InteractionResponse` 继承，此处不再重复声明。 */
export interface TurnResponse extends InteractionResponse {
  turnIndex: number;
  elapsed: TimeAmount;
}

/**
 * 归档响应的玩家投影（R-VS-04）：public 历史 + hidden 计数（内容不下发）。
 * `archive.snapshot` 是归档时刻的**最终快照**（status=archived，带 ending 与 evaluation
 * 五维分项），与 `GET /api/worlds/:id` 的投影同源，所以调用方直接用它刷新即可。
 */
export interface ArchiveResponse {
  worldId: string;
  archive: {
    snapshot: V2Snapshot;
    /** 归档中被过滤掉的 hidden 条目数（只公开计数，不公开内容） */
    hiddenHistoryCount?: number;
    /** R2.7：归档时刻固化的结局叙事来源与文案（可选；旧档 / 未装饰时缺失）。 */
    ending?: {
      narrativeSource?: NarrativeSource;
      title?: string;
      summary?: string;
    };
    /** R2.7：归档时刻固化的人生总结来源与文案（可选）。来源不改变评分。 */
    evaluation?: {
      summary?: string;
      summarySource?: NarrativeSource;
    };
  };
}

export const api = {
  listTemplates() {
    return request<{ templates: TemplateSummary[] }>("/api/templates");
  },
  /** 世界列表（R-PS-04）：savedAt 倒序由服务端保证。 */
  listWorlds() {
    return request<{ worlds: WorldSummary[] }>("/api/worlds");
  },
  deleteWorld(id: string) {
    return request<{ deleted: string }>(`/api/worlds/${id}`, { method: "DELETE" });
  },
  /** 装备穿脱（R-EQ-08）：不推进时间，返回新快照。 */
  equipItem(id: string, itemId: string) {
    return request<{ worldId: string; snapshot: V2Snapshot }>(`/api/worlds/${id}/equipment/equip`, {
      method: "POST",
      body: JSON.stringify({ itemId }),
    });
  },
  unequipItem(id: string, instanceId: string) {
    return request<{ worldId: string; snapshot: V2Snapshot }>(`/api/worlds/${id}/equipment/unequip`, {
      method: "POST",
      body: JSON.stringify({ instanceId }),
    });
  },
  /** R-OP-01：省略 openingId 时服务端取加载顺序首个开局。 */
  createWorld(templateId: string, playerName: string, seed?: number, openingId?: string) {
    return request<{ worldId: string; snapshot: V2Snapshot }>("/api/worlds", {
      method: "POST",
      body: JSON.stringify({
        templateId,
        playerName,
        ...(seed !== undefined ? { seed } : {}),
        ...(openingId !== undefined ? { openingId } : {}),
      }),
    });
  },
  getWorld(id: string) {
    return request<{ worldId: string; snapshot: V2Snapshot; eventFlavors?: EventFlavorMap }>(`/api/worlds/${id}`);
  },
  advanceTurn(id: string, action: { type: string; description: string }, endLife = false) {
    return request<TurnResponse>(`/api/worlds/${id}/turns`, {
      method: "POST",
      body: JSON.stringify({ action, mode: "single", ...(endLife ? { endLife: true } : {}) }),
    });
  },
  chooseOption(id: string, optionId: string) {
    return request<InteractionResponse>(`/api/worlds/${id}/events/choose`, {
      method: "POST",
      body: JSON.stringify({ optionId }),
    });
  },
  battleAction(id: string, command: BattleCommand) {
    return request<InteractionResponse>(`/api/worlds/${id}/battle`, {
      method: "POST",
      body: JSON.stringify(command),
    });
  },
  useItem(id: string, itemId: string) {
    return request<InteractionResponse>(`/api/worlds/${id}/items/use`, {
      method: "POST",
      body: JSON.stringify({ itemId }),
    });
  },
  /**
   * 归档封存：仅已终止世界可封存，返回五类归档数据。
   * 响应里的 `archive.snapshot` 已带 evaluation（含五维分项），页面据此刷新即可。
   */
  archiveWorld(id: string) {
    return request<ArchiveResponse>(`/api/worlds/${id}/archive`, { method: "POST" });
  },
  history(id: string) {
    return request<{ history: HistoryEntryV2[] }>(
      `/api/worlds/${id}/history`,
    ).then((res) => ({
      // 前端防线：不依赖后端过滤正确性（R-VS-02 / design 文件清单「日志过滤」）。
      // 与 shared 的 isPlayerVisible 同语义（缺省视为 public）；本地实现避免把 shared
      // 的 zod schema 打进 bundle。判定口径变更时须同步协议 §21.1。
      history: res.history.filter((entry) => (entry.visibility ?? "public") === "public"),
    }));
  },
};

/**
 * 事件展示文案解析（R2.7 / T-S3 / R-NAR-03）。
 *
 * 优先取服务端异步生成并已校验的 flavor；`flavors` 为 `undefined` / `{}` / 无该 id /
 * 值为空串时，一律回退模板文案 `event.narrative` —— 即「字段缺失 = 与改前逐字相同」。
 * 纯函数、零副作用：flavors 只是当次渲染的非权威展示数据，不缓存、不落库、不进 localStorage。
 */
export function resolveEventNarrative(
  event: { id: string; narrative: string },
  flavors?: EventFlavorMap,
): string {
  const flavor = flavors?.[event.id];
  return flavor !== undefined && flavor !== "" ? flavor : event.narrative;
}

/**
 * 合并两次响应的事件 flavor（R2.7 / T-S3：GET / 409 刷新路径补齐）。
 *
 * flavor 是 fire-and-forget 产物，常到「下一轮 / 刷新」才出现，所以要把后续响应
 * 带回的键**补进**既有 map，而不是整体替换。规则：
 *  - `next` 为 `undefined` / `{}` / 只含空串 ⇒ 原样返回 `prev`（**同一引用**，
 *    调用方据此跳过 setState ⇒ 字段缺失时 UI 与改前逐字一致、且不多一次重渲染）；
 *  - 否则新值覆盖同键旧值、保留旧键；空串是无效值（与 `resolveEventNarrative`
 *    同语义），不写入、也不覆盖已有的有效文案，避免回退响应把 LLM 文案抹掉。
 * 纯函数：不修改入参。
 */
export function mergeEventFlavors(
  prev: EventFlavorMap | undefined,
  next: EventFlavorMap | undefined,
): EventFlavorMap | undefined {
  if (next === undefined) return prev;
  const valid = Object.entries(next).filter(([, text]) => text !== "");
  if (valid.length === 0) return prev;
  return { ...(prev ?? {}), ...Object.fromEntries(valid) };
}

export type { V2Snapshot, BattleCommand, WheelResultView, EndingView };
