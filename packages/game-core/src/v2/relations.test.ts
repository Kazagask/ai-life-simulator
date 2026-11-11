import { describe, expect, it } from "vitest";
import type { RelationEdge, RelationKind } from "@life-sim/shared";
import {
  ancestorGaps,
  addEdge,
  buildRelationGraph,
  COARSE_KINSHIP_TITLE,
  detectCycles,
  freezeOnDeath,
  isKinshipKind,
  isKinshipReachable,
  KINSHIP_TOKEN,
  kinshipTerm,
  PLAYER_NODE_ID,
  projectVisibleRelations,
  queryEdge,
  relationsOf,
  removeEdge,
  SELF_TITLE,
  shortestPath,
} from "./relations.js";

function edge(
  from: string,
  to: string,
  kind: RelationKind,
  extra: Partial<RelationEdge> = {},
): RelationEdge {
  return { from, to, kind, source: "template", visibility: "known", ...extra };
}

describe("R2.6 关系图谱内核 · 建图与增删", () => {
  it("建图建立出/入双向索引与节点集合", () => {
    const edges = [edge("a", "b", "father"), edge("b", "c", "son")];
    const g = buildRelationGraph(edges);
    expect([...g.nodes].sort()).toEqual(["a", "b", "c"]);
    expect(g.outgoing.get("a")?.map((e) => e.to)).toEqual(["b"]);
    expect(g.incoming.get("b")?.map((e) => e.from)).toEqual(["a"]);
    expect(g.outgoing.get("c")).toBeUndefined();
    expect(g.edges).toHaveLength(2);
  });

  it("addEdge 对同 (from,to,kind) 合并而非重复，gap/frozen 取「或」", () => {
    const base = [edge("a", "b", "father", { value: 10 })];
    const merged = addEdge(base, edge("a", "b", "father", { value: 40, gap: true, source: "effect" }));
    expect(merged).toHaveLength(1);
    expect(merged[0].value).toBe(40);
    expect(merged[0].gap).toBe(true);
    expect(merged[0].source).toBe("effect");

    // frozen 是单向棘轮：已冻结的边不能被后续写入解冻
    const frozen = freezeOnDeath(merged, "a");
    const again = addEdge(frozen, edge("a", "b", "father", { frozen: false }));
    expect(again[0].frozen).toBe(true);
  });

  it("addEdge 不修改原数组（纯函数）", () => {
    const base = [edge("a", "b", "father")];
    const snapshot = JSON.parse(JSON.stringify(base));
    addEdge(base, edge("b", "c", "son"));
    expect(base).toEqual(snapshot);
  });

  it("removeEdge 可按 kind 精确删除，省略 kind 删该对的全部边", () => {
    const edges = [edge("a", "b", "father"), edge("a", "b", "mentor"), edge("a", "c", "friend")];
    expect(removeEdge(edges, "a", "b", "mentor")).toHaveLength(2);
    expect(removeEdge(edges, "a", "b")).toHaveLength(1);
    expect(removeEdge(edges, "a", "b")[0].to).toBe("c");
  });

  it("queryEdge / relationsOf 命中直接边与相邻边", () => {
    const edges = [edge("a", "b", "father"), edge("b", "c", "son")];
    expect(queryEdge(edges, "a", "b", "father")?.kind).toBe("father");
    expect(queryEdge(edges, "a", "b", "mother")).toBeUndefined();
    const g = buildRelationGraph(edges);
    expect(relationsOf(g, "b")).toHaveLength(2);
    expect(relationsOf(g, "zz")).toEqual([]);
  });
});

describe("R2.6 关系图谱内核 · 最短路径与断代", () => {
  // 玩家 → 爸爸 甚尔 → 爸爸 直毘人（爷爷）；玩家 → 妈妈 里子
  const blood = [
    edge(PLAYER_NODE_ID, "toji", "father"),
    edge("toji", "naobito", "father"),
    edge(PLAYER_NODE_ID, "riko", "mother"),
    edge("riko", "toji", "husband"),
  ];
  const g = buildRelationGraph(blood);

  it("直达与多跳最短路径，tokens 为关系链记号", () => {
    const direct = shortestPath(g, PLAYER_NODE_ID, "toji");
    expect(direct?.tokens).toEqual(["爸爸"]);
    expect(direct?.edges).toHaveLength(1);
    expect(direct?.gapped).toBe(false);

    const multi = shortestPath(g, PLAYER_NODE_ID, "naobito");
    expect(multi?.tokens).toEqual(["爸爸", "爸爸"]);
    expect(multi?.edges).toHaveLength(2);
  });

  it("不可达返回 null；自己返回空路径", () => {
    expect(shortestPath(g, PLAYER_NODE_ID, "unknown")).toBeNull();
    expect(shortestPath(g, PLAYER_NODE_ID, PLAYER_NODE_ID)).toEqual({ edges: [], tokens: [], gapped: false });
  });

  it("等长路径取关系链字典序最小（不唯一取最短 + 字典序）", () => {
    // 到 x 有两条 2 跳路径：妈妈·的儿子 / 爸爸·的的儿子 —— 取字典序小者
    const g2 = buildRelationGraph([
      edge("p", "m", "mother"),
      edge("m", "x", "son"),
      edge("p", "f", "father"),
      edge("f", "y", "son"),
      edge("x", "z", "son"),
      edge("y", "z", "son"),
    ]);
    // 到 z：妈妈·的儿子·的儿子 vs 爸爸·的儿子·的儿子 → 「妈妈」< 「爸爸」→ 走妈妈侧
    const p = shortestPath(g2, "p", "z");
    expect(p?.tokens).toEqual(["妈妈", "儿子", "儿子"]);
  });

  it("默认只走亲属边，社会边不进称谓推导", () => {
    const mixed = buildRelationGraph([
      edge("p", "mentor", "mentor"),
      edge("mentor", "target", "mentor"),
      edge("p", "dad", "father"),
    ]);
    expect(shortestPath(mixed, "p", "target")).toBeNull(); // 两跳都靠社会边
    // 放开 kinshipOnly 后可走通（纯拓扑查询）
    expect(shortestPath(mixed, "p", "target", { kinshipOnly: false })?.tokens).toEqual([
      "mentor",
      "mentor",
    ]);
  });

  it("ancestorGaps 统计断代边；gapped 路径标记为真", () => {
    const gapped = buildRelationGraph([edge(PLAYER_NODE_ID, "clan-claim", "father", { gap: true })]);
    const path = shortestPath(gapped, PLAYER_NODE_ID, "clan-claim");
    expect(path?.gapped).toBe(true);
    expect(ancestorGaps(gapped, PLAYER_NODE_ID, "clan-claim")).toBe(1);
    expect(ancestorGaps(g, PLAYER_NODE_ID, "naobito")).toBe(0);
  });

  it("maxHops 限制生效", () => {
    expect(shortestPath(g, PLAYER_NODE_ID, "naobito", { maxHops: 1 })).toBeNull();
    expect(shortestPath(g, PLAYER_NODE_ID, "naobito", { maxHops: 2 })?.tokens).toHaveLength(2);
  });
});

describe("R2.6 关系图谱内核 · 环检测与冻结", () => {
  it("亲属图成环可检出（节点首尾闭合，边数 = 节点数 - 1）", () => {
    const cyc = buildRelationGraph([
      edge("a", "b", "father"),
      edge("b", "c", "son"),
      edge("c", "a", "son"),
    ]);
    const cycles = detectCycles(cyc);
    expect(cycles.length).toBeGreaterThan(0);
    const c = cycles[0];
    expect(c.nodes[0]).toBe(c.nodes[c.nodes.length - 1]);
    expect(c.edges).toHaveLength(c.nodes.length - 1);
  });

  it("纯社会边成环不报错（师徒/朋友成环是正常现象）", () => {
    const social = buildRelationGraph([
      edge("a", "b", "mentor"),
      edge("b", "c", "mentor"),
      edge("c", "a", "friend"),
    ]);
    expect(detectCycles(social)).toEqual([]);
  });

  it("无环亲属图返回空数组", () => {
    const tree = buildRelationGraph([edge("a", "b", "father"), edge("b", "c", "father")]);
    expect(detectCycles(tree)).toEqual([]);
  });

  it("freezeOnDeath 冻结相连边但保留可遍历性（逝者仍是亲属）", () => {
    const edges = [edge(PLAYER_NODE_ID, "toji", "father"), edge("toji", "naobito", "father")];
    const frozen = freezeOnDeath(edges, "toji");
    expect(frozen.every((e) => e.frozen === true)).toBe(true);
    // 冻结不影响称谓推导
    expect(shortestPath(buildRelationGraph(frozen), PLAYER_NODE_ID, "naobito")?.tokens).toEqual([
      "爸爸",
      "爸爸",
    ]);
    // 不影响原数组
    expect(edges.some((e) => e.frozen === true)).toBe(false);
  });
});

describe("R2.6 关系图谱内核 · 可见性投影", () => {
  it("仅 known / inferred 投影；unknown / hidden 不泄露", () => {
    const edges = [
      edge("p", "a", "friend", { visibility: "known" }),
      edge("p", "b", "mentor", { visibility: "inferred" }),
      edge("p", "c", "enemy", { visibility: "unknown" }),
      edge("p", "d", "rival", { visibility: "hidden" }),
    ];
    const visible = projectVisibleRelations(edges);
    expect(visible.map((e) => e.to)).toEqual(["a", "b"]);
    // 返回副本，改动不污染状态层
    visible[0].value = 99;
    expect(edges[0].value).toBeUndefined();
  });
});

describe("R2.6 关系图谱内核 · 常量与判定", () => {
  it("isKinshipKind 只认同亲属边", () => {
    expect(isKinshipKind("father")).toBe(true);
    expect(isKinshipKind("mentor")).toBe(false);
    expect(isKinshipKind("nonsense")).toBe(false);
  });

  it("KINSHIP_TOKEN 覆盖全部亲属 kind 且无空值", () => {
    expect(Object.keys(KINSHIP_TOKEN).sort()).toEqual([
      "daughter",
      "elder-brother",
      "elder-sister",
      "father",
      "husband",
      "mother",
      "son",
      "wife",
      "younger-brother",
      "younger-sister",
    ]);
    expect(Object.values(KINSHIP_TOKEN).every((v) => v.length > 0)).toBe(true);
    expect(PLAYER_NODE_ID).toBe("player");
  });
});

describe("R2.6 多跳中文称谓（T-B3 · relationship.js 适配）", () => {
  it("单跳与多跳均得确定性中文称谓", () => {
    const edges = [
      edge(PLAYER_NODE_ID, "toji", "father"),
      edge("toji", "naobito", "father"),
      edge(PLAYER_NODE_ID, "riko", "mother"),
    ];
    expect(kinshipTerm(edges, PLAYER_NODE_ID, "toji")?.term).toBe("爸爸");
    expect(kinshipTerm(edges, PLAYER_NODE_ID, "naobito")?.term).toBe("爷爷");
    expect(kinshipTerm(edges, PLAYER_NODE_ID, "riko")?.term).toBe("妈妈");
  });

  it("旁系与多解称谓按字典序取最小且列出全部候选", () => {
    // 妈妈的哥哥的女儿 → 舅表姐 / 舅表妹（两解）
    const edges = [
      edge(PLAYER_NODE_ID, "mum", "mother"),
      edge("mum", "uncle", "elder-brother"),
      edge("uncle", "cousin", "daughter"),
    ];
    const t = kinshipTerm(edges, PLAYER_NODE_ID, "cousin")!;
    expect(t.exact).toBe(true);
    expect(t.alternatives.length).toBeGreaterThan(1);
    expect(t.term).toBe([...t.alternatives].sort()[0]);
    expect(t.tokens).toEqual(["妈妈", "哥哥", "女儿"]);
    // 确定性：同输入重复调用同输出
    expect(kinshipTerm(edges, PLAYER_NODE_ID, "cousin")).toEqual(t);
  });

  it("自己 → 自己；不可达 → null", () => {
    const edges = [edge(PLAYER_NODE_ID, "toji", "father")];
    expect(kinshipTerm(edges, PLAYER_NODE_ID, PLAYER_NODE_ID)?.term).toBe(SELF_TITLE);
    expect(kinshipTerm(edges, PLAYER_NODE_ID, "stranger")).toBeNull();
    expect(isKinshipReachable(edges, PLAYER_NODE_ID, "stranger")).toBe(false);
    expect(isKinshipReachable(edges, PLAYER_NODE_ID, "toji")).toBe(true);
    expect(isKinshipReachable(edges, PLAYER_NODE_ID, PLAYER_NODE_ID)).toBe(false);
  });

  it("断代边（gap）回退粗称谓而不猜代数", () => {
    const edges = [edge(PLAYER_NODE_ID, "clan-claim", "father", { gap: true })];
    const t = kinshipTerm(edges, PLAYER_NODE_ID, "clan-claim")!;
    expect(t.term).toBe(COARSE_KINSHIP_TITLE);
    expect(t.exact).toBe(false);
    expect(t.gapped).toBe(true);
    // 仍保留关系链记号以便诊断
    expect(t.tokens).toEqual(["爸爸"]);
  });

  it("库无解（非法亲属链）也回退粗称谓，不抛错不静默", () => {
    // 自己→自己的儿子→自己的丈夫：关系链「儿子的丈夫」在库中无解
    const edges = [edge(PLAYER_NODE_ID, "s", "son"), edge("s", "h", "husband")];
    const t = kinshipTerm(edges, PLAYER_NODE_ID, "h")!;
    expect(t.term).toBe(COARSE_KINSHIP_TITLE);
    expect(t.exact).toBe(false);
    expect(t.tokens).toEqual(["儿子", "丈夫"]);
  });

  it("社会边不参与称谓（师徒链不产出称谓）", () => {
    const edges = [edge(PLAYER_NODE_ID, "gojo", "mentor")];
    expect(kinshipTerm(edges, PLAYER_NODE_ID, "gojo")).toBeNull();
  });
});
