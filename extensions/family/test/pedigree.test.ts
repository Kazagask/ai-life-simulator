import { describe, expect, it } from "vitest";
import type { RelationEdge } from "@life-sim/shared";
import type { SnapshotActor, SnapshotDerivationContext } from "@life-sim/game-core";
import { derivePedigree } from "../src/pedigree.js";

/**
 * 族谱派生（`docs/CLAN-DESIGN.md` 第一部分）。
 *
 * 单元层只构造**边 + 演员目录**，不建世界：族谱是纯派生，输入就是这两样。
 * 接缝层的零回归门槛（模板不声明 `extensions.family` ⇒ 快照里没有 `family`）
 * 在 `test/unit/pedigree-seam.test.ts` —— 那层要建世界，本文件保持无副作用。
 */

const NAME: Record<string, string> = {
  player: "主角",
  a: "甲",
  b: "乙",
  c: "丙",
  h: "隐藏者",
  kid: "小孩",
  wife1: "正妻",
  wife2: "继室",
  stranger: "远亲",
};

function edge(
  from: string,
  to: string,
  kind: RelationEdge["kind"],
  extra: Partial<RelationEdge> = {},
): RelationEdge {
  return { from, to, kind, source: "template", visibility: "known", ...extra };
}

function ctx(opts: {
  edges: RelationEdge[];
  hidden?: string[];
  selfId?: string;
  config?: unknown;
}): SnapshotDerivationContext {
  const selfId = opts.selfId ?? "player";
  const ids = new Set<string>([selfId]);
  for (const e of opts.edges) {
    ids.add(e.from);
    ids.add(e.to);
  }
  const hidden = new Set(opts.hidden ?? []);
  const actors = new Map<string, SnapshotActor>();
  for (const id of ids) {
    actors.set(id, {
      id,
      name: NAME[id] ?? "某人",
      visible: !hidden.has(id),
      alive: true,
      age: 30,
      genderLabel: "女",
      lifeStageLabel: "成年",
      lifeState: "alive",
    });
  }
  return {
    selfId,
    visibleEdges: opts.edges,
    hiddenNodeIds: hidden,
    actors,
    worldTime: 0,
    turnIndex: 0,
    config: opts.config ?? true,
    memo: new Map<string, unknown>(),
  };
}

function generationOf(view: ReturnType<typeof derivePedigree>, id: string): number | undefined {
  return view.nodes.find((n) => n.id === id)?.generation;
}

describe("族谱：世代只按血缘", () => {
  it("父女婚：两人按血缘差一代，婚姻只表现为一条配偶边", () => {
    // `{from: 子女, to: 父}`：甲是乙的父亲。`{from: 夫, to: 妻}`：乙是甲的妻子。
    const view = derivePedigree(
      ctx({
        edges: [edge("b", "a", "father"), edge("a", "b", "wife")],
        selfId: "b",
      }),
    );

    expect(generationOf(view, "a")).toBe(0);
    expect(generationOf(view, "b")).toBe(1);
    // 婚姻不参与定代：若按婚姻算，两人会同代（这条断言就是那个反例）。
    expect(generationOf(view, "a")).not.toBe(generationOf(view, "b"));

    const spouse = view.edges.filter((e) => e.kind === "spouse");
    expect(spouse).toHaveLength(1);
    const parent = view.edges.filter((e) => e.kind === "parent");
    expect(parent).toHaveLength(1);
    expect(parent[0]).toMatchObject({ from: "a", to: "b", parentRole: "father" });
  });

  it("son/daughter 与 father/mother 归一成同一方向 parent→child", () => {
    const view = derivePedigree(
      ctx({
        // 反向写法：`{from: 父, to: 子, kind: "son"}` 与 `{from: 子, to: 父, kind: "father"}` 等价。
        edges: [edge("a", "b", "son"), edge("player", "b", "mother")],
        selfId: "player",
      }),
    );
    expect(generationOf(view, "a")).toBe(0);
    expect(generationOf(view, "b")).toBe(1);
    expect(generationOf(view, "player")).toBe(2);
  });
});

describe("族谱：配偶边无向去重", () => {
  it("模板同时写 wife 与 husband ⇒ 只出一条配偶边", () => {
    const view = derivePedigree(
      ctx({
        edges: [edge("a", "b", "wife"), edge("b", "a", "husband")],
        selfId: "a",
      }),
    );
    expect(view.edges.filter((e) => e.kind === "spouse")).toHaveLength(1);
  });

  it("多配偶时按边出现序给位次（不看年龄）", () => {
    const view = derivePedigree(
      ctx({
        edges: [
          edge("a", "wife1", "wife"),
          edge("a", "wife2", "wife"),
          edge("wife1", "kid", "mother"),
        ],
        selfId: "a",
      }),
    );
    const wife1 = view.nodes.find((n) => n.id === "wife1");
    const wife2 = view.nodes.find((n) => n.id === "wife2");
    expect(wife1?.spouseOrdinal).toBe(1);
    expect(wife2?.spouseOrdinal).toBe(2);
    // 只有一位配偶的人不该挂「第 1 位」这种噪音。
    expect(view.nodes.find((n) => n.id === "kid")?.spouseOrdinal).toBeUndefined();
  });
});

describe("族谱：环", () => {
  it("三代互婚成环：标回边与 cyclic，世代仍然有限且稳定", () => {
    const edges = [
      edge("b", "a", "father"),
      edge("c", "b", "father"),
      edge("a", "c", "father"),
    ];
    const view = derivePedigree(ctx({ edges, selfId: "player" }));

    const backs = view.edges.filter((e) => e.back === true);
    expect(backs).toHaveLength(1);
    expect(view.nodes.some((n) => n.cyclic === true)).toBe(true);
    for (const node of view.nodes) {
      expect(Number.isFinite(node.generation)).toBe(true);
    }
    // 同输入两次结果逐字段一致（回边靠 DFS 顺序，不能依赖 Map 迭代序）。
    expect(derivePedigree(ctx({ edges, selfId: "player" }))).toEqual(view);
  });

  it("有共同父边的兄弟不再单独画 sibling 边（血缘已由 parent 边表达）", () => {
    const view = derivePedigree(
      ctx({
        edges: [
          edge("kid", "p", "father"),
          edge("b", "p", "father"),
          edge("kid", "b", "elder-brother"),
          // 无共同父边的兄弟：sibling 边保留。
          edge("b", "c", "younger-brother"),
        ],
        selfId: "kid",
      }),
    );
    const siblings = view.edges.filter((e) => e.kind === "sibling");
    expect(siblings).toHaveLength(1);
    expect(siblings[0]).toMatchObject({ from: "b", to: "c" });
  });
});

describe("族谱：隐藏节点", () => {
  it("隐藏者的节点与连带边都不出现，且可见子节点标 incomplete", () => {
    const view = derivePedigree(
      ctx({
        edges: [
          // h 是 player 的父亲（父边指向隐藏者）；player 有孩子 kid。
          edge("player", "h", "father"),
          edge("player", "kid", "son"),
        ],
        hidden: ["h"],
        selfId: "player",
      }),
    );

    expect(view.nodes.some((n) => n.id === "h")).toBe(false);
    expect(view.edges.some((e) => e.from === "h" || e.to === "h")).toBe(false);
    expect(view.incomplete).toBe(true);
    // 不编一个根：可见节点仍在，只是父位未知。
    expect(view.nodes.some((n) => n.id === "player")).toBe(true);
    // 死者/隐藏者都不该用裸 id 当名字；这里没有 h，就不用管。
    expect(view.nodes.every((n) => n.name !== n.id)).toBe(true);
  });
});

describe("族谱：确定性截断", () => {
  it("超 maxNodes 时按「BFS 距离 → id 升序」取，且两次结果一致（不是 Map 迭代序）", () => {
    // 故意**逆序**插入（c10 → c01）：Map 迭代序会挑到 c10..c07，按 id 升序应挑 c01..c04。
    const edges: RelationEdge[] = [];
    for (let i = 10; i >= 1; i--) {
      const id = `c${String(i).padStart(2, "0")}`;
      edges.push(edge("player", id, "son"));
    }
    const config = { maxNodes: 5, maxGenerations: 8 };

    const first = derivePedigree(ctx({ edges, selfId: "player", config }));
    const second = derivePedigree(ctx({ edges, selfId: "player", config }));

    expect(first).toEqual(second);
    expect(first.truncated).toBe(true);
    expect(first.nodes).toHaveLength(5);
    expect(first.nodes.map((n) => n.id)).toEqual(["player", "c01", "c02", "c03", "c04"]);
  });

  it("世代窗口外的人被丢掉并标 truncated", () => {
    // g0 是最老的祖先，g9 是自己：一条 10 代直链，maxGenerations 缺省 4 ⇒ 只留自己 ±3 代。
    const edges: RelationEdge[] = [];
    for (let i = 1; i <= 9; i++) {
      edges.push(edge(`g${i}`, `g${i - 1}`, "father"));
    }
    const view = derivePedigree(ctx({ edges, selfId: "g9" }));
    const gens = view.nodes.map((n) => n.generation);
    expect(Math.min(...gens)).toBe(6);
    expect(Math.max(...gens)).toBe(9);
    expect(view.nodes.some((n) => n.id === "g9" && n.isSelf)).toBe(true);
    expect(view.truncated).toBe(true);
  });
});

describe("族谱：远亲与名字", () => {
  it("gap: true 的 relative 不进树，进 looseEnds", () => {
    const view = derivePedigree(
      ctx({
        edges: [
          edge("player", "kid", "son"),
          edge("player", "stranger", "relative", { gap: true }),
        ],
        selfId: "player",
      }),
    );
    expect(view.nodes.some((n) => n.id === "stranger")).toBe(false);
    expect(view.looseEnds).toEqual([{ id: "stranger", name: "远亲", gap: true }]);
  });

  it("名字只从演员目录取；目录里没有就用占位名，绝不回落裸 id", () => {
    const base = ctx({ edges: [edge("player", "kid", "son")], selfId: "player" });
    const actors = new Map(base.actors);
    actors.delete("kid");
    const view = derivePedigree({ ...base, actors });
    expect(view.nodes.find((n) => n.id === "kid")?.name).toBe("（不明人物）");
  });
});
