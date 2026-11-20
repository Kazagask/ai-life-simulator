import { describe, expect, it } from "vitest";
import { applyEffectsV2, createRng, createWorldV2 } from "@life-sim/game-core";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function loadEntry() {
  const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

describe("NPC 可见性效果", () => {
  it("setNpcVisibility 只换展示门，不改生命周期与关系", () => {
    const entry = loadEntry();
    const state = createWorldV2(
      { templateId: "jjk-2006", seed: 7, self: { kind: "new", id: "player", name: "玩家", gender: "male", age: 16 } },
      entry.template,
      "w-visibility",
    );
    const before = state.npcs.find((n) => n.id === "npc-geto");
    expect(before?.visibility).toBe("public");
    const relationCount = state.relations.length;

    applyEffectsV2(
      { state, lookup: entry.lookup, rng: createRng(1) },
      [{ type: "setNpcVisibility", npcId: "npc-geto", visibility: "hidden" }],
    );

    const after = state.npcs.find((n) => n.id === "npc-geto");
    expect(after?.visibility).toBe("hidden");
    expect(after?.lifecycle.state).toBe("alive");
    expect(state.relations.length).toBe(relationCount);
  });
});
