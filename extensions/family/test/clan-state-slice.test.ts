import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorldStateV2Schema, type WorldStateV2, type WorldTemplateV2 } from "@life-sim/shared";
import {
  applyEffectsV2,
  createLookup,
  createWorldV2,
  makeTestTemplate,
  registerExtensionRuntime,
  resetExtensionRuntimes,
  type UnknownEffect,
} from "@life-sim/game-core";
import { clanStateSchema, familyExtension, readClanState } from "@life-sim/ext-family";

/**
 * 切片重建不许抹掉婚配 / 收养（`docs/FAMILY-GRAPH.md` §7.1 第 2 条）。
 *
 * `state.extensions.family` 是**一个**切片，里面同时住着宗族（clans/members）与
 * 亲属图输入（spouses/adoptions）。宗族的每个 effect 都会写回整段切片 ——
 * 一旦某个写点用 `{ clans, members }` 裸对象重建，婚配表就被静默抹掉，亲属图当场塌。
 *
 * 这里锁三件事：
 * 1. schema 接受这两个字段（旧档没有它们也必须直载）；
 * 2. 任意 clan effect 跑完，`spouses` / `adoptions` **逐字段原样还在**；
 * 3. 旧档形状（没有这两个键）不会被「补」出空数组 —— 存档形状不变。
 *
 * 变异验证：把任一写点改回重建切片 ⇒ 第 2 组立刻红；把 schema 里的两个字段删掉
 * ⇒ `ensureClanState` 直接抛 `clan_state_invalid`，同样红。
 */

const CLAN_CONFIG = {
  clans: [{ id: "c1", name: "瓦尔蒙" }],
  prestige: { min: 0, max: 100, maxStep: 10 },
};

const SPOUSES = [{ a: "npc-a", b: "npc-b", since: 10 }];
const ADOPTIONS = [{ child: "npc-c", parent: "npc-a", since: 11 }];

function templateWithClans(): WorldTemplateV2 {
  return {
    ...makeTestTemplate(),
    extensions: { family: CLAN_CONFIG as unknown as Record<string, unknown> },
  };
}

function makeWorld(template: WorldTemplateV2 = templateWithClans()): WorldStateV2 {
  return createWorldV2({ templateId: "test", playerName: "我", seed: 7 }, template, "w-slice");
}

/** 手工往切片里塞婚配 / 收养（3c 之前没有写入口，这里模拟「已经建好的亲属图」）。 */
function seedKinFacts(state: WorldStateV2): void {
  const slice = (state.extensions?.family ?? {}) as Record<string, unknown>;
  state.extensions = {
    ...(state.extensions ?? {}),
    family: { ...slice, spouses: structuredClone(SPOUSES), adoptions: structuredClone(ADOPTIONS) },
  };
}

function run(state: WorldStateV2, template: WorldTemplateV2, ...effects: UnknownEffect[]): void {
  applyEffectsV2({ state, lookup: createLookup(template), rng: () => 0.5 }, effects);
}

function familySlice(state: WorldStateV2): Record<string, unknown> {
  return state.extensions?.family as Record<string, unknown>;
}

beforeEach(() => {
  resetExtensionRuntimes();
  registerExtensionRuntime(familyExtension);
});

afterEach(() => {
  resetExtensionRuntimes();
});

describe("切片 schema：可选但一旦存在就逐字段保留", () => {
  it("带 spouses / adoptions 的切片可以读档（WorldStateV2Schema 放行）", () => {
    const state = makeWorld();
    seedKinFacts(state);

    const parsed = WorldStateV2Schema.safeParse(state);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.extensions?.family).toEqual(state.extensions?.family);
  });

  it("字段形状不对 ⇒ 拒载（不是静默丢弃婚配）", () => {
    const parsed = clanStateSchema.safeParse({
      clans: [],
      members: [],
      spouses: [{ a: "x" }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("clan effect 写回：婚配 / 收养原样保留", () => {
  it("joinClan 只改 members 与大事记", () => {
    const template = templateWithClans();
    const state = makeWorld(template);
    seedKinFacts(state);
    state.worldTime = 120;

    run(state, template, {
      type: "joinClan",
      actorId: "npc-x",
      clanId: "c1",
      via: "birth",
      reason: "生于瓦尔蒙家",
    });

    const slice = familySlice(state);
    expect(slice.spouses).toEqual(SPOUSES);
    expect(slice.adoptions).toEqual(ADOPTIONS);
    expect(readClanState(state).members).toHaveLength(1);
  });

  it("adjustClanPrestige 只改 prestige 与大事记", () => {
    const template = templateWithClans();
    const state = makeWorld(template);
    seedKinFacts(state);

    run(state, template, { type: "adjustClanPrestige", clanId: "c1", value: 5 });

    const slice = familySlice(state);
    expect(slice.spouses).toEqual(SPOUSES);
    expect(slice.adoptions).toEqual(ADOPTIONS);
    expect(readClanState(state).clans[0]?.prestige).toBe(5);
  });

  it("旧档（没有这两个键）不被补出空数组：存档形状不变", () => {
    const template = templateWithClans();
    const state = makeWorld(template);
    expect("spouses" in familySlice(state)).toBe(false);

    run(state, template, {
      type: "joinClan",
      actorId: "npc-x",
      clanId: "c1",
      via: "birth",
      reason: "生于瓦尔蒙家",
    });

    const slice = familySlice(state);
    expect("spouses" in slice).toBe(false);
    expect("adoptions" in slice).toBe(false);
  });
});
