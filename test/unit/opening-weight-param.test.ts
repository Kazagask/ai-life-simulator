import { describe, expect, it } from "vitest";
import {
  OpeningBranchDagSchema,
  type OpeningBranchDag,
} from "../../packages/shared/src/schema/opening.ts";
import {
  createOpeningSession,
  describeNode,
  optionWeights,
  resolveStep,
} from "../../packages/game-core/src/v2/opening-dag.ts";
import { validateOpeningDag } from "../../packages/game-core/src/v2/opening-validate.ts";
import { fixtureEntry } from "../helpers/world.ts";

/**
 * ADR-001 D7 · 开局转盘按**本会话已落定参数**调制权重。
 *
 * 全部 fixture 内联，不读真实模板（模板同事在改）；只有加载期校验需要一棵
 * `WorldTemplateV2`，用稳定的 test/fixtures。
 */

/**
 * 最小 DAG：n-set（choose，唯一选项写参数）→ n-roll（roll，两项静态权重 10:10）。
 * `weightByParam` 挂在 full 选项上；静态项 none 作为对照。
 */
function makeDag(set: Record<string, unknown>, weightByParam?: Record<string, unknown>): OpeningBranchDag {
  return OpeningBranchDagSchema.parse({
    openingId: "op-weight",
    name: "权重调制",
    entry: "n-set",
    params: [
      { id: "talentRoll", kind: "number" },
      { id: "origin", kind: "flag" },
    ],
    nodes: [
      {
        node: "n-set",
        title: "定参数",
        mode: "choose",
        goto: "n-roll",
        options: [{ id: "o", text: "落定", set }],
      },
      {
        node: "n-roll",
        title: "转盘",
        mode: "roll",
        options: [
          {
            id: "full",
            text: "完整",
            weight: 10,
            ...(weightByParam !== undefined ? { weightByParam } : {}),
            set: {},
          },
          { id: "none", text: "不会", weight: 10, set: {} },
        ],
      },
    ],
  });
}

function runToRoll(dag: OpeningBranchDag) {
  const session = createOpeningSession(dag, 7);
  return resolveStep(dag, session, { kind: "choose", optionId: "o" }).session;
}

function rollNode(dag: OpeningBranchDag) {
  return dag.nodes.find((n) => n.node === "n-roll") as OpeningBranchDag["nodes"][number];
}

describe("ADR-001 D7 · 开局权重按参数调制", () => {
  it("数值参数：final = weight + 参数值 × 系数，直接改变分布", () => {
    const low = makeDag({ talentRoll: 0 }, { talentRoll: 0.8 });
    const high = makeDag({ talentRoll: 5 }, { talentRoll: 0.8 });

    expect(optionWeights(low, runToRoll(low), rollNode(low))).toEqual([10, 10]);
    // 10 + 5 × 0.8 = 14；对照项保持 10。
    expect(optionWeights(high, runToRoll(high), rollNode(high))).toEqual([14, 10]);
  });

  it("枚举参数：解包 { id, value } 后查表；键不存在则不变", () => {
    const known = makeDag({ origin: { id: "origin", value: "御三家旁支" } }, {
      origin: { 御三家旁支: 12, 平民: -6 },
    });
    expect(optionWeights(known, runToRoll(known), rollNode(known))).toEqual([22, 10]);

    const negative = makeDag({ origin: { id: "origin", value: "平民" } }, {
      origin: { 御三家旁支: 12, 平民: -6 },
    });
    expect(optionWeights(negative, runToRoll(negative), rollNode(negative))).toEqual([4, 10]);

    // 查表里没有这个落定值 ⇒ 该条偏置计 0，不抛错。
    const unknownKey = makeDag({ origin: { id: "origin", value: "路人" } }, {
      origin: { 御三家旁支: 12, 平民: -6 },
    });
    expect(optionWeights(unknownKey, runToRoll(unknownKey), rollNode(unknownKey))).toEqual([10, 10]);
  });

  it("参数缺失 / 类型不匹配：偏置计 0，不抛错", () => {
    // 没写 talentRoll（会话里没有该值）⇒ 无偏向。
    const missing = makeDag({}, { talentRoll: 0.8 });
    expect(() => optionWeights(missing, runToRoll(missing), rollNode(missing))).not.toThrow();
    expect(optionWeights(missing, runToRoll(missing), rollNode(missing))).toEqual([10, 10]);

    // 枚举参数配了裸系数（不是查表）⇒ 类型不匹配，计 0。
    const mismatch = makeDag({ origin: { id: "origin", value: "平民" } }, { origin: 0.5 });
    expect(optionWeights(mismatch, runToRoll(mismatch), rollNode(mismatch))).toEqual([10, 10]);

    // 负到 0 以下夹到 0（与事件侧 wheel 同一口径）。
    const floor = makeDag({ talentRoll: 100 }, { talentRoll: -1 });
    expect(optionWeights(floor, runToRoll(floor), rollNode(floor))).toEqual([0, 10]);
  });

  it("describeNode 对 roll 节点下发本会话最终权重", () => {
    const dag = makeDag({ talentRoll: 5, origin: { id: "origin", value: "御三家旁支" } }, {
      talentRoll: 0.8,
      origin: { 御三家旁支: 12 },
    });
    const session = runToRoll(dag);
    const view = describeNode(dag, session);
    expect(view?.mode).toBe("roll");
    expect(view?.options.map((o) => [o.id, o.weight])).toEqual([
      ["full", 26], // 10 + 5×0.8 + 12
      ["none", 10],
    ]);
  });

  it("同 seed 同结果：权重只改 pickWeighted 入参，不改变按 node 派生的 RNG", () => {
    const dag = makeDag({ talentRoll: 3 }, { talentRoll: 0.8 });
    const session = runToRoll(dag);
    const a = resolveStep(dag, session, { kind: "roll" });
    const b = resolveStep(dag, session, { kind: "roll" });
    expect(a.resolved?.optionId).toBe(b.resolved?.optionId);
    expect(optionWeights(dag, session, rollNode(dag))).toEqual(
      optionWeights(dag, session, rollNode(dag)),
    );
  });

  it("加载期：跨分支引用（非所有路径都落定）拒载", () => {
    const { template } = fixtureEntry();
    // n1 两条分支：a ⇒ n2（写 talentRoll）⇒ n3；b ⇒ n3 直接到。n2 不支配 n3。
    const dag = OpeningBranchDagSchema.parse({
      openingId: "op-cross",
      name: "跨分支",
      entry: "n1",
      params: [{ id: "talentRoll", kind: "number" }],
      nodes: [
        {
          node: "n1",
          title: "分叉",
          mode: "roll",
          options: [
            { id: "a", text: "抽天赋", weight: 1, set: {}, goto: "n2" },
            { id: "b", text: "跳过", weight: 1, set: {}, goto: "n3" },
          ],
        },
        {
          node: "n2",
          title: "写参数",
          mode: "choose",
          goto: "n3",
          options: [{ id: "x", text: "写", set: { talentRoll: 4 } }],
        },
        {
          node: "n3",
          title: "读参数",
          mode: "roll",
          options: [
            { id: "full", text: "完整", weight: 10, weightByParam: { talentRoll: 1 }, set: {} },
            { id: "none", text: "不会", weight: 10, set: {} },
          ],
        },
      ],
    });
    const issues = validateOpeningDag(dag, template);
    expect(
      issues.some(
        (i) =>
          i.message.includes("opening_weight_param_unresolved") && i.path.includes("nodes[2]"),
      ),
    ).toBe(true);
  });

  it("加载期：所有路径都先落定则放行", () => {
    const { template } = fixtureEntry();
    const dag = OpeningBranchDagSchema.parse({
      openingId: "op-linear",
      name: "线性",
      entry: "n1",
      params: [{ id: "talentRoll", kind: "number" }],
      nodes: [
        {
          node: "n1",
          title: "写参数",
          mode: "choose",
          goto: "n2",
          options: [{ id: "x", text: "写", set: { talentRoll: 4 } }],
        },
        {
          node: "n2",
          title: "读参数",
          mode: "roll",
          options: [
            { id: "full", text: "完整", weight: 10, weightByParam: { talentRoll: 1 }, set: {} },
            { id: "none", text: "不会", weight: 10, set: {} },
          ],
        },
      ],
    });
    expect(
      validateOpeningDag(dag, template).filter((i) => i.message.startsWith("opening_weight")),
    ).toEqual([]);
  });

  it("加载期：非 roll 节点用 weightByParam 拒载（opening_weight_non_roll）", () => {
    const { template } = fixtureEntry();
    const dag = OpeningBranchDagSchema.parse({
      openingId: "op-nonroll",
      name: "选点加权",
      entry: "n1",
      params: [{ id: "talentRoll", kind: "number" }],
      nodes: [
        {
          node: "n1",
          title: "选择",
          mode: "choose",
          goto: "n2",
          options: [
            { id: "a", text: "A", weightByParam: { talentRoll: 1 }, set: { talentRoll: 1 } },
          ],
        },
        {
          node: "n2",
          title: "结束",
          mode: "roll",
          options: [{ id: "end", text: "结束", weight: 1, set: {} }],
        },
      ],
    });
    expect(
      validateOpeningDag(dag, template).some((i) => i.message.includes("opening_weight_non_roll")),
    ).toBe(true);
  });

  it("加载期：引用未声明的 param 也拒载", () => {
    const { template } = fixtureEntry();
    const dag = OpeningBranchDagSchema.parse({
      openingId: "op-ghost",
      name: "幽灵参数",
      entry: "n1",
      params: [{ id: "talentRoll", kind: "number" }],
      nodes: [
        {
          node: "n1",
          title: "转盘",
          mode: "roll",
          options: [
            { id: "a", text: "A", weight: 1, weightByParam: { ghost: 1 }, set: {} },
            { id: "b", text: "B", weight: 1, set: {} },
          ],
        },
      ],
    });
    expect(
      validateOpeningDag(dag, template).some(
        (i) => i.message.includes("opening_weight_param_unresolved") && i.message.includes("ghost"),
      ),
    ).toBe(true);
  });
});
