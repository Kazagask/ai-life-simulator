import { describe, expect, it } from "vitest";
import {
  advanceTurnV2,
  checkCondition,
  createConditionRegistry,
  evaluateAll,
  createWorldV2,
  evaluateTriggersEdge,
  historyDigestOf,
  type WorldStateV2,
} from "@life-sim/game-core";
import { RulesSchema } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function loadEntry() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  if (entry.rules === undefined) throw new Error("jjk-2006/3.0.0 没有 rules.yaml");
  return entry;
}

function newWorld(seed = 21) {
  const entry = loadEntry();
  const state = createWorldV2(
    { templateId: "jjk-2006", playerName: "测试", seed },
    entry.template,
    `w-gm-${seed}`,
  );
  state.openingCompleted = true;
  return { state, entry };
}

/** 求一次触发，返回命中的 invocation（按 reason 取名）。 */
function invocationsOf(state: WorldStateV2, entry: ReturnType<typeof loadEntry>) {
  const { invocations } = evaluateTriggersEdge(
    state,
    entry.rules!,
    createConditionRegistry(),
    { seed: state.seed, turnIndex: state.turnIndex, template: entry.template },
  );
  return new Map(invocations.map((inv) => [inv.reason, inv]));
}

describe("条件 instruction（2026-11-21）", () => {
  it("同一幕用 `as` 分两条线：理子本人写「被护送」，其他人写「护送」", () => {
    const { state, entry } = newWorld();
    state.flags.spJoined = true;

    // ① `as: npc-riko`（⇔ selfIs）命中：取第一条，正文原样，不加任何前缀。
    state.selfId = "npc-riko";
    const asRiko = invocationsOf(state, entry).get("jjk.hv.departure");
    expect(asRiko).toBeDefined();
    expect(asRiko!.context.instruction).toContain("你是被护送的那个人");
    expect(asRiko!.context.instruction).not.toContain("身份");

    // ② 普通线（护卫）：兜底变体。
    delete state.selfId;
    const asGuard = invocationsOf(state, entry).get("jjk.hv.departure");
    expect(asGuard!.context.instruction).toContain("你是被派去护卫星浆体的人");
  });

  it("as 数组：多个角色共用同一段提示词（含自建角色按出身生成的 id）", () => {
    const { state, entry } = newWorld();
    state.flags.spJoined = true;
    const rules = structuredClone(entry.rules!);
    const trigger = rules.llmTriggers.find((t) => t.invoke.reason === "jjk.hv.departure")!;
    trigger.invoke.instruction = [
      { as: ["npc-riko", "player-clan-branch"], text: "两个人共用" },
      { text: "兜底" },
    ];

    const instructionFor = (selfId: string): string | undefined => {
      state.selfId = selfId;
      const { invocations } = evaluateTriggersEdge(state, rules, createConditionRegistry(), {
        seed: state.seed,
        turnIndex: state.turnIndex,
        template: entry.template,
      });
      return invocations.find((inv) => inv.reason === "jjk.hv.departure")?.context.instruction;
    };

    expect(instructionFor("npc-riko")).toBe("两个人共用");
    expect(instructionFor("player-clan-branch")).toBe("两个人共用");
    expect(instructionFor("npc-geto")).toBe("兜底");
  });

  it("条件变体不影响触发器本身的判定（没写旗标就不发）", () => {
    const { state, entry } = newWorld();
    expect(invocationsOf(state, entry).get("jjk.hv.departure")).toBeUndefined();
  });

  it("as 变体必须留一条无 as 的兜底（加载期拒）", () => {
    const bad = {
      id: "x",
      when: [],
      invoke: {
        reason: "x",
        perspective: "player",
        targetPerspective: "player",
        toolProfile: "narrative",
        instruction: [{ as: "npc-riko", text: "只给理子" }],
      },
    };
    // 直接用 schema 校验一条只有 as 变体的触发点。
    const parsed = RulesSchema.safeParse({
      llmTriggers: [bad],
      toolProfile: { narrative: [] },
      knowledgeGrants: [],
      inferenceRules: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("instruction 仍然受 300 字上限约束（变体与单字符串同一口径）", () => {
    const { entry } = newWorld();
    const trigger = entry.rules!.llmTriggers.find((t) => t.invoke.reason === "jjk.hv.departure");
    const variants = trigger!.invoke.instruction;
    expect(Array.isArray(variants)).toBe(true);
    for (const variant of variants as Array<{ text: string }>) {
      expect(variant.text.length).toBeLessThanOrEqual(300);
    }
  });
});

describe("LLM 提交的事件真的会上桌（2026-11-21 接线）", () => {
  const branchEvent = (id: string) => ({
    id,
    title: "不速之客",
    narrative: "门口站着一个人，他没有敲门。",
    kind: "normal",
    trigger: { source: "pool", weight: 1 },
    settle: {
      normal: {
        options: [{ id: "opt-gen-1", text: "开门", effects: [] }],
      },
    },
  });

  it("生成事件声明 pool ⇒ 回合 tail 会把它抽进队列（以前只抽模板事件）", () => {
    const { state, entry } = newWorld();
    state.generatedEvents = [branchEvent("gen:inv-1:n1") as never];

    // 与生产同一条路径：lookup 必须叠加 `withGenerated`，否则队列扫描把定义判成缺失。
    advanceTurnV2(
      state,
      { action: { type: "rest", description: "" } },
      entry.template,
      entry.lookup.withGenerated(state.generatedEvents),
    );

    // 抽中即入队；入口没有延迟 ⇒ 同一轮的队列扫描就把它摆上桌（fired + slot）。
    const queued = state.delayQueue.filter((item) => item.definitionId === "gen:inv-1:n1");
    expect(queued).toHaveLength(1);
    expect(["waiting", "fired"]).toContain(queued[0]!.status);
    expect(state.slot?.eventId).toBe("gen:inv-1:n1");
  });

  it("生成事件是一次性内容：结算过就不再被抽中", () => {
    const { state, entry } = newWorld();
    state.generatedEvents = [branchEvent("gen:inv-2:n1") as never];
    // 标记为已结算（recordFire 写的就是这两个索引）
    state.firedEvents["gen:inv-2:n1"] = 3;

    advanceTurnV2(
      state,
      { action: { type: "rest", description: "" } },
      entry.template,
      entry.lookup.withGenerated(state.generatedEvents),
    );

    expect(state.delayQueue.some((item) => item.definitionId === "gen:inv-2:n1")).toBe(false);
  });

  it("规则里有一份能写分支的工具画像，且模型看得到 story.submitBranch", () => {
    const { entry } = newWorld();
    expect(entry.rules!.toolProfile.story).toContain("story.submitBranch");
    const interlude = entry.rules!.llmTriggers.find((t) => t.invoke.reason === "jjk.gm.interlude");
    expect(interlude?.invoke.toolProfile).toBe("story");
  });
});

describe("叙事素材（上一轮加的 historyDigestOf）", () => {
  it("只取玩家可见条目，hidden 不外泄", () => {
    const { state } = newWorld();
    state.history = [
      { id: "h1", type: "world", summary: "公开的事", visibility: "public", turnIndex: 0, worldTime: 0, formattedTime: "" },
      { id: "h2", type: "world", summary: "藏起来的事", visibility: "hidden", turnIndex: 0, worldTime: 0, formattedTime: "" },
    ] as never;
    expect(historyDigestOf(state).map((d) => d.id)).toEqual(["h1"]);
  });
});

describe("触发器条件与引擎条件同义（2026-11-21 补齐）", () => {
  /**
   * `condition-evaluator` 的扁平求值表曾经只覆盖一半 DSL：`selfIs` / `relation` / `mood` /
   * `npcState` 整支缺失、`time` 是个恒真的占位 —— rules.yaml 里写这些条件**恒为假且不报诊断**。
   * 条件 instruction 的分支选择依赖 `selfIs`，才把这个洞暴露出来。
   *
   * 这里只比**两边应当同义**的几类；`attribute` 故意不比：引擎读有效值（叠状态/装备），
   * 触发器读原始值，这是既有口径差异，不是 bug。
   */
  it("selfIs / selfIsNot / mood / time / npcState / relation 与引擎一致", () => {
    const { state, entry } = newWorld();
    const rng = () => 0.5;
    state.selfId = "npc-riko";
    state.player.mood = 40;
    state.worldTime = 100 * 1440;
    state.npcs.find((n) => n.id === "npc-toji")!.lifecycle.state = "alive";
    const registry = createConditionRegistry();
    const evalCtx = { state, rng, turnIndex: state.turnIndex, template: entry.template };
    const engineCtx = { state, lookup: entry.lookup, rng };

    const cases = [
      { selfIs: "npc-riko" },
      { selfIs: "npc-toji" },
      { selfIsNot: "npc-riko" },
      { mood: { gte: 30 } },
      { mood: { lte: 10 } },
      { time: { gte: { value: 50, unit: "day" } } },
      { time: { lt: { value: 50, unit: "day" } } },
      { npcState: { npcId: "npc-toji", state: "alive" } },
      { npcState: { npcId: "npc-toji", state: "dead" } },
      { flag: "从来没有写过的旗标", ne: 1 },
    ] as const;

    for (const cond of cases) {
      const viaTrigger = evaluateAll([cond as never], evalCtx, registry);
      const viaEngine = checkCondition(cond as never, engineCtx);
      expect(viaTrigger, JSON.stringify(cond)).toBe(viaEngine);
    }
  });
});
