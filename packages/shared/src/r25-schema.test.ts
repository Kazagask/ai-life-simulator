import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { ScheduledEventInstanceSchema, WorldTemplateV2Schema } from "./schema/index.js";

/**
 * R2.5 / T1-01 加载期契约验收：
 * - 退役字段给出「指明替代写法」的诊断错误，而不是通用 unrecognized key；
 * - #35 立即 action-hook 唯一性（延时豁免，错误带提示）；
 * - source: pool + kind: combat 拒绝；
 * - schedule 必须有 window.start；新字段 strict 校验。
 */

const TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../specs/data/templates/jjk-2006",
);

const readYaml = (file: string): Record<string, unknown> =>
  YAML.parse(readFileSync(path.join(TEMPLATE_DIR, file), "utf-8")) as Record<string, unknown>;

function baseTemplate(): Record<string, unknown> {
  return {
    ...readYaml("world.yaml"),
    ...readYaml("characters.yaml"),
    ...readYaml("skills.yaml"),
    ...readYaml("items.yaml"),
    ...readYaml("statuses.yaml"),
    ...readYaml("events.yaml"),
  };
}

type Trigger = Record<string, unknown>;

function normalEvent(id: string, trigger: Trigger): Record<string, unknown> {
  return {
    id,
    title: `事件 ${id}`,
    narrative: "加载期校验用事件。",
    trigger,
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  };
}

function combatEvent(id: string, trigger: Trigger): Record<string, unknown> {
  return {
    id,
    title: `战斗 ${id}`,
    narrative: "加载期校验用战斗。",
    trigger,
    kind: "combat",
    settle: { combat: { enemies: [{ ref: "enemy-curse-larva" }] } },
  };
}

function withEvents(extra: Record<string, unknown>[]): Record<string, unknown> {
  const base = baseTemplate();
  return { ...base, events: [...(base.events as unknown[]), ...extra] };
}

function issuesOf(input: Record<string, unknown>): string[] {
  const parsed = WorldTemplateV2Schema.safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("R2.5 · 退役触发字段的诊断错误（R-EV-09）", () => {
  it("atTurn：拒绝且指明 window.start 替代写法", () => {
    const raw = baseTemplate();
    const events = structuredClone(raw.events) as Array<Record<string, unknown>>;
    const briefing = events.find((e) => e.id === "ev-sp-briefing")!;
    delete (briefing.trigger as Record<string, unknown>).window;
    (briefing.trigger as Record<string, unknown>).atTurn = 1;
    const msgs = issuesOf({ ...raw, events });
    expect(msgs.some((m) => m.includes("atTurn") && m.includes("window.start"))).toBe(true);
  });

  it("atWorldTime：拒绝且指明 window.start 替代写法", () => {
    const raw = baseTemplate();
    const events = structuredClone(raw.events) as Array<Record<string, unknown>>;
    const briefing = events.find((e) => e.id === "ev-sp-briefing")!;
    delete (briefing.trigger as Record<string, unknown>).window;
    (briefing.trigger as Record<string, unknown>).atWorldTime = { value: 1, unit: "day" };
    const msgs = issuesOf({ ...raw, events });
    expect(msgs.some((m) => m.includes("atWorldTime") && m.includes("window"))).toBe(true);
  });

  it("cooldownTurns：拒绝且指明 cooldown TimeSpec 替代写法", () => {
    const raw = baseTemplate();
    const events = structuredClone(raw.events) as Array<Record<string, unknown>>;
    const sighting = events.find((e) => e.id === "ev-curse-sighting")!;
    delete (sighting.trigger as Record<string, unknown>).cooldown;
    (sighting.trigger as Record<string, unknown>).cooldownTurns = 4;
    const msgs = issuesOf({ ...raw, events });
    expect(msgs.some((m) => m.includes("cooldownTurns") && m.includes("cooldown"))).toBe(true);
  });

  it("schedule 缺 window.start 时给出明确提示", () => {
    const raw = baseTemplate();
    const events = structuredClone(raw.events) as Array<Record<string, unknown>>;
    const briefing = events.find((e) => e.id === "ev-sp-briefing")!;
    delete (briefing.trigger as Record<string, unknown>).window;
    const msgs = issuesOf({ ...raw, events });
    expect(msgs.some((m) => m.includes("window.start"))).toBe(true);
  });
});

describe("R2.5 · #35 立即 action-hook 唯一性（延时豁免）", () => {
  // 用独立 onActionId，避免与模板内既有的 ev-curse-ambush（patrol）立即 hook 意外同组。
  const immediate = { source: "action-hook", onActionId: "probe-action", probability: 1 };
  const delayedWindow = {
    source: "action-hook",
    onActionId: "probe-action",
    window: { start: { value: 1, unit: "day" } },
  };
  const delayedDelay = {
    source: "action-hook",
    onActionId: "probe-action",
    delay: { value: 2, unit: "hour" },
  };

  it("① 1 条立即 + N 条声明 window/delay 的延时 hook → 加载合法", () => {
    const parsed = WorldTemplateV2Schema.safeParse(
      withEvents([
        normalEvent("ev-h-immediate", immediate),
        normalEvent("ev-h-delayed-window", delayedWindow),
        normalEvent("ev-h-delayed-delay", delayedDelay),
      ]),
    );
    expect(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([]);
  });

  it("② 同一 onActionId 2 条立即 hook → 拒绝且提示「可为后续 hook 声明 window/delay 转为延时」", () => {
    const msgs = issuesOf(
      withEvents([
        normalEvent("ev-h-immediate-a", immediate),
        normalEvent("ev-h-immediate-b", immediate),
      ]),
    );
    expect(msgs.some((m) => m.includes("window/delay 转为延时"))).toBe(true);
  });

  it("③ 同一 onActionId 全为延时 hook → 加载合法", () => {
    const parsed = WorldTemplateV2Schema.safeParse(
      withEvents([
        normalEvent("ev-h-delayed-a", delayedWindow),
        normalEvent("ev-h-delayed-b", delayedDelay),
        normalEvent("ev-h-delayed-c", delayedWindow),
      ]),
    );
    expect(parsed.success).toBe(true);
  });

  it("chain / schedule / pool 不受 #35 约束（同 onActionId 之类比不适用）", () => {
    const parsed = WorldTemplateV2Schema.safeParse(
      withEvents([
        normalEvent("ev-chain-a", { source: "chain" }),
        normalEvent("ev-chain-b", { source: "chain" }),
        normalEvent("ev-pool-a", { source: "pool", probability: 1 }),
        normalEvent("ev-pool-b", { source: "pool", weight: 1 }),
        normalEvent("ev-sched-a", { source: "schedule", window: { start: { value: 1, unit: "day" } } }),
      ]),
    );
    expect(parsed.success).toBe(true);
  });
});

describe("R2.5 · pool 与战斗解耦 / 新字段 strict（R-EV-13 / R-LM-05）", () => {
  it("source: pool + kind: combat 被拒，且提示改用通常事件/转盘事件再触发战斗", () => {
    const msgs = issuesOf(withEvents([combatEvent("ev-pool-combat", { source: "pool", probability: 1 })]));
    expect(msgs.some((m) => m.includes("不允许 kind: combat") && m.includes("触发战斗"))).toBe(true);
  });

  it("TimeSpec 非整数 value 被拒（整数分钟口径）", () => {
    const raw = baseTemplate();
    const events = structuredClone(raw.events) as Array<Record<string, unknown>>;
    (events.find((e) => e.id === "ev-curse-sighting")!.trigger as Record<string, unknown>).cooldown = {
      value: 1.5,
      unit: "day",
    };
    const msgs = issuesOf({ ...raw, events });
    expect(msgs.some((m) => m.includes("cooldown"))).toBe(true);
  });

  it("新字段 window / delay / cooldown / timeCost / missWhen / missLabel 可加载；未知字段仍被 strict 拒绝", () => {
    const good = WorldTemplateV2Schema.safeParse(
      withEvents([
        normalEvent("ev-r25-window", {
          source: "schedule",
          window: { start: { value: 3, unit: "day" }, end: { value: 5, unit: "day" } },
          timeCost: { value: 2, unit: "hour" },
          cooldown: { value: 1, unit: "day" },
          missWhen: [{ flag: "neverSet", eq: true }],
          missLabel: "前提已失效",
        }),
      ]),
    );
    expect(good.success).toBe(true);

    const bad = issuesOf(
      withEvents([
        normalEvent("ev-r25-unknown", {
          source: "schedule",
          window: { start: { value: 1, unit: "day" } },
          notAField: true,
        }),
      ]),
    );
    expect(bad.some((m) => m.includes("notAField") || m.includes("Unrecognized"))).toBe(true);
  });

  it("R-EV-15：ScheduledEventInstance 不含六个配置域字段的副本（strict + 静态扫描）", () => {
    const configFields = ["probability", "weight", "once", "priority", "conditions", "onActionId"];
    const valid = {
      instanceId: "evi-0",
      definitionId: "ev-x",
      origin: { kind: "pool", id: "ev-x" },
      window: { start: 0 },
      hasEnd: false,
      enqueuedAt: 0,
      enqueueSeq: 0,
      status: "waiting",
    };
    const parsed = ScheduledEventInstanceSchema.parse(valid);
    for (const field of configFields) {
      expect(Object.keys(parsed)).not.toContain(field);
      expect(ScheduledEventInstanceSchema.safeParse({ ...valid, [field]: 0.5 }).success).toBe(false);
    }
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "schema/event-instance.ts"), "utf8");
    const declaredKeys = source
      .split(/\r?\n/)
      .map((line) => /^\s{2,}([A-Za-z][A-Za-z0-9]*):\s*z\./.exec(line)?.[1])
      .filter((k): k is string => k !== undefined);
    for (const field of configFields) expect(declaredKeys).not.toContain(field);
  });

  it("enqueueEvent 效果引用未知事件被拒，引用已知事件通过", () => {
    const known = withEvents([
      normalEvent("ev-enqueue-target", { source: "schedule", window: { start: { value: 1, unit: "day" } } }),
    ]);
    const events = known.events as Array<Record<string, unknown>>;
    const host = events.find((e) => e.id === "ev-curse-sighting")!;
    const options = (host.settle as { normal: { options: Array<Record<string, unknown>> } }).normal.options;
    options[0].effects = [{ type: "enqueueEvent", eventId: "ev-enqueue-target", delay: { value: 1, unit: "hour" } }];
    expect(WorldTemplateV2Schema.safeParse(known).success).toBe(true);
    options[0].effects = [{ type: "enqueueEvent", eventId: "ev-not-exist" }];
    expect(issuesOf(known).some((m) => m.includes("enqueueEvent"))).toBe(true);
  });
});
