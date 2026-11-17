/**
 * 称谓实现快照（**只读**，阶段二后不再需要旧库对照）。
 *
 * 跑法：`npx tsx extensions/family/scripts/audit-terms.ts`
 *
 * 输出：`extensions/family/scripts/terms-snapshot.md`。
 * 历史旧新对账结果冻结在 `terms-audit.md`（换库决策的唯一证据，本脚本不再写它）。
 *
 * 语料：
 * 1. `valmont` 模板：12 个 NPC 的 `characters.yaml` 关系，加上开册事件补的玩家 → 父母两条边；
 * 2. 合成家族：三代直系、半血缘、继亲、多配偶、近亲婚配。
 *
 * 快照口径：`kinshipTerm`（maxHops 3）+ `kinshipReadings`（maxHops 3，已按
 * tier → 跳数 → 称谓字典序）。同输入必然同输出，可用来锁行为。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { KinshipKind, RelationEdge } from "../../../packages/shared/src/index.js";
import { kinshipReadings, kinshipTerm, type RelationSignature } from "../src/terms/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VALMONT = path.resolve(HERE, "../../../specs/data/templates/valmont/1.0.0");

function edge(from: string, to: string, kind: KinshipKind): RelationEdge {
  return { from, to, kind, source: "template", visibility: "known", value: 0 };
}

// ---------------- 语料 1：valmont ----------------

interface CharacterDoc {
  characters: {
    id: string;
    identity: { name: string };
    relations?: { to: string; kind: string; visibility?: string }[];
  }[];
}

interface Corpus {
  readonly name: string;
  readonly edges: RelationEdge[];
  readonly names: Map<string, string>;
  readonly ids: string[];
}

function valmontGraph(): Corpus {
  const doc = parse(readFileSync(path.join(VALMONT, "characters.yaml"), "utf8")) as CharacterDoc;
  const edges: RelationEdge[] = [];
  const names = new Map<string, string>();
  const ids: string[] = [];
  for (const c of doc.characters) {
    names.set(c.id, c.identity.name);
    ids.push(c.id);
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
  // 开册事件（opening 的 evt:open）补的玩家出边。
  names.set("player", "罗兰");
  ids.push("player");
  edges.push(edge("player", "npc-reynard", "father"));
  edges.push(edge("player", "npc-blanche", "mother"));
  return { name: "valmont", edges, names, ids };
}

// ---------------- 语料 2：合成家族 ----------------

function synth(name: string): Corpus {
  const spec: Record<string, Array<[string, KinshipKind]>> = {};
  const names = new Map<string, string>();
  const ids: string[] = [];

  const add = (from: string, to: string, kind: KinshipKind) => {
    (spec[from] ??= []).push([to, kind]);
  };
  const sexOf = new Map<string, "male" | "female">();
  const person = (id: string, label: string, sex: "male" | "female") => {
    ids.push(id);
    names.set(id, label);
    sexOf.set(id, sex);
  };
  /** 双向婚配：kind 取**对方**的性别（`{from:A,to:B,kind:wife}` 读作「B 是 A 的妻子」）。 */
  const marry = (a: string, b: string) => {
    add(a, b, sexOf.get(b) === "female" ? "wife" : "husband");
    add(b, a, sexOf.get(a) === "female" ? "wife" : "husband");
  };
  /** 双向亲子边（父/母 + 子/女）。`parentSex` 是**亲代**的性别，不能拿子女性别代替。 */
  const child = (
    parent: string,
    kid: string,
    sex: "son" | "daughter",
    parentSex: "father" | "mother",
  ) => {
    add(parent, kid, sex);
    add(kid, parent, parentSex);
  };

  if (name === "三代直系") {
    // 曾祖父母 → 祖父母 → 父母 → 我
    person("ggf", "ggf", "male");
    person("ggm", "ggm", "female");
    person("gf", "gf", "male");
    person("gm", "gm", "female");
    person("f", "f", "male");
    person("m", "m", "female");
    person("me", "me", "male");
    marry("ggf", "ggm");
    child("ggf", "gf", "son", "father");
    child("ggm", "gf", "son", "mother");
    marry("gf", "gm");
    child("gf", "f", "son", "father");
    child("gm", "f", "son", "mother");
    marry("f", "m");
    child("f", "me", "son", "father");
    child("m", "me", "son", "mother");
  } else if (name === "半血缘") {
    // f1 与 m1 生 a、b；f1 与 m2 生 c；m2 与前夫生 d。
    person("f1", "f1", "male");
    person("m1", "m1", "female");
    person("m2", "m2", "female");
    person("a", "a", "male");
    person("b", "b", "female");
    person("c", "c", "male");
    person("d", "d", "female");
    marry("f1", "m1");
    marry("f1", "m2");
    child("f1", "a", "son", "father");
    child("m1", "a", "son", "mother");
    child("f1", "b", "daughter", "father");
    child("m1", "b", "daughter", "mother");
    child("f1", "c", "son", "father");
    child("m2", "c", "son", "mother");
    child("m2", "d", "daughter", "mother");
    add("a", "b", "elder-sister"); // b 是 a 的妹妹
    add("b", "a", "elder-brother");
    add("a", "c", "younger-brother"); // c 是 a 的弟弟（同父异母）
    add("c", "a", "elder-brother");
    add("c", "d", "elder-sister"); // d 是 c 的同母姐姐（与 a/b 无血缘）
    add("d", "c", "younger-brother");
  } else if (name === "继亲") {
    // a 与 b 生 x；a 续娶 c（c 带来 y）；b 改嫁 d。
    person("a", "a", "male");
    person("b", "b", "female");
    person("c", "c", "female");
    person("d", "d", "male");
    person("x", "x", "male");
    person("y", "y", "female");
    marry("a", "b");
    child("a", "x", "son", "father");
    child("b", "x", "son", "mother");
    marry("a", "c");
    child("c", "y", "daughter", "mother");
    marry("b", "d");
  } else if (name === "多配偶") {
    // h 娶 w1、w2、w3；三房子女 s1/s2/s3。
    person("h", "h", "male");
    person("w1", "w1", "female");
    person("w2", "w2", "female");
    person("w3", "w3", "female");
    person("s1", "s1", "male");
    person("s2", "s2", "female");
    person("s3", "s3", "male");
    marry("h", "w1");
    marry("h", "w2");
    marry("h", "w3");
    child("h", "s1", "son", "father");
    child("w1", "s1", "son", "mother");
    child("h", "s2", "daughter", "father");
    child("w2", "s2", "daughter", "mother");
    child("h", "s3", "son", "father");
    child("w3", "s3", "son", "mother");
    add("s1", "s2", "younger-sister");
    add("s2", "s1", "elder-brother");
    add("s2", "s3", "younger-brother");
    add("s3", "s2", "elder-sister");
  } else if (name === "近亲婚配") {
    // 兄妹婚 a×b → x、y；父女婚 a×y → z。
    person("a", "a", "male");
    person("b", "b", "female");
    person("x", "x", "male");
    person("y", "y", "female");
    person("z", "z", "male");
    child("a", "x", "son", "father");
    child("b", "x", "son", "mother");
    child("a", "y", "daughter", "father");
    child("b", "y", "daughter", "mother");
    add("a", "b", "younger-sister");
    add("b", "a", "elder-brother");
    marry("a", "b");
    marry("a", "y"); // 父女婚
    child("a", "z", "son", "father");
    child("y", "z", "son", "mother");
    add("x", "z", "younger-brother");
    add("z", "x", "elder-brother");
  } else {
    throw new Error(`未知语料 ${name}`);
  }

  const edges: RelationEdge[] = [];
  for (const [from, rels] of Object.entries(spec)) {
    for (const [to, kind] of rels) edges.push(edge(from, to, kind));
  }
  return { name, edges, names, ids };
}

// ---------------- 快照 ----------------

function sigText(sig: RelationSignature | undefined): string {
  if (sig === undefined) return "";
  const atoms = sig.pattern
    .map((a) => {
      const s = a.sex === "male" ? "M" : "F";
      const sen = a.seniority === "elder" ? "+" : a.seniority === "younger" ? "-" : "";
      const inf = a.inferred ? "~" : "";
      return `${a.role[0]!.toUpperCase()}${s}${sen}${inf}`;
    })
    .join(",");
  return `t${sig.tier} ${atoms}${sig.stepKind !== null ? ` step:${sig.stepKind}` : ""}`;
}

const corpora: Corpus[] = [
  valmontGraph(),
  synth("三代直系"),
  synth("半血缘"),
  synth("继亲"),
  synth("多配偶"),
  synth("近亲婚配"),
];

const lines: string[] = [];
lines.push("# 称谓实现快照（新实现）");
lines.push("");
lines.push("语料：" + corpora.map((c) => c.name).join(" / ") + "。");
lines.push(
  "口径：`kinshipTerm`（maxHops 3）+ `kinshipReadings`（maxHops 3，顺序 = tier → 跳数 → 称谓字典序）。",
);
lines.push("历史旧新对账见 `terms-audit.md`（已冻结）；本文件由 `scripts/audit-terms.ts` 生成，可用来锁行为。");
lines.push("");

let pairs = 0;
let reachable = 0;
for (const corpus of corpora) {
  lines.push(`## ${corpus.name}`);
  lines.push("");
  lines.push("| 对 | 主称谓 | 跳数 | tier | 签名 | 全部读法（称谓/跳数/层） |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const from of corpus.ids) {
    for (const to of corpus.ids) {
      if (from === to) continue;
      pairs++;
      const label = `${corpus.names.get(from) ?? from}→${corpus.names.get(to) ?? to}`;
      const t = kinshipTerm(corpus.edges, from, to, { maxHops: 3 });
      const rs = kinshipReadings(corpus.edges, from, to, { maxHops: 3 });
      if (t !== null) reachable++;
      const primary = rs.find((r) => r.term === t?.term);
      const hops = t === null ? "" : String(t.tokens.length);
      // 直接配偶的主称谓是「事实行本身」，`kinshipReadings` 有意不产出它 —— 快照里补一条标注。
      const tier =
        primary?.signature?.tier ??
        (t === null
          ? ""
          : t.tokens.some((x) => x === "丈夫" || x === "妻子")
            ? 2
            : 1);
      const items = rs.map((r) => `${r.term}/${r.hops}/${r.signature?.tier ?? 1}`);
      if (t !== null && primary === undefined) items.unshift(`${t.term}/${hops}/${tier}（事实行）`);
      lines.push(
        `| ${label} | ${t?.term ?? "∅"} | ${hops} | ${tier} | ${sigText(primary?.signature)} | ${items.join(" / ")} |`,
      );
    }
  }
  lines.push("");
}

const out = path.join(HERE, "terms-snapshot.md");
writeFileSync(out, lines.join("\n"), "utf8");
console.log(`写出 ${out}：${pairs} 对（可达 ${reachable}）`);
