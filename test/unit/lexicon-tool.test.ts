import { describe, expect, it } from "vitest";
import { createWorldV2, projectSnapshotV2 } from "@life-sim/game-core";
import { runReadTool, type ReadToolDeps } from "../../packages/agent-runtime/src/read-tools.ts";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * `rule.lexicon`（2026-11-21）：渐进披露的词表入口。
 *
 * 用户实测「LLM 提交的选项基本没有效果」之后加的：模型不知道有哪些效果形状、
 * 也不知道能引用谁，于是只能写空效果。词表做成**按需查询**而不是每轮塞进 prompt ——
 * 它有几十件物品、几十条状态，塞进上下文既贵又会挤掉叙事素材。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function depsOf(): ReadToolDeps {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  const state = createWorldV2(
    { templateId: "jjk-2006", playerName: "测试", seed: 41 },
    entry.template,
    "w-lexicon",
  );
  state.openingCompleted = true;
  return {
    snapshot: projectSnapshotV2(state, entry.template, entry.lookup),
    state,
    template: entry.template,
    perspective: "player",
  };
}

const ask = (section?: string) =>
  runReadTool("rule.lexicon", section === undefined ? {} : { section }, depsOf()) as Record<string, unknown>;

describe("rule.lexicon：先目录，再按节取", () => {
  it("不带参数 ⇒ 目录（渐进披露第一跳，不倾倒全文）", () => {
    const index = ask();
    expect((index.sections as Array<{ id: string }>).map((s) => s.id)).toEqual([
      "effects",
      "items",
      "statuses",
    ]);
    expect(JSON.stringify(index)).not.toContain("item-first-aid");
  });

  it("section=effects ⇒ 9 种形状 + 属性 / 资源 / 关系 kind / 在场角色", () => {
    const effects = ask("effects");
    expect((effects.shapes as Array<{ name: string }>).map((s) => s.name)).toEqual([
      "flag",
      "mood",
      "hp",
      "mp",
      "spawn",
      "relation",
      "relationEdge",
      "secret",
      "lifecycle",
    ]);
    // 属性：id + 显示名 + 当前值（模板 labels 是唯一来源）
    const ce = (effects.attributes as Array<{ id: string; label: string; value: unknown }>).find(
      (a) => a.id === "cursedEnergyTotal",
    );
    expect(ce?.label).toBe("咒力总量");
    expect(typeof ce?.value).toBe("number");
    // 资源：hp / mp 至少在
    const ids = (effects.resources as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["hp", "mp"]));
    // 关系 kind 来自 shared 枚举，不从模板猜
    expect(effects.relationKinds).toEqual(expect.arrayContaining(["mentor", "friend", "father"]));
    // 在场角色：只给活着的，且带 id
    const npcs = effects.npcs as Array<{ id: string; name: string }>;
    expect(npcs.length).toBeGreaterThan(0);
    expect(npcs.every((npc) => npc.id.startsWith("npc-"))).toBe(true);
  });

  it("section=items ⇒ 物品词表（id / 名字 / 类型）", () => {
    const items = ask("items") as { items: Array<{ id: string; name: string; type: string }> };
    const firstAid = items.items.find((item) => item.id === "item-first-aid");
    expect(firstAid?.name).toBeTruthy();
    expect(firstAid?.type).toBe("consumable");
  });

  it("section=statuses ⇒ 状态词表带三类生命周期", () => {
    const statuses = ask("statuses") as { statuses: Array<{ id: string; kind: string }> };
    expect(statuses.statuses.some((s) => s.kind === "talent")).toBe(true);
    expect(statuses.statuses.some((s) => s.id === "heavenly-restriction")).toBe(true);
  });

  it("未知 section 退回目录（写错参数不炸整轮）", () => {
    const index = ask("nonsense");
    expect(Array.isArray(index.sections)).toBe(true);
  });

  it("没有模板 ⇒ 明说拿不到清单，不臆造", () => {
    const deps = depsOf();
    const { template: _template, ...withoutTemplate } = deps;
    const result = runReadTool("rule.lexicon", { section: "effects" }, withoutTemplate) as {
      error?: string;
    };
    expect(result.error).toContain("模板");
  });
});
