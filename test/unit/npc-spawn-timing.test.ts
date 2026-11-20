import { describe, expect, it } from "vitest";
import { advanceTurnV2, createWorldV2, type WorldStateV2 } from "@life-sim/game-core";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silent = { warn: () => {}, error: () => {}, info: () => {} };
const DAY = 1440;

function loadEntry() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

function newWorld(seed = 11) {
  const entry = loadEntry();
  const state = createWorldV2(
    { templateId: "jjk-2006", playerName: "测试", seed },
    entry.template,
    `w-spawn-${seed}`,
  );
  state.openingCompleted = true;
  return { state, entry };
}

const npc = (state: WorldStateV2, id: string) => {
  const found = state.npcs.find((n) => n.id === id);
  if (found === undefined) throw new Error(`npc_not_found: ${id}`);
  return found;
};

/** 把世界拨到第 day 天，推一轮（刷新规则在回合 tail 求值）。 */
function advanceTo(state: WorldStateV2, entry: ReturnType<typeof loadEntry>, day: number): void {
  state.worldTime = day * DAY;
  advanceTurnV2(state, { action: { type: "rest", description: "" } }, entry.template, entry.lookup);
}

// 机制已从 `npcSpawnRules[].when` 搬到 `world.scheduledFacts`（ADR-007 D1），
// 文件名保留是为了不丢「到点登场」这条行为线的历史。
describe("NPC 定时登场（ADR-006 D2 → ADR-007 D1）", () => {
  it("开局只有 2006 那一届在世界上，后面几届全是 unspawned", () => {
    const { state } = newWorld();
    expect(npc(state, "npc-gojo").lifecycle.state).toBe("alive");
    expect(npc(state, "npc-nanami").lifecycle.state).toBe("alive");
    for (const id of ["npc-yuji", "npc-megumi", "npc-nobara", "npc-yuta"]) {
      expect(npc(state, id).lifecycle.state, id).toBe("unspawned");
    }
    // 反派同样按档期：2006 只有甚尔在场。
    expect(npc(state, "npc-toji").lifecycle.state).toBe("unspawned");
    expect(npc(state, "npc-jogo").lifecycle.state).toBe("unspawned");
    expect(npc(state, "npc-sukuna").lifecycle.state).toBe("unspawned");
  });

  it("到点自动登场（不用打任何事件）：215 天甚尔；2017 以后的人再也不来", () => {
    const { state, entry } = newWorld();
    advanceTo(state, entry, 216);
    expect(npc(state, "npc-toji").lifecycle.state).toBe("alive");

    // 2026-11-21 收束到 2006：乙骨 / 羂索 / 虎杖的登场规则随旧章节一起删了，
    // 推得再远也不该有人凭空出现（规则没了 ⇒ 永远 unspawned）。
    advanceTo(state, entry, 4371);
    for (const id of ["npc-yuta", "npc-kenjaku", "npc-yuji", "npc-jogo"]) {
      expect(npc(state, id).lifecycle.state, id).toBe("unspawned");
    }
  });

  it("登场只发生一次（幂等），年龄按规则重算而不是 2006 年的快照", () => {
    const { state, entry } = newWorld();
    advanceTo(state, entry, 216);
    const first = state.spawnLog.filter((l) => l.ruleId === "rule-toji-2006");
    expect(first).toHaveLength(1);
    advanceTo(state, entry, 217);
    expect(state.spawnLog.filter((l) => l.ruleId === "rule-toji-2006")).toHaveLength(1);
    // birthTime 由 `age: 31` 反推 ⇒ 2006 年他 31 岁，而不是「31 年前就 31 岁」。
    const toji = npc(state, "npc-toji");
    const ageYears = Math.floor((state.worldTime - toji.birthTime) / (365 * DAY));
    expect(ageYears).toBe(31);
  });
});
