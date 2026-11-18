import { describe, expect, it } from "vitest";
import { applyEffectsV2, createLookup, createWorldV2, selfIdOf } from "@life-sim/game-core";
import type { UnknownEffect } from "@life-sim/game-core";
import { fixtureEntry } from "../helpers/world.ts";

/**
 * 多开局模板的玩家父母指针（`extensions/family/doc/FAMILY-GRAPH.md` §3.1「玩家不是特例」）。
 *
 * 静态 `playerTemplate.fatherId` 对同一模板的所有开局一视同仁 —— 一个模板里既能扮演
 * 虎杖也能扮演五条时，那条静态指针就是假事实。`setIdentity` 现在允许开局各自写指针，
 * 这里锁两条口径：只写传入字段；不传 = 不详（不是清空）。
 */

function setup() {
  const entry = fixtureEntry();
  const template = entry.template;
  const state = createWorldV2(
    { templateId: template.meta.id, playerName: "测试玩家", seed: 7 },
    template,
    "w-set-identity-parents",
  );
  const run = (...effects: UnknownEffect[]): void =>
    applyEffectsV2({ state, lookup: createLookup(template), rng: () => 0.5 }, effects);
  return { state, template, run, selfId: selfIdOf(state) };
}

describe("setIdentity 玩家父母指针", () => {
  it("按开局写入父/母指针", () => {
    const { state, run } = setup();
    run({
      type: "setIdentity",
      gender: "male",
      age: 15,
      fatherId: "npc-jin",
      motherId: "npc-kenjaku-host",
    });
    expect(state.player.fatherId).toBe("npc-jin");
    expect(state.player.motherId).toBe("npc-kenjaku-host");
    expect(state.player.gender).toBe("male");
    expect(state.player.age).toBe(15);
  });

  it("不传指针字段时保留原值，不清空", () => {
    const { state, run } = setup();
    run({ type: "setIdentity", fatherId: "npc-jin", motherId: "npc-kenjaku-host" });
    run({ type: "setIdentity", gender: "female" });
    expect(state.player.fatherId).toBe("npc-jin");
    expect(state.player.motherId).toBe("npc-kenjaku-host");
    expect(state.player.gender).toBe("female");
  });

  it("静态 playerTemplate 没写指针时缺省仍为不详", () => {
    const { state } = setup();
    expect(state.player.fatherId).toBeUndefined();
    expect(state.player.motherId).toBeUndefined();
  });
});
