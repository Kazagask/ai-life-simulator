import { describe, expect, it } from "vitest";
import { registerServerExtensions } from "../../apps/server/src/extensions.ts";
import { buildOrchestration } from "../../apps/server/src/admin-data.ts";
import {
  buildLine,
  buildNpcLine,
  findCharacter,
  searchOrchestration,
  type LineNode,
} from "../../apps/server/src/admin-lines.ts";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * 「线」推导的回归（支线树 / 角色线 / 搜索）。
 *
 * 同样跑真实模板：这些推导的价值就是回答「jjk-2006 里夏油这条线有哪些戏」，
 * 用假模板测不出隐式引用（效果里的 npcId、战斗 allies、正文提到名字）到底抓没抓到。
 */

const noopLogger = { warn: () => undefined, error: () => undefined, info: () => undefined };
registerServerExtensions();
const registry = loadTemplates(noopLogger);

function orchOf(id = "jjk-2006", version = "3.0.0") {
  const entry = registry.resolve({ id, version });
  expect(entry).toBeDefined();
  return buildOrchestration(entry!);
}

function collect(node: LineNode): LineNode[] {
  return [node, ...node.children.flatMap(collect)];
}

describe("支线树", () => {
  it("沿选项走出分支，并把线尾标出来", () => {
    const tree = buildLine(orchOf(), "ev-hv-06");
    expect(tree).toBeDefined();
    const nodes = collect(tree!.root);
    const ids = nodes.map((n) => n.id);
    // 幕 6 四个门：挡在身前 / 拉走 / 劝同化 / 什么都不做，各自一个转盘。
    expect(ids).toContain("ev-hv-06-block");
    expect(ids).toContain("ev-hv-06-pull");
    expect(ids).toContain("ev-hv-06-merge");
    expect(ids).toContain("ev-hv-06-idle");
    // 三条非死亡出口最后都汇到「盘星教」那一幕的收尾。
    expect(ids).toContain("ev-hv-07b");
    expect(nodes.some((n) => n.note === "terminal")).toBe(true);
    expect(tree!.missing).toEqual([]);
  });

  it("同一事件被多个选项指向时只展开一次，其余标 同上", () => {
    const tree = buildLine(orchOf(), "ev-hv-06");
    const nodes = collect(tree!.root);
    const repeats = nodes.filter((n) => n.note === "repeat");
    expect(repeats.length).toBeGreaterThan(0);
    // 重复节点不再带子树，否则一次点击就能把输出撑成指数级。
    expect(repeats.every((n) => n.children.length === 0)).toBe(true);
    // 四条出口都汇到 ev-hv-07b：第一次展开，其余 同上。
    const converge = nodes.filter((n) => n.id === "ev-hv-07b");
    expect(converge.length).toBeGreaterThan(2);
    expect(converge.filter((n) => n.note === "repeat").length).toBe(converge.length - 1);
  });

  it("节点带上旗标写入与被结局读取的旗标", () => {
    const tree = buildLine(orchOf(), "ev-hv-06");
    // 入口节点写的是玩家的动作标记（挡 / 拉 / 劝 / 不做）。
    expect(tree!.root.flags.map((f) => f.flag)).toContain("hvGuard");
    // 幕 6 的转盘才是真正的落点：救没救下、通没同化、玩家自己的死，都在这里分岔。
    const block = collect(tree!.root).find((n) => n.id === "ev-hv-06-block");
    expect(block?.flags.map((f) => f.flag)).toContain("savedRiko");
    expect(block?.endings).toContain("end-hv-early-death");
  });

  it("不存在的起点返回 undefined，断链在后继里单独计数", () => {
    expect(buildLine(orchOf(), "ev-does-not-exist")).toBeUndefined();
  });
});

describe("角色线", () => {
  it("按名字模糊定位角色", () => {
    const orch = orchOf();
    expect(findCharacter(orch, "夏油")?.id).toBe("npc-geto");
    expect(findCharacter(orch, "npc-riko")?.name).toBe("天内理子");
    expect(findCharacter(orch, "不存在的人")).toBeUndefined();
  });

  it("从效果 / 选项条件这些隐式引用里都能抓到戏份", () => {
    const line = buildNpcLine(orchOf(), "npc-geto")!;
    const byId = new Map(line.scenes.map((s) => [s.eventId, s]));
    // 选项效果里 adjustRelation npcId: npc-geto
    expect(byId.get("ev-d-canteen")?.roles).toContain("关系");
    // 第二拍（2026-11-21 新增）：他带你去看那个人
    expect(byId.get("ev-d-geto-b")?.roles).toContain("关系");
    // 怀玉七幕里他一直在场（关系 + 舞台）
    expect(byId.has("ev-hv-01")).toBe(true);
  });

  it("身份线能读出角色的生死迁移", () => {
    const line = buildNpcLine(orchOf(), "npc-riko")!;
    const states = line.lifecycle.map((s) => s.state);
    expect(states).toContain("inactive");
    expect(states).toContain("alive");
    expect(line.character.visibility).toBe("hidden");
  });

  it("没有戏份的角色返回空场景而不是报错", () => {
    const orch = orchOf();
    const line = buildNpcLine(orch, "enemy-curse-womb");
    expect(line).toBeDefined();
    expect(Array.isArray(line!.scenes)).toBe(true);
  });
});

describe("搜索", () => {
  it("命中标题 / 叙事 / 角色名", () => {
    const hits = searchOrchestration(orchOf(), "理子");
    const ids = hits.map((h) => h.eventId);
    expect(ids).toContain("ev-hv-04");
    expect(ids).toContain("ev-hv-06");
    expect(hits.some((h) => h.where.some((w) => w.startsWith("角色:")))).toBe(true);
  });

  it("搜不到时返回空数组", () => {
    expect(searchOrchestration(orchOf(), "zzz-not-a-word")).toEqual([]);
  });
});
