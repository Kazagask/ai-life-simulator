import { describe, expect, it } from "vitest";
import { advanceTurnV2, applyEffectsV2, createWorldV2, projectSnapshotV2, projectVisibleRelations } from "@life-sim/game-core";
import { toViewModel } from "@life-sim/rpg-ui";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silent = { warn: () => {}, error: () => {}, info: () => {} };
const DAY = 1440;

function loadEntry() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

/** 建一个世界并推进到指定天数，再投影成前端视角。 */
function cardAt(day: number, npcId = "npc-gojo") {
  const entry = loadEntry();
  const state = createWorldV2(
    { templateId: "jjk-2006", playerName: "测试", seed: 5 },
    entry.template,
    `w-rel-${day}`,
  );
  state.openingCompleted = true;
  state.worldTime = day * DAY;
  // 推一轮让世界时间表求值（ADR-007 D1：登场与关系建立都在回合 tail）。
  advanceTurnV2(state, { action: { type: "rest", description: "" } }, entry.template, entry.lookup);
  const snapshot = projectSnapshotV2(state, entry.template, entry.lookup, null, entry.endings, entry.ui);
  const vm = toViewModel({ snapshot, ui: entry.ui });
  const npc = vm.npcs.find((n) => n.id === npcId);
  if (npc === undefined) throw new Error(`${npcId} 不在列表里`);
  return { state, rows: npc.relations , vm };
}

describe("关系按时间发生（ADR-007 D1）", () => {
  it("2006 年的五条卡上没有伏黑惠：那时候他还没收这个学生", () => {
    const { rows } = cardAt(2);
    expect(rows.find((r) => r.withId === "npc-megumi")).toBeUndefined();
    // 2006 年该有的关系照旧在（夏油 / 硝子 / 夜蛾 / 你）。
    expect(rows.map((r) => r.withId)).toEqual(
      expect.arrayContaining(["npc-geto", "npc-shoko", "npc-yaga", "player"]),
    );
  });

  // 2026-11-21 收束到 2006：旧章节的「2018 一年级编成 → 师徒关系」两条用例
  // 随 ev-jv-* / scheduledFacts 一起删。关系边本身还留在 characters.yaml 里，
  // 重写那一章时会重新有写入点。
});

describe("关系行：知情人范围（ADR-007 D3）", () => {
  it("公开关系标 public，词表是「公开」而不是旧的「确知/推断」", () => {
    const { rows } = cardAt(2);
    const geto = rows.find((r) => r.withId === "npc-geto");
    expect(geto?.scope).toBe("public");
    expect(geto?.scopeLabel).toBe("公开");
  });

  it("仅当事人知道的关系：当事人看得到，第三方一条都拿不到", () => {
    // 甚尔 → 惠 [son] 是 private（惠知道父亲是谁，但这不是公开信息）。
    const { state } = cardAt(4539);
    const edge = state.relations.find(
      (e) => e.from === "npc-toji" && e.to === "npc-megumi" && e.kind === "son",
    );
    expect(edge?.scope).toBe("private");
    const sees = (viewer: string): boolean =>
      projectVisibleRelations(state.relations, viewer).some(
        (e) => e.from === "npc-toji" && e.to === "npc-megumi" && e.kind === "son",
      );
    expect(sees("npc-megumi")).toBe(true); // 当事人
    expect(sees("npc-toji")).toBe(true); // 当事人
    expect(sees("npc-gojo")).toBe(false); // 同学 / 同事
    expect(sees("player")).toBe(false); // 你也在局外
  });
});

describe("关系行：没有卡时说清原因（ADR-006 D3）", () => {
  it("对方还没登场 ⇒ 写原因，不写「无档案」，名字照给", () => {
    // 2006 年五条的「远亲」是乙骨忧太 —— 2017 年才回国，人还没登场。
    const rel = cardAt(2).rows.find((r) => r.withId === "npc-yuta");
    expect(rel).toBeDefined();
    expect(rel?.counterpartVisible).toBe(false);
    expect(rel?.counterpartState).toBe("unspawned");
    expect(rel?.counterpartStateLabel).toBe("尚未登场");
    expect(rel?.withName).toBe("乙骨忧太");
  });

  it("裸数值换成档位话术，原值仍随行下发", () => {
    const rel = cardAt(2).rows.find((r) => r.withId === "npc-geto");
    expect(rel?.value).toBe(70);
    expect(rel?.valueLabel).toBe("深厚");
  });
});

describe("玩家自己的关系（2026-11-20 本体补齐）", () => {
  /**
   * 以前关系只挂得出 NPC 卡：玩家自己的关系要么靠在别人的卡上「反向」看见，
   * 要么压根看不见 —— 这是**本体能力的缺口**，不是展示层偷懒。
   */
  it("六个入边 + 六个出边：玩家自己那一侧也写全了", () => {
    const rels = cardAt(2).vm.player.relations;
    const ins = rels.filter((rel) => rel.direction === "in");
    const outs = rels.filter((rel) => rel.direction === "out");

    // 2006 年开局：夜蛾 / 五条视你为弟子，硝子 / 灰原视你为朋友，七海 / 伊地知视你为同事。
    expect(ins).toHaveLength(6);
    expect(ins.find((rel) => rel.withId === "npc-yaga")?.kindLabel).toBe("弟子");

    /**
     * 2026-11-20：关系图只画**出边**之后，玩家侧没有镜像就等于整张图空掉
     * （模板第一版只写了 `to: player` 那六条）。`playerTemplate.relations` 现在
     * 逐条写出镜像，且**不写 value**（自己的观感由行为养成，ADR-017 D1）。
     */
    expect(outs).toHaveLength(6);
    expect(outs).toContainEqual(expect.objectContaining({ withId: "npc-yaga", kind: "mentor" }));
    expect(outs).toContainEqual(expect.objectContaining({ withId: "npc-geto", kind: "friend" }));
    expect(outs.find((rel) => rel.withId === "npc-yaga")?.withName).toBe("夜蛾正道");
  });

  it("运行时建立的出边与对方卡上的入边是同一份事实（不各算一遍）", () => {
    const entry = loadEntry();
    const state = createWorldV2(
      { templateId: "jjk-2006", playerName: "测试", seed: 7 },
      entry.template,
      "w-rel-out",
    );
    state.openingCompleted = true;
    applyEffectsV2({ state, lookup: entry.lookup, rng: () => 0.5 }, [
      // 玩家视五条为对手（出边）；五条那边应当看到同一条边的入向。
      { type: "addRelationEdge", fromId: "player", toId: "npc-gojo", kind: "rival", scope: "public", value: 30 },
    ]);
    const snapshot = projectSnapshotV2(state, entry.template, entry.lookup, null, entry.endings, entry.ui);
    const vm = toViewModel({ snapshot, ui: entry.ui });

    const out = vm.player.relations.find((rel) => rel.withId === "npc-gojo" && rel.kind === "rival");
    expect(out?.direction).toBe("out");
    expect(out?.value).toBe(30);

    // 同一个 `buildRelationRows`：对方卡的投影里那一条是入向，kind / 值一致。
    const mirrored = snapshot.npcs.find((n) => n.id === "npc-gojo")?.relations.find((rel) => rel.kind === "rival");
    expect(mirrored?.direction).toBe("in");
    expect(mirrored?.withId).toBe("player");
    expect(mirrored?.value).toBe(30);
  });
});
