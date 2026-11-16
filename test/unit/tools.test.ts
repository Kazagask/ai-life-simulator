import { describe, expect, it } from "vitest";
import { RpgEngineAPI } from "@life-sim/game-core";
import { makeWorld } from "../helpers/world.ts";

describe("工具面：已下线工具 unknown_tool，story.submitBranch 可用", () => {
  it("narrative.write / fact.enqueueEvent 都被引擎拒绝", () => {
    const { state, entry } = makeWorld();
    const api = new RpgEngineAPI({ state, lookup: entry.lookup });
    for (const tool of ["narrative.write", "fact.enqueueEvent"]) {
      const result = api.dispatch([{ callId: `c-${tool}`, tool, args: {} }], {
        turnIndex: state.turnIndex,
        worldTime: state.worldTime,
        targetPerspective: "player",
      });
      expect(result.receipts[0]?.outcome).toBe("rejected");
      expect(result.receipts[0]?.code).toBe("unknown_tool");
    }
  });

  it("story.submitBranch 仍能正常提交", () => {
    const { state, entry } = makeWorld();
    const api = new RpgEngineAPI({ state, lookup: entry.lookup });
    const result = api.dispatch(
      [
        {
          callId: "c-branch",
          tool: "story.submitBranch",
          args: {
            trigger: { mode: "certain" },
            branch: [
              {
                node: "unit.branch",
                title: "单测分支",
                text: "分支正文。",
                options: [{ text: "继续" }],
              },
            ],
          },
        },
      ],
      {
        turnIndex: state.turnIndex,
        worldTime: state.worldTime,
        perspective: "world",
        targetPerspective: "player",
      },
    );
    expect(result.receipts[0]?.outcome).toBe("accepted");
  });
});
