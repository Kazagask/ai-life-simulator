import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import { OpeningTemplateSchema, OpeningRunSchema, EventInstanceSchema } from "./schema/index.js";

/**
 * T3-01 验收：两个不同开局模板加载均通过；缺字段报错含字段路径；
 * strict / 白名单 / 关系 source / 实例-定义分离（协议 §16、§13）。
 */
const SAMPLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../specs/data/examples/opening.yaml",
);

const sample = (): Record<string, unknown>[] =>
  YAML.parse(readFileSync(SAMPLE, "utf-8")) as Record<string, unknown>[];

describe("T3-01 · 开局分域 Schema（协议 V2.1 §16）", () => {
  it("两个不同开局模板均通过 OpeningTemplateSchema 校验", () => {
    const list = z.array(OpeningTemplateSchema).parse(sample());
    expect(list).toHaveLength(2);
    expect(new Set(list.map((o) => o.openingId)).size).toBe(2);
    expect(list[0].steps[1].kind).toBe("branch");
    expect(list[0].eventPools[0].countRange).toEqual([1, 3]);
    expect(list[1].eventPools[0].events[0].required).toBe(true);
  });

  it("缺字段模板加载报错含字段路径", () => {
    const [first] = sample();
    delete first.openingId;
    const res = OpeningTemplateSchema.safeParse(first);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".").includes("openingId"))).toBe(true);
    }
  });

  it("strict 拒绝未知字段（含 phase / stage 字段）", () => {
    const [first] = sample();
    const res = OpeningTemplateSchema.safeParse({ ...first, phase: "OPENING" });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(JSON.stringify(res.error.issues)).toContain("phase");
    }
  });

  it("steps[].kind 只取 required / optional / branch", () => {
    const [first] = sample();
    const res = OpeningTemplateSchema.safeParse({
      ...first,
      steps: [{ id: "s", kind: "mandatory" }],
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".").includes("steps.0.kind"))).toBe(true);
    }
  });

  it("关系缺 source 报错含字段路径", () => {
    const [first] = sample();
    const npcSetup = first.npcSetup as Record<string, unknown>;
    const relations = (npcSetup.relations as Record<string, unknown>[]).map((r) => {
      const copy = { ...r };
      delete copy.source;
      return copy;
    });
    const res = OpeningTemplateSchema.safeParse({ ...first, npcSetup: { ...npcSetup, relations } });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(
        res.error.issues.some((i) => i.path.join(".").includes("npcSetup.relations.0.source")),
      ).toBe(true);
    }
  });

  it("completionConditions 非空", () => {
    const [first] = sample();
    expect(OpeningTemplateSchema.safeParse({ ...first, completionConditions: [] }).success).toBe(false);
  });

  it("EventInstanceSchema 校验 origin 与实例-定义分离", () => {
    const inst = {
      instanceId: "evi-0",
      definitionId: "ev-first-day",
      origin: { kind: "opening", id: "op-tokyo" },
      status: "pending",
      visibility: "known",
    };
    expect(EventInstanceSchema.parse(inst).origin).toEqual({ kind: "opening", id: "op-tokyo" });
    expect(EventInstanceSchema.safeParse({ ...inst, origin: { kind: "chain", id: "x" } }).success).toBe(
      false,
    );
  });

  it("OpeningRunSchema 校验交接记录", () => {
    const run = {
      openingId: "op-tokyo",
      executedSteps: ["step-character"],
      choiceRecords: [],
      seed: 7,
      startedAt: 0,
      completedAt: 0,
      completed: true,
      instances: [],
      pendingEvents: [{ eventId: "ev-first-day" }],
      scheduledEvents: [{ eventId: "ev-sp-briefing" }],
    };
    expect(OpeningRunSchema.parse(run).completed).toBe(true);
  });
});
