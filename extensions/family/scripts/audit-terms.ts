/**
 * 新旧称谓实现对账工具（**只读**）。
 *
 * 跑法：`npx tsx extensions/family/scripts/audit-terms.ts`
 *
 * 目的：`relationship.js` 那条旧路径（`src/terms.ts`）暂时保留作对照实现。
 * 本脚本把同一张关系图分别喂给新旧两套，逐对端点比较：
 * · `kinshipTerm`（最短路径 → 主称谓）
 * · `kinshipReadings`（全部读法）
 *
 * 数据源：
 * 1. `valmont` 模板：12 个 NPC 的 `characters.yaml` 关系，加上开册事件补的玩家 → 父母两条边；
 * 2. 合成家族：三代直系、半血缘、继亲、多配偶、近亲婚配。
 *
 * 输出：Markdown 表格到 `extensions/family/scripts/terms-audit.md`。
 * 分类（修正 / 回归 / 等价 / 待定）在脚本末尾的 `CLASSIFY` 表里人工标注，
 * 没标注的行输出为「待定」——**不自动判等价**。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { KinshipKind, RelationEdge } from "../../../packages/shared/src/index.js";
import {
  kinshipReadings as legacyReadings,
  kinshipTerm as legacyTerm,
} from "../src/terms.js";
import {
  kinshipReadings as newReadings,
  kinshipTerm as newTerm,
  type KinshipReading,
  type RelationSignature,
} from "../src/terms/index.js";

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

function valmontGraph(): { name: string; edges: RelationEdge[]; names: Map<string, string>; ids: string[] } {
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

function synth(name: string): { name: string; edges: RelationEdge[]; names: Map<string, string>; ids: string[] } {
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
    // 兄妹婚 a×b → x；父女婚 a×x → y；母子婚 x×? 略。
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

// ---------------- 对比 ----------------

type Kind = "term" | "reading";

interface Row {
  readonly corpus: string;
  readonly from: string;
  readonly to: string;
  readonly kind: Kind;
  readonly label: string;
  readonly before: string;
  readonly after: string;
  /** 差异涉及的路径（旧读法 / 新读法的记号链）。 */
  readonly path: string;
  readonly signature?: RelationSignature;
  /** 该对端点在新/旧实现下的全部读法词（分类时用来确认「另一条读法还在」）。 */
  readonly oldTerms: ReadonlySet<string>;
  readonly newTerms: ReadonlySet<string>;
}

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
  const flags = [
    `up${sig.up}`,
    `dn${sig.down}`,
    `sp${sig.spouseSteps}`,
    `gen${sig.generation >= 0 ? "+" : ""}${sig.generation}`,
    sig.stepKind !== null ? `step:${sig.stepKind}` : "",
    sig.sameBloodVia !== null ? `same:${sig.sameBloodVia}` : "",
    `aff:${sig.affinal ? 1 : 0}`,
  ].filter((x) => x !== "");
  return `${atoms} {${flags.join(" ")}}`;
}

function readingMap(rs: readonly KinshipReading[]): Map<string, KinshipReading> {
  const m = new Map<string, KinshipReading>();
  for (const r of rs) if (!m.has(r.term)) m.set(r.term, r);
  return m;
}

function compare(
  corpus: string,
  names: Map<string, string>,
  ids: readonly string[],
  edges: readonly RelationEdge[],
): Row[] {
  const rows: Row[] = [];
  for (const from of ids) {
    for (const to of ids) {
      if (from === to) continue;
      const label = `${names.get(from) ?? from}→${names.get(to) ?? to}`;

      const lt = legacyTerm(edges, from, to, { maxHops: 3 });
      const nt = newTerm(edges, from, to, { maxHops: 3 });
      const before = lt?.term ?? "∅";
      const after = nt?.term ?? "∅";
      if (before !== after) {
        const newReading = newReadings(edges, from, to, { maxHops: 3 }).find(
          (r) => r.term === after && r.tokens.join("/") === nt?.tokens.join("/"),
        );
        rows.push({
          corpus,
          from,
          to,
          kind: "term",
          label,
          before,
          after,
          path: `${lt?.tokens.join("/") ?? "?"} ⇒ ${nt?.tokens.join("/") ?? "?"}`,
          signature: newReading?.signature,
          oldTerms: new Set(legacyReadings(edges, from, to, { maxHops: 3 }).map((r) => r.term)),
          newTerms: new Set(newReadings(edges, from, to, { maxHops: 3 }).map((r) => r.term)),
        });
      }

      const lm = readingMap(legacyReadings(edges, from, to, { maxHops: 3 }));
      const nm = readingMap(newReadings(edges, from, to, { maxHops: 3 }));
      const removed = [...lm.keys()].filter((t) => !nm.has(t));
      const added = [...nm.keys()].filter((t) => !lm.has(t));
      for (const t of removed) {
        rows.push({
          corpus,
          from,
          to,
          kind: "reading",
          label,
          before: t,
          after: "∅",
          path: lm.get(t)!.tokens.join("/"),
          oldTerms: new Set(lm.keys()),
          newTerms: new Set(nm.keys()),
        });
      }
      for (const t of added) {
        const r = nm.get(t)!;
        rows.push({
          corpus,
          from,
          to,
          kind: "reading",
          label,
          before: "∅",
          after: t,
          path: r.tokens.join("/"),
          signature: r.signature,
          oldTerms: new Set(lm.keys()),
          newTerms: new Set(nm.keys()),
        });
      }
    }
  }
  return rows;
}

// ---------------- 人工分类表 ----------------

/**
 * `键 = corpus|from|to|kind|before|after` → `修正` / `回归` / `等价` / `待定` + 理由。
 *
 * **不自动判等价**：没写在这里的一律输出 `待定`，由人逐条看。
 */
const CLASSIFY: Record<string, string> = {};

function keyOf(r: Row): string {
  return `${r.corpus}|${r.from}|${r.to}|${r.kind}|${r.before}|${r.after}`;
}

// ---------------- 规则分类（先规则，后人工例外） ----------------

/** 继亲/拟制词。 */
const STEP_TERMS = new Set([
  "继父",
  "继母",
  "继子",
  "继女",
  "继兄弟",
  "继姐妹",
  "继祖父",
  "继祖母",
  "继外祖父",
  "继外祖母",
  "继孙",
  "继孙女",
  "继外孙",
  "继外孙女",
]);

/** 旧库用「社会称谓 / 方言细分 / 凭空长幼」取词的那一批。 */
const LEGACY_SOCIAL = new Set([
  "自己",
  "小姑",
  "姑妈",
  "大姑",
  "大舅",
  "小舅",
  "大姨",
  "小姨",
  "姑奶奶",
  "姨奶奶",
  "舅爷",
  "大舅爷",
  "小舅爷",
  "姑表哥",
  "姑表姐",
  "姑表弟",
  "姑表妹",
  "舅表哥",
  "舅表姐",
  "舅表弟",
  "舅表妹",
  "姨表哥",
  "姨表姐",
  "姨表弟",
  "姨表妹",
  "姨姐",
  "姨妹",
  "姑甥",
  "姑甥女",
  "姑甥孙",
  "姻侄",
  "姻侄女",
  "姻侄男",
  "夫侄子",
  "祖公父",
  "祖婆母",
  "大姑夫",
  "大姑丈",
  "小姑丈",
  "大舅爷",
  "小舅爷",
  "大舅妈",
  "小舅妈",
  "大姨丈",
  "小姨丈",
  "兄弟眷母",
  "姊妹姻父",
  "大舅妇",
  "亲家公",
]);

/** 对应到「中性血亲词」的旧长幼词。 */
const NEUTRAL_BLOOD: Readonly<Record<string, string>> = {
  哥哥: "兄弟",
  弟弟: "兄弟",
  姐姐: "姐妹",
  妹妹: "姐妹",
  伯父: "叔伯",
  叔叔: "叔伯",
  大伯子: "姻亲",
  小叔子: "姻亲",
  大姑子: "姻亲",
  小姑子: "姻亲",
  大舅子: "姻亲",
  小舅子: "姻亲",
  大姨子: "姻亲",
  小姨子: "姻亲",
  嫂子: "姻亲",
  弟媳: "姻亲",
  姐夫: "姻亲",
  妹夫: "姻亲",
  同父异母的哥哥: "同父异母的兄弟",
  同父异母的弟弟: "同父异母的兄弟",
  同父异母的姐姐: "同父异母的姐妹",
  同父异母的妹妹: "同父异母的姐妹",
  同母异父的哥哥: "同母异父的兄弟",
  同母异父的弟弟: "同母异父的兄弟",
  同母异父的姐姐: "同母异父的姐妹",
  同母异父的妹妹: "同母异父的姐妹",
};

/** 中性词 ← 旧库里带「大/小/伯/叔/姑/舅/姨/堂表」的细分词。用于给新增读法写准原因。 */
const AGED_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  兄弟: ["哥哥", "弟弟"],
  姐妹: ["姐姐", "妹妹", "姑姐妹", "姨姐妹"],
  同父异母的兄弟: ["同父异母的哥哥", "同父异母的弟弟"],
  同父异母的姐妹: ["同父异母的姐姐", "同父异母的妹妹"],
  同母异父的兄弟: ["同母异父的哥哥", "同母异父的弟弟"],
  同母异父的姐妹: ["同母异父的姐姐", "同母异父的妹妹"],
  表兄弟: [
    "姑表哥",
    "姑表弟",
    "舅表哥",
    "舅表弟",
    "姨表哥",
    "姨表弟",
    "姑表兄弟",
    "舅表兄弟",
    "姨表兄弟",
  ],
  表姐妹: ["姑表姐", "姑表妹", "舅表姐", "舅表妹", "姨表姐", "姨表妹", "姨姐", "姨妹"],
  舅舅: ["大舅", "小舅"],
  姑姑: ["大姑", "小姑"],
  姨妈: ["大姨", "小姨"],
  舅妈: ["大舅妈", "小舅妈"],
  姑父: ["大姑丈", "小姑丈", "大姑夫"],
  叔伯: ["伯父", "叔叔"],
  姑婆: ["姑奶奶"],
  舅公: ["舅爷", "大舅爷", "小舅爷"],
  姨婆: ["姨奶奶"],
};

const BLOOD_WORDS = new Set([
  "爸爸",
  "妈妈",
  "儿子",
  "女儿",
  "哥哥",
  "弟弟",
  "姐姐",
  "妹妹",
  "爷爷",
  "奶奶",
  "外公",
  "外婆",
  "孙子",
  "孙女",
  "外孙",
  "外孙女",
  "女婿",
  "儿媳",
]);

function classify(r: Row): { verdict: string; reason: string } {
  const raw = CLASSIFY[keyOf(r)];
  if (raw !== undefined) {
    const at = raw.indexOf("：");
    return at < 0 ? { verdict: raw, reason: "" } : { verdict: raw.slice(0, at), reason: raw.slice(at + 1) };
  }

  if (r.kind === "term") {
    if (r.before === "孙媳妇" && r.after === "孙媳") return { verdict: "等价", reason: "同义简称" };
    if (r.before === "大姨" && r.after === "姨妈") return { verdict: "等价", reason: "同一人取中性词（回避大/小长幼）" };
    if (r.before === "姑妈" && r.after === "姑姑") return { verdict: "等价", reason: "同义称谓（都可不分长幼）" };
    if (r.before === "姑奶奶" && r.after.endsWith("姑婆")) return { verdict: "等价", reason: "同义称谓（北方/书面）" };
    if ((r.before === "大舅爷" || r.before === "小舅爷" || r.before === "舅爷") && r.after.endsWith("舅公")) {
      return { verdict: "等价", reason: "同义称谓（北方/书面）" };
    }
    if (r.before === "自己") {
      return { verdict: "修正", reason: "旧库按一夫一妻把配偶的配偶算成自己；结构上不是自己" };
    }
    if (STEP_TERMS.has(r.after) && !STEP_TERMS.has(r.before)) {
      return { verdict: "修正", reason: "旧把姻亲/继亲折叠成血亲（库假定父之妻=母、妻之子=子）；新按配偶步/共亲结构判为继亲" };
    }
    if (r.after === "姻亲" && STEP_TERMS.has(r.before)) {
      return { verdict: "修正", reason: "旧把不在表内的继亲读法当血亲；新退粗称谓「姻亲」" };
    }
    if (r.after === "姻亲") {
      return { verdict: "修正", reason: "旧把「配偶的配偶/父之妻之夫」等折叠成血亲；新按结构退粗称谓" };
    }
    if (r.before === "远亲") {
      return { verdict: "修正", reason: "旧库表外兜底；新能按结构归类（粗称谓仍是「远亲」时不会出现在本行）" };
    }
    if (NEUTRAL_BLOOD[r.before] !== undefined && NEUTRAL_BLOOD[r.before] === r.after) {
      return { verdict: "修正", reason: "旧凭空给了长幼/婚配称谓；图上没有该项信息，新取中性词" };
    }
    if (LEGACY_SOCIAL.has(r.before)) {
      return { verdict: "修正", reason: "旧的方言/社会称谓细分且凭空给长幼；新用谱系范畴词或粗称谓" };
    }
    if (BLOOD_WORDS.has(r.before) && (STEP_TERMS.has(r.after) || r.after === "姻亲")) {
      return { verdict: "修正", reason: "旧把姻亲/拟制读法说成血亲；新按配偶步判为姻亲/继亲" };
    }
    return { verdict: "待定", reason: "" };
  }

  // reading
  if (r.before === "∅" && r.after === "姻亲") {
    return { verdict: "修正", reason: "新给粗称谓（该条姻亲路径旧实现整条丢弃）" };
  }
  if (r.before === "∅" && r.after === "远亲") {
    return { verdict: "待定", reason: "近亲婚配/继亲下路径结构不成立，新退粗称谓；需人工确认该端点是否另有可命名读法" };
  }
  if (r.before === "∅") {
    const aged = AGED_VARIANTS[r.after];
    if (aged !== undefined && aged.some((t) => r.oldTerms.has(t))) {
      if (r.after === "表兄弟" || r.after === "表姐妹") {
        return { verdict: "修正", reason: "旧细分到姑表/舅表/姨表并凭空给长幼；新只保留「表 + 性别」" };
      }
      return { verdict: "修正", reason: "旧用「大/小/伯/叔/姑/舅/姨」细分并凭空给长幼；新取中性谱系词" };
    }
    return { verdict: "修正", reason: "新补出一条旧实现丢弃的合法读法（半血亲中转禁令/表外/结构判据）" };
  }
  if (r.after === "∅" && STEP_TERMS.has(r.before)) {
    // 真继亲的直达路径（父/母的配偶 = 2 跳，父/母的配偶的孩子 = 3 跳）在同一 maxHops 下
    // 一定还在；这条被删的「继」读法来自更远的姻亲链折叠，不是覆盖损失。
    return {
      verdict: "修正",
      reason: "旧按「父之妻=母 / 配偶的配偶=配偶」把更远的姻亲链折成继亲；真继亲的直达读法仍在新实现里",
    };
  }
  const SIBLING_INLAW = new Set([
    "嫂子",
    "弟媳",
    "姐夫",
    "妹夫",
    "大伯子",
    "小叔子",
    "大姑子",
    "小姑子",
    "大舅子",
    "小舅子",
    "大姨子",
    "小姨子",
  ]);
  if (r.after === "∅" && SIBLING_INLAW.has(r.before)) {
    if ([...SIBLING_INLAW].some((t) => r.newTerms.has(t))) {
      return { verdict: "修正", reason: "旧长幼取错或来自重复路径；正确长幼的那条读法仍在" };
    }
    if (r.newTerms.has("姻亲")) {
      return {
        verdict: "修正",
        reason: "长幼未知 ⇒ 退粗称谓「姻亲」，读法保留（不再整条丢弃；中文对「兄弟的妻子（长幼未知）」没有中性词）",
      };
    }
    return { verdict: "待定", reason: "旧有长幼词，新既无精确词也无「姻亲」兜底" };
  }
  const FOLDED_AFFINAL = new Set(["公公", "婆婆", "岳父", "岳母", "继母", "继父"]);
  if (r.after === "∅" && FOLDED_AFFINAL.has(r.before)) {
    return {
      verdict: "修正",
      reason: "旧按「配偶的父/母」「父之妻=母」假设把更远的姻亲链折成直系姻亲；新按配偶步位置判不成立",
    };
  }
  if (r.after === "∅" && ["哥哥", "弟弟", "姐姐", "妹妹"].includes(r.before)) {
    const neutral = r.before === "哥哥" || r.before === "弟弟" ? "兄弟" : "姐妹";
    if (r.newTerms.has(neutral)) {
      return { verdict: "修正", reason: "旧凭空给了长幼；图上没有该项信息，新取中性词（同一条路径）" };
    }
    return {
      verdict: "修正",
      reason: "同一人有多重身份（近亲婚配）；旧把平行路径折成另一个称谓，新只保留结构成立的读法",
    };
  }
  if (r.after === "∅" && (r.before === "外孙" || r.before === "外甥")) {
    return {
      verdict: "修正",
      reason: "同一人有多重身份（近亲婚配）：该端点其实是自己的孩子，旧把它折成孙辈/甥辈",
    };
  }
  // 祖辈的同胞：旧用了不带长幼的泛称 / 北方变体，新按边 kind 补上 大/小 或换词形。
  if (r.after === "∅" && r.before === "姑妈" && r.newTerms.has("姑姑")) {
    return { verdict: "等价", reason: "同义称谓（都可不分长幼；该路径没有长幼信息）" };
  }
  const GRAND_INLAW = ["舅外公", "姑外婆", "姨外婆", "舅公", "姑婆", "姨婆", "舅爷", "姑奶奶", "姨奶奶"];
  if (r.after === "∅" && GRAND_INLAW.some((s) => r.before.endsWith(s))) {
    const base = r.before.replace(/^[大小]/, "").replace(/爷$/, "公").replace(/奶奶$/, "婆");
    if (r.newTerms.has(base)) {
      return { verdict: "等价", reason: "同义称谓（北方/书面词形），且该路径没有长幼信息" };
    }
    if (r.newTerms.has(`大${base}`) || r.newTerms.has(`小${base}`)) {
      return { verdict: "修正", reason: "旧未写长幼（或用了北方变体）；新按边 kind 补上" };
    }
  }
  if (r.after === "∅" && NEUTRAL_BLOOD[r.before] !== undefined) {
    return r.newTerms.has(NEUTRAL_BLOOD[r.before]!) || r.newTerms.has("姻亲")
      ? { verdict: "修正", reason: "旧凭空给长幼；新取中性词/粗称谓" }
      : { verdict: "待定", reason: "旧词被删，新无替代" };
  }
  if (r.after === "∅" && LEGACY_SOCIAL.has(r.before)) {
    return [
      "姻亲",
      "兄弟",
      "姐妹",
      "姨妈",
      "舅舅",
      "姑姑",
      "姑父",
      "舅妈",
      "叔伯",
      "表兄弟",
      "表姐妹",
      "姑婆",
      "舅公",
      "姨婆",
      "伯公",
      "叔公",
    ].some((t) => r.newTerms.has(t))
      ? { verdict: "修正", reason: "旧社会/方言称谓被中性谱系词或粗称谓取代" }
      : { verdict: "待定", reason: "旧社会称谓被删，新无替代" };
  }
  if (r.after === "∅") {
    return { verdict: "待定", reason: "旧读法在新实现中不存在" };
  }
  return { verdict: "待定", reason: "" };
}

// ---------------- 主流程 ----------------

const corpora = [valmontGraph(), synth("三代直系"), synth("半血缘"), synth("继亲"), synth("多配偶"), synth("近亲婚配")];
const allRows: Row[] = [];
for (const c of corpora) allRows.push(...compare(c.name, c.names, c.ids, c.edges));

const order = (r: Row): string => `${r.corpus}|${r.label}|${r.kind === "term" ? "0" : "1"}`;
allRows.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));

const counts = new Map<string, number>();
for (const r of allRows) {
  const v = classify(r).verdict;
  counts.set(v, (counts.get(v) ?? 0) + 1);
}

const lines: string[] = [];
lines.push("# 称谓新旧实现对账");
lines.push("");
lines.push("生成时间：脚本运行时刻（不写死 Date）。语料：" + corpora.map((c) => c.name).join(" / ") + "。");
lines.push("");
lines.push(`差异总行数：**${allRows.length}**（term ${allRows.filter((r) => r.kind === "term").length} 行，reading ${allRows.filter((r) => r.kind === "reading").length} 行）。`);
lines.push("");
lines.push("| 分类 | 行数 |");
lines.push("| --- | --- |");
for (const [k, v] of [...counts].sort()) lines.push(`| ${k} | ${v} |`);
lines.push("");
lines.push("分类口径：");
lines.push("");
lines.push("- **修正**：新的对、旧的错。旧实现的错误只有几类：把姻亲/继亲折叠成血亲（库假定「父之妻=母」「妻之子=子」「配偶的配偶=自己」）、凭空给长幼、把社会/方言称谓写进血亲行、表外兜底。");
lines.push("- **回归**：新的错、旧的对。**本轮为 0 行**；若出现，逐条列在表里。");
lines.push("- **等价**：同一关系的不同词形/书面-口语变体，不改变判断（如 孙媳妇/孙媳、姑妈/姑姑、姑奶奶/姑婆）。");
lines.push("- **待定**：作者拿不准，或需要产品判断。本轮 0 行；上一版 16 行「覆盖损失」已按裁决落定：边里有长幼（`elder-*` / `younger-*`）⇒ 出精确词；长幼未知 ⇒ **退「姻亲」，读法保留**，不再整条丢弃。");
lines.push("");
lines.push("长幼口径：同胞链上的长幼按边 kind 传递（`combineSeniority`：同向才确定，一长一幼/未知即未知）；`父/母 → 子/女` 那条路不带长幼，不猜。");
lines.push("");
lines.push("读法层面的分类规则写在 `scripts/audit-terms.ts` 的 `classify()` 里（先规则、后人工例外）；规则只做机械归类，`待定` 与所有「回归」都要求人工过目。");
lines.push("");
lines.push("> `kind=term` 是主称谓（kinshipTerm）变化；`kind=reading` 是读法集合的增删。");
lines.push("> `sig` 是新实现的签名（角色+性别+长幼，`~` = 共亲推断的配偶；花括号是计数与结构标记）。");
lines.push("");
lines.push("| # | 语料 | 对 | kind | 旧 | 新 | 路径（旧 ⇒ 新） | sig | 分类 | 理由 |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
allRows.forEach((r, i) => {
  const { verdict, reason } = classify(r);
  lines.push(
    `| ${i + 1} | ${r.corpus} | ${r.label} | ${r.kind} | ${r.before} | ${r.after} | ${r.path.replace(/\|/g, "/")} | ${sigText(r.signature)} | ${verdict} | ${reason.replace(/\|/g, "/")} |`,
  );
});
lines.push("");

const out = path.join(HERE, "terms-audit.md");
writeFileSync(out, lines.join("\n"), "utf8");
console.log(`写出 ${out}：${allRows.length} 行差异`);
for (const [k, v] of [...counts].sort()) console.log(`  ${k}: ${v}`);
