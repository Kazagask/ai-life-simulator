/**
 * ADR-0037 回归锁：DAG 真正开工（种子 / 推进 / 增量续写 / 视图分形 / 回放确定性）。
 *
 * 锁的都是**跨文件**才成立的性质，单看任一文件的单测都看不出来：
 * - IO-8 / IO-10：`fallbackDag` 建世界期种入；无 rules 的模板逐字段停在空 DAG。
 * - IO-9 + D13：一轮一节点一格，且必须按**冻结快照**求值（跨节点不级联）。
 * - IO-11 / IO-12 + D14：增量写的幂等、无变化短路（version 只 +1）、改语义/回退一律拒绝。
 * - D3：world 窗口给全量字段 + `edges`；player 窗口一个 world-only 字段都不许有。
 * - D15：`replay` 必须收 `rules`，否则同 seed 会回放出一个空 DAG 的世界。
 *
 * 第 2/3 条刻意只断言**行为**（`state.taskDag.nodes[].status`），不 import
 * `advanceDagProgress` —— 锁的是"玩家看到的世界怎么变"，不是某个内部函数怎么实现。
 */

import { describe, expect, it, vi } from "vitest";
import type {
  DagNodeView,
  DispatchContext,
  LlmGateway,
  LlmInvocation,
  PerspectiveFactView,
  Rules,
  TaskDag,
  WorldStateV2,
  WorldTemplateV2,
} from "@life-sim/shared";

import { createActiveWorldV2, makeTestTemplate } from "./v2/test-utils.js";
import { createLookup } from "./v2/lookup.js";
import { advanceTurnV2, createWorldV2 } from "./v2/turn.js";
import { replay, type ReplaySpec } from "./v2/replay.js";
import { RpgEngineAPI } from "./api/engine-api.js";
import { buildFacts } from "./api/perspective.js";

const TEMPLATE: WorldTemplateV2 = { ...makeTestTemplate(), events: [] };
const LOOKUP = createLookup(TEMPLATE);

/** 最小 rules：两条节点 + 一条边。n1 已 ready 且 always 完成 ⇒ 第一轮推进一格。 */
function rules(): Rules {
  return {
    llmTriggers: [
      {
        when: [{ op: "nodeCompleted", args: { nodeId: "n1" } }],
        invoke: {
          reason: "chapter.advance",
          perspective: "player",
          targetPerspective: "player",
          contextHints: [],
          toolProfile: "narrative",
        },
      },
    ],
    toolProfile: { narrative: ["content.writeNarrative", "content.submit"] },
    knowledgeGrants: [],
    inferenceRules: [],
    fallbackDag: {
      dagId: "adr0037.seed",
      version: 1,
      issuedBy: "template",
      nodes: [
        {
          id: "n1",
          kind: "opening",
          title: "苏醒",
          status: "ready",
          guards: [],
          completion: [{ op: "always", args: {} }],
          templateRefs: [],
          visibility: "public",
        },
        {
          id: "n2",
          kind: "trial",
          title: "试炼",
          status: "draft",
          guards: [{ op: "nodeCompleted", args: { nodeId: "n1" } }],
          completion: [{ op: "eventResolved", args: { eventId: "evt:x" } }],
          templateRefs: [],
          visibility: "public",
        },
      ],
      edges: [{ from: "n1", to: "n2", kind: "unlocks" }],
    },
  };
}

function countingGateway() {
  const invoke = vi.fn(async (inv: LlmInvocation) => ({
    outcome: "committed" as const,
    invocationId: inv.invocationId,
    receipts: [],
    traceRef: `trace:${inv.invocationId}`,
  }));
  return { invoke, gateway: { invoke } as unknown as LlmGateway };
}

function advanceOne(state: WorldStateV2, gateway: LlmGateway, r: Rules): void {
  advanceTurnV2(
    state,
    { action: { type: "act", description: "" } },
    TEMPLATE,
    LOOKUP,
    undefined,
    { gateway, rules: r },
  );
}

/** 种子 + 激活（开局交接后 turnIndex=0、slot=null），供 DAG 断言用。 */
function seededState(r: Rules = rules()): WorldStateV2 {
  return createActiveWorldV2(
    { templateId: "test", playerName: "P", seed: 42 },
    TEMPLATE,
    "w-adr0037",
    undefined,
    r,
  );
}

function statusOf(state: WorldStateV2, nodeId: string): string | undefined {
  return state.taskDag.nodes.find((n) => n.id === nodeId)?.status;
}

function dispatchCtx(state: WorldStateV2): DispatchContext {
  return {
    turnIndex: state.turnIndex,
    worldTime: state.worldTime,
    targetPerspective: "player",
  };
}

function upsert(state: WorldStateV2, args: Record<string, unknown>) {
  const api = new RpgEngineAPI({ state, perspective: "world", targetPerspective: "player" });
  return api.dispatch([{ callId: "c-upsert", tool: "fact.upsertDagBranch", args }], dispatchCtx(state));
}

function node(id: string, over: Partial<Rules["fallbackDag"]["nodes"][number]> = {}) {
  return {
    id,
    kind: "branch",
    title: `节点 ${id}`,
    status: "draft" as const,
    guards: [],
    completion: [],
    templateRefs: [],
    visibility: "public" as const,
    ...over,
  };
}

describe("ADR-0037 DAG 开工（IO-8..IO-12 / D3 / D11 / D13 / D14 / D15）", () => {
  // ---------- D1 种子（IO-8 / IO-10） ----------

  it("1. 种子落地：createWorldV2(..., rules) ⇒ taskDag.nodes 含 n1 / n2", () => {
    const state = createWorldV2(
      { templateId: "test", playerName: "P", seed: 42 },
      TEMPLATE,
      "w-seed",
      undefined,
      rules(),
    );
    expect(state.taskDag.dagId).toBe("adr0037.seed");
    expect(state.taskDag.version).toBe(1);
    expect(state.taskDag.issuedBy).toBe("template");
    expect(state.taskDag.nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(state.taskDag.edges).toEqual([{ from: "n1", to: "n2", kind: "unlocks" }]);
  });

  it("2. 一轮 ⇒ n1 completed、n2 仍 draft（D13 快照：跨节点不级联）、chapter.advance 恰好 1 次", () => {
    const r = rules();
    const state = seededState(r);
    const { invoke, gateway } = countingGateway();

    advanceOne(state, gateway, r);

    expect(statusOf(state, "n1")).toBe("completed");
    // 关键：n2 的 guard 是 `nodeCompleted n1`。若按实时状态边算边写，本轮 n2 就会被抬到 ready。
    expect(statusOf(state, "n2")).toBe("draft");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]?.reason).toBe("chapter.advance");
    // ADR-0036 边沿：同一轮之后不再重复触发。
    expect(state.triggerFireLedger?.["chapter.advance#0"]?.hit).toBe(true);
  });

  it("3. 第二轮 ⇒ n2 ready（一轮一条边）", () => {
    const r = rules();
    const state = seededState(r);
    const { gateway } = countingGateway();

    advanceOne(state, gateway, r);
    expect(statusOf(state, "n2")).toBe("draft");

    advanceOne(state, gateway, r);
    expect(statusOf(state, "n1")).toBe("completed");
    expect(statusOf(state, "n2")).toBe("ready");
  });

  it("4. 无 rules ⇒ taskDag.nodes 仍为 []（IO-10 零回归）", () => {
    const state = createActiveWorldV2(
      { templateId: "test", playerName: "P", seed: 42 },
      TEMPLATE,
      "w-norules",
    );
    expect(state.taskDag).toEqual({
      dagId: "initial",
      version: 0,
      issuedBy: "template",
      nodes: [],
      edges: [],
    });
  });

  // ---------- D4 增量写（IO-11 / IO-12 / D14） ----------

  it("5. upsertDagBranch 幂等：相同入参两次 ⇒ nodes/edges 不变、version 只 +1", () => {
    const state = seededState();
    const before = structuredClone(state.taskDag);
    const branch = {
      nodes: [node("n3"), node("n4")],
      edges: [{ from: "n2", to: "n3", kind: "unlocks" }],
    };

    const first = upsert(state, branch);
    expect(first.receipts[0]?.outcome).toBe("accepted");
    expect(state.taskDag.nodes).toHaveLength(before.nodes.length + 2);
    expect(state.taskDag.edges).toHaveLength(before.edges.length + 1);
    expect(state.taskDag.version).toBe(before.version + 1);

    const second = upsert(state, branch);
    expect(second.receipts[0]?.outcome).toBe("accepted");
    // IO-11：同一 branch 两次 ⇒ 不翻倍、version 不再涨（无变化短路，D14.2）。
    expect(state.taskDag.nodes).toHaveLength(before.nodes.length + 2);
    expect(state.taskDag.edges).toHaveLength(before.edges.length + 1);
    expect(state.taskDag.version).toBe(before.version + 1);
  });

  it("6. upsertDagBranch 造环 ⇒ state_conflict、taskDag 逐字段不变（IO-12）", () => {
    const state = seededState();
    const before: TaskDag = structuredClone(state.taskDag);

    const result = upsert(state, {
      nodes: [node("n3"), node("n4")],
      edges: [
        { from: "n3", to: "n4", kind: "unlocks" },
        { from: "n4", to: "n3", kind: "unlocks" },
      ],
    });

    expect(result.receipts[0]?.outcome).toBe("rejected");
    expect(result.receipts[0]?.code).toBe("state_conflict");
    expect(state.taskDag).toEqual(before);
  });

  it("7. upsertDagBranch 改已存在节点的 title ⇒ state_conflict", () => {
    const state = seededState();
    const before: TaskDag = structuredClone(state.taskDag);

    const result = upsert(state, {
      nodes: [{ ...node("n2"), kind: "trial", title: "被改写的标题" }],
    });

    expect(result.receipts[0]?.outcome).toBe("rejected");
    expect(result.receipts[0]?.code).toBe("state_conflict");
    expect(state.taskDag).toEqual(before);
  });

  it("8. upsertDagBranch 把 completed 节点改回 ready ⇒ 拒绝（D14.3 单调）", () => {
    const state = seededState();
    // 先让它 completed（等价于 D2 推进过一次的结果；直接构造，避免依赖推进实现细节）。
    state.taskDag = {
      ...state.taskDag,
      nodes: state.taskDag.nodes.map((n) =>
        n.id === "n1" ? { ...n, status: "completed" as const } : n,
      ),
    };
    const before: TaskDag = structuredClone(state.taskDag);

    const result = upsert(state, {
      nodes: [{ ...node("n1"), kind: "opening", title: "苏醒", status: "ready" }],
    });

    expect(result.receipts[0]?.outcome).toBe("rejected");
    expect(result.receipts[0]?.code).toBe("state_conflict");
    expect(state.taskDag).toEqual(before);
  });

  // ---------- D3 视图分形 ----------

  it("9. 玩家窗口不含 world-only 字段与 edges；world 窗口两者都有", () => {
    const state = seededState();

    type WorldOnlyNode = DagNodeView & {
      title?: string;
      kind?: string;
      visibility?: string;
      templateRefs?: string[];
    };
    type ViewWithEdges = PerspectiveFactView & {
      edges?: Array<{ from: string; to: string; kind: string }>;
    };

    const world = buildFacts(state, "world") as ViewWithEdges;
    const player = buildFacts(state, "player") as ViewWithEdges;

    const worldNode = world.dagNodes?.find((n) => n.nodeId === "n1") as
      | WorldOnlyNode
      | undefined;
    expect(worldNode).toMatchObject({
      nodeId: "n1",
      status: "ready",
      title: "苏醒",
      kind: "opening",
      visibility: "public",
    });
    expect(worldNode?.templateRefs).toEqual([]);
    expect(world.edges?.length).toBe(1);

    for (const n of (player.dagNodes ?? []) as WorldOnlyNode[]) {
      expect(n.title).toBeUndefined();
      expect(n.kind).toBeUndefined();
      expect(n.visibility).toBeUndefined();
      expect(n.templateRefs).toBeUndefined();
    }
    expect(player.edges).toBeUndefined();
    expect(player.dagNodes?.map((n) => n.nodeId)).toEqual(["n1", "n2"]);
  });

  // ---------- D15 replay 必须收 rules ----------

  it("10. replay 传 rules 才有 DAG（确定性：同一 spec 两次逐字段相同）", () => {
    const base: ReplaySpec = {
      seed: 7,
      playerName: "回放者",
      worldId: "w-replay",
      template: TEMPLATE,
      commands: [{ action: { type: "act" } }],
    };

    const withRules = replay({ ...base, rules: rules() });
    const without = replay(base);

    // 传了 ⇒ 种子进 state；不传 ⇒ 仍是建世界初值（IO-10 的另一面）。
    expect(withRules.taskDag.nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(without.taskDag.nodes).toEqual([]);

    // 确定性：同一 spec 重放两次逐字段一致（D15 是硬约束，不是可选项）。
    const again = replay({ ...base, rules: rules() });
    expect(again.taskDag).toEqual(withRules.taskDag);
  });
});
