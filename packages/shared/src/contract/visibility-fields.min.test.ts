import { describe, expect, it } from "vitest";
import {
  PerspectiveSchema,
  ObserverIdSchema,
  KnowledgeLevelSchema,
  PerspectiveFactViewSchema,
  ObservationLedgerSchema,
} from "./perspective.js";

describe("F4 Perspective string-literal union", () => {
  it("accepts world / player / npc:<id>", () => {
    for (const p of ["world", "player", "npc:itadori"]) {
      expect(PerspectiveSchema.safeParse(p).success).toBe(true);
    }
  });
  it("rejects illegal perspective", () => {
    expect(PerspectiveSchema.safeParse("bogus").success).toBe(false);
    expect(PerspectiveSchema.safeParse("npc").success).toBe(false);
    // 旧对象判别联合形 { kind: "world" } 必须被拒
    expect(PerspectiveSchema.safeParse({ kind: "world" }).success).toBe(false);
  });
  it("ObserverId rejects world", () => {
    expect(ObserverIdSchema.safeParse("player").success).toBe(true);
    expect(ObserverIdSchema.safeParse("npc:rival").success).toBe(true);
    expect(ObserverIdSchema.safeParse("world").success).toBe(false);
  });
});

describe("F4 level enum (known / inferred)", () => {
  it("accepts known / inferred", () => {
    expect(KnowledgeLevelSchema.safeParse("known").success).toBe(true);
    expect(KnowledgeLevelSchema.safeParse("inferred").success).toBe(true);
  });
  it("rejects hidden", () => {
    expect(KnowledgeLevelSchema.safeParse("hidden").success).toBe(false);
  });
});

describe("F4 ObservationLedger key validation (save-deserialization leak guard)", () => {
  it("accepts player / npc:<id> keys", () => {
    expect(
      ObservationLedgerSchema.safeParse({ player: [], "npc:npc-rival": [] }).success,
    ).toBe(true);
  });
  it("rejects illegal observer keys (e.g. world / arbitrary)", () => {
    expect(ObservationLedgerSchema.safeParse({ world: [] }).success).toBe(false);
    expect(ObservationLedgerSchema.safeParse({ bogus: [] }).success).toBe(false);
  });
});

describe("F4 PerspectiveFactView (v2 §6.3.2)", () => {
  const playerView = {
    perspective: "player",
    facts: [{ factRef: "f1", value: 1, level: "known" }],
  };
  it("player window parses with known/inferred facts", () => {
    expect(PerspectiveFactViewSchema.safeParse(playerView).success).toBe(true);
  });
  it("unknown key rejected (strict)", () => {
    expect(PerspectiveFactViewSchema.safeParse({ ...playerView, __unknown: 1 }).success).toBe(false);
  });
  it("world window carries full ledger + hidden DAG node", () => {
    expect(
      PerspectiveFactViewSchema.safeParse({
        perspective: "world",
        facts: [{ factRef: "secret:mentor-plan", value: "…" }],
        dagNodes: [{ nodeId: "n3.hiddenSeed", status: "draft" }],
        ledger: { player: [], "npc:npc-rival": [] },
      }).success,
    ).toBe(true);
  });
  it("non-world window cannot carry full ledger (F4)", () => {
    expect(
      PerspectiveFactViewSchema.safeParse({ ...playerView, ledger: { player: [] } }).success,
    ).toBe(false);
  });
  it("rejects level outside known / inferred", () => {
    expect(
      PerspectiveFactViewSchema.safeParse({
        perspective: "player",
        facts: [{ factRef: "f1", value: 1, level: "hidden" }],
      }).success,
    ).toBe(false);
  });
  it("rejects legacy object perspective shape", () => {
    expect(
      PerspectiveFactViewSchema.safeParse({
        perspective: { kind: "world" },
        facts: [],
      }).success,
    ).toBe(false);
  });
});
