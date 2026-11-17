/**
 * 称谓实现快照（**只读**，阶段二后不再需要旧库对照）。
 *
 * 跑法：`npx tsx extensions/family/scripts/audit-terms.ts`
 *
 * 输出：`extensions/family/scripts/terms-snapshot.md`。
 * 历史旧新对账结果冻结在 `terms-audit.md`（换库决策的唯一证据，本脚本不再写它）。
 *
 * 语料与一致性测试共用 `scripts/corpora.ts` —— 两边必须同一份数据，
 * 否则「快照里对得上」可能只是两边各用了一份不同的图。
 *
 * 快照口径：`kinshipTerm`（= `readings[0]`，maxHops 3）+ `kinshipReadings`
 * （maxHops 3，顺序 = 跳数 → tier → 精确词 → 称谓字典序）。
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCorpora } from "./corpora.js";
import { kinshipReadings, kinshipTerm, type RelationSignature } from "../src/terms/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

const corpora = buildCorpora();

const lines: string[] = [];
lines.push("# 称谓实现快照（新实现）");
lines.push("");
lines.push("语料：" + corpora.map((c) => c.name).join(" / ") + "。");
lines.push(
  "口径：`kinshipTerm`（= `readings[0]`，maxHops 3）+ `kinshipReadings`（maxHops 3，顺序 = 跳数 → tier → 精确词 → 称谓字典序）。",
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
      const primary = rs[0];
      const items = rs.map((r) => `${r.term}/${r.hops}/${r.signature?.tier ?? 1}`);
      lines.push(
        `| ${label} | ${t?.term ?? "∅"} | ${primary?.hops ?? ""} | ${primary?.signature?.tier ?? ""} | ${sigText(primary?.signature)} | ${items.join(" / ")} |`,
      );
    }
  }
  lines.push("");
}

const out = path.join(HERE, "terms-snapshot.md");
writeFileSync(out, lines.join("\n"), "utf8");
console.log(`写出 ${out}：${pairs} 对（可达 ${reachable}）`);
