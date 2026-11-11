import type {
  BattleCommand,
  EndingView,
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
    return request<{ history: Array<{ id: string; turnIndex: number; worldTime: number; formattedTime: string; type: string; summary: string; detail?: string }> }>(
      `/api/worlds/${id}/history`,
    );
  },
};

export type { V2Snapshot, BattleCommand, WheelResultView, EndingView };
