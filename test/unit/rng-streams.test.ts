import { describe, expect, it } from "vitest";
import { CombatAiConfigSchema } from "@life-sim/shared";
import { createBattleRng, createRng, forkRng } from "@life-sim/game-core";

describe("RNG 命名子流", () => {
  it("fork 不推进父流，重复 fork 同一标签得到同一序列", () => {
    const parent = createRng(2026);
    const first = parent.fork("battle.resolve");
    expect(parent.cursor).toBe(0);

    const again = parent.fork("battle.resolve");
    expect([first(), first(), first()]).toEqual([again(), again(), again()]);
    expect(parent.cursor).toBe(0);
  });

  it("父流抽数后 fork 的序列会变，但父流自身序列不受 fork 影响", () => {
    const parent = createRng(7);
    const before = parent.fork("x");
    const expectedBefore = [before(), before(), before()];

    const control = createRng(7);
    const expectedParent = [control(), control(), control()];
    const actualParent = [parent(), parent(), parent()];
    expect(actualParent).toEqual(expectedParent);

    const after = parent.fork("x");
    expect([after(), after(), after()]).not.toEqual(expectedBefore);
  });

  it("战斗判定、AI、目标三条流互不影响", () => {
    const main = createRng(99);
    const streams = createBattleRng(main);
    const aiControl = forkRng(main, "battle.ai");
    const targetControl = forkRng(main, "battle.target");
    const expectedAi = [aiControl(), aiControl(), aiControl()];
    const expectedTarget = [targetControl(), targetControl(), targetControl()];

    streams.resolve();
    streams.resolve();
    streams.resolve();
    streams.ai();
    streams.ai();
    expect([streams.ai(), streams.ai(), streams.ai()]).not.toEqual(expectedAi);
    // 目标流直接从根派生，不随 AI 流的游标漂移。
    const fresh = createBattleRng(createRng(99));
    expect([fresh.target(), fresh.target(), fresh.target()]).toEqual(expectedTarget);
    expect([streams.target(), streams.target(), streams.target()]).toEqual(expectedTarget);
  });

  it("裸函数 Rng 退化为共享流（legacy 兼容）", () => {
    const legacy = (() => 0.42) as () => number;
    const streams = createBattleRng(legacy);
    expect(streams.resolve()).toBe(0.42);
    expect(streams.ai()).toBe(0.42);
  });
});

describe("战斗 AI 目标策略", () => {
  const style = {
    styleId: "aggressive",
    scoreWeights: { "sk-blue": 1 },
    targetPolicy: "random",
  };

  it("combat-ai schema 接受 random，缺省 lowest", () => {
    const config = { styles: [style], assignments: { "npc-gojo": "aggressive" } };
    expect(CombatAiConfigSchema.parse(config).styles[0]?.targetPolicy).toBe("random");
    expect(
      CombatAiConfigSchema.parse({
        styles: [{ styleId: "plain", scoreWeights: {} }],
        assignments: {},
      }).styles[0]?.targetPolicy,
    ).toBe("lowest");
  });

  it("不接受未知策略", () => {
    expect(() =>
      CombatAiConfigSchema.parse({
        styles: [{ ...style, targetPolicy: "nearest" }],
        assignments: {},
      }),
    ).toThrow();
  });
});
