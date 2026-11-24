import { describe, expect, it } from "vitest";
import {
  createOpeningSession,
  describeNode,
  resolveParamMap,
  resolveStep,
} from "../../packages/game-core/src/v2/opening-dag.ts";
import { OpeningBranchDagSchema, type OpeningBranchDag } from "@life-sim/shared";

/**
 * 输入节点（ADR-072 D7）：唯一一个玩家写字符串的格子。
 *
 * 这里用小手搭 DAG 测**协议本身**（预填候选 / `{pick}` / 校验 / 落点），
 * 模板侧的验收在 `jjk2006-dag.test.ts`（姓名格在加点之前、姓随家传术式）。
 */
function dagOf(input: Record<string, unknown>): OpeningBranchDag {
  const parsed = OpeningBranchDagSchema.safeParse({
    openingId: "test-input",
    name: "输入节点测试",
    entry: "n-origin-pick",
    params: [
      { id: "origin", kind: "flag" },
      { id: "surname", kind: "flag" },
      { id: "nick", kind: "name" },
      { id: "memo", kind: "flag" },
    ],
    nodes: [
      {
        node: "n-origin-pick",
        title: "出身",
        mode: "choose",
        options: [
          {
            id: "c-civilian",
            text: "平民",
            set: { origin: { id: "origin", value: "civilian" }, surname: { id: "surname", value: "神谷" } },
          },
          {
            id: "c-clan",
            text: "旁支",
            set: { origin: { id: "origin", value: "clan" }, surname: { id: "surname", value: "禅院" } },
          },
        ],
      },
      { node: "n-name", title: "姓名", mode: "input", input },
    ],
  });
  if (!parsed.success) {
    throw new Error(`DAG 不合法：${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

const INPUT = {
  param: "nick",
  prefill: [
    { when: [{ param: "origin", in: ["clan"] }], require: ["playerName"], text: "{surname}{playerName}" },
    { when: [{ param: "origin", in: ["clan"] }], text: "{surname}{pick}" },
    { require: ["playerName"], text: "{playerName}" },
    { text: "{surname}{pick}" },
  ],
  suggestions: ["透", "恵", "澪"],
  hint: "姓已经填好",
  minLength: 1,
  maxLength: 6,
  pattern: "^[^<>]{1,6}$",
} as const;

function sessionAtName(dag: OpeningBranchDag, optionId: string, typedName?: string) {
  const started = createOpeningSession(dag, 7, typedName !== undefined ? { playerName: typedName } : undefined);
  return resolveStep(dag, started, { kind: "choose", optionId }).session;
}

const viewOf = (dag: OpeningBranchDag, session: ReturnType<typeof sessionAtName>) =>
  describeNode(dag, session, undefined)?.input;

describe("开局输入节点（input）", () => {
  it("御三家：姓 + 向导里写的名字", () => {
    const dag = dagOf(INPUT);
    const session = sessionAtName(dag, "c-clan", "三郎");
    expect(viewOf(dag, session)?.value).toBe("禅院三郎");
  });

  it("非御三家：写了就原样用（不加姓）", () => {
    const dag = dagOf(INPUT);
    const session = sessionAtName(dag, "c-civilian", "三郎");
    expect(viewOf(dag, session)?.value).toBe("三郎");
  });

  it("没写名字：用 {pick} 从 suggestions 里取一个，且同 seed 同结果", () => {
    const dag = dagOf(INPUT);
    const a = viewOf(dag, sessionAtName(dag, "c-civilian"))?.value ?? "";
    const b = viewOf(dag, sessionAtName(dag, "c-civilian"))?.value ?? "";
    expect(a).toBe(b);
    expect(a.startsWith("神谷")).toBe(true);
    expect(["神谷透", "神谷恵", "神谷澪"]).toContain(a);
  });

  it("提交空串 ⇒ 用预填兜底；超过长度 / 命中禁用字符 ⇒ 拒", () => {
    const dag = dagOf(INPUT);
    const session = sessionAtName(dag, "c-clan", "三郎");

    const accepted = resolveStep(dag, session, { kind: "input", value: "  " }).session;
    expect(resolveParamMap(dag, accepted).nick).toBe("禅院三郎");

    expect(() => resolveStep(dag, session, { kind: "input", value: "一二三四五六七" })).toThrow(
      /opening_input_too_long/,
    );
    expect(() => resolveStep(dag, session, { kind: "input", value: "坏<名" })).toThrow(
      /opening_input_pattern/,
    );
  });

  it("落点：name 参数存裸字符串，flag 参数存 { id, value }", () => {
    const dag = dagOf({ param: "memo", flag: "note", prefill: "记录", maxLength: 6 });
    const session = sessionAtName(dag, "c-civilian");
    const stepped = resolveStep(dag, session, { kind: "input", value: "换了" }).session;
    expect(resolveParamMap(dag, stepped).memo).toEqual({ id: "note", value: "换了" });
  });

  it("没有预填也没有 defaultValue ⇒ 空提交直接拒（不会把空名字写进世界）", () => {
    const dag = dagOf({ param: "nick" });
    const session = sessionAtName(dag, "c-civilian");
    expect(viewOf(dag, session)?.value).toBe("");
    expect(() => resolveStep(dag, session, { kind: "input", value: " " })).toThrow(
      /opening_input_required/,
    );
  });

  it("节点视图把预填解析完再下发（客户端不认识模板语法）", () => {
    const dag = dagOf(INPUT);
    const view = viewOf(dag, sessionAtName(dag, "c-clan", "三郎"));
    expect(view).toMatchObject({
      param: "nick",
      value: "禅院三郎",
      hint: "姓已经填好",
      minLength: 1,
      maxLength: 6,
    });
  });
});
