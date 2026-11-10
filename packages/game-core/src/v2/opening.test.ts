import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  WorldTemplateV2Schema,
  type OpeningEventPool,
  type OpeningTemplate,
  type WorldTemplateV2,
} from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { createRunnerContext } from "./runner-context.js";
import { advanceTurnV2, createWorldV2 } from "./turn.js";
import {
  createDefaultOpeningTemplate,
  drawOpeningEvents,
  handoff,
  runOpening,
  selectOpeningTemplate,
  type OpeningDrawContext,
  type OpeningRunnerContext,
} from "./opening.js";

const jjkDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../specs/data/templates/jjk-2006",
);

function loadJjkTemplate(): WorldTemplateV2 {
  const merged: Record<string, unknown> = {};
  for (const file of ["world.yaml", "characters.yaml", "skills.yaml", "items.yaml", "statuses.yaml", "events.yaml"]) {
    const doc = parse(readFileSync(path.join(jjkDir, file), "utf8")) as Record<string, unknown>;
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

function fixture(seed = 7) {
  const template = loadJjkTemplate();
  const lookup = createLookup(template);
  const state = createWorldV2(
    { templateId: "jjk-2006", playerName: "测试者", seed },
    template,
    "w-opening",
  );
  const ctx: OpeningRunnerContext = { ...createRunnerContext(seed), lookup };
  const drawCtx = (openingId = "op-test"): OpeningDrawContext => ({
    state,
    lookup,
    idFactory: createRunnerContext(1).idFactory,
    openingId,
  });
  return { template, lookup, state, ctx, drawCtx };
}

function openingTemplate(overrides: Partial<OpeningTemplate> = {}): OpeningTemplate {
  const base: OpeningTemplate = {
    openingId: "op-test",
    name: "测试开局",
    description: "开局测试模板",
    entryConditions: [],
    steps: [{ id: "step-character", kind: "required" }],
    characterSetup: {},
    worldSetup: { flags: { openingDone: true } },
    npcSetup: {},
    eventPools: [],
    objectives: {},
    choices: {},
    completionConditions: [{ flag: "openingDone", eq: true }],
    handoff: { pendingEvents: [], schedule: [] },
  };
  return { ...base, ...overrides };
}

describe("T3-02 · drawOpeningEvents 事件池抽取（R-OP-03 / R-OP-04）", () => {
  it("① 同 seed 可复现", () => {
    const { ctx, drawCtx } = fixture();
    const pool: OpeningEventPool = {
      id: "pool-repro",
      seed: 42,
      countRange: [1, 3],
      events: [
        { id: "a", weight: 2 },
        { id: "b", weight: 1 },
        { id: "c", weight: 3 },
      ],
    };
    const r1 = drawOpeningEvents(pool, ctx.rng, drawCtx());
    const r2 = drawOpeningEvents(pool, ctx.rng, drawCtx());
    expect(r1.map((i) => i.definitionId)).toEqual(r2.map((i) => i.definitionId));
  });

  it("② exclusiveGroup 至多命中一个", () => {
    const { ctx, drawCtx } = fixture();
    const pool: OpeningEventPool = {
      id: "pool-excl",
      countRange: [1, 3],
      events: [
        { id: "x1", exclusiveGroup: "omen", weight: 1 },
        { id: "x2", exclusiveGroup: "omen", weight: 1 },
        { id: "free", weight: 1 },
      ],
    };
    for (let s = 0; s < 24; s++) {
      const res = drawOpeningEvents({ ...pool, seed: s }, ctx.rng, drawCtx());
      const inGroup = res.filter((i) => i.definitionId === "x1" || i.definitionId === "x2");
      expect(inGroup.length).toBeLessThanOrEqual(1);
    }
  });

  it("③ required 必出现", () => {
    const { ctx, drawCtx } = fixture();
    const pool: OpeningEventPool = {
      id: "pool-req",
      countRange: [1, 3],
      events: [
        { id: "must", required: true, weight: 1 },
        { id: "opt-a", weight: 2 },
        { id: "opt-b", weight: 1 },
      ],
    };
    for (let s = 0; s < 16; s++) {
      const res = drawOpeningEvents({ ...pool, seed: s }, ctx.rng, drawCtx());
      expect(res.map((i) => i.definitionId)).toContain("must");
    }
  });

  it("④ 数量落在 countRange 区间", () => {
    const { ctx, drawCtx } = fixture();
    const pool: OpeningEventPool = {
      id: "pool-range",
      countRange: [1, 3],
      events: [
        { id: "e1", weight: 1 },
        { id: "e2", weight: 1 },
        { id: "e3", weight: 1 },
        { id: "e4", weight: 1 },
        { id: "e5", weight: 1 },
      ],
    };
    for (let s = 0; s < 30; s++) {
      const res = drawOpeningEvents({ ...pool, seed: s }, ctx.rng, drawCtx());
      expect(res.length).toBeGreaterThanOrEqual(1);
      expect(res.length).toBeLessThanOrEqual(3);
    }
  });

  it("换 seed 随机结果可变，且 tags / conditions 走既有声明式 DSL", () => {
    const { ctx, drawCtx, state } = fixture();
    const pool: OpeningEventPool = {
      id: "pool-seed",
      countRange: [2, 4],
      events: [
        { id: "must", required: true, weight: 1 },
        { id: "a", weight: 1 },
        { id: "b", weight: 1 },
        { id: "c", weight: 1 },
        { id: "d", weight: 1 },
      ],
    };
    const variants = new Set<string>();
    for (let s = 0; s < 20; s++) {
      const res = drawOpeningEvents({ ...pool, seed: s }, ctx.rng, drawCtx());
      variants.add(res.map((i) => i.definitionId).join(","));
      expect(res.map((i) => i.definitionId)).toContain("must");
    }
    expect(variants.size).toBeGreaterThan(1);

    state.flags["allowNight"] = true;
    const filtered: OpeningEventPool = {
      id: "pool-tags",
      tags: ["campus"],
      countRange: [1, 3],
      seed: 1,
      events: [
        { id: "campus-ev", tags: ["campus"], weight: 1 },
        { id: "night-ev", tags: ["night"], weight: 1 },
        { id: "blocked-ev", tags: ["campus"], conditions: [{ flag: "missingFlag", eq: true }], weight: 1 },
      ],
    };
    const ids = drawOpeningEvents(filtered, ctx.rng, drawCtx()).map((i) => i.definitionId);
    expect(ids).not.toContain("night-ev");
    expect(ids).not.toContain("blocked-ev");
  });
});

describe("T3-03 / T3-04 · runOpening 初始化编排与 origin", () => {
  it("未声明关系的 NPC 为 unknown 且无关系条目；声明者关系带 source", () => {
    const { state, ctx } = fixture();
    const tpl = openingTemplate({
      npcSetup: {
        relations: [{ npcId: "npc-gojo", value: 5, source: "入学引导" }],
        visibility: { "npc-shoko": "inferred" },
      },
    });
    const { state: opened } = runOpening(state, tpl, ctx);
    expect(opened.flags["relationSource:npc-gojo"]).toBe("入学引导");
    expect(opened.npcs.find((n) => n.id === "npc-gojo")?.relationship).toBe(5);
    expect(opened.flags["infoVisibility:npc-gojo"]).toBe("known");
    expect(opened.flags["infoVisibility:npc-shoko"]).toBe("inferred");
    // 未声明关系者：unknown 且无关系条目
    expect(opened.flags["infoVisibility:npc-geto"]).toBe("unknown");
    expect(opened.flags["relationSource:npc-geto"]).toBeUndefined();
    // 纯函数：入参未被改写
    expect(state.flags["infoVisibility:npc-geto"]).toBeUndefined();
  });

  it("origin 为 opening + openingId，实例-定义可分离，effects 经既有 DSL 执行", () => {
    const { state, ctx } = fixture();
    const tpl = openingTemplate({
      eventPools: [
        {
          id: "pool-1",
          seed: 1,
          countRange: [1, 1],
          events: [
            {
              id: "ev-curse-sighting",
              weight: 1,
              required: true,
              effects: [{ type: "setFlag", id: "drawn", value: true }],
            },
          ],
        },
      ],
      handoff: { pendingEvents: [], schedule: [{ eventId: "ev-sp-briefing" }] },
    });
    const { state: opened, run } = runOpening(state, tpl, ctx);
    expect(run.instances.length).toBeGreaterThanOrEqual(2);
    for (const inst of run.instances) {
      expect(inst.origin).toEqual({ kind: "opening", id: "op-test" });
      expect(inst.instanceId).not.toBe(inst.definitionId);
    }
    expect(opened.flags["drawn"]).toBe(true);
    expect(run.instances.some((i) => i.status === "pending")).toBe(true);
    expect(
      run.instances.some((i) => i.status === "scheduled" && i.definitionId === "ev-sp-briefing"),
    ).toBe(true);
  });
});

describe("T3-05 · handoff 与首轮推进（R-OP-07 / R-TM-02）", () => {
  it("handoff 置 openingCompleted=true，即时事件进 pendingEvents，未来事件登记 schedule", () => {
    const { state, ctx } = fixture();
    const tpl = openingTemplate({
      handoff: {
        pendingEvents: ["ev-curse-sighting"],
        schedule: [{ eventId: "ev-sp-briefing", at: { value: 1, unit: "day" } }],
      },
    });
    const { state: opened, run } = runOpening(state, tpl, ctx);
    const final = handoff(opened, run);
    expect(final.openingCompleted).toBe(true);
    expect(final.pendingEvents.map((p) => p.eventId)).toContain("ev-curse-sighting");
    expect(final.flags["openingScheduled:ev-sp-briefing"]).toBe(true);
    // 纯函数：入参逐字段未被改写
    expect(opened.openingCompleted).toBe(false);
    expect(opened.pendingEvents).toEqual([]);
  });

  it("completionConditions 不满足时 handoff 拒绝（错误可诊断）", () => {
    const { state, ctx } = fixture();
    const tpl = openingTemplate({ completionConditions: [{ flag: "neverSet", eq: true }] });
    const { state: opened, run } = runOpening(state, tpl, ctx);
    expect(run.completed).toBe(false);
    expect(() => handoff(opened, run)).toThrow(/opening_not_complete/);
  });

  it("handoff 后首轮 advanceTurnV2 能正常消费 chains / schedule", () => {
    const { state, ctx, template, lookup } = fixture();
    const tpl = openingTemplate({
      worldSetup: {
        flags: { openingDone: true },
        effects: [
          { type: "startChain", chainId: "chain-star-plasma" },
          { type: "advanceTo", value: { value: 1, unit: "day" } },
        ],
      },
      handoff: {
        pendingEvents: [],
        schedule: [{ eventId: "ev-sp-briefing", at: { value: 1, unit: "day" } }],
      },
    });
    const { state: opened, run } = runOpening(state, tpl, ctx);
    const final = handoff(opened, run);
    expect(final.openingCompleted).toBe(true);
    expect(final.chains.some((c) => c.id === "chain-star-plasma" && c.status === "active")).toBe(true);

    const res = advanceTurnV2(final, { action: { type: "rest" } }, template, lookup);
    expect(res.state.openingCompleted).toBe(true);
    // schedule 事件由既有 resolveScheduleV2 在首轮触发（复用统一事件系统）
    expect(res.triggeredEvents.some((e) => e.id === "ev-sp-briefing")).toBe(true);
    // 既有链状态保留并参与首轮管线
    expect(res.state.chains.some((c) => c.id === "chain-star-plasma")).toBe(true);
  });

  it("最小默认开局（未提供 opening.yaml）直接完成交接", () => {
    const { state, ctx } = fixture();
    const tpl = createDefaultOpeningTemplate();
    const { state: opened, run } = runOpening(state, tpl, ctx);
    const final = handoff(opened, run);
    expect(final.openingCompleted).toBe(true);
    expect(run.executedSteps).toEqual([]);
    expect(run.instances).toEqual([]);
    expect(final.pendingEvents).toEqual([]);
  });
});

describe("T3-01 · R-OP-01 按 openingId 选择开局", () => {
  it("未指定时取首个；指定时按 id 命中；未知 id 返回 undefined", () => {
    const a = openingTemplate({ openingId: "op-a" });
    const b = openingTemplate({ openingId: "op-b", name: "另一个开局" });
    const list = [a, b];
    expect(selectOpeningTemplate(list)?.openingId).toBe("op-a");
    expect(selectOpeningTemplate(list, "op-b")?.name).toBe("另一个开局");
    expect(selectOpeningTemplate(list, "op-missing")).toBeUndefined();
    expect(selectOpeningTemplate([])).toBeUndefined();
    // 纯函数：入参数组未被改写
    expect(list).toEqual([a, b]);
  });

  it("两个不同开局分别跑出的世界彼此可区分", () => {
    const { state, ctx } = fixture();
    const tokyo = openingTemplate({
      openingId: "op-tokyo",
      worldSetup: { flags: { openingDone: true, startPlace: "东京" } },
    });
    const kyoto = openingTemplate({
      openingId: "op-kyoto",
      worldSetup: { flags: { openingDone: true, startPlace: "京都" } },
    });
    const r1 = runOpening(state, tokyo, ctx);
    const r2 = runOpening(state, kyoto, ctx);
    expect(r1.state.flags["startPlace"]).toBe("东京");
    expect(r2.state.flags["startPlace"]).toBe("京都");
    expect(r1.run.openingId).toBe("op-tokyo");
    expect(r2.run.openingId).toBe("op-kyoto");
  });
});

describe("T3-04 · 静态自查（R-OP-06 / 附录 A A4/A5）", () => {
  it("source 枚举仍为四类、无事件栈模块", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    // 阶段状态机符号由 boundary.test.ts 统一扫描全部 .ts，此处只查 source 枚举与栈模块。
    const eventSrc = readFileSync(path.resolve(dir, "../../../shared/src/schema/event.ts"), "utf8");
    const match = eventSrc.match(/source:\s*z\.enum\(\[([^\]]*)\]\)/);
    expect(match).not.toBeNull();
    const values = (match as RegExpMatchArray)[1]
      .split(",")
      .map((s) => s.trim().replace(/["']/g, ""))
      .filter(Boolean);
    expect(values).toEqual(["pool", "chain", "schedule", "action-hook"]);
    const v2Files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(v2Files.some((f) => /stack/i.test(f))).toBe(false);
  });
});
