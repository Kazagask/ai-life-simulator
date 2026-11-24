import { api } from "./server.ts";

export interface Snapshot {
  turnIndex: number;
  status?: string;
  slotEvent?: { eventId?: string; kind?: string } | null;
  /** ADR-077：战斗结束会停在战评，`over` 非空 ⇒ 还要一次 `leave` 才推进世界。 */
  battle?: { over?: string | null } | null;
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

/**
 * 开局 → 转盘 → 战斗（两击）→ 选择 → 结局。
 *
 * 2026-11-19 起选项结算自己也走终止边界（`chooseOptionV2` 末尾的 `applyEndingBoundary`），
 * 所以结局通常**在选项那一响应里**就落地了。仍留一次兜底推轮，供只靠时间推进才成立的
 * 终止条件（`afterTimeAdvance`）使用 —— 已经不是「必须多点一次」的老行为。
 */
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
  let last: { snapshot: Snapshot } | undefined;
  for (let i = 0; i < 2; i += 1) {
    last = await api<{ snapshot: Snapshot }>(baseUrl, "POST", `/api/worlds/${worldId}/battle`, {
      type: "skill",
      skillId: "sk-strike",
    });
  }
  // ADR-077：战斗结束停在战评面板，`leave` 才收场 / 推进世界
  if (last?.snapshot.battle?.over !== undefined && last.snapshot.battle?.over !== null) {
    await api<{ snapshot: Snapshot }>(baseUrl, "POST", `/api/worlds/${worldId}/battle`, {
      type: "leave",
    });
  }
  const chosen = await api<{ snapshot: Snapshot }>(baseUrl, "POST", `/api/worlds/${worldId}/events/choose`, {
    optionId: finalOptionId,
  });
  if (chosen.snapshot.ending) return chosen.snapshot;
  const end = await api<{ snapshot: Snapshot }>(baseUrl, "POST", `/api/worlds/${worldId}/turns`, {
    action: { type: "rest", description: "" },
    mode: "single",
  });
  return end.snapshot;
}
