import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createBattle, createLookup, createWorldV2, performBattleAction, resolveBattleFx } from "@life-sim/game-core";
import { UiConfigSchema } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * ADR-078：**样式属于模板，引擎只认积木**。
 *
 * 以前「苍的引力起手 / 黑闪的雷弧 / 十影的法阵」是前端 `switch (preset)` 里的分支 ——
 * 换一个世界就得改前端代码。现在引擎只实现几何（环 / 光柱 / 雷弧 / 割口…），
 * 具体某个术式长什么样写在 `ui.yaml.presentation.effects` 里。
 */
const silent = { warn: () => {}, error: () => {}, info: () => {} };

function loadEntry() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

const jjkUi = () => {
  const raw = readFileSync("specs/data/templates/jjk-2006/3.0.0/ui.yaml", "utf8");
  const ui = UiConfigSchema.parse(parse(raw));
  const presentation = ui.presentation;
  if (presentation === undefined) throw new Error("ui.yaml 缺 presentation");
  return presentation;
};

describe("ADR-078 · 模板 DSL", () => {
  it("带作品辨识度的表现都在模板里定义", () => {
    const fx = jjkUi();
    const ids = Object.keys(fx.effects ?? {});
    for (const id of ["converge", "repulse", "collapse", "mandala", "ultimate", "precision", "slash", "lightning", "cuts", "shield"]) {
      expect(ids).toContain(id);
    }
    // 每一条都是积木列表，不是一张图片 / 一个路径字符串
    for (const id of ids) {
      const def = fx.effects![id]!;
      expect(def.layers.length).toBeGreaterThan(0);
      for (const layer of def.layers) expect(typeof layer.shape).toBe("string");
    }
  });

  it("苍的起手是「光晕 + 环 + 光线 + 粒子」，黑闪的受击是「光晕 + 雷弧 + 闪屏 + 火花」", () => {
    const fx = jjkUi();
    const converge = fx.effects!.converge!;
    expect(converge.kind).toBe("cast");
    const shapes = converge.layers.map((l) => l.shape);
    for (const want of ["glow", "ring", "rays", "motes"]) expect(shapes).toContain(want);

    const lightning = fx.effects!.lightning!;
    expect(lightning.kind).toBe("impact");
    const hitShapes = lightning.layers.map((l) => l.shape);
    for (const want of ["glow", "bolt", "flash", "sparks"]) expect(hitShapes).toContain(want);
  });

  it("有颜色的地方就有渐变：发光体不能是一块纯色", () => {
    const fx = jjkUi();
    // 环 / 球 / 光晕 / 光柱这几类「发光」图元，jjk 里都必须给出 2–3 个色标
    const glowing = new Set(["ring", "orb", "glow", "pool", "pillar"]);
    let checked = 0;
    for (const def of Object.values(fx.effects ?? {})) {
      for (const layer of def.layers) {
        if (!glowing.has(layer.shape)) continue;
        if (layer.gradient === undefined) continue;
        expect(layer.gradient.length).toBeGreaterThanOrEqual(2);
        expect(layer.gradient.length).toBeLessThanOrEqual(3);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("法阵里有内接三角，奥义里有旋转的扇形光", () => {
    const fx = jjkUi();
    const mandala = fx.effects!.mandala!;
    const polys = mandala.layers.filter((l) => l.shape === "polygon");
    expect(polys.length).toBeGreaterThanOrEqual(1);
    // 三角必须转起来，否则「法阵」只是个圈
    for (const p of polys) expect(p.turns).not.toBe(0);

    const ultimate = fx.effects!.ultimate!;
    const fan = ultimate.layers.find((l) => l.shape === "fan");
    expect(fan).toBeDefined();
    expect(fan!.mirror).toBe(true);
    expect(fan!.turns).not.toBe(0);
  });

  it("投影把模板定义挂到段上（前端不需要认识 id）", () => {
    const entry = loadEntry();
    const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed: 31 }, entry.template, "w-fx-dsl");
    state.openingCompleted = true;
    if (!state.player.skills.includes("sk-basic-strike")) state.player.skills.push("sk-basic-strike");
    state.battle = createBattle("ev:fx", { enemies: [{ ref: "enemy-grade2-curse" }] }, state, entry.lookup);
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, entry.lookup, () => 0.5);

    const cast = resolveBattleFx(state.battle!, jjkUi()).casts.findLast((c) => c.skillId === "sk-basic-strike")!;
    // 体术打击没配施法：没有 def
    expect(cast.cast.def).toBeUndefined();
    // 轨迹是内置 arrow：也没有 def（前端走内置几何）
    expect(cast.trace.def).toBeUndefined();
    // 受击没配 → 内置 burst
    expect(cast.hits.at(-1)!.def).toBeUndefined();
  });

  it("黑闪段带上来的是模板那张雷弧定义", () => {
    const entry = loadEntry();
    const template = structuredClone(entry.template);
    template.combat = { ...(template.combat ?? {}), crit: { chance: 1, multiplier: 1.5 } };
    const hook = template.combat.hooks?.find((h) => h.id === "black-flash");
    if (hook === undefined) throw new Error("缺世界黑闪钩子");
    hook.when = [{ crit: true }];
    const lookup = createLookup(template);

    const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed: 21 }, template, "w-fx-dsl-bf");
    state.openingCompleted = true;
    if (!state.player.skills.includes("sk-basic-strike")) state.player.skills.push("sk-basic-strike");
    state.battle = createBattle("ev:fx", { enemies: [{ ref: "enemy-grade2-curse" }] }, state, lookup);
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);

    const cast = resolveBattleFx(state.battle!, jjkUi()).casts.findLast((c) => c.skillId === "sk-basic-strike")!;
    // 起手一层星芒、受击一层雷弧 + 星芒：三段各占一处，谁都不抢谁的位置
    expect(cast.cast.def?.layers.map((l) => l.shape)).toContain("rays");
    expect(cast.trace.def?.layers[0]?.shape).toBe("arc"); // slash = 刀光
    const hitShapes = cast.hits.at(-1)!.def?.layers.map((l) => l.shape) ?? [];
    for (const want of ["rays", "bolt"]) expect(hitShapes).toContain(want);
  });
});

describe("ADR-078 · 前端不认作品", () => {
  it("渲染层源码里没有任何「苍 / 黑闪 / 法阵」这类样式 id", () => {
    const source = readFileSync("packages/rpg-ui/src/fx/engine.ts", "utf8");
    for (const word of ["converge", "repulse", "collapse", "mandala", "ultimate", "precision", "lightning", "slash"]) {
      expect(source.includes(`"${word}"`)).toBe(false);
    }
  });
});
