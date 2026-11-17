import { describe, expect, it } from "vitest";
import type { SnapshotActor, SnapshotDerivationContext } from "@life-sim/game-core";
import type { RelationEdge } from "@life-sim/shared";
import { deriveClanView } from "../src/clan-view.js";

/**
 * 宗族投影（`docs/CLAN-DESIGN.md` §2.4）。
 *
 * 单元层只构造**权威族表 + 演员目录**，不建世界：投影是纯读，输入就是这两样。
 * 端到端接缝（`state.extensions.family` 真的被投影读到）在 `test/unit/clan-seam.test.ts`。
 *
 * 计数口径是本文件的主角：`memberCount` 含已故、不含隐藏与离族；`livingCount` 只算在世。
 * 数真实总数是侧信道（§2.4 / §2.6），所以每条用例都把「不该数的人」摆进去。
 */

const NAME: Record<string, string> = {
  head: "家主甲",
  aunt: "已故姑母",
  left: "嫁出女",
  "hidden-guy": "隐藏者",
  player: "我",
  spouse: "外姓配偶",
  stranger: "路人",
};

const CLAN_STATE = {
  clans: [
    {
      id: "c1",
      name: "瓦尔蒙",
      seat: "巴黎",
      prestige: 42,
      headId: "head",
      status: "active",
      foundedAt: 0,
      legacies: ["duel"],
      history: [
        { at: 0, turn: 0, kind: "founded", text: "瓦尔蒙立族" },
        { at: 120, turn: 2, kind: "head_changed", text: "家主甲继任瓦尔蒙家主" },
      ],
    },
    {
      id: "c2",
      name: "另一族",
      prestige: 3,
      headId: null,
      status: "extinct",
      foundedAt: 0,
      legacies: [],
      history: [],
    },
  ],
  members: [
    { actorId: "head", clanId: "c1", since: 0, via: "birth", role: "家主" },
    { actorId: "aunt", clanId: "c1", since: 0, via: "marriage" },
    { actorId: "left", clanId: "c1", since: 0, via: "birth", leftAt: 90, leftReason: "嫁出" },
    { actorId: "hidden-guy", clanId: "c1", since: 0, via: "birth" },
    { actorId: "player", clanId: "c1", since: 0, via: "birth" },
  ],
} as const;

const CONFIG = {
  clans: [
    {
      id: "c1",
      name: "瓦尔蒙",
      legacies: [{ id: "duel", name: "决斗传统" }, { id: "trade" }],
    },
    { id: "c2", name: "另一族" },
  ],
};

/** 只有 `aunt` 已故；其余在世。隐藏者同时进 `hiddenNodeIds`。 */
const DEAD = new Set(["aunt"]);
const HIDDEN = new Set(["hidden-guy"]);

function edge(
  from: string,
  to: string,
  kind: RelationEdge["kind"],
  extra: Partial<RelationEdge> = {},
): RelationEdge {
  return { from, to, kind, source: "template", visibility: "known", ...extra };
}

function ctx(opts: {
  extensionState?: unknown;
  edges?: RelationEdge[];
  hidden?: string[];
  selfId?: string;
  config?: unknown;
  actors?: string[];
  formatWorldTime?: (minutes: number) => string;
}): SnapshotDerivationContext {
  const selfId = opts.selfId ?? "player";
  const ids = new Set<string>([selfId, ...(opts.actors ?? [])]);
  const hidden = new Set(opts.hidden ?? []);
  const actors = new Map<string, SnapshotActor>();
  for (const id of ids) {
    const alive = !DEAD.has(id);
    actors.set(id, {
      id,
      name: NAME[id] ?? "某人",
      visible: !hidden.has(id),
      alive,
      age: 30,
      genderLabel: "女",
      lifeStageLabel: "成年",
      lifeState: alive ? "alive" : "inactive",
      ...(alive ? {} : { reasonCode: "已故" }),
    });
  }
  return {
    selfId,
    visibleEdges: opts.edges ?? [],
    hiddenNodeIds: hidden,
    actors,
    worldTime: 200,
    turnIndex: 3,
    config: opts.config ?? CONFIG,
    extensionState: "extensionState" in opts ? opts.extensionState : CLAN_STATE,
    ...(opts.formatWorldTime !== undefined ? { formatWorldTime: opts.formatWorldTime } : {}),
    memo: new Map<string, unknown>(),
  };
}

/** 族表里的全部可见候选（含已故 / 离族 / 隐藏），投影必须只数其中一部分。 */
const ALL_ACTORS = ["head", "aunt", "left", "hidden-guy", "player", "spouse", "stranger"];

describe("宗族投影：字段齐全", () => {
  it("族名 / 郡望 / 状态 / 声望 / 家主 / 计数 / 关系 / 族学 / 大事记都在", () => {
    const view = deriveClanView(ctx({ actors: ALL_ACTORS, hidden: [...HIDDEN] }));
    const clan = view.clans.find((c) => c.id === "c1")!;

    expect(clan.name).toBe("瓦尔蒙");
    expect(clan.seat).toBe("巴黎");
    expect(clan.status).toBe("active");
    expect(clan.prestige).toBe(42);
    expect(clan.head).toEqual({
      id: "head",
      name: "家主甲",
      hasCard: true,
      isSelf: false,
      alive: true,
    });
    expect(clan.history.map((h) => h.text)).toEqual([
      "瓦尔蒙立族",
      "家主甲继任瓦尔蒙家主",
    ]);
    expect(clan.history[1]).toMatchObject({ at: 120, kind: "head_changed" });
  });

  it("id 只作 key：显示名走 name（改姓后两者不同）", () => {
    const view = deriveClanView(ctx({ actors: ALL_ACTORS }));
    expect(view.clans[0]!.id).toBe("c1");
    expect(view.clans[0]!.name).toBe("瓦尔蒙");
  });

  it("没设郡望 / 没家主 / 没族学的族不硬塞空字段", () => {
    const view = deriveClanView(ctx({ actors: ALL_ACTORS }));
    const clan = view.clans.find((c) => c.id === "c2")!;
    expect(clan.seat).toBeUndefined();
    expect(clan.head).toBeUndefined();
    expect(clan.legacies).toBeUndefined();
    expect(clan.history).toEqual([]);
  });

  it("族学以模板候选为准，unlocked 看 state；state 里多出来的解锁项照实列出", () => {
    const view = deriveClanView(ctx({ actors: ALL_ACTORS }));
    const clan = view.clans.find((c) => c.id === "c1")!;
    expect(clan.legacies).toEqual([
      { id: "duel", name: "决斗传统", unlocked: true },
      { id: "trade", name: "trade", unlocked: false },
    ]);

    // state 解锁了模板没声明的 id（配置被删的遗留）：不吞掉，名字回落到 id。
    const orphan = {
      ...CLAN_STATE,
      clans: [{ ...CLAN_STATE.clans[0], legacies: ["duel", "lost-art"] }],
    };
    const withOrphan = deriveClanView(ctx({ actors: ALL_ACTORS, extensionState: orphan }));
    expect(withOrphan.clans[0]!.legacies?.find((l) => l.id === "lost-art")).toEqual({
      id: "lost-art",
      name: "lost-art",
      unlocked: true,
    });
  });

  it("大事记 text 原样透传，formattedAt 走内核时间适配器口径", () => {
    const view = deriveClanView(
      ctx({ actors: ALL_ACTORS, formatWorldTime: (minutes) => `第 ${minutes} 分` }),
    );
    const clan = view.clans.find((c) => c.id === "c1")!;
    expect(clan.history[0]!.formattedAt).toBe("第 0 分");
    expect(clan.history[1]!.formattedAt).toBe("第 120 分");
    // 史是事实不是叙事：不在这里改写文本。
    expect(clan.history[1]!.text).toBe("家主甲继任瓦尔蒙家主");
  });

  it("没有时间适配器时 formattedAt 只给世界分钟数，不编历法", () => {
    const view = deriveClanView(ctx({ actors: ALL_ACTORS }));
    expect(view.clans.find((c) => c.id === "c1")!.history[1]!.formattedAt).toBe("120");
  });
});

describe("宗族投影：只数看得见、还在族里的人", () => {
  it("memberCount 含已故、不含隐藏与已出族", () => {
    const view = deriveClanView(ctx({ actors: ALL_ACTORS, hidden: [...HIDDEN] }));
    const clan = view.clans.find((c) => c.id === "c1")!;
    // 在族可见：head / aunt(已故) / player = 3；hidden-guy 与 left 不计。
    expect(clan.memberCount).toBe(3);
  });

  it("livingCount 不含已故", () => {
    const view = deriveClanView(ctx({ actors: ALL_ACTORS, hidden: [...HIDDEN] }));
    const clan = view.clans.find((c) => c.id === "c1")!;
    expect(clan.livingCount).toBe(2);
    // 两个计数的差就是族里死了多少人 —— 投影不隐去死亡事实。
    expect(clan.memberCount - clan.livingCount).toBe(1);
  });

  it("隐藏成员不数，但也不影响其它族的计数", () => {
    const view = deriveClanView(ctx({ actors: ALL_ACTORS, hidden: [...HIDDEN] }));
    expect(view.clans.find((c) => c.id === "c2")).toMatchObject({ memberCount: 0, livingCount: 0 });
  });

  it("家主被隐藏 ⇒ 整个 head 缺省（不编一个无名的家主）", () => {
    const view = deriveClanView(ctx({ actors: ALL_ACTORS, hidden: ["head", ...HIDDEN] }));
    expect(view.clans.find((c) => c.id === "c1")!.head).toBeUndefined();
  });
});

describe("宗族投影：selfRelation 四种取值", () => {
  it("head：我是家主", () => {
    const view = deriveClanView(ctx({ actors: ALL_ACTORS, selfId: "head" }));
    expect(view.selfClanIds).toEqual(["c1"]);
    expect(view.clans.find((c) => c.id === "c1")!.selfRelation).toBe("head");
  });

  it("member：我在族中但不是家主", () => {
    const view = deriveClanView(ctx({ actors: ALL_ACTORS, selfId: "player" }));
    expect(view.selfClanIds).toEqual(["c1"]);
    expect(view.clans.find((c) => c.id === "c1")!.selfRelation).toBe("member");
  });

  it("affine：我不在族，但与在族成员是配偶", () => {
    const view = deriveClanView(
      ctx({
        actors: ALL_ACTORS,
        selfId: "spouse",
        // `{from: spouse, to: aunt, kind: "wife"}` ⇒ 姑母是「外姓配偶」的妻子。
        edges: [edge("spouse", "aunt", "wife")],
      }),
    );
    expect(view.selfClanIds).toEqual([]);
    expect(view.clans.find((c) => c.id === "c1")!.selfRelation).toBe("affine");
  });

  it("outsider：不在族也没有可见的姻亲连接", () => {
    const view = deriveClanView(ctx({ actors: ALL_ACTORS, selfId: "stranger" }));
    expect(view.selfClanIds).toEqual([]);
    expect(view.clans.find((c) => c.id === "c1")!.selfRelation).toBe("outsider");
  });

  it("配偶被隐藏 ⇒ 落回 outsider（姻亲标签本身会泄露「有这么个人」）", () => {
    const view = deriveClanView(
      ctx({
        actors: ALL_ACTORS,
        selfId: "spouse",
        hidden: [...HIDDEN, "aunt"],
        edges: [edge("spouse", "aunt", "wife")],
      }),
    );
    expect(view.clans.find((c) => c.id === "c1")!.selfRelation).toBe("outsider");
  });
});

describe("宗族投影：切片缺省不抛", () => {
  it("extensionState 缺省 ⇒ 空视图", () => {
    const view = deriveClanView(ctx({ extensionState: undefined, actors: ALL_ACTORS }));
    expect(view).toEqual({ selfClanIds: [], clans: [] });
  });

  it("`family: true` 但没声明 clans（切片是 {}）⇒ 空视图，不抛", () => {
    expect(() => deriveClanView(ctx({ extensionState: {}, actors: ALL_ACTORS }))).not.toThrow();
    expect(deriveClanView(ctx({ extensionState: {}, actors: ALL_ACTORS }))).toEqual({
      selfClanIds: [],
      clans: [],
    });
  });

  it("空族表 / 坏形状 ⇒ 空视图，不抛", () => {
    for (const state of [{ clans: [], members: [] }, { clans: "nope" }, 42, null]) {
      const view = deriveClanView(ctx({ extensionState: state, actors: ALL_ACTORS }));
      expect(view).toEqual({ selfClanIds: [], clans: [] });
    }
  });

  it("配置解析失败只丢族学，不影响族的其它字段", () => {
    const view = deriveClanView(
      ctx({ actors: ALL_ACTORS, config: { clans: [{ id: "c1" }] } }), // 缺 name ⇒ 非法声明
    );
    const clan = view.clans.find((c) => c.id === "c1")!;
    expect(clan.name).toBe("瓦尔蒙");
    // 模板候选读不到 ⇒ 只剩 state 里的解锁项。
    expect(clan.legacies).toEqual([{ id: "duel", name: "duel", unlocked: true }]);
  });
});
