import { describe, expect, it } from "vitest";
import {
  advanceTurnV2,
  battleActionV2,
  chooseOptionV2,
  createBattle,
  createLookup,
  createRng,
  createWorldV2,
  resolveDeathRoute,
  resolveEnding,
} from "@life-sim/game-core";
import {
  EndingConfigSchema,
  type BattleResult,
  type DeathRoute,
  type EventV2,
  type WorldTemplateV2,
} from "@life-sim/shared";
import { fixtureEntry } from "../helpers/world.ts";

/**
 * ADR-075 §5：死亡路由。
 *
 * 守四件事：
 * 1. `defeatState: dead` 才进路由；结局直接按 `endingId` 固化，后续决胜不再改它；
 * 2. 事件路由 ⇒ 占槽 + `deathPending`，结算后 hp1、链结束；
 * 3. 事件里 `playerDeath` ⇒ 跳过 hp1，`deathDepth + 1` 再入路由；
 * 4. 死亡链里普通行动被 `death_pending` 挡住。
 */

const endingConfig = EndingConfigSchema.parse({
  endings: [
    { endingId: "end:dead", name: "战死", description: "你倒下了。" },
    { endingId: "end:other", name: "别的结局", description: "不是这条。" },
  ],
});

function normalEvent(id: string, effects: unknown[]): EventV2 {
  return {
    id,
    title: id,
    trigger: { source: "chain" },
    kind: "normal",
    settle: { normal: { options: [{ id: "ok", text: "继续", effects: effects as never }] } },
  };
}

function setup(routes: DeathRoute[], events: EventV2[] = []): {
  state: ReturnType<typeof createWorldV2>;
  template: WorldTemplateV2;
  lookup: ReturnType<typeof createLookup>;
} {
  const template: WorldTemplateV2 = structuredClone(fixtureEntry().template);
  template.deathRoutes = structuredClone(routes);
  template.events.push(...structuredClone(events));
  const lookup = createLookup(template);
  const state = createWorldV2(
    { templateId: "p0", playerName: "测试", seed: 51 },
    template,
    "w-adr075-t4",
  );
  state.openingCompleted = true;
  return { state, template, lookup };
}

/** 把战斗打到"玩家已倒下"：hp 0 + pass，敌人行动后判负。 */
function loseBattle(
  state: ReturnType<typeof createWorldV2>,
  template: WorldTemplateV2,
  lookup: ReturnType<typeof createLookup>,
): void {
  const battle = createBattle(
    "ev:fight",
    { enemies: [{ ref: "enemy-x" }], stake: "deaths" },
    state,
    lookup,
  );
  state.battle = battle;
  battle.player.hp = 0;
  battleActionV2(state, { type: "pass" }, template, lookup, { endingConfig });
  // ADR-077：战斗结束后世界停住，等一次「继续」才收场 / 跑死亡路由
  battleActionV2(state, { type: "leave" }, template, lookup, { endingConfig });
}

describe("ADR-075 §5 · 死亡路由", () => {
  it("死斗败北 + 兜底 ending：termination 直接引用 endingId", () => {
    const { state, template, lookup } = setup([
      { id: "d", when: [], then: { kind: "ending", endingId: "end:dead" } },
    ]);
    loseBattle(state, template, lookup);

    expect(state.termination?.endingId).toBe("end:dead");
    expect(state.termination?.source).toBe("battleDefeat");
    expect(state.player.hp).toBe(0);
    expect(state.deathPending).toBeUndefined();

    // 后续展示 / 归档再决胜时，必须认已固化的 endingId，而不是跑 triggerConditions。
    const record = resolveEnding(state, endingConfig.endings, {
      state,
      lookup,
      rng: createRng(9),
    });
    expect(record.endingId).toBe("end:dead");
  });

  it("先判具体路由：实力差 3 倍走 humiliation，而不是兜底", () => {
    const { state, template, lookup } = setup([
      {
        id: "humiliation",
        when: [{ battle: { ratio: { left: "playerSide", right: "enemy", gte: 3 } } }],
        then: { kind: "ending", endingId: "end:other" },
      },
      { id: "d", when: [], then: { kind: "ending", endingId: "end:dead" } },
    ]);
    const battle = createBattle(
      "ev:fight",
      { enemies: [{ ref: "enemy-x" }], stake: "deaths" },
      state,
      lookup,
    );
    state.battle = battle;
    battle.powerStart = { player: 300, ally: 0, enemy: 100, neutral: 0 };
    battle.player.hp = 0;
    battleActionV2(state, { type: "pass" }, template, lookup, { endingConfig });
    battleActionV2(state, { type: "leave" }, template, lookup, { endingConfig });

    expect(state.termination?.endingId).toBe("end:other");
  });

  it("事件路由：占槽 + deathPending，结算后 hp1 继续", () => {
    const mild = normalEvent("ev:death-mild", []);
    const { state, template, lookup } = setup(
      [{ id: "mild", when: [], then: { kind: "event", eventId: "ev:death-mild" } }],
      [mild],
    );
    loseBattle(state, template, lookup);

    expect(state.termination).toBeNull();
    expect(state.deathPending?.eventId).toBe("ev:death-mild");
    expect(state.slot).toMatchObject({ eventId: "ev:death-mild", from: "death" });
    expect(state.player.hp).toBe(0);

    // 死亡链里普通行动被拒
    expect(() =>
      advanceTurnV2(state, { action: { type: "patrol" } }, template, lookup),
    ).toThrow(/death_pending/);

    chooseOptionV2(state, { optionId: "ok" }, template, lookup, { endingConfig });
    expect(state.termination).toBeNull();
    expect(state.deathPending).toBeUndefined();
    expect(state.player.hp).toBe(1);
    expect(state.deathDepth).toBe(0);
  });

  it("事件里 playerDeath：跳过 hp1，depth+1 再入路由", () => {
    const bad = normalEvent("ev:death-bad", [{ type: "playerDeath", reason: "回魂失败" }]);
    const { state, template, lookup } = setup(
      [
        {
          id: "again",
          when: [{ deathDepth: { gte: 2 } }],
          then: { kind: "ending", endingId: "end:dead" },
        },
        { id: "loop", when: [], then: { kind: "event", eventId: "ev:death-bad" } },
      ],
      [bad],
    );
    loseBattle(state, template, lookup);
    expect(state.deathDepth).toBe(1);
    expect(state.deathPending?.eventId).toBe("ev:death-bad");

    chooseOptionV2(state, { optionId: "ok" }, template, lookup, { endingConfig });
    expect(state.deathDepth).toBe(2);
    expect(state.termination?.endingId).toBe("end:dead");
    expect(state.deathPending).toBeUndefined();
  });

  it("没有玩家死的战斗不进路由（hard 失败仍走 hp1）", () => {
    const { state, template, lookup } = setup([
      { id: "d", when: [], then: { kind: "ending", endingId: "end:dead" } },
    ]);
    const battle = createBattle(
      "ev:fight",
      { enemies: [{ ref: "enemy-x" }], stake: "hard" },
      state,
      lookup,
    );
    state.battle = battle;
    battle.player.hp = 0;
    battleActionV2(state, { type: "pass" }, template, lookup, { endingConfig });
    battleActionV2(state, { type: "leave" }, template, lookup, { endingConfig });

    expect(state.termination).toBeNull();
    expect(state.player.hp).toBe(1);
    expect(state.deathPending).toBeUndefined();
  });
});

describe("ADR-075 §5.2 · 战果谓词", () => {
  const result = {
    eventId: "ev",
    outcome: "defeat",
    stake: "deaths",
    defeatState: "dead",
    rounds: 12,
    player: {
      hp: 0,
      maxHp: 100,
      resources: [],
      attributes: {},
      power: 30,
      powerEnd: 0,
      damageDealt: 80,
      damageTaken: 120,
      crits: 2,
      hits: 4,
      kills: 0,
      statusStacks: {},
    },
    sides: { player: 30, ally: 0, enemy: 10, neutral: 5 },
    enemies: [
      {
        ref: "npc-sukuna",
        name: "宿傩",
        tier: "hero",
        power: 10,
        damageByPlayer: 80,
        damageToPlayer: 120,
        defeated: false,
        killer: true,
        summonedByPlayer: false,
      },
    ],
    killer: {
      ref: "npc-sukuna",
      name: "宿傩",
      tier: "hero",
      power: 10,
      summonedByPlayer: false,
    },
    deaths: [{ id: "player", side: "player", name: "测试" }],
  } satisfies BattleResult;

  const emptyState = { deathDepth: 0 } as unknown as Parameters<typeof resolveDeathRoute>[0];
  const ctx = {
    state: emptyState,
    lookup: { template: {} } as never,
    rng: createRng(1),
  };

  it("killer / damageTo / playerPower 同时成立", () => {
    const hit = resolveDeathRoute(
      emptyState,
      [
        {
          id: "proud",
          when: [
            { battle: { killer: "npc-sukuna" } },
            { battle: { damageTo: { ref: "npc-sukuna", gte: 80 } } },
            { battle: { playerPower: { lte: 30 } } },
          ],
          then: { kind: "ending", endingId: "end:dead" },
        },
      ],
      ctx,
      "battle",
      result,
    );
    expect(hit.route.id).toBe("proud");
  });

  it("ratio 除零：敌侧 0、我侧正 ⇒ +∞，gte 成立", () => {
    const zero = { ...result, sides: { player: 30, ally: 0, enemy: 0, neutral: 0 } };
    const hit = resolveDeathRoute(
      emptyState,
      [
        {
          id: "ratio",
          when: [{ battle: { ratio: { left: "playerSide", right: "enemy", gte: 3 } } }],
          then: { kind: "ending", endingId: "end:dead" },
        },
      ],
      ctx,
      "battle",
      zero,
    );
    expect(hit.route.id).toBe("ratio");
  });

  it("cause 不是 battle 时 battle 谓词为 false", () => {
    expect(() =>
      resolveDeathRoute(
        emptyState,
        [
          {
            id: "only-battle",
            when: [{ battle: { killer: "npc-sukuna" } }],
            then: { kind: "ending", endingId: "end:dead" },
          },
        ],
        ctx,
        "event",
        result,
      ),
    ).toThrow(/death_route_missing/);
  });
});
