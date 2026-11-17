import { describe, expect, it } from "vitest";
import { projectVisibleRelations } from "@life-sim/game-core";
import { kinshipTerm } from "@life-sim/ext-family";
import type { RelationEdge } from "@life-sim/shared";

const edge = (
  from: string,
  to: string,
  visibility: RelationEdge["visibility"],
  kind: RelationEdge["kind"] = "mother",
): RelationEdge => ({ from, to, kind, source: "template", visibility });

describe("relations: 只按边自身 visibility 收敛", () => {
  it("known / inferred 出，unknown / hidden 不出", () => {
    const visible = projectVisibleRelations([
      edge("a", "b", "known"),
      edge("a", "b", "inferred"),
      edge("a", "b", "unknown"),
      edge("a", "b", "hidden"),
    ]);
    expect(visible.map((e) => e.visibility)).toEqual(["known", "inferred"]);
  });

  it("kinshipTerm 只看边，不要求端点在 state.npcs 里有实例", () => {
    const term = kinshipTerm([edge("parent-x", "child-y", "known")], "parent-x", "child-y");
    expect(term).not.toBeNull();
    expect(term?.term).toBe("妈妈");
  });
});
