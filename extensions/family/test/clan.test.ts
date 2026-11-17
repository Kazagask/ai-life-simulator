import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorldStateV2Schema, type WorldStateV2, type WorldTemplateV2 } from "@life-sim/shared";
import {
  applyEffectsV2,
  collectExtensionConditions,
  createConditionRegistry,
  createLookup,
  createWorldV2,
  evaluateCondition,
  makeTestTemplate,
  registerExtensionRuntime,
  resetExtensionRuntimes,
  type ConditionEvalContext,
  type UnknownEffect,
} from "@life-sim/game-core";
import {
  clanConditions,
  familyExtension,
  readClanState,
  type ClanState,
} from "@life-sim/ext-family";

/**
 * 宗族 B1（`docs/CLAN-DESIGN.md` 第二部分）：数据模型 / 6 个 effect / 5 个条件 /
 * 建世界期初始化 / 读档校验 / `unknown_effect`。
 *
 * 单元层全部走**引擎真实入口**（`createWorldV2` / `applyEffectsV2` / `WorldStateV2Schema`），
 * 不手搓半截 state —— 否则「接缝没接通」这类问题在本文件里看不见。
 */

const CLAN_CONFIG = {
  clans: [
    {
      id: "c1",
      name: "瓦尔蒙",
      seat: "巴黎",
      prestige: 40,
      legacies: [{ id: "duel", name: "决斗传统" }],
    },
    { id: "c2", name: "另一族", prestige: 48 },
  ],
  prestige: { min: 10, max: 50, maxStep: 5 },
};

function templateWith(config: unknown = CLAN_CONFIG): WorldTemplateV2 {
  return {
    ...makeTestTemplate(),
    extensions: { family: config === true ? true : (config as Record<string, unknown>) },
  };
}

function makeWorld(template: WorldTemplateV2 = templateWith()): WorldStateV2 {
  return createWorldV2({ templateId: "test", playerName: "我", seed: 7 }, template, "w1");
}

function effectCtx(state: WorldStateV2, template: WorldTemplateV2) {
  return { state, lookup: createLookup(template), rng: () => 0.5 };
}

function clanOf(state: WorldStateV2, clanId: string) {
  const clan = readClanState(state).clans.find((c) => c.id === clanId);
  if (!clan) throw new Error(`测试夹具：找不到宗族 ${clanId}`);
  return clan;
}

function membersOf(state: WorldStateV2) {
  return readClanState(state).members;
}

function run(
  state: WorldStateV2,
  template: WorldTemplateV2,
  ...effects: UnknownEffect[]
): void {
  applyEffectsV2(effectCtx(state, template), effects);
}

beforeEach(() => {
  resetExtensionRuntimes();
  registerExtensionRuntime(familyExtension);
});

afterEach(() => {
  resetExtensionRuntimes();
});

describe("建世界期：族声明 → state.extensions.family", () => {
  it("实例化族、写 founded 史、成员表为空、声望按域夹紧", () => {
    const state = makeWorld();
    const clanState = readClanState(state);

    expect(clanState.clans.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(clanState.members).toEqual([]);
    expect(clanState.clans[0]).toMatchObject({
      name: "瓦尔蒙",
      seat: "巴黎",
      prestige: 40,
      headId: null,
      status: "active",
      foundedAt: 0,
      legacies: [],
    });
    expect(clanState.clans[0]!.history).toHaveLength(1);
    expect(clanState.clans[0]!.history[0]).toMatchObject({ kind: "founded", at: 0, turn: 0 });
  });

  it("没声明族 ⇒ 不造空段（零回归：state.extensions 保持缺省）", () => {
    const state = makeWorld(templateWith({ showAllRoles: true }));
    expect(state.extensions).toBeUndefined();
  });

  it("`extensions.family: true` ⇒ 不造族、不抛", () => {
    const state = makeWorld(templateWith(true));
    expect(state.extensions).toBeUndefined();
  });
});

describe("joinClan / leaveClan：入族出族必有记录", () => {
  it("入族写全字段并自动追加 member_joined 史", () => {
    const template = templateWith();
    const state = makeWorld(template);
    state.worldTime = 120;

    run(state, template, {
      type: "joinClan",
      actorId: "npc-x",
      clanId: "c1",
      via: "marriage",
      reason: "嫁入瓦尔蒙家",
      role: "嫡长",
    });

    expect(membersOf(state)).toEqual([
      {
        actorId: "npc-x",
        clanId: "c1",
        since: 120,
        via: "marriage",
        role: "嫡长",
      },
    ]);
    const history = clanOf(state, "c1").history;
    expect(history.at(-1)).toMatchObject({
      kind: "member_joined",
      text: "嫁入瓦尔蒙家",
      refs: ["npc-x"],
      at: 120,
    });
  });

  it("同一族重复入族是幂等：不堆成员、不刷史", () => {
    const template = templateWith();
    const state = makeWorld(template);
    run(state, template, { type: "joinClan", actorId: "npc-x", clanId: "c1", via: "birth", reason: "生于此族" });
    run(state, template, { type: "joinClan", actorId: "npc-x", clanId: "c1", via: "birth", reason: "生于此族" });

    expect(membersOf(state)).toHaveLength(1);
    expect(clanOf(state, "c1").history.filter((h) => h.kind === "member_joined")).toHaveLength(1);
  });

  it("已在一族时入另一族 ⇒ 抛错（换族必须先 leaveClan）", () => {
    const template = templateWith();
    const state = makeWorld(template);
    run(state, template, { type: "joinClan", actorId: "npc-x", clanId: "c1", via: "birth", reason: "生于此族" });

    expect(() =>
      run(state, template, { type: "joinClan", actorId: "npc-x", clanId: "c2", via: "override", reason: "改宗" }),
    ).toThrow(/换族须先 leaveClan/);
  });

  it("未知 clanId ⇒ 抛可诊断错误（不静默跳过）", () => {
    const template = templateWith();
    const state = makeWorld(template);
    expect(() =>
      run(state, template, { type: "joinClan", actorId: "npc-x", clanId: "nope", via: "birth", reason: "x" }),
    ).toThrow(/未知宗族：nope/);
  });

  it("出族写 leftAt + leftReason、保留成员条目（历史要留）", () => {
    const template = templateWith();
    const state = makeWorld(template);
    run(state, template, { type: "joinClan", actorId: "npc-x", clanId: "c1", via: "birth", reason: "生于此族" });
    state.worldTime = 900;

    run(state, template, { type: "leaveClan", actorId: "npc-x", reason: "嫁出" });

    const members = membersOf(state);
    expect(members).toHaveLength(1); // 不删条目
    expect(members[0]).toMatchObject({ actorId: "npc-x", clanId: "c1", leftAt: 900, leftReason: "嫁出" });
    expect(clanOf(state, "c1").history.at(-1)).toMatchObject({
      kind: "member_left",
      text: "嫁出",
      refs: ["npc-x"],
    });
  });

  it("不在族却出族 ⇒ 抛错", () => {
    const template = templateWith();
    const state = makeWorld(template);
    expect(() => run(state, template, { type: "leaveClan", actorId: "ghost", reason: "出继" })).toThrow(
      /当前不属于任何宗族/,
    );
  });

  it("家主出族 ⇒ 家主落空位并写 head_changed 史", () => {
    const template = templateWith();
    const state = makeWorld(template);
    run(state, template, { type: "joinClan", actorId: "player", clanId: "c1", via: "birth", reason: "生于此族" });
    run(state, template, { type: "setClanHead", clanId: "c1", actorId: "player" });

    run(state, template, { type: "leaveClan", actorId: "player", reason: "除籍" });

    const clan = clanOf(state, "c1");
    expect(clan.headId).toBeNull();
    expect(clan.history.at(-1)).toMatchObject({ kind: "head_changed", refs: ["player"] });
  });

  it("`__self__` 按 addSecret 同约定解析当前行动 NPC；没有时抛错", () => {
    const template = templateWith();
    const state = makeWorld(template);

    expect(() =>
      run(state, template, { type: "joinClan", actorId: "__self__", clanId: "c1", via: "birth", reason: "x" }),
    ).toThrow(/__self__/);

    applyEffectsV2(
      { ...effectCtx(state, template), selfNpcId: "npc-self" },
      [{ type: "joinClan", actorId: "__self__", clanId: "c1", via: "birth", reason: "生于此族" }],
    );
    expect(membersOf(state)[0]?.actorId).toBe("npc-self");
  });
});

describe("setClanHead", () => {
  it("成员继任写 headId + 人话史；空位可设 null", () => {
    const template = templateWith();
    const state = makeWorld(template);
    run(state, template, { type: "joinClan", actorId: "player", clanId: "c1", via: "birth", reason: "生于此族" });

    run(state, template, { type: "setClanHead", clanId: "c1", actorId: "player" });
    expect(clanOf(state, "c1").headId).toBe("player");
    expect(clanOf(state, "c1").history.at(-1)?.text).toBe("我继任瓦尔蒙家主");

    run(state, template, { type: "setClanHead", clanId: "c1", actorId: null });
    expect(clanOf(state, "c1").headId).toBeNull();
    expect(clanOf(state, "c1").history.at(-1)?.text).toBe("家主之位空悬");
  });

  it("非成员不能当家主 ⇒ 抛错", () => {
    const template = templateWith();
    const state = makeWorld(template);
    expect(() => run(state, template, { type: "setClanHead", clanId: "c1", actorId: "outsider" })).toThrow(
      /不是宗族 c1 的在族成员/,
    );
  });
});

describe("adjustClanPrestige：增量 + 钳域 + 单次上限", () => {
  it("单次增量先按 maxStep 夹，再按 [min,max] 夹", () => {
    const template = templateWith();
    const state = makeWorld(template);
    expect(clanOf(state, "c1").prestige).toBe(40);

    run(state, template, { type: "adjustClanPrestige", clanId: "c1", value: 100 });
    expect(clanOf(state, "c1").prestige).toBe(45); // step 夹到 5

    run(state, template, { type: "adjustClanPrestige", clanId: "c1", value: 100 });
    expect(clanOf(state, "c1").prestige).toBe(50); // 再 +5 撞上界

    run(state, template, { type: "adjustClanPrestige", clanId: "c1", value: -100 });
    expect(clanOf(state, "c1").prestige).toBe(45);
  });

  it("声望初值越界也会在建世界期夹紧", () => {
    const template = templateWith({
      clans: [{ id: "c1", name: "瓦尔蒙", prestige: 9_999 }],
      prestige: { min: 10, max: 50, maxStep: 5 },
    });
    const state = makeWorld(template);
    expect(clanOf(state, "c1").prestige).toBe(50);
  });

  it("夹完没变化 ⇒ 不写史（不刷屏）", () => {
    const template = templateWith();
    const state = makeWorld(template);
    run(state, template, { type: "adjustClanPrestige", clanId: "c1", value: 100 });
    run(state, template, { type: "adjustClanPrestige", clanId: "c1", value: 100 });
    const before = clanOf(state, "c1").history.length;

    run(state, template, { type: "adjustClanPrestige", clanId: "c1", value: 100 }); // 已在上界
    expect(clanOf(state, "c1").prestige).toBe(50);
    expect(clanOf(state, "c1").history).toHaveLength(before);
  });

  it("声望史是人话（带前后值）", () => {
    const template = templateWith();
    const state = makeWorld(template);
    run(state, template, { type: "adjustClanPrestige", clanId: "c1", value: 3 });
    expect(clanOf(state, "c1").history.at(-1)).toMatchObject({
      kind: "prestige",
      text: "声望 +3（40 → 43）",
    });
  });
});

describe("unlockLegacy / clanHistory", () => {
  it("只能解锁模板声明过的候选，且幂等", () => {
    const template = templateWith();
    const state = makeWorld(template);

    expect(() => run(state, template, { type: "unlockLegacy", clanId: "c1", legacyId: "nope" })).toThrow(
      /未声明族学候选/,
    );

    run(state, template, { type: "unlockLegacy", clanId: "c1", legacyId: "duel" });
    run(state, template, { type: "unlockLegacy", clanId: "c1", legacyId: "duel" });

    expect(clanOf(state, "c1").legacies).toEqual(["duel"]);
    expect(clanOf(state, "c1").history.at(-1)).toMatchObject({
      kind: "legacy",
      text: "族学「决斗传统」已解锁",
    });
  });

  it("clanHistory 只追加（refs 原样保留）", () => {
    const template = templateWith();
    const state = makeWorld(template);
    run(state, template, {
      type: "clanHistory",
      clanId: "c1",
      kind: "custom",
      text: "祖宅失火",
      refs: ["npc-x"],
    });
    expect(clanOf(state, "c1").history.at(-1)).toMatchObject({
      kind: "custom",
      text: "祖宅失火",
      refs: ["npc-x"],
    });
  });
});

describe("五个条件（注册进 ConditionRegistry）", () => {
  function conditions(state: WorldStateV2): (op: string, args: Record<string, unknown>) => boolean {
    const registry = createConditionRegistry({ ...clanConditions });
    const ctx: ConditionEvalContext = { state, rng: () => 0.5, turnIndex: state.turnIndex };
    return (op, args) => evaluateCondition({ op, args }, ctx, registry);
  }

  it("inClan：actorId 缺省 = 玩家；出族后为假", () => {
    const template = templateWith();
    const state = makeWorld(template);
    const cond = conditions(state);

    expect(cond("inClan", { clanId: "c1" })).toBe(false);

    run(state, template, { type: "joinClan", actorId: "player", clanId: "c1", via: "birth", reason: "生于此族" });
    expect(cond("inClan", { clanId: "c1" })).toBe(true);
    expect(cond("inClan", { clanId: "c1", actorId: "npc-y" })).toBe(false);
    expect(cond("inClan", { clanId: "nope" })).toBe(false);

    run(state, template, { type: "leaveClan", actorId: "player", reason: "除籍" });
    expect(cond("inClan", { clanId: "c1" })).toBe(false);
  });

  it("isClanHead：只有 headId 本人为真", () => {
    const template = templateWith();
    const state = makeWorld(template);
    const cond = conditions(state);
    run(state, template, { type: "joinClan", actorId: "player", clanId: "c1", via: "birth", reason: "生于此族" });

    expect(cond("isClanHead", { clanId: "c1" })).toBe(false);
    run(state, template, { type: "setClanHead", clanId: "c1", actorId: "player" });
    expect(cond("isClanHead", { clanId: "c1" })).toBe(true);
    expect(cond("isClanHead", { clanId: "c1", actorId: "npc-y" })).toBe(false);
    expect(cond("isClanHead", { clanId: "nope" })).toBe(false);
  });

  it("clanPrestige：gte / lte 都生效", () => {
    const template = templateWith();
    const state = makeWorld(template);
    const cond = conditions(state);
    expect(cond("clanPrestige", { clanId: "c1", gte: 40 })).toBe(true);
    expect(cond("clanPrestige", { clanId: "c1", gte: 41 })).toBe(false);
    expect(cond("clanPrestige", { clanId: "c1", lte: 39 })).toBe(false);
    expect(cond("clanPrestige", { clanId: "nope" })).toBe(false);
  });

  it("clanSize：只数在族成员（全图口径，出族即减）", () => {
    const template = templateWith();
    const state = makeWorld(template);
    const cond = conditions(state);

    run(state, template, { type: "joinClan", actorId: "a", clanId: "c1", via: "birth", reason: "x" });
    run(state, template, { type: "joinClan", actorId: "b", clanId: "c1", via: "adoption", reason: "x" });
    expect(cond("clanSize", { clanId: "c1", gte: 2 })).toBe(true);
    expect(cond("clanSize", { clanId: "c1", gte: 3 })).toBe(false);

    run(state, template, { type: "leaveClan", actorId: "b", reason: "出继" });
    expect(cond("clanSize", { clanId: "c1", lte: 1 })).toBe(true);
  });

  it("clanStatus：三态精确匹配", () => {
    const template = templateWith();
    const state = makeWorld(template);
    const cond = conditions(state);
    expect(cond("clanStatus", { clanId: "c1", is: "active" })).toBe(true);
    expect(cond("clanStatus", { clanId: "c1", is: "extinct" })).toBe(false);
    expect(cond("clanStatus", { clanId: "nope", is: "active" })).toBe(false);
  });

  it("未声明扩展 ⇒ 一个条件 op 都不并入（保证 4）", () => {
    expect(collectExtensionConditions(makeTestTemplate())).toEqual({});
    expect(Object.keys(collectExtensionConditions(templateWith()))).toEqual([
      "inClan",
      "isClanHead",
      "clanPrestige",
      "clanSize",
      "clanStatus",
    ]);
  });
});

describe("unknown_effect：不静默吞", () => {
  it("未注册的 type 必须抛（带 type 名）", () => {
    const template = templateWith();
    const state = makeWorld(template);
    expect(() => run(state, template, { type: "definitelyNotAnEffect" })).toThrow(
      /unknown_effect: 效果类型 "definitelyNotAnEffect"/,
    );
  });

  it("`cancelChain` 是有意 no-op，不算未知类型", () => {
    const template = templateWith();
    const state = makeWorld(template);
    expect(() =>
      run(state, template, { type: "cancelChain", chainId: "whatever" }),
    ).not.toThrow();
  });

  it("已声明扩展注册的 handler 会被调用（分发确实通了）", () => {
    const template = templateWith();
    const state = makeWorld(template);
    run(state, template, { type: "joinClan", actorId: "npc-x", clanId: "c1", via: "birth", reason: "x" });
    expect(membersOf(state)).toHaveLength(1);
  });

  it("扩展没声明（模板无 extensions）⇒ 同名 type 仍是 unknown_effect", () => {
    const template = makeTestTemplate();
    const state = makeWorld(template);
    expect(() =>
      run(state, template, { type: "joinClan", actorId: "npc-x", clanId: "c1", via: "birth", reason: "x" }),
    ).toThrow(/unknown_effect/);
  });
});

describe("读档校验：state.extensions.family 过 stateSchema", () => {
  it("合法切片通过，且 round-trip 逐字段保留", () => {
    const template = templateWith();
    const state = makeWorld(template);
    run(state, template, { type: "joinClan", actorId: "npc-x", clanId: "c1", via: "birth", reason: "x" });

    const parsed = WorldStateV2Schema.safeParse(state);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.extensions?.family).toEqual(state.extensions?.family);
  });

  it("坏形状被拒：issue 路径指向 extensions.family", () => {
    const template = templateWith();
    const state = makeWorld(template);
    // 手改坏：prestige 不是数字、成员缺 via
    state.extensions = {
      family: { clans: [{ id: "c1", name: "x" }], members: [{ actorId: "a", clanId: "c1", since: 0 }] },
    };

    const parsed = WorldStateV2Schema.safeParse(state);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const path = parsed.error.issues[0]?.path ?? [];
    expect(path.slice(0, 2)).toEqual(["extensions", "family"]);
  });

  it("未注册的 id 留在 state 里、不报错、不丢", () => {
    const template = templateWith();
    const state = makeWorld(template);
    state.extensions = {
      ...(state.extensions ?? {}),
      ghostExtension: { anything: [1, 2, 3] },
    };

    const parsed = WorldStateV2Schema.safeParse(state);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.extensions?.ghostExtension).toEqual({ anything: [1, 2, 3] });
  });

  it("切片缺省 ⇒ 不校验（旧档直载，加扩展不废在跑存档）", () => {
    const template = templateWith();
    const state = makeWorld(template);
    delete state.extensions;

    expect(WorldStateV2Schema.safeParse(state).success).toBe(true);
  });
});

describe("切片与其它扩展共存", () => {
  it("写宗族切片不会抹掉别的扩展的切片", () => {
    const template = templateWith();
    const state = makeWorld(template);
    state.extensions = { ...(state.extensions ?? {}), other: { keep: true } };

    run(state, template, { type: "joinClan", actorId: "npc-x", clanId: "c1", via: "birth", reason: "x" });

    expect(state.extensions?.other).toEqual({ keep: true });
    expect((state.extensions?.family as ClanState).members).toHaveLength(1);
  });
});
