import { describe, expect, it } from "vitest";
import { advanceTurnV2, createWorldV2, type WorldStateV2 } from "@life-sim/game-core";
import { WorldTemplateV2Schema } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silent = { warn: () => {}, error: () => {}, info: () => {} };
const DAY = 1440;

function loadEntry() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

function newWorld(seed = 13) {
  const entry = loadEntry();
  const state = createWorldV2(
    { templateId: "jjk-2006", playerName: "测试", seed },
    entry.template,
    `w-facts-${seed}`,
  );
  state.openingCompleted = true;
  return { state, entry };
}

const npc = (state: WorldStateV2, id: string) => {
  const found = state.npcs.find((n) => n.id === id);
  if (found === undefined) throw new Error(`npc_not_found: ${id}`);
  return found;
};

/** 把世界拨到第 day 天，推一轮（时间表在回合 tail 求值）。 */
function advanceTo(state: WorldStateV2, entry: ReturnType<typeof loadEntry>, day: number): void {
  state.worldTime = day * DAY;
  advanceTurnV2(state, { action: { type: "rest", description: "" } }, entry.template, entry.lookup);
}

describe("世界时间表（ADR-007 D1）", () => {
  it("模板声明了时间表，且开局一条都还没执行", () => {
    const { state, entry } = newWorld();
    expect(entry.template.scheduledFacts?.length ?? 0).toBeGreaterThan(0);
    expect(state.facts).toEqual([]);
  });

  it("到点才发生：差一天不发生，到点当天就发生", () => {
    const { state, entry } = newWorld();
    // `rest` 一次推进一天 ⇒ 214 - 1 天时世界时间落在门槛之前。
    advanceTo(state, entry, 213);
    expect(npc(state, "npc-toji").lifecycle.state).toBe("unspawned");
    expect(state.facts.some((f) => f.factId === "fact-toji-2006")).toBe(false);

    // 一次 rest 推进一天 ⇒ 从第 214 天推到第 215 天，正好跨过门槛。
    advanceTo(state, entry, 214);
    expect(npc(state, "npc-toji").lifecycle.state).toBe("alive");
    const fired = state.facts.find((f) => f.factId === "fact-toji-2006");
    expect(fired).toBeDefined();
    // 记的是「发生那一刻」的世界时间，不是声明里的门槛值（这里两者恰好都是 215 天）。
    expect(fired!.worldTime).toBe(215 * DAY);
  });

  it("一事实只发生一次：再推几轮也不会重复执行、不会重复登场", () => {
    const { state, entry } = newWorld();
    advanceTo(state, entry, 216);
    advanceTo(state, entry, 300);
    advanceTo(state, entry, 301);
    expect(state.facts.filter((f) => f.factId === "fact-toji-2006")).toHaveLength(1);
    expect(state.spawnLog.filter((l) => l.ruleId === "rule-toji-2006")).toHaveLength(1);
  });

  it("跳过很久也照常补齐：一次推到 500 天，2006 的事实已经发生", () => {
    const { state, entry } = newWorld();
    advanceTo(state, entry, 4539);
    const ids = new Set(state.facts.map((f) => f.factId));
    expect(ids.has("fact-toji-2006")).toBe(true);
    // 2006 单章两条事实：甚尔入场（215 天）+ 怀玉之后五条悟的成长（260 天）。
    expect(ids.has("fact-gojo-growth")).toBe(true);
    expect(state.facts).toHaveLength(2);
    // 成长的事实真的落到人身上（不是只写了一条日志）：反转、赫、茈、常时无下限。
    const gojo = npc(state, "npc-gojo");
    expect(gojo.skills).toContain("sk-reverse-heal");
    expect(gojo.skills).toContain("sk-gojo-hollow-purple");
    expect(gojo.statuses.some((s) => s.statusId === "infinity")).toBe(true);
    expect(npc(state, "npc-yuta").lifecycle.state).toBe("unspawned");
    expect(state.relations.some((e) => e.from === "npc-gojo" && e.to === "npc-megumi")).toBe(false);
  });

  it("确定性：同一 seed 两次跑，事实日志逐字段相同", () => {
    const a = newWorld(7);
    const b = newWorld(7);
    advanceTo(a.state, a.entry, 4539);
    advanceTo(b.state, b.entry, 4539);
    expect(a.state.facts).toEqual(b.state.facts);
  });

  it("加载期拦住写错的事实：引用不存在的刷新规则 ⇒ 模板拒载", () => {
    const entry = loadEntry();
    const broken = structuredClone(entry.template);
    broken.scheduledFacts = [
      {
        id: "fact-typo",
        when: [{ time: { gte: { value: 1, unit: "day" } } }],
        effects: [{ type: "spawnNpc", ruleId: "rule-does-not-exist" }],
      },
    ];
    const parsed = WorldTemplateV2Schema.safeParse(broken);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const messages = parsed.error.issues.map((i) => i.message).join(" / ");
    expect(messages).toContain("未知刷新规则");
  });
});
