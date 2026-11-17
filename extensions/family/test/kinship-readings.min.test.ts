import { describe, expect, it } from "vitest";
import type { KinshipKind, RelationEdge } from "@life-sim/shared";
import { inbreedingCoefficient, kinshipCoefficient } from "../src/coefficient.js";
import { kinshipReadings } from "../src/terms.js";

/**
 * 亲缘读法（多身份推导）的行为固定。
 *
 * 这一组断言记录的是**几类必须成立的判断**，不是某一版实现的细节：
 * 1. 血亲身份优先于姻亲身份（「外婆」不能被「继母」挤掉）；
 * 2. 短路径不能被 DFS 先到的长路径挤掉（旧实现的真实 bug）；
 * 3. 姻亲不得伪装成血亲（父之妻 ≠ 母、母之夫的女儿 ≠ 妹）；
 * 4. 半血亲要从父边/母边算出来，而不是当全血亲。
 *
 * 夹具是瓦勒蒙家谱的骨架：四代、多妻、兄妹婚、转房、继亲。
 */

type Spec = Record<string, Array<[string, KinshipKind]>>;

function buildEdges(spec: Spec): RelationEdge[] {
  const edges: RelationEdge[] = [];
  for (const [from, rels] of Object.entries(spec)) {
    for (const [to, kind] of rels) {
      edges.push({ from, to, kind, source: "template", visibility: "known", value: 0 });
    }
  }
  return edges;
}

/**
 * 骨架（只看结构，不看剧情）：
 *
 *   bardo ─ hilda        正妻，生 aldric / mathilde（全兄妹）
 *   bardo ─ irma         继室，生 godfrey（与 aldric / mathilde 同父异母）
 *   aldric ─ mathilde    兄妹婚 → cecily / hugh
 *   aldric ─ cecily      父女婚 → blanche
 *   hugh ─ mathilde      母子婚 → reynard
 *   reynard ─ blanche    汇合
 *   mathilde ─ godfrey   转房（既是弟弟又是丈夫）
 *   konrad ─ irma        继室的前夫；rosa 是 konrad 的女儿 ⇒ 与全族零血缘
 *   godfrey ─ rosa       纯伦理结合
 */
const SPEC: Spec = {
  bardo: [
    ["hilda", "wife"],
    ["irma", "wife"],
    ["aldric", "son"],
    ["mathilde", "daughter"],
    ["godfrey", "son"],
  ],
  hilda: [
    ["bardo", "husband"],
    ["aldric", "son"],
    ["mathilde", "daughter"],
  ],
  irma: [
    ["bardo", "husband"],
    ["konrad", "husband"],
    ["godfrey", "son"],
  ],
  konrad: [
    ["irma", "wife"],
    ["rosa", "daughter"],
  ],
  aldric: [
    ["bardo", "father"],
    ["hilda", "mother"],
    ["mathilde", "wife"],
    ["mathilde", "younger-sister"],
    ["cecily", "daughter"],
    ["cecily", "wife"],
    ["hugh", "son"],
    ["blanche", "daughter"],
    ["blanche", "wife"],
  ],
  mathilde: [
    ["bardo", "father"],
    ["hilda", "mother"],
    ["aldric", "husband"],
    ["aldric", "elder-brother"],
    ["godfrey", "husband"],
    ["godfrey", "younger-brother"],
    ["cecily", "daughter"],
    ["hugh", "son"],
    ["hugh", "husband"],
    ["reynard", "son"],
  ],
  cecily: [
    ["aldric", "father"],
    ["aldric", "husband"],
    ["mathilde", "mother"],
    ["blanche", "daughter"],
  ],
  hugh: [
    ["aldric", "father"],
    ["mathilde", "mother"],
    ["mathilde", "wife"],
    ["reynard", "son"],
  ],
  godfrey: [
    ["bardo", "father"],
    ["irma", "mother"],
    ["mathilde", "wife"],
    ["mathilde", "elder-sister"],
    ["rosa", "wife"],
  ],
  rosa: [
    ["konrad", "father"],
    ["godfrey", "husband"],
  ],
  reynard: [
    ["hugh", "father"],
    ["mathilde", "mother"],
    ["blanche", "wife"],
  ],
  blanche: [
    ["aldric", "father"],
    ["aldric", "husband"],
    ["cecily", "mother"],
    ["cecily", "elder-sister"],
    ["reynard", "husband"],
  ],
};

const EDGES = buildEdges(SPEC);
const readings = (from: string, to: string) => kinshipReadings(EDGES, from, to, { maxHops: 3 });

describe("亲缘读法 · 主称谓必须走血亲短路径", () => {
  it("布兰奇看玛蒂尔达：外婆（2 跳血亲），而不是「爸爸的妻子 ⇒ 妈妈」", () => {
    const rs = readings("blanche", "mathilde");
    expect(rs.length).toBeGreaterThan(0);
    expect(rs[0]!.term).toBe("外婆");
    expect(rs[0]!.affinal).toBe(false);
    expect(rs[0]!.hops).toBe(2);
    // 旧实现把 3 跳的 [爸爸,妻子] 排在了 2 跳的 [妈妈,妈妈] 前面 —— 那不是「最短路径」，
    // 是 DFS 先到先得。这条断言就是那道护栏。
    expect(rs[0]!.tokens).toEqual(["妈妈", "妈妈"]);
  });

  it("血亲读法全部排在姻亲读法之前", () => {
    const rs = readings("blanche", "mathilde");
    const firstAffinal = rs.findIndex((r) => r.affinal);
    expect(firstAffinal).toBeGreaterThan(0);
    expect(rs.slice(firstAffinal).every((r) => r.affinal)).toBe(true);
  });

  it("继母作为姻亲读法保留，且标记 affinal", () => {
    const step = readings("blanche", "mathilde").find((r) => r.term === "继母");
    expect(step).toBeDefined();
    expect(step!.affinal).toBe(true);
    expect(step!.tokens).toEqual(["爸爸", "妻子"]);
  });

  it("多跳不得输出父母称谓：旧链「爸爸的儿子 ⇒ 妈妈」被拦下", () => {
    const terms = readings("blanche", "mathilde").map((r) => r.term);
    expect(terms).not.toContain("妈妈");
    expect(terms).not.toContain("爸爸");
  });
});

describe("亲缘读法 · 姻亲不得伪装成血亲", () => {
  it("戈弗雷看罗莎（零血缘、母亲改嫁带来的继女）：继姐妹，不是妹妹", () => {
    const rs = readings("godfrey", "rosa");
    expect(rs.length).toBeGreaterThan(0);
    expect(rs[0]!.term).toBe("继姐妹");
    expect(rs[0]!.affinal).toBe(true);
    // 库会把「妈妈的丈夫的女儿」硬解成「妹妹」—— 那是把姻亲当成血亲，必须丢掉。
    expect(rs.map((r) => r.term)).not.toContain("妹妹");
  });

  it("继亲关系不产生配偶称谓（儿子的妈妈 ≠ 老婆）", () => {
    for (const [a, b] of [
      ["blanche", "mathilde"],
      ["godfrey", "rosa"],
      ["blanche", "hilda"],
    ] as const) {
      const terms = readings(a, b).map((r) => r.term);
      expect(terms).not.toContain("老婆");
      expect(terms).not.toContain("老公");
    }
  });
});

describe("亲缘读法 · 词与路必须同质", () => {
  it("子女称谓只能一跳：妻子的儿子是继子，不是儿子", () => {
    const rs = readings("godfrey", "reynard");
    expect(rs[0]!.term).toBe("继子");
    expect(rs.map((r) => r.term)).not.toContain("儿子");
  });

  it("血亲路径不得产出姻亲词：孙辈的父亲不等于我的女婿", () => {
    const rs = readings("hilda", "hugh");
    expect(rs[0]!.term).toBe("外孙");
    // 旧链 `女儿的儿子 … 的爸爸` 会给「女婿」—— 库假定孙辈的父亲是我的女婿，
    // 而孙辈也可能是儿子的孩子。没有配偶边就不该出现姻亲称谓。
    expect(rs.filter((r) => !r.affinal).map((r) => r.term)).not.toContain("女婿");
  });
});

describe("亲缘读法 · 半血亲由父边/母边算出", () => {
  it("玛蒂尔达看戈弗雷：同父异母（共享巴尔多，母亲不同）", () => {
    const rs = readings("mathilde", "godfrey");
    expect(rs[0]!.term).toBe("同父异母的弟弟");
    expect(rs[0]!.half).toBe("同父异母");
    expect(rs[0]!.hops).toBe(1);
  });

  it("全血亲不加前缀：塞西莉看休仍是普通同胞", () => {
    const terms = readings("cecily", "hugh").map((r) => r.term);
    expect(terms.some((t) => t.startsWith("同父异母") || t.startsWith("同母异父"))).toBe(false);
  });
});

describe("亲缘系数：给称谓推导当判据", () => {
  it("零血缘的两人 r = 0，姻亲或拟制关系一条血亲读法都不该有", () => {
    expect(kinshipCoefficient(EDGES, "godfrey", "rosa")).toBe(0);
    const blood = readings("godfrey", "rosa").filter((r) => !r.affinal);
    expect(blood).toEqual([]);
  });

  it("继母与继子 r = 0：不得输出「儿子」", () => {
    // 希尔达是巴尔多正妻，戈弗雷是继室伊尔玛所出 —— 她只是继母。
    expect(kinshipCoefficient(EDGES, "hilda", "godfrey")).toBe(0);
    const terms = readings("hilda", "godfrey").map((r) => r.term);
    expect(terms).not.toContain("儿子");
    expect(terms).toContain("继子");
  });

  it("系数与家谱对得上：全兄妹婚的子代 F = 0.25，且多路径会叠加", () => {
    // 塞西莉的父母是奥德里克 × 玛蒂尔达（全兄妹）⇒ F = 0.25（可手算）。
    expect(inbreedingCoefficient(EDGES, "cecily")).toBeCloseTo(0.25, 6);
    // 布兰奇的父母是奥德里克 × 塞西莉（父女）：
    //   F = φ(奥德里克, 塞西莉) = 0.5 × (0.5 × (1 + F(奥德里克)) + 0.25) = 0.375
    expect(inbreedingCoefficient(EDGES, "blanche")).toBeCloseTo(0.375, 6);
    // 她与玛蒂尔达之间同时有「外婆」「外曾祖母」等多条路径，r 因此高于单条路径的 0.25
    expect(kinshipCoefficient(EDGES, "blanche", "mathilde")).toBeCloseTo(0.625, 6);
  });
});

describe("亲缘读法 · 确定性与自指", () => {
  it("同输入两次调用逐字段相同", () => {
    expect(JSON.stringify(readings("blanche", "mathilde"))).toBe(
      JSON.stringify(readings("blanche", "mathilde")),
    );
  });

  it("不输出「自己」", () => {
    for (const [a, b] of [
      ["blanche", "mathilde"],
      ["godfrey", "rosa"],
      ["mathilde", "godfrey"],
    ] as const) {
      expect(readings(a, b).map((r) => r.term)).not.toContain("自己");
    }
  });
});
