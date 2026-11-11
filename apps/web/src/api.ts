import type {
  BattleCommand,
  EndingView,
  HistoryEntryV2,
  TimeAmount,
  V2Snapshot,
  WheelResultView,
} from "@life-sim/shared";

const BASE = "";

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
  triggeredEvents: Array<{ id: string; title: string; narrative: string }>;
  wheelResult: WheelResultView | null;
}

export interface TurnResponse extends InteractionResponse {
  turnIndex: number;
  elapsed: TimeAmount;
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
    return request<{ worldId: string; snapshot: V2Snapshot }>(`/api/worlds/${id}`);
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
  /** 归档封存：仅已终止世界可封存，返回五类归档数据。 */
  archiveWorld(id: string) {
    return request<{ worldId: string; archive: unknown }>(`/api/worlds/${id}/archive`, { method: "POST" });
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

export type { V2Snapshot, BattleCommand, WheelResultView, EndingView };
