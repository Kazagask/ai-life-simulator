import { api } from "./server.ts";

export interface Snapshot {
  turnIndex: number;
  status?: string;
  slotEvent?: { eventId?: string; kind?: string } | null;
  ending?: { endingId?: string } | null;
}

interface WorldResponse {
  worldId: string;
  snapshot: Snapshot;
}

export async function createP0(
  baseUrl: string,
  openingId: "op-gojo" | "op-yuji",
  playerName = "P0",
): Promise<WorldResponse> {
  return api<WorldResponse>(baseUrl, "POST", "/api/worlds", {
    templateId: "p0",
    playerName,
    openingId,
  });
}

/** 开局 → 转盘 → 战斗（两击）→ 选择 → 再推一回合触发 afterSettle 终局。 */
export async function playP0ToEnding(
  baseUrl: string,
  worldId: string,
  finalOptionId: "opt-good" | "opt-bad",
  expectedStart?: "ev:start-gojo" | "ev:start-yuji",
): Promise<Snapshot> {
  const first = await api<{ snapshot: Snapshot }>(baseUrl, "POST", `/api/worlds/${worldId}/turns`, {
    action: { type: "patrol", description: "" },
    mode: "single",
  });
  if (expectedStart !== undefined && first.snapshot.slotEvent?.eventId !== expectedStart) {
    throw new Error(`opening_start_mismatch: ${String(first.snapshot.slotEvent?.eventId)} != ${expectedStart}`);
  }
  await api<{ snapshot: Snapshot }>(baseUrl, "POST", `/api/worlds/${worldId}/events/choose`, {
    optionId: "opt-go",
  });
  await api<{ snapshot: Snapshot }>(baseUrl, "POST", `/api/worlds/${worldId}/wheels/confirm`);
  for (let i = 0; i < 2; i += 1) {
    await api<{ snapshot: Snapshot }>(baseUrl, "POST", `/api/worlds/${worldId}/battle`, {
      type: "skill",
      skillId: "sk-strike",
    });
  }
  await api<{ snapshot: Snapshot }>(baseUrl, "POST", `/api/worlds/${worldId}/events/choose`, {
    optionId: finalOptionId,
  });
  const end = await api<{ snapshot: Snapshot }>(baseUrl, "POST", `/api/worlds/${worldId}/turns`, {
    action: { type: "rest", description: "" },
    mode: "single",
  });
  return end.snapshot;
}
