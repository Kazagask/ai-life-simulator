import { describe, expect, it } from "vitest";
import type { WorldStateV2 } from "@life-sim/shared";
import { addEdge } from "@life-sim/game-core";
import { kinshipTerm } from "../src/terms.js";

/**
 * 亲缘系数的参照实现 + 关系推导的现状固定。
 *
 * 上半部分是**参照实现**（表格法），它不依赖 game-core 的任何代码，
 * 只用父代映射算 Wright 近交系数 F 与亲缘系数 φ。它的正确性由
 * 「连续兄妹婚」的已知数列校验 —— 那是唯一能独立验证的标准答案。
 *
 * 下半部分是**现状固定**：把关系推导函数在同一张图上给出的结果钉住，
 * 用来记录「它可以算什么、算不了什么」。将来补上全路径推导时，
 * 这些断言会变红，届时按新行为改写它们（不是删掉）。
 */

type Ped = Record<string, [string, string] | null>;

function makeCalc(ped: Ped) {
  const fMemo = new Map<string, number>();
  const phiMemo = new Map<string, number>();
  const ancMemo = new Map<string, boolean>();

  function isAnc(x: string, y: string): boolean {
    if (x === y) return false;
    const k = `${x}>${y}`;
    const hit = ancMemo.get(k);
    if (hit !== undefined) return hit;
    ancMemo.set(k, false);
    const p = ped[y];
    const r = p ? p[0] === x || p[1] === x || isAnc(x, p[0]) || isAnc(x, p[1]) : false;
    ancMemo.set(k, r);
    return r;
  }

  function getF(x: string): number {
    const hit = fMemo.get(x);
    if (hit !== undefined) return hit;
    const p = ped[x];
    if (!p) {
      fMemo.set(x, 0);
      return 0;
    }
    const v = getPhi(p[0], p[1]);
    fMemo.set(x, v);
    return v;
  }

  /**
   * φ(X, Y)：从 X 与 Y 各取一个等位基因、二者同源的概率。
   * 递归只能沿「不是对方祖先」的那一侧上行，否则会重复计数。
   */
  function getPhi(x: string, y: string): number {
    if (x === y) return 0.5 * (1 + getF(x));
    const k = x < y ? `${x}|${y}` : `${y}|${x}`;
    const hit = phiMemo.get(k);
    if (hit !== undefined) return hit;
    const px = ped[x];
    const py = ped[y];
    let v: number;
    if (px && !isAnc(x, y)) v = 0.5 * (getPhi(px[0], y) + getPhi(px[1], y));
    else if (py) v = 0.5 * (getPhi(x, py[0]) + getPhi(x, py[1]));
    else v = 0;
    phiMemo.set(k, v);
    return v;
  }

  return { F: getF, phi: getPhi, r: (a: string, b: string) => 2 * getPhi(a, b) };
}

/** 连续兄妹婚：已知序列 0 / .25 / .375 / .5 / .59375 / .671875。 */
const LADDER: Ped = (() => {
  const p: Ped = { gm0: null, gf0: null };
  p.gm1 = ["gm0", "gf0"];
  p.gf1 = ["gm0", "gf0"];
  for (let g = 2; g <= 5; g++) {
    p[`gm${g}`] = [`gm${g - 1}`, `gf${g - 1}`];
    p[`gf${g}`] = [`gm${g - 1}`, `gf${g - 1}`];
  }
  p.player = ["gm5", "gf5"];
  return p;
})();

/** 八类婚配交织：兄妹、半血缘、母子、父女、隔代、纯伦理、多配偶、无血缘。 */
const TANGLED: Ped = {
  bardo: null,
  hilda: null,
  irma: null,
  xprev: null,
  aldric: ["bardo", "hilda"],
  mathilde: ["bardo", "hilda"],
  godfrey: ["bardo", "irma"],
  rosa: ["xprev", "irma"],
  hugh: ["aldric", "mathilde"],
  cecily: ["aldric", "mathilde"],
  reynard: ["hugh", "mathilde"],
  blanche: ["aldric", "cecily"],
  roland: ["reynard", "blanche"],
};

describe("亲缘系数 · 参照实现", () => {
  it("连续兄妹婚复现教科书数列", () => {
    const c = makeCalc(LADDER);
    expect(c.F("gm1")).toBeCloseTo(0, 6);
    expect(c.F("gm2")).toBeCloseTo(0.25, 6);
    expect(c.F("gm3")).toBeCloseTo(0.375, 6);
    expect(c.F("gm4")).toBeCloseTo(0.5, 6);
    expect(c.F("gm5")).toBeCloseTo(0.59375, 6);
    expect(c.F("player")).toBeCloseTo(0.671875, 6);
  });

  it("八类交织图的 F", () => {
    const c = makeCalc(TANGLED);
    expect(c.F("hugh")).toBeCloseTo(0.25, 6);
    expect(c.F("cecily")).toBeCloseTo(0.25, 6);
    expect(c.F("reynard")).toBeCloseTo(0.375, 6);
    expect(c.F("blanche")).toBeCloseTo(0.375, 6);
    expect(c.F("roland")).toBeCloseTo(0.34375, 6);
  });

  it("父母只到兄妹档，孩子却比 r/2 更纯", () => {
    const c = makeCalc(TANGLED);
    const fr = c.F("reynard");
    const fb = c.F("blanche");
    const phi = c.phi("reynard", "blanche");
    const normR = (2 * phi) / Math.sqrt((1 + fr) * (1 + fb));
    expect(normR).toBeCloseTo(0.5, 6);
    expect(c.F("roland")).toBeGreaterThan(normR / 2);
  });

  it("谱系坍缩让高祖与来孙共享一半基因", () => {
    const c = makeCalc(TANGLED);
    expect(c.r("roland", "bardo")).toBeCloseTo(0.5, 6);
  });
});

describe("亲缘系数 · 推导现状固定", () => {
  function buildEdges(): WorldStateV2["relations"] {
    let e: WorldStateV2["relations"] = [];
    for (const [child, p] of Object.entries(TANGLED)) {
      if (!p) continue;
      e = addEdge(e, { from: child, to: p[0], kind: "father", source: "effect", visibility: "known" });
      e = addEdge(e, { from: child, to: p[1], kind: "mother", source: "effect", visibility: "known" });
    }
    return e;
  }

  it("直系祖先算得出，但只给一个值", () => {
    const e = buildEdges();
    const t = kinshipTerm(e, "roland", "mathilde");
    expect(t).not.toBeNull();
    expect(t!.alternatives).toHaveLength(1);
  });

  it("旁系算不出：曾叔祖返回 null", () => {
    const e = buildEdges();
    expect(kinshipTerm(e, "roland", "godfrey")).toBeNull();
  });

  it("把提问方向反过来同样算不出", () => {
    const e = buildEdges();
    expect(kinshipTerm(e, "godfrey", "roland")).toBeNull();
    expect(kinshipTerm(e, "bardo", "roland")).toBeNull();
  });

  it("纯伦理与姻亲完全不参与推导", () => {
    const e = buildEdges();
    expect(kinshipTerm(e, "roland", "rosa")).toBeNull();
    expect(kinshipTerm(e, "roland", "irma")).toBeNull();
  });
});
