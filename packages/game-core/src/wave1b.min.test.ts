import { describe, expect, it } from "vitest";
import { deepStrictEqual, notDeepStrictEqual } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import {
  LlmTraceSchema,
  type ApiCall,
  type ContentBlock,
  type DispatchContext,
  type EvaluationConfig,
  type LlmGateway,
  type LlmInvocation,
  type Rules,
  type TaskDag,
  type TaskNode,
  type WorldStateV2,
} from "@life-sim/shared";

import { createActiveWorldV2, makeTestTemplate } from "./v2/test-utils.js";
import { createLookup } from "./v2/lookup.js";
import { advanceTurnV2 } from "./v2/turn.js";
import { RpgEngineAPI, isRetryable, assignSlot } from "./api/engine-api.js";
import { buildFacts, isPlayerWindowVisible } from "./api/perspective.js";
import { validateDag, validateFallbackDag } from "./v2/task-dag.js";
import {
  createConditionRegistry,
  evaluateTriggers,
  evaluateTriggersDetailed,
} from "./v2/condition-evaluator.js";
import { evaluateLifeV2, activeDimensionIds } from "./v2/life-evaluation.js";
import { replayWithLlm } from "./v2/replay.js";
import { createContentSink, buildContentTrace, validateContentBlock } from "./v2/narrative.js";

/**
 * 阶段 B（Wave 1B）验收：全部用内联 fixture，不依赖 rules.yaml / evaluation.yaml 已落盘。
 * 覆盖 8 条判据 + 追加 R11（未注册 op ⇒ unknown_reference）+ 源码守卫。
 */

// ---------- 内联 fixture ----------

const SECRET_RIVAL = "secret:rival-plan";
const SECRET_MENTOR = "secret:mentor-plan";

function makeState(): WorldStateV2 {
  const state = createActiveWorldV2(
    { templateId: "test", playerName: "P", seed: 42 },
    makeTestTemplate(),
    "w1",
  );
  state.flags = { "took-right": true };
  state.npcs = [
    { id: "npc:npc-rival", secrets: [SECRET_RIVAL] },
    { id: "npc:npc-mentor", secrets: [SECRET_MENTOR] },
  ] as unknown as WorldStateV2["npcs"];
  state.observationLedger = {
    player: [{ factRef: "fact:gate-location", level: "known", source: "witness", sinceTurn: 0 }],
    "npc:npc-rival": [{ factRef: SECRET_RIVAL, level: "known", source: "witness", sinceTurn: 0 }],
    "npc:npc-mentor": [{ factRef: SECRET_MENTOR, level: "inferred", source: "inferred", sinceTurn: 0 }],
  };
  state.taskDag = {
    dagId: "demo",
    version: 1,
    issuedBy: "template",
    nodes: [
      { id: "n1", kind: "opening", title: "苏醒", status: "ready", guards: [], completion: [], templateRefs: ["evt:awaken"], visibility: "public" },
      { id: "n3.hiddenSeed", kind: "secret", title: "隐秘", status: "draft", guards: [], completion: [], templateRefs: [], visibility: "hidden" },
    ],
    edges: [],
  };
  return state;
}

function ctx(targetPerspective: "world" | "player" | `npc:${string}` = "player"): DispatchContext {
  return { turnIndex: 0, worldTime: 0, targetPerspective };
}

const INVOKE = {
  reason: "chapter.advance",
  perspective: "world",
  targetPerspective: "player",
  toolProfile: "narrative",
} as const;

function baseRules(llmTriggers: Rules["llmTriggers"]): Rules {
  return {
    llmTriggers,
    toolProfile: { narrative: ["narrative.write"] },
    knowledgeGrants: [],
    inferenceRules: [],
    fallbackDag: { dagId: "d", version: 1, issuedBy: "template", nodes: [], edges: [] },
  };
}

// ---------- 判据 1：dispatch([], ctx) 零变更 + 连调两次 + 源码守卫 ----------

describe("判据1 dispatch 空调用零变更 + 源码守卫", () => {
  it("dispatch([], ctx).state 与原 state 逐字段相等；连调两次一致", () => {
    const state = makeState();
    const before = structuredClone(state);
    const api = new RpgEngineAPI({ state });
    const r1 = api.dispatch([], ctx());
    deepStrictEqual(r1.state, before);
    expect(r1.receipts).toEqual([]);
    const r2 = api.dispatch([], ctx());
    deepStrictEqual(r2.state, before);
    deepStrictEqual(r2.state, r1.state);
  });

  it("源码守卫：权威字段写入只出现在 api/engine-api.ts（排除测试文件）", () => {
    const srcDir = fileURLToPath(new URL("./", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name !== "legacy-tests") walk(p);
        } else if (ent.name.endsWith(".ts") && !ent.name.includes(".test.ts")) {
          files.push(p);
        }
      }
    };
    walk(srcDir);
    const slotAssign = /state\.slot\s*=(?!=)/; // 负向前瞻排除 === 比较
    const factAssign = /state\.(observationLedger|taskDag|pendingInvocation|traceRef|media)\s*=(?!=)/;
    const offenders = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (slotAssign.test(text) || factAssign.test(text)) {
        const rel = relative(srcDir, file).replace(/\\/g, "/");
        if (rel !== "api/engine-api.ts") offenders.add(rel);
      }
    }
    expect([...offenders]).toEqual([]);
  });
});

// ---------- 判据 2：buildFacts 三类窗口（1+1+N）+ 未登记 NPC 空 facts ----------

describe("判据2 buildFacts 透视窗口（F4）", () => {
  it("world 含全量隐秘 + hidden DAG 节点 + 全部台账", () => {
    const view = buildFacts(makeState(), "world");
    expect(view.perspective).toBe("world");
    const refs = view.facts.map((f) => f.factRef);
    expect(refs).toContain(SECRET_RIVAL);
    expect(refs).toContain(SECRET_MENTOR);
    expect(refs).toContain("dag:n3.hiddenSeed");
    expect(view.dagNodes?.some((n) => n.nodeId === "n3.hiddenSeed")).toBe(true);
    expect(view.ledger).toBeDefined();
    expect(Object.keys(view.ledger ?? {})).toEqual(
      expect.arrayContaining(["player", "npc:npc-rival", "npc:npc-mentor"]),
    );
  });

  it("player / npc 窗口只含 known / inferred，NPC 互不可见对方 secret", () => {
    const state = makeState();
    const player = buildFacts(state, "player");
    expect(player.facts.every((f) => f.level === "known" || f.level === "inferred")).toBe(true);
    expect(player.facts.map((f) => f.factRef)).not.toContain(SECRET_MENTOR);
    expect(player.ledger).toBeUndefined(); // 仅 world 允许携带

    const rival = buildFacts(state, "npc:npc-rival");
    expect(rival.facts.map((f) => f.factRef)).toContain(SECRET_RIVAL);
    expect(rival.facts.map((f) => f.factRef)).not.toContain(SECRET_MENTOR);
    expect(rival.facts.every((f) => f.level === "known" || f.level === "inferred")).toBe(true);
  });

  it("未登记 NPC 返回空 facts（不抛错、不回退 world）", () => {
    const view = buildFacts(makeState(), "npc:npc-unknown");
    expect(view.facts).toEqual([]);
    expect(view.ledger).toBeUndefined();
  });

  it("NPC 与玩家共用同一台账与同一 buildFacts（结构断言）", () => {
    const state = makeState();
    const world = buildFacts(state, "world");
    const player = buildFacts(state, "player");
    const rival = buildFacts(state, "npc:npc-rival");
    // 三窗口读同一份统一台账：world 携带全部观察者 ledger；player / npc 的 facts 来自各自台账条目
    const ledger = (world.ledger ?? {}) as Record<string, Array<{ factRef: string }>>;
    expect(Object.keys(ledger).sort()).toEqual(
      ["npc:npc-mentor", "npc:npc-rival", "player"].sort(),
    );
    for (const f of player.facts) {
      expect((ledger.player ?? []).some((e) => e.factRef === f.factRef)).toBe(true);
    }
    for (const f of rival.facts) {
      expect((ledger["npc:npc-rival"] ?? []).some((e) => e.factRef === f.factRef)).toBe(true);
    }
    // 同一 buildFacts 实现：perspective 回显 + player 窗口兼容别名
    expect(world.perspective).toBe("world");
    expect(player.perspective).toBe("player");
    expect(rival.perspective).toBe("npc:npc-rival");
    expect(typeof isPlayerWindowVisible).toBe("function");
    expect(isPlayerWindowVisible(state, "fact:gate-location")).toBe(true);
  });
});

// ---------- 判据 3：visibility_violation + 整块不下发 + 快照无隐秘原文 ----------

describe("判据3 F4 越窗拦下（visibility_violation）+ 整块不下发", () => {
  it("player 窗口写 hidden ref ⇒ visibility_violation（RETRYABLE + factsHint）+ sink 不收", () => {
    const state = makeState();
    const api = new RpgEngineAPI({ state });
    const call: ApiCall = {
      callId: "c1",
      tool: "narrative.write",
      args: {
        blockId: "b1",
        kind: "narrative",
        text: "导师的绝密计划原文-LEAK-CANARY",
        refs: [SECRET_MENTOR],
        visibility: "public",
        targetPerspective: "player",
        maskText: "某未公开的计划",
      },
    };
    const r = api.dispatch([call], ctx("player"));
    expect(r.receipts[0].outcome).toBe("rejected");
    expect(r.receipts[0].code).toBe("visibility_violation");
    expect(isRetryable("visibility_violation")).toBe(true);
    expect(r.receipts[0].factsHint).toBeDefined();
    expect(api.sink.list()).toHaveLength(0); // 整块不下发
    const snapshotJson = JSON.stringify(api.snapshot());
    expect(snapshotJson).not.toContain("LEAK-CANARY");
  });

  it("args.targetPerspective 与权威窗口不一致 ⇒ visibility_violation（绝不信 args 自带窗口）", () => {
    const state = makeState();
    const api = new RpgEngineAPI({ state });
    const call: ApiCall = {
      callId: "c2",
      tool: "narrative.write",
      args: {
        blockId: "b2",
        kind: "narrative",
        text: "x",
        refs: ["flag:took-right"],
        visibility: "public",
        targetPerspective: "world", // 与 ctx.targetPerspective=player 不一致
      },
    };
    const r = api.dispatch([call], ctx("player"));
    expect(r.receipts[0].code).toBe("visibility_violation");
  });

  it("ContentSink：hidden 块对 player 整块不下发，maskText 仅作 trace 元数据", () => {
    const sink = createContentSink();
    const block: ContentBlock = {
      blockId: "b3",
      kind: "narrative",
      text: "SECRET-ORIGINAL",
      refs: [],
      visibility: "hidden",
      targetPerspective: "player",
      maskText: "MASK",
    };
    expect(sink.append(block)).toBe(true);
    expect(sink.list()[0].maskText).toBe("MASK"); // trace 元数据保留
    expect(sink.forWindow("player")).toHaveLength(0); // 整块不下发
    expect(JSON.stringify(sink.forWindow("player"))).not.toContain("SECRET-ORIGINAL");
    // buildContentTrace 的 contentBlocks 是完整 ContentBlock[]，可过 LlmTraceSchema
    const trace = buildContentTrace(sink, {
      invocationId: "i", turnIndex: 0, worldTime: 0, reason: "r", toolProfile: "p", templateRef: "tpl",
    });
    expect(LlmTraceSchema.safeParse(trace).success).toBe(true);
    expect(validateContentBlock({ ...block, kind: "bogus" })).toBeNull();
  });
});

// ---------- 判据 4：validateDag 六步反例 + 加载/运行同函数 ----------

describe("判据4 validateDag 六步（Kahn）", () => {
  const node = (id: string, visibility: "public" | "hidden" = "public"): TaskNode => ({
    id, kind: "x", title: id, status: "ready", guards: [], completion: [], templateRefs: [], visibility,
  });
  const dag = (nodes: TaskNode[], edges: TaskDag["edges"]): TaskDag => ({
    dagId: "d", version: 1, issuedBy: "template", nodes, edges,
  });

  it("步1 悬空端点 / 步2 重复 id / 步3 自环 / 步4 重复边 / 步5 环 / 步6 不可解析 guard", () => {
    const reg = createConditionRegistry();
    // 步1 悬空端点
    expect(validateDag(dag([node("a")], [{ from: "a", to: "ghost", kind: "k" }])).ok).toBe(false);
    // 步2 重复 id
    expect(validateDag(dag([node("a"), node("a")], [])).ok).toBe(false);
    // 步3 自环
    expect(validateDag(dag([node("a")], [{ from: "a", to: "a", kind: "k" }])).ok).toBe(false);
    // 步4 重复边
    expect(validateDag(dag([node("a"), node("b")], [
      { from: "a", to: "b", kind: "k" }, { from: "a", to: "b", kind: "k" },
    ])).ok).toBe(false);
    // 步5 环（Kahn 未出队全部节点）
    expect(validateDag(dag([node("a"), node("b")], [
      { from: "a", to: "b", kind: "k" }, { from: "b", to: "a", kind: "k" },
    ])).ok).toBe(false);
    // 步6 不可解析 guard（未注册 op）
    const bad = dag([{ ...node("a"), guards: [{ op: "noSuchOp", args: {} }] }], []);
    const r6 = validateDag(bad, { registry: reg });
    expect(r6.ok).toBe(false);
    expect(r6.code).toBe("unknown_reference");
  });

  it("合法 DAG 通过；加载期与运行期共用同一函数", () => {
    expect(validateDag(dag([node("a"), node("b")], [{ from: "a", to: "b", kind: "k" }])).ok).toBe(true);
    expect(validateFallbackDag).toBe(validateDag); // 字面同一实现
    // 运行期 fact.advanceDag 走同一 validateDag：坏 DAG ⇒ 回执失败码
    const state = makeState();
    const api = new RpgEngineAPI({ state });
    const call: ApiCall = {
      callId: "c", tool: "fact.advanceDag",
      args: { dag: dag([node("a")], [{ from: "a", to: "ghost", kind: "k" }]) },
    };
    const r = api.dispatch([call], ctx());
    expect(r.receipts[0].outcome).toBe("rejected");
    expect(r.receipts[0].factsHint).toBeDefined();
  });
});

// ---------- 判据 5：触发求值 + R11 + 未传 gateway 零回归 ----------

describe("判据5 触发求值 / R11 / 零回归", () => {
  const reg = createConditionRegistry();

  it("2 条触发条件可求值；非触发回合 invocations.length === 0", () => {
    const state = makeState();
    const firing = baseRules([
      { when: [{ op: "always", args: {} }], invoke: INVOKE },
      { when: [{ op: "flagSet", args: { flag: "took-right" } }], invoke: INVOKE },
    ]);
    expect(evaluateTriggers(state, firing, reg, { seed: 1, turnIndex: 0 })).toHaveLength(2);
    const nonFiring = baseRules([
      { when: [{ op: "flagSet", args: { flag: "no-such-flag" } }], invoke: INVOKE },
    ]);
    expect(evaluateTriggers(state, nonFiring, reg, { seed: 1, turnIndex: 0 })).toHaveLength(0);
  });

  it("随机触发同 seed 两次结果一致（派生流不扰动主轮 RNG）", () => {
    const state = makeState();
    const rules = baseRules([
      { when: [{ op: "random", args: { probability: 0.5 } }], invoke: INVOKE },
    ]);
    const a = evaluateTriggers(state, rules, reg, { seed: 5, turnIndex: 0 });
    const b = evaluateTriggers(state, rules, reg, { seed: 5, turnIndex: 0 });
    expect(a).toEqual(b);
  });

  it("追加 R11：未注册 op ⇒ unknown_reference 诊断（非空、非静默）", () => {
    const state = makeState();
    const rules = baseRules([
      { when: [{ op: "totallyUnregistered", args: {} }], invoke: INVOKE },
    ]);
    const res = evaluateTriggersDetailed(state, rules, reg, { seed: 1, turnIndex: 0 });
    expect(res.diagnostics.length).toBeGreaterThan(0);
    expect(res.diagnostics.some((d) => d.code === "unknown_reference")).toBe(true);
    expect(res.diagnostics[0].op).toBe("totallyUnregistered");
  });

  it("未传 gateway 时逐字段一致（零回归）", () => {
    const t = makeTestTemplate();
    const sA = createActiveWorldV2({ templateId: "test", playerName: "P", seed: 7 }, t, "wA");
    assignSlot(sA, null);
    const sB = structuredClone(sA);
    const rA = advanceTurnV2(sA, { action: { type: "rest" } }, t, createLookup(t));
    const rB = advanceTurnV2(sB, { action: { type: "rest" } }, t, createLookup(t), undefined, {});
    deepStrictEqual(rA.state, rB.state);
    expect(rA.state.pendingInvocation).toBeUndefined();
  });

  it("传 gateway 时结算 tail hook 产出 invocation 交网关（不 await）+ 落 pendingInvocation", () => {
    const t = makeTestTemplate();
    const state = createActiveWorldV2({ templateId: "test", playerName: "P", seed: 9 }, t, "wB");
    assignSlot(state, null);
    const calls: LlmInvocation[] = [];
    const gateway: LlmGateway = {
      invoke(inv) {
        calls.push(inv);
        return Promise.resolve({ outcome: "deferred", invocationId: inv.invocationId });
      },
    };
    const rules = baseRules([{ when: [{ op: "always", args: {} }], invoke: INVOKE }]);
    const result = advanceTurnV2(
      state,
      { action: { type: "rest" } },
      t,
      createLookup(t),
      undefined,
      { gateway, rules },
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].replyTo).toBe("dispatch");
    expect(result.state.pendingInvocation).toBeDefined();
  });

  it("slot 仅既有来源 + delayQueue 唯一队列（结构断言）", () => {
    const state = makeState();
    // 单槽：slot 只能是 null 或呈现槽对象；slot 写入只在 api/engine-api.ts（判据1 源码守卫）
    expect(state.slot === null || typeof state.slot === "object").toBe(true);
    // 单队列：delayQueue 是唯一延时队列，不存在第二套 scheduledEvents
    expect(Array.isArray(state.delayQueue)).toBe(true);
    expect("scheduledEvents" in state).toBe(false);
  });
});

// ---------- 判据 6：档 1 回放（同 trace 相等 / 改 1 条不等 / 网络 0） ----------

describe("判据6 replayWithLlm 档1 回放", () => {
  const spec = {
    seed: 42,
    playerName: "P",
    worldId: "w1",
    template: makeTestTemplate(),
    commands: [{ action: { type: "rest" } }],
    llmTrace: [
      {
        turnIndex: 1,
        calls: [
          {
            callId: "k1",
            tool: "fact.setKnowledge",
            args: { observer: "npc:npc-rival", factRef: "fact:replayed", level: "known", source: "rule", sinceTurn: 1 },
          } as ApiCall,
        ],
      },
    ],
  };

  it("同 seed + commands + llmTrace ⇒ 逐字段相等；改 1 条 trace 必不相等", () => {
    const a = replayWithLlm(spec);
    const b = replayWithLlm(spec);
    deepStrictEqual(a, b);
    const changed = {
      ...spec,
      llmTrace: [
        {
          turnIndex: 1,
          calls: [
            { callId: "k1", tool: "fact.setKnowledge", args: { observer: "npc:npc-rival", factRef: "fact:DIFFERENT", level: "known", source: "rule", sinceTurn: 1 } } as ApiCall,
          ],
        },
      ],
    };
    notDeepStrictEqual(replayWithLlm(changed), a);
  });

  it("回放零网络（fetch 一旦被调用即抛错）", () => {
    const original = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (() => {
      networkCalls += 1;
      throw new Error("network must not be called");
    }) as typeof globalThis.fetch;
    try {
      replayWithLlm(spec);
    } finally {
      globalThis.fetch = original;
    }
    expect(networkCalls).toBe(0);
  });
});

// ---------- 判据 7：评价维度集由 EvaluationConfig 驱动 + state 无叙事正文字段 ----------

describe("判据7 评价模板化 + WorldStateV2 无叙事正文", () => {
  it("换 EvaluationConfig 维度集 ⇒ 输出维度集跟随变化", () => {
    const cfg: EvaluationConfig = {
      dimensions: [
        { id: "growth", label: "成长", weight: 1, ranges: [0, 100], explainRules: ["growth"] },
      ],
      worldSpecificDimensions: [
        { id: "resolve", label: "心志", weight: 0.5, ranges: [0, 50], explainRules: ["resolve"] },
      ],
    };
    const rec = evaluateLifeV2(makeState(), cfg);
    expect(rec.dimensions.map((d) => d.id)).toEqual(["growth", "resolve"]);
    expect(activeDimensionIds(cfg)).toEqual(["growth", "resolve"]);
  });

  it("WorldStateV2 结构断言：无任何叙事正文字段", () => {
    const state = makeState();
    expect("contentLayer" in state).toBe(false);
    expect("narrative" in state).toBe(false);
    expect("contentBlocks" in state).toBe(false);
    // traceRef 只是引用锚（字符串），不是正文
    state.traceRef = "trace:1";
    expect(typeof state.traceRef).toBe("string");
    expect("traceRef" in state).toBe(true);
  });
});
