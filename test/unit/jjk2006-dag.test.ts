import { describe, expect, it } from "vitest";
import { loadTemplates } from "../../apps/server/src/templates.ts";
import {
  commitOpening,
  createOpeningSession,
  resolveStep,
} from "../../packages/game-core/src/v2/opening-dag.ts";
import type { OpeningBranchDag } from "@life-sim/shared";

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function loadV2() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "2.0.0" });
  if (entry?.status !== "ready" || entry.openingDag === undefined) {
    throw new Error("jjk-2006/2.0.0 未就绪");
  }
  return entry;
}

/** 按固定序列跑完开局：self 可指定，其余步骤取首项（roll 自动落定）。 */
function runOpening(dag: OpeningBranchDag, template: ReturnType<typeof loadV2>["template"], firstOption?: string) {
  let session = createOpeningSession(dag, 12345);
  for (let guard = 0; !session.done && guard < 30; guard += 1) {
    const node = dag.nodes.find((n) => n.node === session.nodeId);
    if (node === undefined) break;
    const optionId =
      node.node === "n-self" && firstOption !== undefined ? firstOption : node.options?.[0]?.id;
    if (node.mode === "roll") session = resolveStep(dag, session, { kind: "roll" }).session;
    else if (node.mode === "choose" && optionId !== undefined) {
      session = resolveStep(dag, session, { kind: "choose", optionId }).session;
    } else throw new Error(`无法推进节点：${node.node}`);
  }
  expect(session.done).toBe(true);
  return commitOpening(dag, session, template, "w-jjk-opening-test");
}

describe("jjk-2006 2.0.0 · 前实例化开局", () => {
  it("13 步 DAG 一次建世界：turnIndex=0、无 delayQueue、92 天时间锚、无 mood", () => {
    const entry = loadV2();
    const state = runOpening(entry.openingDag, entry.template);
    expect(state.turnIndex).toBe(0);
    expect(state.worldTime).toBe(92 * 1440);
    expect(state.delayQueue).toEqual([]);
    expect(state.flags.creationDone).toBe(true);
    expect(state.flags.chapter).toBe(1);
    expect(state.flags.openingPath).toBe("tokyo");
    // 特质在 commit 时统一获得（而非进世界后的事件）。
    expect(state.player.statuses.some((s) => s.statusId === "tech-ten-shadow")).toBe(true);
    expect(state.player.skills.length).toBeGreaterThan(0);
    expect(state.player.inventory["item-first-aid"]).toBeGreaterThan(0);
    // 旧开场事件链彻底移除。
    expect(entry.template.events.some((e) => e.id === "ev-w01" || e.id === "ev-opening-wheel")).toBe(false);
    expect(entry.template.events.some((e) => e.id.startsWith("evt:amane-short"))).toBe(true);
  });

  it("复用原作人物：基本属性取角色、self 即该角色，不重复进 npcs", () => {
    const entry = loadV2();
    const state = runOpening(entry.openingDag, entry.template, "self-riko");
    expect(state.player.id).toBe("npc-riko");
    expect(state.player.name).toBe("天内理子");
    expect(state.npcs.some((n) => n.id === "npc-riko")).toBe(false);
  });

  it("天内理子短线：首节点 as 分派互斥，两个 badend 独占终结条件", () => {
    const entry = loadV2();
    const ids = entry.template.events.map((e) => e.id);
    expect(ids).toContain("evt:amane-short#entrance@npc-riko");
    expect(ids).toContain("evt:amane-short");
    expect(ids).toContain("evt:amane-short#assimilated@npc-riko");
    expect(ids).toContain("evt:amane-short#shot@npc-riko");
    expect(ids).toContain("evt:amane-short#watched");

    const riko = entry.template.events.find((e) => e.id === "evt:amane-short#entrance@npc-riko");
    const fallback = entry.template.events.find((e) => e.id === "evt:amane-short");
    expect(riko?.trigger.conditions).toContainEqual({ selfIs: "npc-riko" });
    expect(fallback?.trigger.conditions).toContainEqual({ selfIsNot: "npc-riko" });
    if (riko?.kind !== "normal" || fallback?.kind !== "normal") throw new Error("branch kind");
    expect(riko.settle.normal.options.map((o) => o.nextEventId)).toEqual([
      "evt:amane-short#assimilated@npc-riko",
      "evt:amane-short#shot@npc-riko",
    ]);
    expect(new Set(fallback.settle.normal.options.map((o) => o.nextEventId))).toEqual(
      new Set(["evt:amane-short#watched"]),
    );

    const endings = entry.endingConfig?.endings.map((e) => e.endingId) ?? [];
    expect(endings).toContain("end-riko-assimilated");
    expect(endings).toContain("end-riko-shot");
    expect(entry.endingConfig?.terminationConditions.length).toBeGreaterThanOrEqual(5);
  });
});
