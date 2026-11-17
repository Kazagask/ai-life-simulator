import { describe, expect, it } from "vitest";
import {
  kinGraphFromPointers,
  kinshipReadingsIn,
  kinshipTermIn,
  movesOf,
  type KinPerson,
} from "../src/terms/index.js";

/**
 * `KinGraph`（指针模型）+ 三层推导（血亲 → 拟制 → 收养）+ 出生时间定长幼。
 *
 * 这张夹具刻意把三条线放在同一家人里：
 * - 血亲：爷爷/奶奶 → 父辈（父/伯/叔/姑）→ 我/兄/姐/妹/半同胞；
 * - 拟制：母亲改嫁 → 继父 / 继兄弟；
 * - 收养：我被收养 → 养父 / 养母 / 养兄弟 / 养姐妹；养父同时是我的生父（位次不覆盖）。
 *
 * 没有任何 `father` / `elder-brother` 边 —— 全部由指针 + 婚配 + 收养派生。
 * 长幼只靠 `birthTime`（`docs/FAMILY-GRAPH.md` §5）。
 */

const PEOPLE: KinPerson[] = [
  // 第一代
  { id: "gf", sex: "male", birthTime: 0 },
  { id: "gm", sex: "female", birthTime: 5 },
  // 第二代：父辈
  { id: "dad", sex: "male", birthTime: 20, fatherId: "gf", motherId: "gm" },
  { id: "uncleE", sex: "male", birthTime: 15, fatherId: "gf", motherId: "gm" },
  { id: "uncleY", sex: "male", birthTime: 25, fatherId: "gf", motherId: "gm" },
  { id: "uncleX", sex: "male", fatherId: "gf", motherId: "gm" },
  { id: "mom", sex: "female", birthTime: 22 },
  // 第三代：我这一辈
  { id: "me", sex: "male", birthTime: 50, fatherId: "dad", motherId: "mom" },
  { id: "bro", sex: "male", birthTime: 45, fatherId: "dad", motherId: "mom" },
  { id: "sis", sex: "female", birthTime: 48, fatherId: "dad", motherId: "mom" },
  // 半同胞：同父异母
  { id: "otherWoman", sex: "female", birthTime: 30 },
  { id: "half", sex: "male", birthTime: 52, fatherId: "dad", motherId: "otherWoman" },
  // 拟制：母亲改嫁
  { id: "stepdad", sex: "male", birthTime: 28 },
  { id: "stepBro", sex: "male", birthTime: 49, fatherId: "stepdad", motherId: "otherWoman" },
  // 收养
  { id: "adopter", sex: "male", birthTime: 18 },
  { id: "adopterWife", sex: "female", birthTime: 19 },
  { id: "adoptedSis", sex: "female", birthTime: 47 },
  { id: "adopterBio", sex: "male", birthTime: 44, fatherId: "adopter", motherId: "adopterWife" },
  // 认知父 ≠ 血缘父：本轮只认 fatherId
  { id: "realDad", sex: "male", birthTime: 21 },
  { id: "secret", sex: "male", birthTime: 51, fatherId: "dad", motherId: "otherWoman", realFatherId: "realDad" },
];

const GRAPH = kinGraphFromPointers(
  PEOPLE,
  [
    { a: "gf", b: "gm" },
    { a: "dad", b: "mom" },
    { a: "mom", b: "stepdad" },
    { a: "adopter", b: "adopterWife" },
  ],
  [
    { parent: "adopter", child: "me" },
    { parent: "adopterWife", child: "me" },
    { parent: "adopter", child: "adoptedSis" },
    // 生父同时也是养父：位次被血亲占住，收养不得覆盖
    { parent: "dad", child: "me" },
  ],
);

const term = (from: string, to: string) => kinshipTermIn(GRAPH, from, to, { maxHops: 4 })?.term;
const readings = (from: string, to: string) => kinshipReadingsIn(GRAPH, from, to, { maxHops: 4 });

describe("KinGraph · 指针模型", () => {
  it("父母/子女/婚配/收养四个访问口都从指针派生", () => {
    expect(GRAPH.parentsOf("me")).toEqual([
      { parent: "dad", role: "father" },
      { parent: "mom", role: "mother" },
    ]);
    expect(GRAPH.childrenOf("dad").map((c) => c.child).sort()).toEqual(["bro", "half", "me", "secret", "sis"]);
    expect([...GRAPH.spousesOf("mom")].sort()).toEqual(["dad", "stepdad"]);
    expect(GRAPH.adoptionsOf("me").map((a) => a.parent).sort()).toEqual(["adopter", "adopterWife", "dad"]);
  });

  it("收养边与生育边是两种移动", () => {
    const kinds = movesOf(GRAPH, "adopter").map((m) => `${m.kind}:${m.to}`).sort();
    expect(kinds).toContain("adoptive-son:me");
    expect(kinds).toContain("adoptive-daughter:adoptedSis");
    expect(kinds).toContain("son:adopterBio");
  });

  it("realFatherId 不参与推导", () => {
    expect(term("secret", "dad")).toBe("爸爸");
    expect(kinshipTermIn(GRAPH, "secret", "realDad", { maxHops: 4 })).toBeNull();
  });
});

describe("三层推导 · 血亲在最前", () => {
  it("生父同时是养父：爸爸压过养父，但两条读法各自成立", () => {
    const rs = readings("me", "dad");
    expect(rs[0]!.term).toBe("爸爸");
    expect(rs[0]!.signature?.tier).toBe(1);
    expect(rs.map((r) => r.term)).toContain("养父");
    expect(rs.find((r) => r.term === "养父")?.signature?.tier).toBe(3);
    // 血亲永远排在收养前面。
    expect(rs.findIndex((r) => r.term === "养父")).toBeGreaterThan(0);
  });

  it("半同胞是第一层：同父异母，不是继", () => {
    const rs = readings("me", "half");
    const r = rs.find((x) => x.term.includes("同父异母"));
    expect(r).toBeDefined();
    expect(r!.signature?.tier).toBe(1);
    expect(r!.affinal).toBe(false);
    expect(r!.signature?.sameBloodVia).toBe("father");
  });

  it("拟制是第二层：继父 / 继兄弟", () => {
    expect(term("me", "stepdad")).toBe("继父");
    expect(readings("me", "stepdad").find((r) => r.term === "继父")?.signature?.tier).toBe(2);
    expect(term("me", "stepBro")).toBe("继兄弟");
  });

  it("收养是第三层：养父 / 养母 / 养兄弟 / 养姐妹", () => {
    expect(term("me", "adopter")).toBe("养父");
    expect(readings("me", "adopter").find((r) => r.term === "养父")?.signature?.tier).toBe(3);
    expect(term("me", "adopterWife")).toBe("养母");
    expect(term("me", "adopterBio")).toBe("养兄弟");
    expect(term("me", "adoptedSis")).toBe("养姐妹");
    expect(term("adopter", "me")).toBe("养子");
  });

  it("血缘/拟制/收养同场时按层号排序", () => {
    // me → dad（血亲）与 me → adopter（收养）是不同端点；这里看同一端点的层号单调性。
    const rs = readings("me", "dad");
    const tiers = rs.map((r) => r.signature?.tier ?? 1);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
  });
});

describe("长幼 · 只靠 birthTime", () => {
  it("同胞：出生早的是哥哥/姐姐", () => {
    expect(term("me", "bro")).toBe("哥哥");
    expect(term("me", "sis")).toBe("姐姐");
    expect(term("bro", "sis")).toBe("妹妹");
    expect(term("sis", "bro")).toBe("哥哥");
  });

  it("父之兄弟：比父亲年长是伯父，年幼是叔叔；缺 birthTime 用中性词", () => {
    expect(term("me", "uncleE")).toBe("伯父");
    expect(term("me", "uncleY")).toBe("叔叔");
    expect(term("me", "uncleX")).toBe("叔伯");
  });

  it("同父异母的兄长也按 birthTime 定长幼", () => {
    expect(term("half", "bro")).toBe("哥哥");
    expect(term("bro", "half")).toBe("弟弟");
  });
});
