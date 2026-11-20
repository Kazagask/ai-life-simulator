import { describe, expect, it } from "vitest";
import { simulateDuel } from "../../apps/server/src/admin/sim.ts";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * 战斗数值模拟器（`pnpm inspect sim`）。
 *
 * 它是「仪器」：跑的是真实 `performBattleAction`，所以这组用例守的其实是**战斗规则本身**
 * ——输出公式、闪避合成、资源池 —— 只是换了一个能一次跑几十局的入口。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function loadTemplate() {
  const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry.template;
}

const dummy = (hp: number, attributes: Record<string, number> = {}) => ({ dummy: { hp, attributes } });

describe("simulateDuel", () => {
  it("同 seed 同 spec ⇒ 同一份报告（回放确定性）", () => {
    const spec = {
      left: { ref: "npc-gojo" },
      right: dummy(5000, { agility: 8 }),
      repeat: 3,
      seed: 7,
      maxRounds: 4,
    } as const;
    const a = simulateDuel(loadTemplate(), spec);
    const b = simulateDuel(loadTemplate(), spec);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("木桩不还手：承伤恒为 0", () => {
    const report = simulateDuel(loadTemplate(), {
      left: { ref: "npc-gojo" },
      right: dummy(5000, { agility: 8 }),
      repeat: 4,
      seed: 3,
      maxRounds: 5,
    });
    expect(report.takenPerRound).toBe(0);
    expect(report.dpr).toBeGreaterThan(0);
  });

  it("一发苍 = (18 + 140×0.9) × 1.3（六眼）≈ 187", () => {
    const report = simulateDuel(loadTemplate(), {
      left: { ref: "npc-gojo" },
      right: dummy(50_000, { agility: 8 }),
      repeat: 1,
      seed: 5,
      maxRounds: 5,
    });
    const dealt = report.rows.reduce((sum, r) => sum + r.damageDealt, 0);
    const hits = report.rows.reduce((sum, r) => sum + r.hits, 0);
    expect(hits).toBeGreaterThan(0);
    expect(dealt / hits).toBeCloseTo(187, 0);
  });

  it("不持天逆鉾就碰不到无下限：甚尔打五条 0 伤害", () => {
    const report = simulateDuel(loadTemplate(), {
      left: { ref: "npc-toji", equipment: [] },
      right: { ref: "npc-gojo" },
      repeat: 3,
      seed: 9,
      maxRounds: 6,
    });
    expect(report.rows.every((r) => r.damageDealt === 0)).toBe(true);
    expect(report.hitRate).toBe(0);
  });

  it("持天逆鉾：必中穿过无下限，一刺 32（ADR-012 D7 的数值验收）", () => {
    const report = simulateDuel(loadTemplate(), {
      left: { ref: "npc-toji" },
      right: { ref: "npc-gojo" },
      repeat: 3,
      seed: 9,
      maxRounds: 6,
    });
    // 甚尔只有 1 回合可活（五条一发就打残），所以「打到 32」比「总量」更稳。
    expect(report.rows.every((r) => r.damageDealt === 32)).toBe(true);
    expect(report.skillUse["sk-ten-spear"]).toBe(3);
  });

  it("coverage 姿态才会把召唤环走完（堆伤害姿态下夏油第一发就是旋涡）", () => {
    const spec = {
      left: { ref: "npc-geto" },
      right: dummy(900, { agility: 8 }),
      repeat: 1,
      seed: 7,
      maxRounds: 8,
    };
    expect(simulateDuel(loadTemplate(), spec).summonsPerDuel).toBe(0);
    const coverage = simulateDuel(loadTemplate(), { ...spec, stance: "coverage" });
    expect(coverage.summonsPerDuel).toBeGreaterThan(0);
    expect(coverage.skillUse["sk-summon-curse"]).toBeGreaterThan(0);
  });
});
