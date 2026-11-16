import { describe, expect, it } from "vitest";
import { projectSnapshotV2 } from "@life-sim/game-core";
import { makeWorld } from "../helpers/world.ts";

describe("projection: hidden npc 只影响上屏，不影响关系边", () => {
  it("hidden NPC 不进入 npcs，但 known 关系边仍上屏且带全名", () => {
    const { state, entry } = makeWorld();
    const friend = state.npcs[0];
    expect(friend).toBeDefined();

    const hidden = {
      ...friend!,
      id: "npc-hidden",
      name: "隐藏者",
      visibility: "hidden" as const,
      statuses: [...friend!.statuses],
      knownGoals: [...friend!.knownGoals],
      goals: [...friend!.goals],
      traits: [...friend!.traits],
      knowledge: [...friend!.knowledge],
      secrets: [...friend!.secrets],
      inventory: { ...friend!.inventory },
    };
    state.npcs.push(hidden);
    state.relations.push({
      from: friend!.id,
      to: hidden.id,
      kind: "mother",
      source: "template",
      visibility: "known",
    });

    const snapshot = projectSnapshotV2(state, entry.template, entry.lookup);
    expect(snapshot.npcs.some((npc) => npc.id === "npc-hidden")).toBe(false);

    const friendRow = snapshot.npcs
      .find((npc) => npc.id === friend!.id)
      ?.relations.find((rel) => rel.withId === "npc-hidden");
    expect(friendRow).toBeDefined();
    // 866204a / 35b7906 回归锁：边仍上屏；名字是「隐藏者」，不是裸 id。
    expect(friendRow?.withName).toBe("隐藏者");
    expect(friendRow?.counterpartVisible).toBe(false);
  });
});
