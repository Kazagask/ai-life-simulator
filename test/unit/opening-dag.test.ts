import { describe, expect, it } from "vitest";
import { OpeningBranchDagSchema } from "../../packages/shared/src/schema/opening.ts";
import {
  commitOpening,
  createOpeningSession,
  resolveStep,
} from "../../packages/game-core/src/v2/opening-dag.ts";
import { selfIdOf as stateSelfId } from "../../packages/game-core/src/v2/actors.ts";
import { fixtureEntry } from "../helpers/world.ts";

const dag = OpeningBranchDagSchema.parse({
  openingId: "op-test",
  name: "测试开局",
  params: [
    { id: "who", kind: "self" },
    { id: "nick", kind: "name" },
    { id: "bonus", kind: "attribute" },
    { id: "gift", kind: "status" },
    { id: "bond", kind: "relation" },
    { id: "clock", kind: "time" },
  ],
  entry: "n1",
  nodes: [
    {
      node: "n1",
      title: "你是谁",
      mode: "choose",
      options: [
        {
          id: "friend",
          text: "扮演朋友",
          set: {
            who: { kind: "reuse", characterId: "npc-friend" },
            // 复用路径：基本属性忽略开局填的名；附加属性照常叠加。
            nick: "冒名者",
            bond: { with: "npc-friend", value: 3 },
          },
        },
      ],
    },
    {
      node: "n2",
      title: "加点",
      mode: "roll",
      options: [
        {
          id: "luck",
          text: "幸运 +2",
          weight: 1,
          set: {
            bonus: { id: "luck", value: 2, mode: "add" },
            gift: [{ id: "absorbed-curses", stacks: 2 }, "inj"],
            clock: { value: 2, unit: "day" },
          },
        },
      ],
    },
  ],
});

describe("前实例化开局内核", () => {
  it("同 seed 重放一致；参数 id 按 kind 落点；复用角色时基本属性忽略开局名", () => {
    const { template } = fixtureEntry();
    const run = (): ReturnType<typeof commitOpening> => {
      let session = createOpeningSession(dag, 42);
      session = resolveStep(dag, session, { kind: "choose", optionId: "friend" }).session;
      expect(session.done).toBe(false);
      session = resolveStep(dag, session, { kind: "roll" }).session;
      expect(session.done).toBe(true);
      return commitOpening(dag, session, template, "w-opening");
    };
    const a = run();
    const b = run();
    expect(a.player.name).toBe("朋友"); // 角色名，不是 "冒名者"
    expect(a.player.age).toBe(20);
    expect(a.player.attributes.luck).toBe(2); // 角色基线 luck=0（覆盖世界默认 5）+ 附加 +2
    expect(a.player.statuses.map((s) => [s.statusId, s.stacks])).toEqual([
      ["absorbed-curses", 2],
      ["inj", 1],
    ]); // 开局统一获得，不消耗世界轮次
    expect(a.player.id).toBe("npc-friend");
    expect(stateSelfId(a)).toBe("npc-friend");
    expect(a.npcs.some((n) => n.id === "npc-friend")).toBe(false); // 同一实体不重复实例化
    expect(a.opening?.openingId).toBe("op-test");
    expect(a.turnIndex).toBe(0);
    expect(a.worldTime).toBe(2880); // 开局时间锚：2 天，不推进轮次
    expect(a.delayQueue).toEqual([]);
    expect(b.player.name).toBe(a.player.name);
    expect(b.player.attributes).toEqual(a.player.attributes);
  });

  it("relation 参数值加载期校验：kind 必须在闭集内、必须带 with 与数值", () => {
    const base = {
      openingId: "op-rel",
      name: "关系校验",
      entry: "n",
      params: [{ id: "bond", kind: "relation" }],
    };
    const node = (set: Record<string, unknown>) => ({
      node: "n",
      title: "t",
      mode: "choose",
      options: [{ id: "o", text: "o", set }],
    });
    expect(OpeningBranchDagSchema.safeParse({ ...base, nodes: [node({ bond: { with: "npc-x", value: 5, kind: "friend" } })] }).success).toBe(true);
    expect(OpeningBranchDagSchema.safeParse({ ...base, nodes: [node({ bond: { with: "npc-x", value: 5 } })] }).success).toBe(true);
    // 非法 kind（如 classmate/senior）必须在加载期拒载，否则会写坏 state.relations。
    expect(OpeningBranchDagSchema.safeParse({ ...base, nodes: [node({ bond: { with: "npc-x", value: 5, kind: "classmate" } })] }).success).toBe(false);
    expect(OpeningBranchDagSchema.safeParse({ ...base, nodes: [node({ bond: { value: 5, kind: "friend" } })] }).success).toBe(false);
    expect(OpeningBranchDagSchema.safeParse({ ...base, nodes: [node({ bond: { with: "npc-x", kind: "friend" } })] }).success).toBe(false);
  });
});
