import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "yaml";
import { WorldTemplateV2Schema, RulesSchema, type WorldStateV2, type WorldTemplateV2 } from "@life-sim/shared";

import { createActiveWorldV2 } from "./v2/test-utils.js";
import { createConditionRegistry, evaluateTriggers } from "./v2/condition-evaluator.js";
import { RpgEngineAPI } from "./api/engine-api.js";
import { createLookup } from "./v2/lookup.js";
import { advanceTurnV2, chooseOptionV2 } from "./v2/turn.js";
import { checkEventPremise, enqueueScheduled, scanDelayQueue } from "./v2/scheduler.js";
import { createRng } from "./rng.js";

/**
 * 防线二回归：**模板侧 `missWhen` 一次性守卫**（demo-agentic `evt:chance` / `evt:trial`）。
 *
 * 为什么需要这一组：防线一在 agent-runtime（mock 不再把裸 `evt:` 标签当入队指令），
 * 而 `fact.enqueueEvent` 走的是 `enqueueScheduled`、**绕过 `enqueueCandidate` 的 `once` 门控**
 * （`api/engine-api.ts`）。只要还有任何一条路径能把同一事件重复塞进 `delayQueue`
 * （ScriptedProvider / 真实 LLM 硬 emit / 未来的结构化 `branchEventIds`），
 * 只有出队终判 `checkEventPremise → missWhen` 能把重复实例清场。
 *
 * 本文件把 2026-11-16 的 409 事故**形状**固化成回归锁：
 * `closing ↔ chance` 无限交替的成因是「同一窗口内多条 `origin.kind="effect"` 的重复实例」。
 * 数据全部来自仓库里的真实模板 `specs/data/templates/demo-agentic/1.0.0/`，不 mock 调度器。
 */

const VERSION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../specs/data/templates/demo-agentic/1.0.0",
);

/** 与 `apps/server/src/templates.ts` 的 `TEMPLATE_MERGE_FILES` 同口径的最小合并（只取存在的文件）。 */
const MERGE_FILES = [
  "world.yaml",
  "characters.yaml",
  "skills.yaml",
  "items.yaml",
  "statuses.yaml",
  "events.yaml",
  "equipment.yaml",
  "combat-ai.yaml",
] as const;

function loadDemoTemplate(): WorldTemplateV2 {
  const merged: Record<string, unknown> = {};
  for (const file of MERGE_FILES) {
    const abs = path.join(VERSION_DIR, file);
    if (!existsSync(abs)) continue;
    const doc = parse(readFileSync(abs, "utf8")) as Record<string, unknown> | null;
    if (doc === null || typeof doc !== "object") continue;
    for (const [key, value] of Object.entries(doc)) {
      if (key === "meta") merged.meta = value;
      else if (merged[key] === undefined) merged[key] = value;
      else if (Array.isArray(merged[key]) && Array.isArray(value)) {
        merged[key] = [...(merged[key] as unknown[]), ...value];
      }
    }
  }
  return WorldTemplateV2Schema.parse(merged);
}

function freshWorld(seed = 42): {
  template: WorldTemplateV2;
  lookup: ReturnType<typeof createLookup>;
  state: WorldStateV2;
} {
  const template = loadDemoTemplate();
  const lookup = createLookup(template);
  const state = createActiveWorldV2({ templateId: "demo-agentic", playerName: "回归", seed }, template, `mw-${seed}`);
  // 直接把时间推到一个确定的锚点：重复实例的 window.start === enqueuedAt（事故形状见下）。
  state.worldTime = 1440;
  return { template, lookup, state };
}

/** 复刻 `fact.enqueueEvent` 的入队形状：origin.kind="effect" + 零延时（start === enqueuedAt）。 */
function enqueueEffect(state: WorldStateV2, eventId: string) {
  return enqueueScheduled({
    state,
    definitionId: eventId,
    origin: { kind: "effect", id: eventId },
    absoluteStart: state.worldTime,
  });
}

const act = (
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: ReturnType<typeof createLookup>,
) => advanceTurnV2(state, { action: { type: "act", description: "" } }, template, lookup);

describe("missWhen 一次性守卫（防线二）", () => {
  it("同一窗口的两条 effect 实例：第一条 fire 写 Done flag，第二条在下一次 drain 被判 miss_when", () => {
    const { template, lookup, state } = freshWorld();
    expect(state.slot).toBeNull();

    const first = enqueueEffect(state, "evt:chance");
    const second = enqueueEffect(state, "evt:chance");

    // 事故形状：同一时刻入队 ⇒ 同一时刻到期（不是池子抽取，origin 是 effect）。
    expect(first.origin).toEqual({ kind: "effect", id: "evt:chance" });
    expect(second.origin).toEqual({ kind: "effect", id: "evt:chance" });
    expect(first.enqueuedAt).toBe(1440);
    expect(second.enqueuedAt).toBe(1440);
    expect(first.window.start).toBe(first.enqueuedAt);
    expect(second.window.start).toBe(second.enqueuedAt);

    // 第 1 轮：drain 取第一条 ⇒ 摆上桌（偶遇转盘）。
    const presented = act(state, template, lookup);
    expect(presented.snapshot.slotEvent?.eventId).toBe("evt:chance");
    expect(presented.snapshot.slotEvent?.kind).toBe("random");

    // 第 2 轮：确认转盘 ⇒ 结算（写 chanceDone），nextEventId 指向落幕。
    act(state, template, lookup);
    expect(state.firedEvents["evt:chance"]).toBeDefined();
    expect(state.flags.chanceDone).toBe(true);
    expect(state.slot?.eventId).toBe("evt:closing");

    // 收掉落幕 ⇒ 槽清空，下一轮必然 drain（这正是 409 事故发生的时刻）。
    chooseOptionV2(state, { optionId: "opt-finish" }, template, lookup);
    expect(state.slot).toBeNull();

    // 第 3 轮：第二条到期，被 missWhen 判死 ⇒ 不再占槽，玩家继续自由行动。
    const afterDrop = act(state, template, lookup);
    expect(afterDrop.snapshot.slotEvent).toBeNull();
    expect(second.status).toBe("expired");
    expect(first.status).toBe("fired");

    // 恰好 fire 一次；一条 miss_when 记录（带模板给的 missLabel）。
    expect(state.eventFires.filter((f) => f.eventId === "evt:chance")).toHaveLength(1);
    const misses = state.missedEvents.filter((m) => m.eventId === "evt:chance");
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({
      eventId: "evt:chance",
      instanceId: second.instanceId,
      reason: "miss_when",
      label: "偶遇已经过去了",
    });
  });

  it("清场靠的是 missWhen 而不是 once：摘掉 missWhen 后，同形状的第二条会再次上桌", () => {
    const { template, lookup, state } = freshWorld();
    // 只在内存里摘掉守卫（不改 yaml）：证明 once 不是这道闸。
    const unguarded = structuredClone(template);
    const chance = unguarded.events.find((e) => e.id === "evt:chance");
    expect(chance).toBeDefined();
    delete chance!.trigger.missWhen;
    delete chance!.trigger.missLabel;
    const unguardedLookup = createLookup(unguarded);

    enqueueEffect(state, "evt:chance");
    const second = enqueueEffect(state, "evt:chance");

    act(state, unguarded, unguardedLookup); // 呈现
    act(state, unguarded, unguardedLookup); // 确认 ⇒ chanceDone=true
    expect(state.flags.chanceDone).toBe(true);
    // 收掉落幕的同一轮里，nextTurn 就会 drain 到第二条重复实例 ——
    // 槽位立刻又被它占住，这就是 closing↔chance 无限交替的形状（有守卫时同一时刻槽是空的）。
    chooseOptionV2(state, { optionId: "opt-finish" }, unguarded, unguardedLookup);
    expect(state.slot?.eventId).toBe("evt:chance");
    expect(state.slot?.from).toBe("queueTake");

    // 再确认一次转盘 ⇒ 第二张卡也结算了（同一事件 fire 两次），环继续。
    const again = act(state, unguarded, unguardedLookup);
    expect(again.snapshot.slotEvent?.eventId).toBe("evt:closing");
    expect(second.status).toBe("fired");
    expect(state.eventFires.filter((f) => f.eventId === "evt:chance")).toHaveLength(2);
    expect(state.missedEvents.filter((m) => m.reason === "miss_when")).toHaveLength(0);
  });

  it("跨事件不串味：trialDone 为真不得让 evt:chance 被判 miss_when", () => {
    const { lookup, state } = freshWorld();
    const def = lookup.event("evt:chance");
    expect(def).toBeDefined();

    state.flags.trialDone = true;
    expect(checkEventPremise(def!, { state, lookup, rng: createRng(1) })).toEqual({ ok: true });

    state.flags.chanceDone = true;
    expect(checkEventPremise(def!, { state, lookup, rng: createRng(1) })).toMatchObject({
      ok: false,
      missWhen: true,
      label: "偶遇已经过去了",
    });
  });

  it("missWhen 命中返回 missWhen 标志，且是纯判定（不写 missedEvents）", () => {
    const { lookup, state } = freshWorld();
    const def = lookup.event("evt:chance")!;
    state.flags.chanceDone = true;
    const before = state.missedEvents.length;

    const verdict = checkEventPremise(def, { state, lookup, rng: createRng(1) });
    expect(verdict).toEqual({ ok: false, missWhen: true, label: "偶遇已经过去了" });
    expect(state.missedEvents.length).toBe(before);
  });

  it("守卫不误杀：missWhen 未命中时正常 fire，且不产生任何 missedEvents", () => {
    const { lookup, state } = freshWorld();
    const instance = enqueueEffect(state, "evt:chance");
    expect(state.flags.chanceDone).toBeUndefined();

    const scan = scanDelayQueue(state, lookup, createRng(1));
    expect(scan.kind).toBe("taken");
    expect(instance.status).toBe("fired");
    expect(state.missedEvents).toHaveLength(0);
  });

  /**
   * ADR-0038 第 4 条：**白名单是能力声明，不是提示的副产物**。
   *
   * 模板作者只在 `contextHints` 里写 `evt:trial`（旧写法，标签语义）而没声明
   * `invoke.branchEventIds` ⇒ core 不往 `LlmContext` 里拷任何白名单 ⇒ 引擎侧
   * 「两拒一放」的第一种拒绝（未声明），`delayQueue` 逐字段不变。
   *
   * 这条把「沉默 = 没有分支能力」钉在 engine 层：即使调用方（mock / 真实模型）
   * 硬发 `fact.enqueueEvent`，也进不了队列。
   */
  it("未声明 branchEventIds ⇒ 即使 contextHints 提到事件也零入队", () => {
    const { state } = freshWorld();
    const rawRules = parse(readFileSync(path.join(VERSION_DIR, "rules.yaml"), "utf8")) as Record<
      string,
      unknown
    >;
    const rules = RulesSchema.parse(rawRules);
    const trigger = rules.llmTriggers[0]!;
    // 只写标签、不声明白名单（模拟迁移前的老模板）。
    trigger.invoke.contextHints = ["chapter.tone", "evt:trial"];
    delete trigger.invoke.branchEventIds;
    // 让触发器稳定命中，不依赖 taskDag 状态。
    trigger.when = [{ op: "always", args: {} }];

    const invocation = evaluateTriggers(state, rules, createConditionRegistry(), {
      seed: state.seed,
      turnIndex: 1,
    })[0];
    expect(invocation).toBeDefined();
    // 关键：hints 里有事件 id，但 context 里没有白名单。
    expect(invocation!.context.contextHints).toContain("evt:trial");
    expect(invocation!.context.branchEventIds).toBeUndefined();

    const api = new RpgEngineAPI({
      state,
      perspective: "player",
      targetPerspective: "player",
    });
    const before = JSON.stringify(state);
    const result = api.dispatch(
      [{ callId: "c-1", tool: "fact.enqueueEvent", args: { eventId: "evt:trial" } }],
      {
        turnIndex: state.turnIndex,
        worldTime: state.worldTime,
        invocationId: invocation!.invocationId,
        perspective: "player",
        targetPerspective: "player",
      },
    );

    const receipt = result.receipts[0];
    expect(receipt?.outcome).toBe("rejected");
    expect(receipt?.code).toBe("unknown_reference");
    expect(receipt?.factsHint).toMatchObject({ allowedRefs: [] });
    // 逐字段不变（含 enqueueSeqCounter）—— 拒绝不是"入队后清理"。
    expect(JSON.stringify(state)).toBe(before);
    expect(state.delayQueue).toHaveLength(0);
  });
});
