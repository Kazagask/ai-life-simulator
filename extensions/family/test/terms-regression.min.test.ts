import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { KinshipKind, RelationEdge } from "@life-sim/shared";
import { kinshipReadings, kinshipTerm } from "../src/terms/index.js";

/**
 * 换库回归：这 7 组断言是 `terms-audit.md`（682/692 行对账）里挑出来的**代表性修正**。
 *
 * 旧实现 `relationship.js` 已删除；这些用例锁住「换库到底换掉了什么」，
 * 防止以后有人把库的错误假设（父之妻=母、妻之子=子、配偶的配偶=自己、凭空给长幼）
 * 又写回来。注释里的「旧」都是 `terms-audit.md` 的实测输出。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VALMONT = path.resolve(HERE, "../../../specs/data/templates/valmont/1.0.0");

/** 与 `scripts/audit-terms.ts` 同一口径：角色边 + 开册事件补的玩家 → 父母两条边。 */
function valmontEdges(): RelationEdge[] {
  const doc = parse(readFileSync(path.join(VALMONT, "characters.yaml"), "utf8")) as {
    characters: {
      id: string;
      relations?: { to: string; kind: string; visibility?: string }[];
    }[];
  };
  const edges: RelationEdge[] = [];
  for (const c of doc.characters) {
    for (const rel of c.relations ?? []) {
      edges.push({
        from: c.id,
        to: rel.to,
        kind: rel.kind as KinshipKind,
        source: "template",
        visibility: (rel.visibility as RelationEdge["visibility"] | undefined) ?? "known",
        value: 0,
      });
    }
  }
  edges.push({ from: "player", to: "npc-reynard", kind: "father", source: "template", visibility: "known" });
  edges.push({ from: "player", to: "npc-blanche", kind: "mother", source: "template", visibility: "known" });
  return edges;
}

const E = valmontEdges();
const term = (from: string, to: string) => kinshipTerm(E, from, to, { maxHops: 3 })?.term;
const readings = (from: string, to: string) => kinshipReadings(E, from, to, { maxHops: 3 });
const terms = (from: string, to: string) => readings(from, to).map((r) => r.term);

function build(spec: Record<string, Array<[string, KinshipKind]>>): RelationEdge[] {
  const out: RelationEdge[] = [];
  for (const [from, rels] of Object.entries(spec)) {
    for (const [to, kind] of rels) {
      out.push({ from, to, kind, source: "template", visibility: "known", value: 0 });
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
