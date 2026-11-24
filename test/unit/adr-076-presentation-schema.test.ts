import { describe, expect, it } from "vitest";
import {
  BUILTIN_IMPACT_PRESETS,
  BUILTIN_TRACE_PRESETS,
  FxPresentationSchema,
  UiConfigSchema,
} from "@life-sim/shared";

/**
 * ADR-078（接 ADR-076 §2）：`ui.presentation` 的形状契约。
 *
 * 两条边界变了：
 * - 轨迹 / 受击 / 施法的 `preset` 都是**开放 id**：先在 `effects` 里找，再找内置；
 * - 引用未定义的 id **加载期拒载**（不静默变成一个空特效）。
 *
 * 内置的只有「不表达世界观」的几何（箭头 / 扇刃 / 上升气流 / 火花 / 登场 / 离场 / 消散）；
 * 苍赫茈的起手、黑闪的雷弧这些一律由模板 DSL 提供。
 */
const EFFECT = { kind: "impact", layers: [{ shape: "sparks", count: 6 }] };

describe("ADR-078 ui.presentation schema", () => {
  it("内置 id 直接可用", () => {
    for (const preset of BUILTIN_TRACE_PRESETS) {
      expect(FxPresentationSchema.safeParse({ skills: { a: { trace: { preset } } } }).success).toBe(true);
    }
    for (const preset of BUILTIN_IMPACT_PRESETS) {
      expect(FxPresentationSchema.safeParse({ skills: { a: { impact: { preset } } } }).success).toBe(true);
    }
  });

  it("引用了没定义的 id ⇒ 拒载（三层都一样）", () => {
    for (const layer of ["cast", "trace", "impact"] as const) {
      const parsed = FxPresentationSchema.safeParse({ skills: { a: { [layer]: { preset: "zigzag" } } } });
      expect(parsed.success).toBe(false);
    }
  });

  it("在 effects 里定义了就能引用，施法也一样", () => {
    const base = { effects: { zigzag: EFFECT } };
    for (const layer of ["cast", "trace", "impact"] as const) {
      const parsed = FxPresentationSchema.safeParse({ ...base, skills: { a: { [layer]: { preset: "zigzag" } } } });
      expect(parsed.success).toBe(true);
    }
  });

  it("覆盖表里的引用也要能查到", () => {
    const ok = FxPresentationSchema.safeParse({
      effects: { zigzag: EFFECT },
      defaults: { impact: { preset: "zigzag" } },
      units: { u: { cast: { preset: "zigzag" } } },
      hooks: { h: { trace: { preset: "zigzag" } } },
      events: { e: { impact: { preset: "zigzag" } } },
    });
    expect(ok.success).toBe(true);
    const bad = FxPresentationSchema.safeParse({ events: { e: { impact: { preset: "zigzag" } } } });
    expect(bad.success).toBe(false);
  });

  it("只写要改的字段：没写的层不要求出现", () => {
    const parsed = FxPresentationSchema.safeParse({
      effects: { slash: { kind: "trace", layers: [{ shape: "arc", profile: "blade" }] } },
      defaults: { result: { sizePx: 30, strokePx: 1.8 } },
      hooks: { "some-hook": { trace: { preset: "slash", color: "#FF2F45" } } },
    });
    expect(parsed.success).toBe(true);
  });

  it("图元写错也拒载（strict，不静默吞掉拼错的键）", () => {
    expect(
      FxPresentationSchema.safeParse({ effects: { x: { layers: [{ shape: "ring", r: 10, glow: true }] } } }).success,
    ).toBe(false);
    expect(FxPresentationSchema.safeParse({ effects: { x: { layers: [] } } }).success).toBe(false);
  });

  it("能挂到 ui.yaml 顶层，且缺省时完全可选", () => {
    expect(UiConfigSchema.safeParse({ presentation: { defaults: { result: { sizePx: 30 } } } }).success).toBe(true);
    expect(UiConfigSchema.safeParse({}).success).toBe(true);
  });
});
