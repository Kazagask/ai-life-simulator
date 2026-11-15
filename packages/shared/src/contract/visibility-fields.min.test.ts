import { describe, expect, it } from "vitest";
import {
  SubjectSchema,
  KnowledgeTierSchema,
  PerspectiveFactViewSchema,
} from "./visibility.js";

describe("F4 subject / tier enums", () => {
  it("accepts subject ∈ {world, player, npc:<id>}", () => {
    for (const s of ["world", "player", "npc:itadori"]) {
      expect(SubjectSchema.safeParse(s).success).toBe(true);
    }
  });
  it("rejects unknown subject", () => {
    expect(SubjectSchema.safeParse("bogus").success).toBe(false);
  });
  it("accepts tier ∈ {known, inferred}", () => {
    expect(KnowledgeTierSchema.safeParse("known").success).toBe(true);
    expect(KnowledgeTierSchema.safeParse("inferred").success).toBe(true);
  });
  it("rejects tier hidden", () => {
    expect(KnowledgeTierSchema.safeParse("hidden").success).toBe(false);
  });
});

describe("F4 player / npc window must not declare hidden", () => {
  it("player window declaring hidden fails", () => {
    expect(
      PerspectiveFactViewSchema.safeParse({
        perspective: { kind: "player" },
        facts: [{ factRef: "f1", level: "hidden" }],
        inferenceMarkers: [],
      }).success,
    ).toBe(false);
  });
  it("world window may carry hidden (full view)", () => {
    expect(
      PerspectiveFactViewSchema.safeParse({
        perspective: { kind: "world" },
        facts: [{ factRef: "f1", level: "hidden" }],
        inferenceMarkers: [],
      }).success,
    ).toBe(true);
  });
});
