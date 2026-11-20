import { describe, expect, it } from "vitest";
import {
  applyEffectsV2,
  createWorldV2,
  normalizeAllocation,
  projectSnapshotV2,
  registerExtensionRuntime,
} from "@life-sim/game-core";
import { familyExtension } from "@life-sim/ext-family";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * 世界内加点（ADR-019，2026-11-20）。
 *
 * 上一轮把「战斗内加点」做成了 `adjustAttribute` 走战斗道具白名单，方向错了 ——
 * 战斗里调属性会牵动伤害 / 命中 / 血量上限一串结算。真正的缺口是**加点组件从没在
 * 世界里用过**：这里钉住它的世界侧链路（挂请求 → 面板 → 提交 → 落基础属性）。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };

const TARGETS = [
  { attribute: "body", max: 3 },
  { attribute: "mind", max: 3 },
  { attribute: "will", max: 2 },
];

describe("加点校验器（开局与世界内同一份）", () => {
  it("允许放弃余额，但不许超支", () => {
    const partial = normalizeAllocation({ body: 1 }, { budget: 3, targets: TARGETS });
    expect(partial).toMatchObject({ ok: true, spent: 1 });

    const over = normalizeAllocation({ body: 2, mind: 2 }, { budget: 3, targets: TARGETS });
    expect(over).toMatchObject({ ok: false, code: "over_budget" });
  });

  it("单项上限 / 下限 / 非整数 / 未知目标各有各的码", () => {
    expect(normalizeAllocation({ will: 3 }, { budget: 5, targets: TARGETS })).toMatchObject({
      ok: false,
      code: "above_max",
    });
    expect(
      normalizeAllocation({ body: 0 }, { budget: 2, targets: [{ attribute: "body", min: 1 }] }),
    ).toMatchObject({ ok: false, code: "below_min" });
    expect(normalizeAllocation({ body: 1.5 }, { budget: 2, targets: TARGETS })).toMatchObject({
      ok: false,
      code: "invalid_value",
    });
    expect(normalizeAllocation({ prowess: 1 }, { budget: 2, targets: TARGETS })).toMatchObject({
      ok: false,
      code: "unknown_target",
    });
  });

  it("没提交的目标按 0 展开（min>0 漏填不会被当成合法）", () => {
    const res = normalizeAllocation(
      { body: 1 },
      { budget: 3, targets: [{ attribute: "body" }, { attribute: "mind", min: 1 }] },
    );
    expect(res).toMatchObject({ ok: false, code: "below_min" });
  });
});

describe("世界内加点：效果挂请求 → 投影 → 提交", () => {
  const loadEntry = () => {
    registerExtensionRuntime(familyExtension);
    const entry = loadTemplates(silent).resolve({ id: "valmont", version: "1.0.0" });
    if (entry?.status !== "ready") throw new Error("valmont/1.0.0 未就绪");
    return entry;
  };

  it("grantAllocation 只挂请求，不动属性；投影带出已解析的目标", () => {
    const entry = loadEntry();
    const state = createWorldV2({ templateId: "valmont", playerName: "罗兰", seed: 21 }, entry.template, "w-alloc");
    const before = { ...state.player.attributes };

    applyEffectsV2({ state, lookup: entry.lookup, rng: () => 0.5 }, [
      {
        type: "grantAllocation",
        id: "alloc-test",
        budget: 3,
        reason: "练过",
        targets: [{ attribute: "body", max: 3 }],
      },
    ]);

    // 属性一点没变：加点要玩家自己选
    expect(state.player.attributes).toEqual(before);
    expect(state.pendingAllocation?.id).toBe("alloc-test");

    const snapshot = projectSnapshotV2(state, entry.template, entry.lookup, null, undefined, entry.ui);
    expect(snapshot.pendingAllocation?.budget).toBe(3);
    // 展示名由投影解析（前端不查模板）
    expect(snapshot.pendingAllocation?.targets[0]).toMatchObject({ attribute: "body", label: "体魄" });
  });

  it("同 id 重复授予是幂等的（日常事件泡在池子里会反复给同一笔）", () => {
    const entry = loadEntry();
    const state = createWorldV2({ templateId: "valmont", playerName: "罗兰", seed: 24 }, entry.template, "w-alloc-idem");
    const grant = {
      type: "grantAllocation" as const,
      id: "alloc-spar",
      budget: 2,
      targets: [{ attribute: "body", max: 2 }],
    };
    applyEffectsV2({ state, lookup: entry.lookup, rng: () => 0.5 }, [grant]);
    // 第二次不该抛：切磋会再刷到，玩家手里的那一笔还在
    expect(() => applyEffectsV2({ state, lookup: entry.lookup, rng: () => 0.5 }, [grant])).not.toThrow();
    expect(state.pendingAllocation?.id).toBe("alloc-spar");
    expect(state.pendingAllocation?.budget).toBe(2);
  });

  it("同一时刻只能挂一条（不同 id）：第二条直接拒", () => {
    const entry = loadEntry();
    const state = createWorldV2({ templateId: "valmont", playerName: "罗兰", seed: 22 }, entry.template, "w-alloc-2");
    const grant = {
      type: "grantAllocation" as const,
      id: "a1",
      budget: 2,
      targets: [{ attribute: "body", max: 2 }],
    };
    applyEffectsV2({ state, lookup: entry.lookup, rng: () => 0.5 }, [grant]);
    expect(() =>
      applyEffectsV2({ state, lookup: entry.lookup, rng: () => 0.5 }, [{ ...grant, id: "a2" }]),
    ).toThrow(/未完成的加点/);
  });

  it("提交后点数叠进基础属性（与开局同一口径：叠加不覆盖）", () => {
    const entry = loadEntry();
    const state = createWorldV2({ templateId: "valmont", playerName: "罗兰", seed: 23 }, entry.template, "w-alloc-3");
    applyEffectsV2({ state, lookup: entry.lookup, rng: () => 0.5 }, [
      { type: "grantAllocation", id: "a1", budget: 3, targets: [{ attribute: "body", max: 3 }] },
    ]);
    const body = state.player.attributes.body;
    expect(typeof body).toBe("number");

    const checked = normalizeAllocation({ body: 2 }, { budget: 3, targets: [{ attribute: "body", max: 3 }] });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    for (const [attribute, amount] of Object.entries(checked.points)) {
      const current = state.player.attributes[attribute];
      if (typeof current !== "number") continue;
      state.player.attributes[attribute] = current + amount;
    }
    expect(state.player.attributes.body).toBe((body as number) + 2);
  });
});

describe("jjk-2006 · 机制接线", () => {
  it("训练场切磋给的是「自己分两点」，不是硬编码的体术 +2", () => {
    const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
    if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
    const spar = entry.template.events.find((e) => e.id === "ev-d-spar");
    const options = (spar?.settle as { normal?: { options?: Array<{ id: string; effects?: Array<Record<string, unknown>> }> } })
      .normal?.options ?? [];
    const hit = options.find((o) => o.id === "opt-sp-1");
    const grant = (hit?.effects ?? []).find((e) => e.type === "grantAllocation");
    expect(grant).toMatchObject({ id: "alloc-spar-2006", budget: 2 });
    expect((grant?.targets as unknown[]).length).toBe(3);
  });

  it("本殿挡甚尔：撑过三回合也算赢（不是「必须把他打空」）", () => {
    const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
    if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
    const block = entry.template.events.find((e) => e.id === "ev-hv-06-block");
    const combat = (block?.settle as { combat?: { victory?: Array<{ kind: string }>; defeat?: Array<{ kind: string }> } })
      .combat;
    expect(combat?.victory?.map((v) => v.kind)).toContain("survive_rounds");
    expect(combat?.defeat?.map((v) => v.kind)).toContain("player_down");
  });
});
