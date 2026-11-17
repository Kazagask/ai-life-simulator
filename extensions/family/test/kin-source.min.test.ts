import { describe, expect, it } from "vitest";
import type { RelationEdge } from "@life-sim/shared";
import type { SnapshotActor, SnapshotDerivationContext } from "@life-sim/game-core";
import { familyExtension, familyKinGraph, kinGraphToRelationEdges } from "../src/index.js";
import { kinshipReadingsIn, kinshipTermIn, type KinGraph } from "../src/terms/index.js";

/**
 * 指针模式 vs 边模式（`docs/FAMILY-GRAPH.md` §1）。
 *
 * 同一份三代家族分别写成：
 * 1. **边图**：模板自己写 `father` / `wife` / `elder-brother` 边；
 * 2. **指针 + 婚配表**：角色只写 `fatherId` / `motherId`，婚配在 `state.extensions.family.spouses`。
 *
 * 断言两件事：
 * · `familyKinGraph` 的选源判据（有指针走指针、没有回落边）；
 * · 两种输入的 `kinshipReadings` **逐条同词**（路径记号可以不同：指针模式没有同胞边，
 *   同胞是父边派生出来的）。
 */

interface Person {
  readonly id: string;
  readonly name: string;
  readonly genderId: string;
  readonly birthTime: number;
  readonly fatherId?: string;
  readonly motherId?: string;
}

/** 三代 + 同胞 + 半同胞 + 继亲：覆盖 `docs/FAMILY-GRAPH.md §4.5` 的前两层。 */
const PEOPLE: readonly Person[] = [
  // 第一代
  { id: "gf", name: "爷爷", genderId: "male", birthTime: 0 },
  { id: "gm", name: "奶奶", genderId: "female", birthTime: 5 },
  // 第二代：父辈（含父亲的哥哥）
  { id: "dad", name: "父亲", genderId: "male", birthTime: 20, fatherId: "gf", motherId: "gm" },
  { id: "uncleE", name: "伯父", genderId: "male", birthTime: 15, fatherId: "gf", motherId: "gm" },
  { id: "mom", name: "母亲", genderId: "female", birthTime: 22 },
  // 母亲的第二任丈夫（继父）；他另有一个儿子 stepBro
  { id: "stepdad", name: "继父", genderId: "male", birthTime: 28 },
  // 第三代：我这一辈
  { id: "me", name: "我", genderId: "male", birthTime: 50, fatherId: "dad", motherId: "mom" },
  { id: "bro", name: "哥哥", genderId: "male", birthTime: 45, fatherId: "dad", motherId: "mom" },
  { id: "sis", name: "姐姐", genderId: "female", birthTime: 48, fatherId: "dad", motherId: "mom" },
  // 半同胞：同父异母
  { id: "otherWoman", name: "外室", genderId: "female", birthTime: 30 },
  { id: "half", name: "异母弟", genderId: "male", birthTime: 52, fatherId: "dad", motherId: "otherWoman" },
  // 继兄弟：继父的儿子（与我无共同父母）
  { id: "stepBro", name: "继兄弟", genderId: "male", birthTime: 49, fatherId: "stepdad", motherId: "otherWoman" },
];

const SPOUSES = [
  { a: "gf", b: "gm" },
  { a: "dad", b: "mom" },
  { a: "mom", b: "stepdad" },
] as const;

const BY_ID = new Map(PEOPLE.map((p) => [p.id, p]));
const sexOf = (id: string): "male" | "female" => (BY_ID.get(id)!.genderId === "male" ? "male" : "female");

function makeActors(pointer: boolean): Map<string, SnapshotActor> {
  const actors = new Map<string, SnapshotActor>();
  for (const p of PEOPLE) {
    actors.set(p.id, {
      id: p.id,
      name: p.name,
      visible: true,
      alive: true,
      age: 30,
      genderId: p.genderId,
      lifeState: "alive",
      ...(pointer && p.fatherId !== undefined ? { fatherId: p.fatherId } : {}),
      ...(pointer && p.motherId !== undefined ? { motherId: p.motherId } : {}),
      birthTime: p.birthTime,
    });
  }
  return actors;
}

/**
 * 边模式夹具：把指针图**完整**写成边（父母两向 + 婚配两向 + 同胞两向）。
 *
 * 同胞边是模板在边模式下表达长幼的唯一手段（边里没有出生时刻），所以必须写；
 * 指针模式的长幼由 `birthTime` 派生，两边最终应得到同一组称谓。
 */
function makeEdges(): RelationEdge[] {
  const edges: RelationEdge[] = [];
  const push = (from: string, to: string, kind: RelationEdge["kind"]): void => {
    edges.push({ from, to, kind, source: "template", visibility: "known" });
  };

  for (const p of PEOPLE) {
    if (p.fatherId !== undefined) {
      push(p.id, p.fatherId, "father");
      push(p.fatherId, p.id, sexOf(p.id) === "male" ? "son" : "daughter");
    }
    if (p.motherId !== undefined) {
      push(p.id, p.motherId, "mother");
      push(p.motherId, p.id, sexOf(p.id) === "male" ? "son" : "daughter");
    }
  }

  for (const s of SPOUSES) {
    push(s.a, s.b, sexOf(s.b) === "male" ? "husband" : "wife");
    push(s.b, s.a, sexOf(s.a) === "male" ? "husband" : "wife");
  }

  // 同胞：凡共享父或母的两人，按 birthTime 写双向长幼边。
  for (let i = 0; i < PEOPLE.length; i++) {
    for (let j = i + 1; j < PEOPLE.length; j++) {
      const a = PEOPLE[i]!;
      const b = PEOPLE[j]!;
      const shared =
        (a.fatherId !== undefined && a.fatherId === b.fatherId) ||
        (a.motherId !== undefined && a.motherId === b.motherId);
      if (!shared) continue;
      const elder = a.birthTime <= b.birthTime ? a : b;
      const younger = elder === a ? b : a;
      push(younger.id, elder.id, sexOf(elder.id) === "male" ? "elder-brother" : "elder-sister");
      push(elder.id, younger.id, sexOf(younger.id) === "male" ? "younger-brother" : "younger-sister");
    }
  }

  return edges;
}

function ctxOf(opts: {
  readonly actors: Map<string, SnapshotActor>;
  readonly edges: RelationEdge[];
  readonly spouses?: readonly { readonly a: string; readonly b: string }[];
}): SnapshotDerivationContext {
  return {
    selfId: "me",
    visibleEdges: opts.edges,
    hiddenNodeIds: new Set<string>(),
    actors: opts.actors,
    worldTime: 0,
    turnIndex: 0,
    config: true,
    extensionState: { spouses: opts.spouses ?? [], adoptions: [] },
    memo: new Map<string, unknown>(),
  };
}

const EDGE_CTX = ctxOf({ actors: makeActors(false), edges: makeEdges(), spouses: SPOUSES });
const POINTER_CTX = ctxOf({ actors: makeActors(true), edges: [], spouses: SPOUSES });

const EDGE_GRAPH = familyKinGraph(EDGE_CTX).graph;
const POINTER_GRAPH = familyKinGraph(POINTER_CTX).graph;

function terms(graph: KinGraph, from: string, to: string, maxHops = 4): string[] {
  return kinshipReadingsIn(graph, from, to, { maxHops }).map((r) => r.term);
}

describe("选源：有指针走指针，没有回落边", () => {
  it("无指针 ⇒ 边模式（存量模板的路径）", () => {
    expect(familyKinGraph(EDGE_CTX).mode).toBe("edges");
    expect(kinshipTermIn(EDGE_GRAPH, "me", "dad", { maxHops: 2 })?.term).toBe("爸爸");
  });

  it("至少一人带父/母指针 ⇒ 指针模式，即使同一次快照里还有社会边", () => {
    expect(familyKinGraph(POINTER_CTX).mode).toBe("pointers");
    // 指针模式下婚配来自扩展 state，不靠边。
    expect([...POINTER_GRAPH.spousesOf("mom")].sort()).toEqual(["dad", "stepdad"]);
  });
});

describe("等价性：同一家族写成边图或指针图，称谓逐条相同", () => {
  /** 三代直系 + 旁系 + 同胞 + 半同胞 + 继亲（`docs/FAMILY-GRAPH.md §4.5` 前两层）。 */
  const PAIRS: readonly (readonly [string, string, string])[] = [
    ["me", "dad", "爸爸"],
    ["me", "mom", "妈妈"],
    ["dad", "me", "儿子"],
    ["me", "gf", "爷爷"],
    ["me", "gm", "奶奶"],
    ["gf", "me", "孙子"],
    ["me", "bro", "哥哥"],
    ["me", "sis", "姐姐"],
    ["bro", "me", "弟弟"],
    ["me", "half", "同父异母的弟弟"],
    ["me", "uncleE", "伯父"],
    ["me", "stepdad", "继父"],
    ["me", "stepBro", "继兄弟"],
  ];

  it.each(PAIRS)("%s → %s 的主称谓同为「%s」", (from, to, expected) => {
    expect(terms(EDGE_GRAPH, from, to)[0]).toBe(expected);
    expect(terms(POINTER_GRAPH, from, to)[0]).toBe(expected);
  });

  /**
   * 边模式可以比指针模式**多**读法：模板写了 `elder-brother` 边，（如「我 → 兄 → 母 → 父」）
   * 就多出一条可达路径，多出「姻亲」之类的备选读法；指针模式只有父边派生，路径更少。
   * 这是输入信息量不同，不是结论不同 —— 所以钉两件事：
   * · 主称谓逐对相同（上面）；
   * · 指针模式的**每一条**读法都能在边模式里找到同词读法（不凭空造词）。
   */
  it("指针模式的每条读法都能在边模式里找到同词读法", () => {
    for (const [from, to] of PAIRS) {
      const edgeTerms = new Set(terms(EDGE_GRAPH, from, to));
      for (const term of terms(POINTER_GRAPH, from, to)) {
        expect(edgeTerms.has(term), `${from} → ${to} 的「${term}」在边模式里不存在`).toBe(true);
      }
    }
  });

  it("三代以上（父之父之父）也一致", () => {
    // 爷爷没有父指针 ⇒ 再往上就是不可达（两边都取不到），这里顺带钉住「不编祖先」。
    expect(terms(EDGE_GRAPH, "me", "gf", 4)).toEqual(terms(POINTER_GRAPH, "me", "gf", 4));
  });

  it("族谱视图等价：节点世代与边三元组相同", () => {
    const edge = familyExtension.snapshotDerivation!.derive(EDGE_CTX) as {
      family: { pedigree: { nodes: { id: string; generation: number }[]; edges: { from: string; to: string; kind: string; parentRole?: string }[] } };
    };
    const pointer = familyExtension.snapshotDerivation!.derive(POINTER_CTX) as typeof edge;
    const nodes = (v: typeof edge): string[] =>
      v.family.pedigree.nodes.map((n) => `${n.id}@g${n.generation}`).sort();
    const triples = (v: typeof edge): string[] =>
      v.family.pedigree.edges
        .map((e) => `${e.from}>${e.to}:${e.kind}:${e.parentRole ?? ""}`)
        .sort();
    expect(nodes(pointer)).toEqual(nodes(edge));
    expect(triples(pointer)).toEqual(triples(edge));
  });

  it("指针图 → 边（族谱适配）不丢父/母方向", () => {
    const adapted = kinGraphToRelationEdges(POINTER_GRAPH);
    expect(adapted).toContainEqual({
      from: "me",
      to: "dad",
      kind: "father",
      source: "template",
      visibility: "known",
    });
    expect(adapted).toContainEqual({
      from: "me",
      to: "mom",
      kind: "mother",
      source: "template",
      visibility: "known",
    });
  });
});

describe("指针模式单独用例", () => {
  it("只写父不写母：父系正常，母系缺失（不猜）", () => {
    const actors = new Map<string, SnapshotActor>();
    const add = (id: string, genderId: string, extra: Partial<SnapshotActor> = {}): void => {
      actors.set(id, { id, name: id, visible: true, alive: true, age: 30, genderId, lifeState: "alive", ...extra });
    };
    add("dad", "male", { birthTime: 20 });
    add("kid", "male", { birthTime: 50, fatherId: "dad" });
    add("pgm", "female", { birthTime: 0 }); // 父之母（奶奶）；dad 没写 motherId ⇒ 不可达
    const graph = familyKinGraph(ctxOf({ actors, edges: [] })).graph;

    expect(kinshipTermIn(graph, "kid", "dad", { maxHops: 2 })?.term).toBe("爸爸");
    expect(graph.parentsOf("kid")).toEqual([{ parent: "dad", role: "father" }]);
    // 没写 motherId ⇒ 母系那半张图根本不存在，不是「猜一个妈妈」。
    expect(kinshipTermIn(graph, "kid", "pgm", { maxHops: 3 })).toBeNull();
  });

  it("genderId 未知：出中性词，不出哥哥/弟弟/姐姐/妹妹", () => {
    const actors = new Map<string, SnapshotActor>();
    const add = (id: string, genderId: string | undefined, extra: Partial<SnapshotActor> = {}): void => {
      actors.set(id, {
        id,
        name: id,
        visible: true,
        alive: true,
        age: 30,
        ...(genderId !== undefined ? { genderId } : {}),
        lifeState: "alive",
        ...extra,
      });
    };
    add("dad", "male", { birthTime: 20 });
    add("me", "male", { birthTime: 50, fatherId: "dad" });
    add("sib", "unranked", { birthTime: 45, fatherId: "dad" }); // 模板自定义 id ⇒ 不详
    const graph = familyKinGraph(ctxOf({ actors, edges: [] })).graph;

    expect(kinshipTermIn(graph, "dad", "sib", { maxHops: 2 })?.term).toBe("远亲");
    const sibTerms = terms(graph, "me", "sib");
    expect(sibTerms.length).toBeGreaterThan(0);
    for (const t of sibTerms) {
      expect(t).not.toMatch(/哥哥|弟弟|姐姐|妹妹|儿子|女儿/);
    }
  });
});
