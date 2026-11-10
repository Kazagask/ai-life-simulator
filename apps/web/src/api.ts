import type {
  BattleCommand,
  TimeAmount,
  V2Snapshot,
  WheelResultView,
} from "@life-sim/shared";

const BASE = "";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* 忽略解析失败 */
    }
    const error = new Error(`请求失败：${detail}`) as Error & { status: number };
    error.status = res.status;
    throw error;
  }
  return (await res.json()) as T;
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
    return request<{ templates: Array<{ id: string; name: string; description: string; startYear: number }> }>(
      "/api/templates",
    );
  },
  createWorld(templateId: string, playerName: string, seed?: number) {
    return request<{ worldId: string; snapshot: V2Snapshot }>("/api/worlds", {
      method: "POST",
      body: JSON.stringify({ templateId, playerName, ...(seed !== undefined ? { seed } : {}) }),
    });
  },
  getWorld(id: string) {
    return request<{ worldId: string; snapshot: V2Snapshot }>(`/api/worlds/${id}`);
  },
  advanceTurn(id: string, action: { type: string; description: string }) {
    return request<TurnResponse>(`/api/worlds/${id}/turns`, {
      method: "POST",
      body: JSON.stringify({ action, mode: "single" }),
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
  history(id: string) {
    return request<{ history: Array<{ id: string; turnIndex: number; worldTime: number; formattedTime: string; type: string; summary: string; detail?: string }> }>(
      `/api/worlds/${id}/history`,
    );
  },
};

export type { V2Snapshot, BattleCommand, WheelResultView };
