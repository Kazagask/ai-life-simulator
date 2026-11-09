export type LifeStage = "childhood" | "youth" | "adulthood" | "elderhood";

export type Visibility = "public" | "known" | "inferred" | "hidden";

export interface TimeAmount {
  value: number;
  unit: "minute" | "hour" | "day" | "week" | "month" | "year";
}

export interface Character {
  id: string;
  name: string;
  age: number;
  lifeStage: LifeStage;
  attributes: Record<string, number>;
  goals: string[];
  knowledge: string[];
  secrets: string[];
}

export interface Npc extends Character {
  relationships: Record<string, number>;
  lastActedAtTurn: number;
}

export interface WorldState {
  id: string;
  templateId: string;
  seed: number;
  turnIndex: number;
  worldTime: number;
  player: Character;
  npcs: Npc[];
  flags: Record<string, boolean | number | string>;
  activeEventChains: EventChainState[];
  history: HistoryEntry[];
}

export interface EventDefinition {
  id: string;
  title: string;
  priority: number;
  probability: number;
  once?: boolean;
  cooldownTurns?: number;
  conditions: Array<{ flag: string; operator: "eq" | "gte" | "lte"; value: boolean | number | string }>;
  effects: Array<{ type: "setFlag" | "addFlag"; key: string; value: number | boolean | string }>;
  nextEventIds?: string[];
}

export interface EventChainState {
  id: string;
  currentEventId: string;
  status: "pending" | "active" | "completed" | "cancelled";
}

export interface HistoryEntry {
  id: string;
  turnIndex: number;
  worldTime: number;
  type: "player_action" | "npc_action" | "event" | "milestone";
  summary: string;
}

export interface WorldTemplate {
  id: string;
  defaultStep: TimeAmount;
  lifeStageSteps: Partial<Record<LifeStage, TimeAmount>>;
  events: EventDefinition[];
}

export interface TurnCommand {
  action: { type: string; description: string; duration?: TimeAmount };
  mode: "single" | "fast";
}

export interface TurnResult {
  state: WorldState;
  elapsed: TimeAmount;
  triggeredEventIds: string[];
  npcActionSummaries: string[];
  playerVisibleHistory: HistoryEntry[];
}
