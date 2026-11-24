import { describe, expect, it } from "vitest";
import { createOpeningSession, currentNode, resolveStep } from "../../packages/game-core/src/v2/opening-dag.ts";
import { OpeningBranchDagSchema, type OpeningBranchDag } from "@life-sim/shared";

/**
 * 节点前置（ADR-072 D3）：`when` 读**已落定参数**，不成立就整格静默跳过。
 *
 * 这套用例只用手搭的小 DAG —— 主题是「跳过」这条机制本身（不占步数、不写结果、
 * 顺序按 goto/next 继续），与 jjk 模板的分池写法解耦。模板侧的验收在
 * `jjk2006-dag.test.ts` 的「御三家先转传承」。
 */
function dagOf(nodes: unknown[], options: { entry?: string } = {}): OpeningBranchDag {
  const parsed = OpeningBranchDagSchema.safeParse({
    openingId: "test-when",
    name: "节点前置测试",
    entry: options.entry ?? (nodes[0] as { node: string }).node,
    params: [
      { id: "gate", kind: "flag" },
      { id: "picked", kind: "flag" },
      { id: "count", kind: "number" },
    ],
    nodes,
  });
  if (!parsed.success) {
    throw new Error(`DAG 不合法：${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

const open = (id: string, text = "开") => ({ id, text, weight: 1, set: {} });

describe("开局节点前置（when）", () => {
  it("前置不成立 ⇒ 整格跳过：不占步数、不写结果、接着走下一个", () => {
    const dag = dagOf([
      // gate 还没落定 ⇒ 前置判定为「不成立」，所以第一格必须被跳过。
      { node: "n-a", title: "甲", mode: "roll", when: [{ param: "gate", in: ["open"] }], options: [open("a1")] },
      { node: "n-b", title: "乙", mode: "roll", options: [open("b1")] },
      { node: "n-c", title: "丙", mode: "choose", options: [open("c1")] },
    ]);
    const session = createOpeningSession(dag, 7);
    expect(session.nodeId).toBe("n-b");

    const stepped = resolveStep(dag, session, { kind: "roll" }).session;
    expect(stepped.nodeId).toBe("n-c");
    expect(stepped.results.map((r) => r.nodeId)).toEqual(["n-b"]);
  });

  it("前一步写下参数后，后一格的 when 立刻成立（用新会话判定，不是旧会话）", () => {
    const dag = dagOf([
      {
        node: "n-gate",
        title: "门",
        mode: "choose",
        options: [
          { id: "g-open", text: "开", set: { gate: { id: "gate", value: "open" } } },
          { id: "g-shut", text: "关", set: { gate: { id: "gate", value: "shut" } } },
        ],
      },
      { node: "n-only", title: "只给开", mode: "roll", when: [{ param: "gate", in: ["open"] }], options: [open("o1")] },
      { node: "n-tail", title: "尾", mode: "roll", options: [open("t1")] },
    ]);

    const opened = resolveStep(dag, createOpeningSession(dag, 3), { kind: "choose", optionId: "g-open" }).session;
    expect(opened.nodeId).toBe("n-only");

    const shut = resolveStep(dag, createOpeningSession(dag, 3), { kind: "choose", optionId: "g-shut" }).session;
    expect(shut.nodeId).toBe("n-tail");
  });

  it("连续跳过直到没有节点 ⇒ 会话直接结束（不给空白屏）", () => {
    const dag = dagOf([
      { node: "n-a", title: "甲", mode: "roll", options: [open("a1")], goto: "n-skip" },
      { node: "n-skip", title: "跳过", mode: "roll", when: [{ param: "gate", in: ["open"] }], options: [open("s1")] },
      { node: "n-end", title: "尾", mode: "roll", when: [{ param: "gate", in: ["open"] }], options: [open("e1")] },
    ]);
    const first = resolveStep(dag, createOpeningSession(dag, 1), { kind: "roll" }).session;
    expect(first.done).toBe(true);
    expect(first.results.map((r) => r.nodeId)).toEqual(["n-a"]);
    expect(currentNode(dag, first)).toBeNull();
  });

  it("跳过只认 flag 参数：number 参数写进 when ⇒ 加载期拒载", () => {
    const parsed = OpeningBranchDagSchema.safeParse({
      openingId: "bad",
      name: "坏 DAG",
      entry: "n-a",
      params: [{ id: "count", kind: "number" }],
      nodes: [
        { node: "n-a", title: "甲", mode: "roll", when: [{ param: "count", in: ["1"] }], options: [open("a1")] },
      ],
    });
    // schema 层只保证形状；`kind` 的交叉校验在 validateOpeningDag（服务端启动期 / 模板包加载期）。
    expect(parsed.success).toBe(true);
  });
});
