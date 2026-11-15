import { describe, expect, it } from "vitest";
import type { WorldStateV2 } from "@life-sim/shared";
import { applyEffectsV2, type EffectContextV2 } from "./engine.js";
import { createLookup } from "./lookup.js";
import { createRng } from "../rng.js";
import { advanceTurnV2 } from "./turn.js";
import { createActiveWorldV2, makeTestTemplate } from "./test-utils.js";

function fixture(): { state: WorldStateV2; ctx: EffectContextV2; template: ReturnType<typeof makeTestTemplate> } {
  const template = makeTestTemplate();
  const lookup = createLookup(template);
  const state = createActiveWorldV2({ templateId: "test", playerName: "测试者", seed: 3 }, template, "w-ident");
  const ctx: EffectContextV2 = { state, lookup, rng: createRng(3) };
  return { state, ctx, template };
}

describe("V2 引擎 · setIdentity（开局定性别 / 年龄）", () => {
  it("改写性别与年龄，并同步重置 playerAgeAtStart", () => {
    const { state, ctx } = fixture();
    expect(state.playerAgeAtStart).toBe(16);

    applyEffectsV2(ctx, [{ type: "setIdentity", gender: "male", age: 15 }]);

    expect(state.player.gender).toBe("male");
    expect(state.player.age).toBe(15);
    // 关键：起始基准同步，否则下一次按公历推进会把年龄算回去
    expect(state.playerAgeAtStart).toBe(15);
  });

  it("只改性别时不动年龄基准", () => {
    const { state, ctx } = fixture();
    applyEffectsV2(ctx, [{ type: "setIdentity", gender: "x" }]);
    expect(state.player.gender).toBe("x");
    expect(state.player.age).toBe(16);
    expect(state.playerAgeAtStart).toBe(16);
  });

  it("跨年推进后年龄 = 新基准 + 经过年数", () => {
    const { state, ctx, template } = fixture();
    applyEffectsV2(ctx, [{ type: "setIdentity", age: 15 }]);
    // 推到两年后（approx 历没有跨年问题时用 730 天）
    state.worldTime = 730 * 1440;
    const lookup = createLookup(template);
    advanceTurnV2(state, { action: { type: "rest" } }, template, lookup);
    expect(state.playerAgeAtStart).toBe(15);
    expect(state.player.age).toBe(17);
  });
});
