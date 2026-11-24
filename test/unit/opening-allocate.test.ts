import { describe, expect, it } from "vitest";
import { OpeningBranchDagSchema, type OpeningBranchDag } from "@life-sim/shared";
import {
  collectOpeningGains,
  commitOpening,
  createOpeningSession,
  describeNode,
  resolveStep,
} from "../../packages/game-core/src/v2/opening-dag.ts";
import { validateOpeningDag } from "../../packages/game-core/src/v2/opening-validate.ts";
import { registerExtensionRuntime } from "@life-sim/game-core";
import { familyExtension } from "@life-sim/ext-family";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * ADR-004 开局加点：预算来源、四项校验、加载期白名单、增量落点与「开局所得」。
 *
 * 主路径跑**真实模板** `jjk-2006@3.0.0`：v3 开局在「高阶技巧」之后、「入场」之前有一格
 * `n-allocate`，预算来自天赋档（`talentRoll` 2~5：天赋越好，可塑空间越小）。
 * 夹具只留给真实模板表达不出来的边界（预算未落定、`min` 下限、不设 `max`、
 * 加载期白名单）——那些是内核语义，不是模板内容。
 */

registerExtensionRuntime(familyExtension);
const silent = { warn: () => {}, error: () => {}, info: () => {} };
const ALLOC_NODE = "n-allocate";

function loadJjk() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready" || entry.openingDag === undefined) throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

/** 跑到加点那一格为止（roll 自动落定、choose 取首项）。 */
function driveToAllocate(dag: OpeningBranchDag, seed: number) {
  let session = createOpeningSession(dag, seed);
  for (let guard = 0; !session.done && guard < 40; guard += 1) {
    const node = dag.nodes.find((n) => n.node === session.nodeId);
    if (node === undefined) throw new Error(`节点不存在：${session.nodeId}`);
    if (node.mode === "allocate") return session;
    if (node.mode === "roll") session = resolveStep(dag, session, { kind: "roll" }).session;
    else if (node.mode === "choose") {
      session = resolveStep(dag, session, { kind: "choose", optionId: node.options![0]!.id }).session;
    } else if (node.mode === "input") {
      session = resolveStep(dag, session, { kind: "input", value: "测试名字" }).session;
    }
  }
  throw new Error("没走到加点节点");
}

/** 加完点后把剩下的节点跑完。 */
function finish(dag: OpeningBranchDag, session: ReturnType<typeof createOpeningSession>, allocation: Record<string, number>) {
  let cur = resolveStep(dag, session, { kind: "allocate", allocation }).session;
  for (let guard = 0; !cur.done && guard < 10; guard += 1) {
    const node = dag.nodes.find((n) => n.node === cur.nodeId)!;
    cur = resolveStep(dag, cur, { kind: "choose", optionId: node.options![0]!.id }).session;
  }
  expect(cur.done).toBe(true);
  return cur;
}

function baseDag(overrides: Partial<OpeningBranchDag> = {}): OpeningBranchDag {
  return OpeningBranchDagSchema.parse({
    openingId: "op-test",
    name: "测试开局",
    entry: "n1",
    params: [
      {
        id: "pts",
        kind: "points",
        budget: 2,
        targets: [
          { attribute: "energy", min: 0, max: 2 },
          { attribute: "agility", min: 0, max: 2 },
        ],
      },
    ],
    nodes: [{ node: "n1", title: "加点", mode: "allocate", param: "pts" }],
    ...overrides,
  });
}

describe("ADR-004 · 开局加点（真实模板 jjk-2006@3.0.0）", () => {
  it("v3 开局有一格加点，预算来自天赋档而不是写死的常数", () => {
    const entry = loadJjk();
    const dag = entry.openingDag!;
    const node = dag.nodes.find((n) => n.node === ALLOC_NODE);
    expect(node?.mode).toBe("allocate");
    expect(node?.param).toBe("talentPoints");

    const budgets = new Set<number>();
    for (let seed = 1; seed <= 40; seed += 1) {
      const session = driveToAllocate(dag, seed);
      const view = describeNode(dag, session, { template: entry.template });
      const budget = view?.allocation?.budget ?? 0;
      expect(budget).toBeGreaterThan(0);
      // 视图里的 targets 来自模板：4 项、第一项是咒力、带样式（前端直接拿来渲染）。
      expect(view?.allocation?.targets.map((t) => t.attribute)).toEqual([
        "cursedEnergyTotal",
        "intellect",
        "physique",
        "agility",
      ]);
      expect(view?.allocation?.targets[0]?.style?.preset).toBeDefined();
      budgets.add(budget);
    }
    // 预算不是常数：2~5 之间至少出现两种。
    expect(budgets.size).toBeGreaterThan(1);
    for (const budget of budgets) expect(budget).toBeGreaterThanOrEqual(2);
  });

  it("提交合法分配：进 results，且落点是「基础值 + 分配值」（两种分法只差点数）", () => {
    const entry = loadJjk();
    const dag = entry.openingDag!;
    const session = driveToAllocate(dag, 777);
    const view = describeNode(dag, session, { template: entry.template });
    const budget = view?.allocation?.budget ?? 0;
    const energyMax = view?.allocation?.targets.find((t) => t.attribute === "cursedEnergyTotal")!.max ?? budget;
    const agilityMax = view?.allocation?.targets.find((t) => t.attribute === "agility")!.max ?? budget;

    const onEnergy = { cursedEnergyTotal: Math.min(budget, energyMax) };
    const onAgility = { agility: Math.min(budget, agilityMax) };

    const after = resolveStep(dag, session, { kind: "allocate", allocation: onEnergy }).session;
    expect(after.results.at(-1)?.nodeId).toBe(ALLOC_NODE);
    expect(after.results.at(-1)?.allocation?.talentPoints?.cursedEnergyTotal).toBe(onEnergy.cursedEnergyTotal);

    const stateA = commitOpening(dag, finish(dag, session, onEnergy), entry.template, "w-alloc-a");
    const stateB = commitOpening(dag, finish(dag, session, onAgility), entry.template, "w-alloc-b");

    // 同一个 seed 的其余步骤完全一致 ⇒ 差值只能来自加点。
    expect(
      Number(stateA.player.attributes.cursedEnergyTotal) - Number(stateB.player.attributes.cursedEnergyTotal),
    ).toBe(onEnergy.cursedEnergyTotal);
    expect(Number(stateB.player.attributes.agility) - Number(stateA.player.attributes.agility)).toBe(
      onAgility.agility,
    );
  });

  it("加点进「开局所得」：非 0 项逐条列出，名字取模板标签", () => {
    const entry = loadJjk();
    const dag = entry.openingDag!;
    const session = driveToAllocate(dag, 424242);
    const view = describeNode(dag, session, { template: entry.template });
    const budget = view?.allocation?.budget ?? 0;
    const allocation = { cursedEnergyTotal: budget };
    const after = resolveStep(dag, session, { kind: "allocate", allocation }).session;
    const gains = collectOpeningGains(dag, after, entry.template, entry.ui);
    for (const [attribute, amount] of Object.entries(allocation)) {
      if (amount === 0) continue;
      const item = gains.filter((g) => g.category === "attribute" && g.id === attribute).at(-1);
      expect(item?.amount).toBe(amount);
    }
    const cursedEntry = gains.filter((g) => g.id === "cursedEnergyTotal").at(-1);
    expect(cursedEntry?.name).toBe("咒力总量");
  });

  it("预算未落定时报错而不是按 0 处理", () => {
    const dag = baseDag({
      params: [
        { id: "roll", kind: "number" },
        {
          id: "pts",
          kind: "points",
          budgetFrom: "roll",
          targets: [{ attribute: "energy", min: 0, max: 5 }],
        },
      ],
      nodes: [{ node: "n1", title: "加点", mode: "allocate", param: "pts" }],
    });
    const session = createOpeningSession(dag, 1);
    expect(() => describeNode(dag, session)).toThrow("opening_allocate_budget_unavailable");
    expect(() => resolveStep(dag, session, { kind: "allocate", allocation: { energy: 0 } })).toThrow(
      "opening_allocate_budget_unavailable",
    );
  });

  it("四项校验：白名单外的键 / 小数 / 上限 / 超支", () => {
    const dag = baseDag();
    const session = createOpeningSession(dag, 2);
    const step = (allocation: Record<string, number>) =>
      resolveStep(dag, session, { kind: "allocate", allocation });

    expect(() => step({ luck: 2 })).toThrow("opening_allocation_unknown_target");
    expect(() => step({ energy: 1.5 })).toThrow("opening_allocation_invalid_value");
    expect(() => step({ energy: -1, agility: 3 })).toThrow("opening_allocation_invalid_value");
    expect(() => step({ energy: 3 })).toThrow("opening_allocation_above_max");
    // ADR-004 D4 修订：允许放弃余额，只拒绝超支。
    expect(() => step({ energy: 2, agility: 1 })).toThrow("opening_allocation_over_budget");
    const partial = step({ energy: 1 });
    expect(partial.session.done).toBe(true);
    expect(partial.session.results.at(-1)?.allocation?.pts).toEqual({ energy: 1, agility: 0 });
    // 合法：刚好 2 点
    const ok = step({ energy: 1, agility: 1 });
    expect(ok.session.done).toBe(true);
  });

  it("不设 max 的目标可以吃下全部预算（模板不限制最大值）", () => {
    const dag = baseDag({
      params: [
        {
          id: "pts",
          kind: "points",
          budget: 5,
          targets: [{ attribute: "energy", min: 0 }],
        },
      ],
    });
    const session = createOpeningSession(dag, 5);
    const view = describeNode(dag, session);
    expect(view?.allocation?.targets[0]?.max).toBeUndefined();
    const ok = resolveStep(dag, session, { kind: "allocate", allocation: { energy: 5 } });
    expect(ok.session.done).toBe(true);
  });

  it("min 不可绕过：漏填按 0 校验，不会因为「没写」而放行", () => {
    const dag = baseDag({
      params: [
        {
          id: "pts",
          kind: "points",
          budget: 1,
          targets: [
            { attribute: "energy", min: 1, max: 1 },
            { attribute: "agility", min: 0, max: 1 },
          ],
        },
      ],
    });
    const session = createOpeningSession(dag, 3);
    expect(() => resolveStep(dag, session, { kind: "allocate", allocation: { agility: 1 } })).toThrow(
      "opening_allocation_below_min",
    );
    const ok = resolveStep(dag, session, { kind: "allocate", allocation: { energy: 1 } });
    expect(ok.session.done).toBe(true);
  });

  it("加载期：加点目标只能是已声明的数值属性", () => {
    const entry = loadJjk();
    const enumTarget = baseDag({
      params: [
        {
          id: "pts",
          kind: "points",
          budget: 1,
          targets: [{ attribute: "grade", min: 0, max: 1 }],
        },
      ],
    });
    const enumIssues = validateOpeningDag(enumTarget, entry.template);
    expect(enumIssues.some((i) => i.message.includes("必须是数值类属性"))).toBe(true);

    const unknown = baseDag({
      params: [
        {
          id: "pts",
          kind: "points",
          budget: 1,
          targets: [{ attribute: "no-such-attr", min: 0, max: 1 }],
        },
      ],
    });
    expect(validateOpeningDag(unknown, entry.template).some((i) => i.message.includes("未知属性"))).toBe(true);
  });

  it("加载期：budgetFrom 必须指向 number 参数，allocate 必须指向 points 参数", () => {
    const entry = loadJjk();
    const badBudget = baseDag({
      params: [
        { id: "who", kind: "self" },
        { id: "pts", kind: "points", budgetFrom: "who", targets: [{ attribute: "energy" }] },
      ],
    });
    expect(validateOpeningDag(badBudget, entry.template).some((i) => i.message.includes("kind=number"))).toBe(
      true,
    );

    const badNode = baseDag({
      params: [{ id: "attr", kind: "attribute" }],
      nodes: [{ node: "n1", title: "x", mode: "allocate", param: "attr" }],
    });
    expect(validateOpeningDag(badNode, entry.template).some((i) => i.message.includes("kind=points"))).toBe(
      true,
    );
  });

  it("实际模板通过加载期校验", () => {
    const entry = loadJjk();
    expect(validateOpeningDag(entry.openingDag, entry.template, entry.ui)).toEqual([]);
  });
});
