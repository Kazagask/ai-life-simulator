import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyEffectsV2,
  createLookup,
  createWorldV2,
  projectSnapshotV2,
  registerExtensionRuntime,
  resetExtensionRuntimes,
  selfIdOf,
  type UnknownEffect,
} from "@life-sim/game-core";
import type { V2Npc, V2Snapshot, WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
import { familyExtension } from "@life-sim/ext-family";
import type { FamilyView } from "@life-sim/ext-family";
import { fixtureEntry } from "../helpers/world.ts";

/**
 * 宗族投影的**接缝**门槛（`extensions/family/doc/CLAN-DESIGN.md` §2.4 / §5）。
 *
 * 单元口径（字段、计数、四种关系）在 `extensions/family/test/clan-view.test.ts`；
 * 这里只证明两件单元层证明不了的事：
 * 1. `state.extensions.family` **真的**被投影读到（`extensionState` 接缝通着）；
 * 2. 模板声明了 `family` 但没声明 `clans` ⇒ 空数组、不抛（`valmont` 那种 `family: true`）。
 *
 * 零回归（不声明 `extensions` ⇒ 快照里没有 `extensions` 键）由
 * `test/unit/pedigree-seam.test.ts` 的既有用例守着，本项目不再重复一份。
 */

const CLAN_CONFIG = {
  clans: [
    { id: "c1", name: "瓦尔蒙", seat: "巴黎", prestige: 40, legacies: [{ id: "duel", name: "决斗传统" }] },
    { id: "c2", name: "另一族", prestige: 12 },
  ],
  prestige: { min: 0, max: 100, maxStep: 10 },
};

function worldWith(config: unknown): {
  state: WorldStateV2;
  template: WorldTemplateV2;
  selfId: string;
} {
  const entry = fixtureEntry();
  const template: WorldTemplateV2 = {
    ...entry.template,
    extensions: { family: config as Record<string, unknown> },
  };
  const state = createWorldV2(
    { templateId: entry.template.meta.id, playerName: "测试玩家", seed: 7 },
    template,
    "w-clan-seam",
  );
  return { state, template, selfId: selfIdOf(state) };
}

function run(state: WorldStateV2, template: WorldTemplateV2, ...effects: UnknownEffect[]): void {
  applyEffectsV2({ state, lookup: createLookup(template), rng: () => 0.5 }, effects);
}

function snapshotOf(state: WorldStateV2, template: WorldTemplateV2) {
  return projectSnapshotV2(state, template, createLookup(template));
}

/**
 * 宿主侧 `snapshot.extensions.family` 是 `unknown`（内核不认识「家族」）；
 * 测试拿扩展自己的契约类型收窄 —— 这正是任何消费方该做的事。
 */
function familyOf(snapshot: V2Snapshot): FamilyView | undefined {
  return snapshot.extensions?.family as FamilyView | undefined;
}

/** 一个玩家视角可见、且在世 / 可被置死的 NPC（p0 夹具里一定有）。 */
function pickNpc(state: WorldStateV2): V2Npc {
  const npc = state.npcs.find((n) => n.lifecycle.state === "alive" && n.visibility !== "hidden");
  if (npc === undefined) throw new Error("夹具里没有可见在世 NPC");
  return npc;
}

beforeEach(() => {
  resetExtensionRuntimes();
  registerExtensionRuntime(familyExtension);
});

afterEach(() => resetExtensionRuntimes());

describe("宗族接缝：state.extensions.family → snapshot.family", () => {
  it("入族后投影带 clans / selfClanIds，且史的时刻走历法口径", () => {
    const { state, template, selfId } = worldWith(CLAN_CONFIG);
    run(state, template, {
      type: "joinClan",
      actorId: selfId,
      clanId: "c1",
      via: "birth",
      reason: "生于本族",
    });

    const family = familyOf(snapshotOf(state, template));
    expect(family).toBeDefined();
    expect(family!.selfClanIds).toEqual(["c1"]);
    expect(family!.clans.map((c) => c.id)).toEqual(["c1", "c2"]);

    const c1 = family!.clans[0]!;
    expect(c1.name).toBe("瓦尔蒙");
    expect(c1.seat).toBe("巴黎");
    expect(c1.prestige).toBe(40);
    expect(c1.selfRelation).toBe("member");
    expect(c1.livingCount).toBe(1);
    expect(c1.memberCount).toBe(1);
    expect(c1.head).toBeUndefined(); // 还没立家主
    expect(c1.legacies).toEqual([{ id: "duel", name: "决斗传统", unlocked: false }]);

    // 历法口径（内核时间适配器）：不是把分钟数当字符串塞给 UI。
    expect(c1.history.map((h) => h.text)).toEqual(["瓦尔蒙立族", "生于本族"]);
    expect(c1.history[0]!.formattedAt).not.toBe(String(c1.history[0]!.at));
  });

  it("立家主后 selfRelation 变 head，head 带 isSelf", () => {
    const { state, template, selfId } = worldWith(CLAN_CONFIG);
    run(
      state,
      template,
      { type: "joinClan", actorId: selfId, clanId: "c1", via: "birth", reason: "生于本族" },
      { type: "setClanHead", clanId: "c1", actorId: selfId },
    );

    const c1 = familyOf(snapshotOf(state, template))!.clans[0]!;
    expect(c1.selfRelation).toBe("head");
    expect(c1.head).toMatchObject({ id: selfId, isSelf: true, hasCard: true, alive: true });
  });

  it("隐藏成员与已故成员的计数口径（成员含已故、在世只算活人）", () => {
    const { state, template, selfId } = worldWith(CLAN_CONFIG);
    const npc = pickNpc(state);
    run(
      state,
      template,
      { type: "joinClan", actorId: selfId, clanId: "c1", via: "birth", reason: "生于本族" },
      { type: "joinClan", actorId: npc.id, clanId: "c1", via: "marriage", reason: "嫁入本族" },
    );

    const alive = familyOf(snapshotOf(state, template))!.clans[0]!;
    expect(alive.livingCount).toBe(2);
    expect(alive.memberCount).toBe(2);

    // 身故：仍是族人（memberCount 不变），但不再算在世。
    npc.lifecycle = {
      state: "inactive",
      reasonCode: "病故",
      sinceTurn: state.turnIndex,
      sinceWorldTime: state.worldTime,
    };
    const dead = familyOf(snapshotOf(state, template))!.clans[0]!;
    expect(dead.memberCount).toBe(2);
    expect(dead.livingCount).toBe(1);

    // 判 hidden：玩家视角里根本没这个人 ⇒ 两个数都不算他。
    state.npcs.find((n) => n.id === npc.id)!.visibility = "hidden";
    const hidden = familyOf(snapshotOf(state, template))!.clans[0]!;
    expect(hidden.memberCount).toBe(1);
    expect(hidden.livingCount).toBe(1);
  });

  it("出族（leaveClan）后两个数都不再算他，自族 id 也清掉", () => {
    const { state, template, selfId } = worldWith(CLAN_CONFIG);
    run(
      state,
      template,
      { type: "joinClan", actorId: selfId, clanId: "c1", via: "birth", reason: "生于本族" },
      { type: "leaveClan", actorId: selfId, reason: "出继" },
    );

    const family = familyOf(snapshotOf(state, template))!;
    expect(family.selfClanIds).toEqual([]);
    expect(family.clans[0]!).toMatchObject({
      memberCount: 0,
      livingCount: 0,
      selfRelation: "outsider",
    });
  });
});

describe("宗族接缝：声明了 family 但没声明 clans", () => {
  it("`family: true` ⇒ clans / selfClanIds 都是空数组，族谱照出，不抛", () => {
    const { state, template } = worldWith(true);
    expect(state.extensions).toBeUndefined();

    const snapshot = snapshotOf(state, template);
    const family = familyOf(snapshot);
    expect(family).toBeDefined();
    expect(family!.clans).toEqual([]);
    expect(family!.selfClanIds).toEqual([]);
    // 两段互不依赖：没有宗族，族谱照样出（至少玩家自己一个节点）。
    expect(family!.pedigree).toBeDefined();
    expect(family!.pedigree!.nodes.some((n) => n.isSelf)).toBe(true);
  });

  it("只有族谱配置（showAllRoles）⇒ 同样空宗族、不抛", () => {
    const { state, template } = worldWith({ showAllRoles: true });
    const family = familyOf(snapshotOf(state, template))!;
    expect(family.clans).toEqual([]);
    expect(family.pedigree!.nodes.length).toBeGreaterThan(0);
  });
});
