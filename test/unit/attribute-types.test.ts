import { describe, expect, it } from "vitest";
import {
  collectOpeningGains,
  commitOpening,
  createOpeningSession,
  describeNode,
  resolveStep,
} from "../../packages/game-core/src/v2/opening-dag.ts";
import { createWorldV2 } from "../../packages/game-core/src/v2/turn.ts";
import { createLookup } from "../../packages/game-core/src/v2/lookup.ts";
import { applyEffectsV2 } from "../../packages/game-core/src/v2/engine.ts";
import { projectSnapshotV2 } from "../../packages/game-core/src/v2/projection.ts";
import { captureGainBaseline, diffGains } from "../../packages/game-core/src/v2/presentation/gains.ts";
import { registerExtensionRuntime } from "@life-sim/game-core";
import { familyExtension } from "@life-sim/ext-family";
import { loadTemplates } from "../../apps/server/src/templates.ts";
import type { OpeningBranchDag, WorldTemplateV2 } from "@life-sim/shared";
import { WorldTemplateV2Schema } from "@life-sim/shared";

/**
 * ADR-003 属性类型：enum / ladder / composite / hidden 的加载、求值、投影与收获。
 * 夹具全部来自真实模板（jjk-2006 / valmont），不手搓「看起来像」的世界。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };

// valmont 声明了 family 扩展；模板加载期会核对 runtime 是否注册。
registerExtensionRuntime(familyExtension);

function loadJjk() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready" || entry.openingDag === undefined) throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

function loadValmont() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "valmont", version: "1.0.0" });
  if (entry?.status !== "ready") throw new Error("valmont/1.0.0 未就绪");
  return entry;
}

/** 跑完 jjk 开局；`picks` 按节点 id 指定选项（未指定取首项），roll 自动落定。 */
function runJjkOpening(picks: Record<string, string> = {}) {
  const entry = loadJjk();
  const dag: OpeningBranchDag = entry.openingDag;
  let session = createOpeningSession(dag, 20261119);
  for (let guard = 0; !session.done && guard < 40; guard += 1) {
    const node = dag.nodes.find((n) => n.node === session.nodeId);
    if (node === undefined) break;
    if (node.mode === "roll") session = resolveStep(dag, session, { kind: "roll" }).session;
    else if (node.mode === "choose") {
      const optionId = picks[node.node] ?? node.options?.[0]?.id;
      if (optionId === undefined) throw new Error(`节点无选项：${node.node}`);
      session = resolveStep(dag, session, { kind: "choose", optionId }).session;
    } else if (node.mode === "allocate") {
      // ADR-004：按「第一项吃满」分配，够跑完流程即可。
      const view = describeNode(dag, session, { template: entry.template });
      const allocation: Record<string, number> = {};
      let left = view?.allocation?.budget ?? 0;
      for (const target of view?.allocation?.targets ?? []) {
        const take = Math.min(left, target.max ?? left);
        allocation[target.attribute] = take;
        left -= take;
      }
      session = resolveStep(dag, session, { kind: "allocate", allocation }).session;
    } else throw new Error(`无法推进节点：${node.node}`);
  }
  expect(session.done).toBe(true);
  const state = commitOpening(dag, session, entry.template, "w-attr-test");
  return { entry, dag, session, state };
}

function fameOf(template: WorldTemplateV2, infamy: number, virtue: number): string {
  const state = createWorldV2({ templateId: template.meta.id, playerName: "测试" }, template, "w-fame");
  state.player.attributes.infamy = infamy;
  state.player.attributes.virtue = virtue;
  const lookup = createLookup(template);
  const snap = projectSnapshotV2(state, template, lookup);
  return snap.player.attributeViews.find((v) => v.id === "fame")?.display ?? "(缺)";
}

describe("ADR-003 · 文本属性（enum）", () => {
  it("开局写入等级 / 生得术式；存档只存选项 id，投影解析出 label 与样式", () => {
    const { entry, state } = runJjkOpening();
    // n03 是 roll 节点：具体档位由 seed 决定，但写进去的必须是合法选项 id。
    const gradeId = String(state.player.attributes.grade);
    const gradeLabels: Record<string, string> = {
      "grade-4": "四级",
      "grade-3": "三级",
      "grade-2": "二级",
      "grade-1": "一级",
      special: "特级",
    };
    expect(Object.keys(gradeLabels)).toContain(gradeId);
    // 生得术式也是 roll 出来的：断言「写进去的是合法枚举 id」，标签与样式由模板 defs 解析。
    const techId = String(state.player.attributes.innateTechnique);
    const techDef = entry.template.attributes.defs?.innateTechnique;
    const techOption = techDef?.kind === "enum" ? techDef.values.find((v) => v.id === techId) : undefined;
    expect(techOption, `生得术式不是合法枚举：${techId}`).toBeDefined();

    const snap = projectSnapshotV2(state, entry.template, createLookup(entry.template), null, undefined, entry.ui);
    const grade = snap.player.attributeViews.find((v) => v.id === "grade");
    const tech = snap.player.attributeViews.find((v) => v.id === "innateTechnique");
    expect(grade?.display).toBe(gradeLabels[gradeId]);
    expect(tech?.display).toBe(techOption?.label);
    // 样式来自模板 defs.values[].style，解析结果必须非空。
    expect(grade?.style?.preset).toBeDefined();
    expect(tech?.style?.preset).toBeDefined();
    // 原始记录保留字符串值（权威数据不丢）。
    expect(snap.player.attributes.grade).toBe(gradeId);
  });

  it("枚举变化进「本轮收获」：action=set + 选项 label，不是数字差分", () => {
    const { entry, state } = runJjkOpening();
    const lookup = createLookup(entry.template);
    const before = captureGainBaseline(state);
    applyEffectsV2(
      { state, lookup, rng: () => 0.5, logs: [] },
      [{ type: "setAttribute", attribute: "grade", value: "special" }],
    );
    const gains = diffGains(before, state, lookup, entry.ui);
    const row = gains.find((g) => g.id === "grade");
    expect(row?.action).toBe("set");
    expect(row?.value).toBe("特级");
    expect(row?.style?.preset).toBe("gold");
    expect(row?.amount).toBeUndefined();
  });

  it("adjustAttribute 写文本属性：运行期拒绝（加载期也会拒）", () => {
    const { entry, state } = runJjkOpening();
    const lookup = createLookup(entry.template);
    expect(() =>
      applyEffectsV2(
        { state, lookup, rng: () => 0.5, logs: [] },
        [{ type: "adjustAttribute", attribute: "grade", value: 1 }],
      ),
    ).toThrow(/attribute_not_numeric/);
  });

  it("未知选项 id 在运行期可诊断（不静默写坏档）", () => {
    const { entry, state } = runJjkOpening();
    const lookup = createLookup(entry.template);
    expect(() =>
      applyEffectsV2(
        { state, lookup, rng: () => 0.5, logs: [] },
        [{ type: "setAttribute", attribute: "grade", value: "grade-99" }],
      ),
    ).toThrow(/unknown_attribute_value/);
  });
});

describe("ADR-003 · 复合属性（名誉）优先序表", () => {
  it("恶名 × 善名 的七种组合逐条命中", () => {
    const entry = loadJjk();
    const tpl = entry.template;
    expect(fameOf(tpl, 0, 0)).toBe("默默无闻");
    expect(fameOf(tpl, 1, 0)).toBe("声名狼藉");
    expect(fameOf(tpl, 2, 0)).toBe("恶贯满盈");
    expect(fameOf(tpl, 1, 1)).toBe("亦正亦邪");
    expect(fameOf(tpl, 0, 1)).toBe("声名远扬");
    expect(fameOf(tpl, 0, 2)).toBe("名震天下");
    expect(fameOf(tpl, 2, 2)).toBe("乱世枭雄");
  });

  it("hidden 轴不进面板，但复合视图带来源行；原始记录仍保留", () => {
    const { entry, state } = runJjkOpening();
    state.player.attributes.infamy = 2;
    state.player.attributes.virtue = 2;
    const snap = projectSnapshotV2(state, entry.template, createLookup(entry.template), null, undefined, entry.ui);
    expect(snap.player.attributeViews.some((v) => v.id === "infamy")).toBe(false);
    expect(snap.player.attributeViews.some((v) => v.id === "virtue")).toBe(false);
    const fame = snap.player.attributeViews.find((v) => v.id === "fame");
    expect(fame?.display).toBe("乱世枭雄");
    expect(fame?.sources?.map((s) => `${s.label}${s.display}`)).toEqual(["恶名＋＋", "善名＋＋"]);
    expect(snap.player.attributes.infamy).toBe(2);
  });
});

describe("ADR-003 · 阶梯属性", () => {
  it("cumulative：10/30 的档位与进度（瓦勒蒙·武艺）", () => {
    const entry = loadValmont();
    const template = entry.template;
    const state = createWorldV2({ templateId: "valmont", playerName: "罗兰" }, template, "w-ladder");
    expect(state.player.attributes.prowess).toBe(10);
    const snap = projectSnapshotV2(state, template, createLookup(template));
    const view = snap.player.attributeViews.find((v) => v.id === "prowess");
    expect(view?.display).toBe("生手");
    expect(view?.tier?.id).toBe("novice");
    expect(view?.progress).toEqual({ value: 10, max: 30 });
  });

  it("cumulative：升档不归零（+40 ⇒ 熟手、20/50）", () => {
    const entry = loadValmont();
    const template = entry.template;
    const state = createWorldV2({ templateId: "valmont", playerName: "罗兰" }, template, "w-ladder2");
    const lookup = createLookup(template);
    applyEffectsV2({ state, lookup, rng: () => 0.5, logs: [] }, [
      { type: "adjustAttribute", attribute: "prowess", value: 40 },
    ]);
    expect(state.player.attributes.prowess).toBe(50);
    const snap = projectSnapshotV2(state, template, lookup);
    const view = snap.player.attributeViews.find((v) => v.id === "prowess");
    expect(view?.display).toBe("熟手");
    expect(view?.progress).toEqual({ value: 20, max: 50 });
  });

  it("reset：升档扣减本档所需，档位落 attributeTiers", () => {
    const valmont = loadValmont().template;
    const tpl = structuredClone(valmont);
    tpl.attributes.order = [...tpl.attributes.order, "sword"];
    tpl.attributes.defaults = { ...tpl.attributes.defaults, sword: 0 };
    tpl.attributes.labels = { ...tpl.attributes.labels, sword: "剑意" };
    tpl.attributes.defs = {
      ...(tpl.attributes.defs ?? {}),
      sword: {
        kind: "ladder",
        mode: "reset",
        tiers: [
          { id: "s1", label: "初窥", at: 80 },
          { id: "s2", label: "小成", at: 200 },
          { id: "s3", label: "大成", at: 400 },
        ],
      },
    };
    const parsed = WorldTemplateV2Schema.parse(tpl);
    const state = createWorldV2({ templateId: "valmont", playerName: "罗兰" }, parsed, "w-reset");
    const lookup = createLookup(parsed);
    applyEffectsV2({ state, lookup, rng: () => 0.5, logs: [] }, [
      { type: "adjustAttribute", attribute: "sword", value: 90 },
    ]);
    // 90 → 扣掉 80 进第二档，剩 10。
    expect(state.player.attributes.sword).toBe(10);
    expect(state.player.attributeTiers?.sword).toBe("s2");
    const snap = projectSnapshotV2(state, parsed, lookup);
    const view = snap.player.attributeViews.find((v) => v.id === "sword");
    expect(view?.display).toBe("小成");
    expect(view?.progress).toEqual({ value: 10, max: 200 });
  });
});

describe("ADR-003 · 加载期 fail-fast", () => {
  it("caps 不能指向文本属性", () => {
    const template = loadJjk().template;
    const tpl = structuredClone(template);
    tpl.attributes.caps = { ...(tpl.attributes.caps ?? {}), grade: 5 };
    const result = WorldTemplateV2Schema.safeParse(tpl);
    expect(result.success).toBe(false);
  });

  it("复合属性的来源必须是数值属性", () => {
    const template = loadJjk().template;
    const tpl = structuredClone(template);
    const fame = (tpl.attributes.defs as Record<string, { sources: string[] }>).fame;
    fame.sources = ["grade"];
    const result = WorldTemplateV2Schema.safeParse(tpl);
    expect(result.success).toBe(false);
  });

  it("enum 的默认值必须是已声明选项", () => {
    const template = loadJjk().template;
    const tpl = structuredClone(template);
    tpl.attributes.defaults = { ...tpl.attributes.defaults, grade: "grade-99" };
    const result = WorldTemplateV2Schema.safeParse(tpl);
    expect(result.success).toBe(false);
  });
});
