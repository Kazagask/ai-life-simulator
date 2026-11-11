import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const SRC_ROOT = path.resolve(path.dirname(SELF), "..");
const V2_DIR = path.join(SRC_ROOT, "v2");

/** 递归收集 game-core/src 下所有 .ts；排除本检查文件自身，避免禁用模式自命中。 */
function collectTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (abs === SELF) continue;
    if (statSync(abs).isDirectory()) out.push(...collectTs(abs));
    else if (entry.endsWith(".ts")) out.push(abs);
  }
  return out;
}

/** 递归收集运行时源码（排除测试夹具与检查文件自身）：专名扫描只针对生产代码。 */
function collectRuntimeTs(dir: string): string[] {
  return collectTs(dir).filter((f) => !f.endsWith(".test.ts"));
}

interface Forbidden {
  label: string;
  re: RegExp;
}

/** R-TM-03 禁止产物：阶段状态机相关的类型 / 符号 / 迁移函数。 */
const LIFECYCLE_FORBIDDEN: Forbidden[] = [
  { label: "Phase 类型声明/引用", re: /\b(?:type|interface|enum)\s+Phase\b|\bas\s+Phase\b|:\s*Phase\b|<Phase>|\bPhase\[\]/ },
  { label: "PhaseTransitionLog", re: /\bPhaseTransitionLog\b/ },
  { label: "LifecycleState", re: /\bLifecycleState\b/ },
  { label: "assertPhase()", re: /\bassertPhase\s*\(/ },
  { label: "transition(state, to: Phase) 形式导出", re: /\btransition\s*\([^)]*\bPhase\b/ },
];

/** R-EN-07 / P9：ending.ts 不得读取 HP 作为死亡/终止判据。 */
const HP_DEATH_FORBIDDEN: Forbidden[] = [
  { label: "读取 hp 属性（如 state.player.hp）", re: /\.hp\b/i },
  { label: "以 hp 数值作比较判据", re: /\bhp\b\s*(?:<=|>=|<|>|===|==|!=)/i },
  { label: "死亡/终止语境引用 hp", re: /(?:死亡|判死|terminat|death)[^\n]*\bhp\b|\bhp\b[^\n]*(?:死亡|判死|terminat|death)/i },
];

/** R-TM-03 / R-NFR-01：回放断言不得依赖任何阶段序列标识。 */
const PHASE_SEQUENCE_FORBIDDEN: Forbidden[] = [
  { label: "Phase", re: /\bPhase\b/ },
  { label: "PhaseTransitionLog", re: /\bPhaseTransitionLog\b/ },
  { label: "LifecycleState", re: /\bLifecycleState\b/ },
  { label: "assertPhase()", re: /\bassertPhase\s*\(/ },
  { label: "transition()", re: /\btransition\s*\(/ },
  { label: ".phase 访问", re: /\.phase\b/ },
];

/**
 * R-NFR-06 / R-NFR-05（协议 §1、§14）：game-core 不得把世界观专名写进引擎，
 * 显示名一律来自模板（statusBar / attributes.labels）。新增模板时按需扩充此表。
 */
const WORLD_NOUN_FORBIDDEN: Forbidden[] = [
  { label: "咒灵", re: /咒灵/ },
  { label: "咒力", re: /咒力/ },
  { label: "咒术", re: /咒术/ },
  { label: "五条", re: /五条/ },
  { label: "夏油", re: /夏油/ },
  { label: "高专", re: /高专/ },
];

function scan(files: string[], patterns: Forbidden[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const p of patterns) {
      if (p.re.test(src)) hits.push(`${file} → ${p.label}`);
    }
  }
  return hits;
}

describe("T2-03 · 静态边界检查（R-TM-03 / R-EN-07 / R-NFR-01）", () => {
  it("① game-core/src/v2/ 下不存在 lifecycle.ts，且 src 内无任何同名文件", () => {
    const exact = path.join(V2_DIR, "lifecycle.ts");
    const strays = collectTs(SRC_ROOT).filter((f) => path.basename(f).toLowerCase() === "lifecycle.ts");
    expect(strays, `发现违规的 lifecycle 文件：${strays.join(", ") || exact}`).toEqual([]);
    expect(existsSync(exact), `违规文件存在：${exact}`).toBe(false);
  });

  it("② game-core/src 内不存在 Phase / PhaseTransitionLog / LifecycleState / transition(state, to: Phase) / assertPhase", () => {
    const files = collectTs(SRC_ROOT);
    expect(files.length, `未收集到任何 .ts 源码，扫描失效（根目录 ${SRC_ROOT}）`).toBeGreaterThan(0);
    const hits = scan(files, LIFECYCLE_FORBIDDEN);
    expect(hits, `静态边界检查失败，违规位置：\n${hits.join("\n")}`).toEqual([]);
  });

  it("③ ending.ts 不读取 HP 作为死亡/终止判据", () => {
    const ending = path.join(V2_DIR, "ending.ts");
    expect(existsSync(ending), `缺少待检查文件：${ending}`).toBe(true);
    const hits = scan([ending], HP_DEATH_FORBIDDEN);
    expect(hits, `${ending} 违规读取 HP 作判据：\n${hits.join("\n")}`).toEqual([]);
  });

  it("④ 回放夹具与回放基线断言不依赖任何阶段序列", () => {
    const fixture = path.join(V2_DIR, "replay.ts");
    const baseline = path.join(V2_DIR, "replay.test.ts");
    for (const f of [fixture, baseline]) {
      expect(existsSync(f), `缺少待检查文件：${f}`).toBe(true);
    }
    const hits = scan([fixture, baseline], PHASE_SEQUENCE_FORBIDDEN);
    expect(hits, `回放断言引用了阶段序列标识：\n${hits.join("\n")}`).toEqual([]);
  });

  it("⑤ game-core 运行时源码不含世界观专名（显示名必须来自模板）", () => {
    const files = collectRuntimeTs(SRC_ROOT);
    expect(files.length, `未收集到运行时源码（根目录 ${SRC_ROOT}）`).toBeGreaterThan(0);
    const hits = scan(files, WORLD_NOUN_FORBIDDEN);
    expect(hits, `发现硬编码世界观专名，请改为读取模板 statusBar / attributes.labels：\n${hits.join("\n")}`).toEqual([]);
  });
});
