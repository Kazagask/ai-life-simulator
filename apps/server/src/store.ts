import { randomUUID } from "node:crypto";
import type { WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
import { createWorldV2 } from "@life-sim/game-core";

/** 内存仓储：P0 阶段不持久化，重启即清空。 */
const worlds = new Map<string, WorldStateV2>();

export interface CreateWorldInputV2 {
  templateId: string;
  playerName: string;
  seed?: number;
}

export const worldStore = {
  create(input: CreateWorldInputV2, template: WorldTemplateV2): WorldStateV2 {
    const world = createWorldV2(input, template, randomUUID());
    worlds.set(world.id, world);
    return world;
  },
  get(id: string): WorldStateV2 | undefined {
    return worlds.get(id);
  },
  save(state: WorldStateV2): void {
    worlds.set(state.id, state);
  },
};

export type { WorldTemplateV2 };
