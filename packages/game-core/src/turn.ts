import type { TurnCommand, TurnResult, WorldState, WorldTemplate, HistoryEntry } from "@life-sim/shared";
import { determineStep, toMinutes } from "./time.js";

/**
 * Minimal deterministic turn skeleton.
 * Extend this function through small domain services; do not turn it into a monolith.
 */
export function advanceTurn(
  state: WorldState,
  command: TurnCommand,
  template: WorldTemplate,
): TurnResult {
  const elapsed = determineStep(state.player, template, command.action.duration);
  const elapsedMinutes = toMinutes(elapsed);
  const nextTurn = state.turnIndex + 1;

  const playerEntry: HistoryEntry = {
    id: `turn-${nextTurn}-player`,
    turnIndex: nextTurn,
    worldTime: state.worldTime + elapsedMinutes,
    type: "player_action",
    summary: command.action.description,
  };

  const nextState: WorldState = {
    ...state,
    turnIndex: nextTurn,
    worldTime: state.worldTime + elapsedMinutes,
    history: [...state.history, playerEntry],
  };

  return {
    state: nextState,
    elapsed,
    triggeredEventIds: [],
    npcActionSummaries: [],
    playerVisibleHistory: [playerEntry],
  };
}
