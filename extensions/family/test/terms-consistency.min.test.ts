import { describe, expect, it } from "vitest";
import { buildCorpora } from "../scripts/corpora.js";
import { kinshipReadings, kinshipTerm, type KinshipReading } from "../src/terms/index.js";

/**
 * 一致性断言：`kinshipTerm(pair)` **必须**等于 `kinshipReadings(pair)[0].term`。
 *
 * 这两条 API 以前各走一套选择逻辑（一个只看最短移动路径、一个按排序取首项），
 * 同一个「她」在事实行和派生行会得到两个主称谓。现在 `kinshipTerm` 就是
 * `readings[0]`，本测试守住这条不变量 —— **不靠眼看，靠断言**。
 *
 * 语料与 `terms-snapshot.md` 共用 `scripts/corpora.ts`：快照里出现过的每一对都会在这里跑一遍。
 */

interface PairRun {
  readonly label: string;
  /** `kinshipTerm` 的结果；`null` = 不可达。 */
  readonly term: string | null;
  readonly readings: readonly KinshipReading[];
}

const RUNS: PairRun[] = [];
for (const corpus of buildCorpora()) {
  for (const from of corpus.ids) {
    for (const to of corpus.ids) {
      if (from === to) continue;
      RUNS.push({
        label: `${corpus.name} ${from}→${to}`,
        term: kinshipTerm(corpus.edges, from, to, { maxHops: 3 })?.term ?? null,
        readings: kinshipReadings(corpus.edges, from, to, { maxHops: 3 }),
      });
    }
  }
}

describe("称谓 API 一致性", () => {
  it(`快照语料全部 ${RUNS.length} 对：kinshipTerm === readings[0]`, () => {
    const mismatches: string[] = [];
    for (const run of RUNS) {
      if ((run.term === null) !== (run.readings.length === 0)) {
        mismatches.push(`${run.label}: term=${run.term ?? "null"} readings=${run.readings.length}`);
        continue;
      }
      if (run.term === null) continue;
      if (run.term !== run.readings[0]!.term) {
        mismatches.push(`${run.label}: term=${run.term} readings[0]=${run.readings[0]!.term}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("读法顺序：跳数升序；同跳数 tier 升序", () => {
    const bad: string[] = [];
    for (const run of RUNS) {
      for (let i = 1; i < run.readings.length; i++) {
        const a = run.readings[i - 1]!;
        const b = run.readings[i]!;
        const ta = a.signature?.tier ?? 1;
        const tb = b.signature?.tier ?? 1;
        if (a.hops > b.hops) {
          bad.push(`${run.label}: hops ${a.term}(${a.hops}) > ${b.term}(${b.hops})`);
        } else if (a.hops === b.hops && ta > tb) {
          bad.push(`${run.label}: tier ${a.term}(t${ta}) > ${b.term}(t${tb})`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("每条读法的 tier 都在 1..3（血亲 / 拟制 / 收养）", () => {
    const bad: string[] = [];
    for (const run of RUNS) {
      for (const r of run.readings) {
        const tier = r.signature?.tier;
        if (tier !== 1 && tier !== 2 && tier !== 3) {
          bad.push(`${run.label}: ${r.term} tier=${String(tier)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
