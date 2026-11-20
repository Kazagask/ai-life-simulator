import { describe, expect, it } from "vitest";
import type { KinshipKind, RelationEdge } from "@life-sim/shared";
import { kinshipReadings, kinshipTerm } from "../src/terms/index.js";

/**
 * 换库回归：这 7 组断言是 `terms-audit.md`（682/692 行对账）里挑出来的**代表性修正**。
 *
 * 旧实现 `relationship.js` 已删除；这些用例锁住「换库到底换掉了什么」，
 * 防止以后有人把库的错误假设（父之妻=母、妻之子=子、配偶的配偶=自己、凭空给长幼）
 * 又写回来。注释里的「旧」都是 `terms-audit.md` 的实测输出。
 *
 * **夹具是手搓的边图，不读模板文件**：valmont 已迁到指针模式（`fatherId`/`motherId`
 * + `extensions.family.spouses`），`characters.yaml` 里不再有亲属边。本文件测的是
 * **terms 库对一张给定亲属图怎么命名**，不该随模板的写法迁移而松动 —— 所以把这家人的
 * 亲缘事实（父/母、婚配、同胞长幼）直接写在这里，断言保持原样。
 */

const E = build({
  "npc-bardo": [
    ["npc-hilda", "wife"],
    ["npc-irma", "wife"],
    ["npc-aldric", "son"],
    ["npc-mathilde", "daughter"],
    ["npc-godfrey", "son"],
  ],
  "npc-hilda": [
    ["npc-bardo", "husband"],
    ["npc-aldric", "son"],
    ["npc-mathilde", "daughter"],
  ],
  "npc-irma": [
    ["npc-bardo", "husband"],
    ["npc-konrad", "husband"],
    ["npc-godfrey", "son"],
  ],
  "npc-konrad": [
    ["npc-irma", "wife"],
    ["npc-rosa", "daughter"],
  ],
  "npc-aldric": [
    ["npc-bardo", "father"],
    ["npc-hilda", "mother"],
    ["npc-mathilde", "wife"],
    ["npc-mathilde", "younger-sister"],
    ["npc-hugh", "son"],
    ["npc-cecily", "daughter"],
    ["npc-cecily", "wife"],
    ["npc-blanche", "daughter"],
    ["npc-blanche", "wife"],
  ],
  "npc-mathilde": [
    ["npc-bardo", "father"],
    ["npc-hilda", "mother"],
    ["npc-aldric", "husband"],
    ["npc-aldric", "elder-brother"],
    ["npc-godfrey", "husband"],
    ["npc-godfrey", "younger-brother"],
    ["npc-cecily", "daughter"],
    ["npc-hugh", "son"],
    ["npc-hugh", "husband"],
    ["npc-reynard", "son"],
  ],
  "npc-godfrey": [
    ["npc-bardo", "father"],
    ["npc-irma", "mother"],
    ["npc-mathilde", "wife"],
    ["npc-mathilde", "elder-sister"],
    ["npc-rosa", "wife"],
  ],
  "npc-rosa": [
    ["npc-konrad", "father"],
    ["npc-godfrey", "husband"],
  ],
  "npc-hugh": [
    ["npc-aldric", "father"],
    ["npc-mathilde", "mother"],
    ["npc-mathilde", "wife"],
    ["npc-reynard", "son"],
  ],
  "npc-cecily": [
    ["npc-aldric", "father"],
    ["npc-aldric", "husband"],
    ["npc-mathilde", "mother"],
    ["npc-blanche", "daughter"],
  ],
  "npc-reynard": [
    ["npc-hugh", "father"],
    ["npc-mathilde", "mother"],
    ["npc-blanche", "wife"],
    ["player", "son"],
  ],
  "npc-blanche": [
    ["npc-aldric", "father"],
    ["npc-aldric", "husband"],
    ["npc-cecily", "mother"],
    ["npc-cecily", "elder-sister"],
    ["npc-reynard", "husband"],
    ["player", "son"],
  ],
  player: [
    ["npc-reynard", "father"],
    ["npc-blanche", "mother"],
  ],
});

const term = (from: string, to: string) => kinshipTerm(E, from, to, { maxHops: 3 })?.term;
const readings = (from: string, to: string) => kinshipReadings(E, from, to, { maxHops: 3 });
const terms = (from: string, to: string) => readings(from, to).map((r) => r.term);

function build(spec: Record<string, Array<[string, KinshipKind]>>): RelationEdge[] {
  const out: RelationEdge[] = [];
  for (const [from, rels] of Object.entries(spec)) {
    for (const [to, kind] of rels) {
      out.push({ from, to, kind, source: "template", scope: "public", value: 0 });
    }
  }
  return out;
}

describe("换库回归 · 继亲不得折叠成血亲", () => {
  it("伊尔玛→奥德里克 = 继子（旧：儿子）", () => {
    // 伊尔玛是巴尔多续娶的妻子；奥德里克是巴尔多与希尔达的儿子。
    // 旧库按「妻之子=子」把他算成伊尔玛的亲儿子。
    expect(term("npc-irma", "npc-aldric")).toBe("继子");
    expect(terms("npc-irma", "npc-aldric")).not.toContain("儿子");
  });

  it("休→奥德里克 的读法里不出现「哥哥」（旧：父亲之妻的丈夫被折成爸爸/哥哥）", () => {
    // 旧库从「爸爸的儿子…」一路折出「哥哥」；奥德里克是休的父亲，不是兄长。
    expect(terms("npc-hugh", "npc-aldric")).not.toContain("哥哥");
  });
});

describe("换库回归 · 姻亲靠配偶步判，不靠词表", () => {
  it("「儿子的妈妈的哥哥」= 大舅子，不出现「哥哥」", () => {
    // 只有 3 跳那条：我 → 子 → 子的母亲（共亲推断为妻，图上没有妻边）→ 她的哥哥。
    // 旧库的原始输出是 ["大舅子","哥哥"]，字典序取了「哥哥」，把血亲词写进姻亲行。
    const edges = build({
      me: [["s", "son"]],
      s: [
        ["me", "father"],
        ["w", "mother"],
      ],
      w: [
        ["s", "son"],
        ["u", "elder-brother"],
      ],
      u: [["w", "younger-sister"]],
    });
    expect(kinshipTerm(edges, "me", "u", { maxHops: 3 })?.term).toBe("大舅子");
    const list = kinshipReadings(edges, "me", "u", { maxHops: 3 }).map((r) => r.term);
    expect(list).toContain("大舅子");
    expect(list).not.toContain("哥哥");
  });

  it("奥德里克→罗莎 = 弟媳（旧：嫂子 —— 长幼是边里的事实，旧库取错）", () => {
    // 罗莎是戈弗雷的妻子；戈弗雷是奥德里克的弟弟（玛蒂尔达 younger-sister / younger-brother 链传递）。
    // 旧库一律给「嫂子」，实际应是「弟媳」。
    expect(term("npc-aldric", "npc-rosa")).toBe("弟媳");
  });

  it("12 条长幼未知的姻亲读法退「姻亲」但仍然存在，没有被吞掉", () => {
    // 这些路径的同胞链接都是 `父/母 → 子/女`，链里没有任何长幼信息；
    // 中文对「兄弟的妻子（长幼未知）」没有中性词，所以退粗称谓「姻亲」——但不许整条消失。
    const pairs: Array<[string, string]> = [
      ["npc-hugh", "npc-blanche"], // 旧：嫂子
      ["npc-hugh", "npc-reynard"], // 旧：姐夫
      ["npc-cecily", "npc-blanche"], // 旧：嫂子
      ["npc-cecily", "npc-reynard"], // 旧：姐夫
      ["npc-aldric", "npc-mathilde"], // 旧：嫂子
      ["npc-blanche", "npc-hugh"], // 旧：大伯子
      ["npc-blanche", "npc-mathilde"], // 旧：嫂子
      ["npc-godfrey", "npc-mathilde"], // 旧：嫂子
      ["npc-mathilde", "npc-aldric"], // 旧：大伯子
      ["npc-mathilde", "npc-godfrey"], // 旧：大伯子
      ["npc-reynard", "npc-aldric"], // 旧：姐夫
    ];
    for (const [from, to] of pairs) {
      expect(terms(from, to), `${from}→${to}`).toContain("姻亲");
    }

    // 第 12 条来自合成近亲婚配：x 的姐姐 y 的丈夫 a（a 同时是 x 的父亲）。
    // 旧库给「姐夫」，长幼与身份都不成立；新实现退「姻亲」但保留该读法。
    const incest = build({
      a: [
        ["b", "wife"],
        ["x", "son"],
        ["y", "daughter"],
        ["y", "wife"],
        ["z", "son"],
      ],
      b: [
        ["a", "husband"],
        ["a", "elder-brother"],
        ["x", "son"],
        ["y", "daughter"],
      ],
      x: [
        ["a", "father"],
        ["b", "mother"],
        ["z", "younger-brother"],
      ],
      y: [
        ["a", "father"],
        ["b", "mother"],
        ["a", "husband"],
        ["z", "son"],
      ],
      z: [
        ["a", "father"],
        ["y", "mother"],
        ["x", "elder-brother"],
      ],
    });
    const incestTerms = kinshipReadings(incest, "x", "a", { maxHops: 3 }).map((r) => r.term);
    expect(incestTerms).toContain("姻亲");
    expect(incestTerms).not.toContain("姐夫");
  });
});

describe("换库回归 · 长幼按边 kind 保留", () => {
  it("休→玛蒂尔达 有「小姑」（链里是 younger-sister，不是凭空长幼）", () => {
    // 爸爸的妹妹 = 小姑；旧库也给小姑，这条是「不能塌成中性姑姑」的证据。
    expect(terms("npc-hugh", "npc-mathilde")).toContain("小姑");
  });

  it("布兰奇→玛蒂尔达 有「外婆」", () => {
    // 两条妈妈路径的血亲读法；不能被 3 跳的「爸爸的妻子 ⇒ 继母」挤掉。
    expect(terms("npc-blanche", "npc-mathilde")).toContain("外婆");
  });
});
