import { describe, expect, it } from "vitest";
import { buildToolDescriptors } from "@life-sim/agent-runtime";
import { buildOpeningPrologueRequest, createWorldV2 } from "@life-sim/game-core";
import {
  BRANCH_MAX_EFFECTS_PER_OPTION,
  BRANCH_MAX_NODES,
  SubmitBranchArgsSchema,
  type WorldTemplateV2,
} from "@life-sim/shared";
import { HISTORY_HARD_CAP, runReadTool } from "../../packages/agent-runtime/src/read-tools.ts";
import { registerServerExtensions } from "../../apps/server/src/extensions.ts";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * 提示词卫生（2026-11-21 自查）：**通用运行时里不许有世界事实**。
 *
 * 两条纪律，各配一个守卫：
 *
 * 1. **不写世界专名**：工具描述是给所有模板共用的一段话。里面出现 `npc-yuji`、`咒力`
 *    这类词，模型会照抄 —— 换一个世界就是错的（以前 `story.submitBranch` 的示例
 *    真的带着 `npc-yuji`）。
 * 2. **数字只有一处定义**：「1..12 个事件块」「默认 50 条」这类数字同时出现在
 *    schema、工具描述、工具表 `maxItems` 三处。三处各写各的就会漂，模型照描述写、
 *    被 schema 拒，整轮作废。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };

// 模板的 `extensions:` 声明要能对上注册表（valmont 声明了 family），否则会被判 invalid。
registerServerExtensions();

function entryOf(id: string, version: string) {
  const entry = loadTemplates(silent).resolve({ id, version });
  if (entry?.status !== "ready") throw new Error(`${id}@${version} 未就绪`);
  return entry;
}

const jjk = () => entryOf("jjk-2006", "3.0.0");
const valmont = () => entryOf("valmont", "1.0.0");

/** 所有模板 × 所有画像的工具描述（模型能看到的全部文字）。 */
function allDescriptors(): Array<{ template: string; profile: string; text: string }> {
  const out: Array<{ template: string; profile: string; text: string }> = [];
  for (const entry of [jjk(), valmont()]) {
    const profiles = Object.keys(entry.rules.toolProfile);
    for (const profile of profiles) {
      const descriptors = buildToolDescriptors(entry.rules, profile);
      out.push({
        template: entry.ref.id,
        profile,
        text: JSON.stringify(descriptors),
      });
    }
  }
  return out;
}

describe("提示词卫生：通用运行时里不许有世界事实", () => {
  it("工具描述里没有任何具体角色 id（示例要用占位符）", () => {
    for (const row of allDescriptors()) {
      // `npc-` 是模板角色 id 的前缀；示例里应写 `<角色id>`。
      expect(row.text, `${row.template}/${row.profile}`).not.toContain("npc-");
    }
  });

  it("工具描述里没有某个世界的专名（咒力 / 咒术 / 世界名）", () => {
    const forbidden = ["咒", "术式", "瓦勒蒙", "valmont", "jjk"];
    for (const row of allDescriptors()) {
      for (const word of forbidden) {
        expect(row.text.includes(word), `${row.template}/${row.profile} 含「${word}」`).toBe(false);
      }
    }
  });

  it("资源叫法由模板决定：mp 叫「能量」时词表就说「恢复能量」", () => {
    const entry = jjk();
    const state = createWorldV2(
      { templateId: entry.ref.id, playerName: "卫生", seed: 7 },
      entry.template,
      "w-hygiene-label",
    );
    const renamed: WorldTemplateV2 = structuredClone(entry.template);
    for (const section of renamed.statusBar) {
      if (section.key === "mp") section.label = "能量";
    }
    renamed.mood.min = 0;
    renamed.mood.max = 10;

    const out = runReadTool(
      "rule.lexicon",
      { section: "effects" },
      {
        snapshot: {
          player: { attributes: {}, resources: [] },
        } as never,
        state,
        template: renamed,
        perspective: "player",
      },
    ) as { shapes: Array<{ name: string; when?: string; caveat?: string }> };

    const mp = out.shapes.find((shape) => shape.name === "mp");
    expect(mp?.when).toContain("能量");
    expect(mp?.when).not.toContain("咒力");

    const mood = out.shapes.find((shape) => shape.name === "mood");
    expect(mood?.caveat).toContain("0..10");
  });

  it("历史条数：描述里的数字与实现常量同一处", () => {
    const descriptor = buildToolDescriptors(jjk().rules, "story").find(
      (tool) => tool.name === "world.history",
    );
    expect(descriptor?.description).toContain(String(HISTORY_HARD_CAP));
  });

  it("分支块数：schema 上限 = 描述里的数字 = 常量", () => {
    const descriptor = buildToolDescriptors(jjk().rules, "story").find(
      (tool) => tool.name === "story.submitBranch",
    );
    expect(descriptor?.description).toContain(String(BRANCH_MAX_NODES));

    const node = (index: number) => ({
      node: `n${index}`,
      title: "块",
      text: "……",
      options: [{ text: "继续", effects: [{ mood: 1 }] }],
    });

    const atLimit = SubmitBranchArgsSchema.safeParse({
      trigger: { mode: "certain" },
      branch: Array.from({ length: BRANCH_MAX_NODES }, (_, i) => node(i)),
    });
    const overLimit = SubmitBranchArgsSchema.safeParse({
      trigger: { mode: "certain" },
      branch: Array.from({ length: BRANCH_MAX_NODES + 1 }, (_, i) => node(i)),
    });
    expect(atLimit.success).toBe(true);
    expect(overLimit.success).toBe(false);
  });

  it("序章的写作指令可被覆写：默认字数只是默认，不是焊死的", () => {
    const input = {
      worldTitle: "某世界",
      worldSummary: "一句话",
      player: { name: "你", gender: "女", age: 16 },
      attributes: [{ name: "体质", value: 6 }],
      traits: ["普通人"],
      choices: [{ step: "出身", choice: "学生" }],
      setting: [],
    };
    expect(buildOpeningPrologueRequest(input).instruction).toContain("180–260");
    expect(buildOpeningPrologueRequest({ ...input, instruction: "写 60 字。" }).instruction).toBe(
      "写 60 字。",
    );
  });

  it("选项效果条数：schema 上限 = 常量", () => {
    const effects = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ mood: i % 2 === 0 ? 1 : -1 }));
    const parse = (count: number) =>
      SubmitBranchArgsSchema.safeParse({
        trigger: { mode: "certain" },
        branch: [
          {
            node: "n1",
            title: "块",
            text: "……",
            options: [{ text: "继续", effects: effects(count) }],
          },
        ],
      });
    expect(parse(BRANCH_MAX_EFFECTS_PER_OPTION).success).toBe(true);
    expect(parse(BRANCH_MAX_EFFECTS_PER_OPTION + 1).success).toBe(false);
  });
});
