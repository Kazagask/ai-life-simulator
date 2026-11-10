import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { WorldTemplateV2Schema, type WorldTemplateV2 } from "./schema/index.js";

/**
 * Schema 校验测试 = 协议验收标准：
 * 1. JJK 示例模板（specs/data/templates/jjk-2006/ 六个 YAML）必须通过校验；
 * 2. 非法样例必须被拒绝。
 */

const TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../specs/data/templates/jjk-2006",
);

const readYaml = (file: string): Record<string, unknown> =>
  YAML.parse(readFileSync(path.join(TEMPLATE_DIR, file), "utf-8")) as Record<string, unknown>;

/** 按加载约定合并六个分域文件（规格第 3 节） */
function loadJjkTemplate(): Record<string, unknown> {
  return {
    ...readYaml("world.yaml"),
    ...readYaml("characters.yaml"),
    ...readYaml("skills.yaml"),
    ...readYaml("items.yaml"),
    ...readYaml("statuses.yaml"),
    ...readYaml("events.yaml"),
  };
}

describe("世界模板协议 V2 Schema", () => {
  it("JJK 示例模板六个 YAML 合并后通过校验", () => {
    const result = WorldTemplateV2Schema.safeParse(loadJjkTemplate());
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`示例模板校验失败：\n${issues}`);
    }
    expect(result.success).toBe(true);
  });

  it("解析结果的关键结构正确", () => {
    const world = WorldTemplateV2Schema.parse(loadJjkTemplate()) as WorldTemplateV2;
    expect(world.meta.id).toBe("jjk-2006");
    expect(world.genders.map((g) => g.id)).toContain("femboy");
    expect(world.mood.bands).toHaveLength(3);
    expect(world.statuses.map((s) => s.id)).toContain("curse-poison");
    expect(world.events.map((e) => e.id)).toContain("ev-shrine-lottery");
    const combatEvent = world.events.find((e) => e.id === "ev-curse-find");
    expect(combatEvent?.kind).toBe("combat");
    const wheel = world.events.find((e) => e.id === "ev-shrine-lottery");
    expect(wheel?.kind).toBe("random");
    if (wheel?.kind === "random") {
      const greatLuck = wheel.settle.random.wheel.segments.find((s) => s.label === "大吉");
      expect(greatLuck?.weightBy).toEqual({ luck: 0.4 });
      const greatOmen = wheel.settle.random.wheel.segments.find((s) => s.label === "大凶");
      expect(greatOmen?.weightBy).toEqual({ luck: -0.3, cursedEnergy: 0.1 });
    }
    expect(world.attributes.order).toContain("luck");
    expect(world.chains?.map((c) => c.id)).toContain("chain-curse-investigation");

    // 主角技能 kits 扩展
    const domainVoid = world.skills.find((s) => s.id === "sk-domain-void");
    expect(domainVoid?.kind).toBe("combat");
    if (domainVoid?.kind === "combat") {
      expect(domainVoid.target).toBe("all_enemies");
      expect(domainVoid.hitCheck).toBeUndefined(); // 省略命中判定 = 必中
    }
    const uzumaki = world.skills.find((s) => s.id === "sk-uzumaki");
    if (uzumaki?.kind === "combat") {
      expect(uzumaki.damage?.[0]?.preset).toBe("stack-scaled");
      expect(uzumaki.consumeStatus?.status).toBe("absorbed-curses");
    }
    const gojo = world.characters.find((c) => c.id === "npc-gojo");
    expect(gojo?.skills).toContain("sk-domain-void");
  });

  it("拒绝：补正既无 simulation 面也无 combat 面", () => {
    const world = loadJjkTemplate();
    (world.statuses as unknown[]).push({
      id: "broken-status",
      name: "坏补正",
      duration: { turns: 1 },
      stacking: "refresh",
      visibility: "known",
    });
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：非法 control 语义", () => {
    const world = loadJjkTemplate();
    (world.statuses as unknown[]).push({
      id: "bad-control",
      name: "非法控制",
      duration: { turns: 1 },
      stacking: "refresh",
      combat: { control: ["fly_to_the_moon"] },
      visibility: "known",
    });
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：strict 模式下的未知字段（拼写保护）", () => {
    const world = loadJjkTemplate();
    (world.items as unknown[]).push({
      id: "item-typo",
      type: "material",
      name: "拼错物品",
      stackable: true,
      usableInBattel: true,
      usableOutsideBattle: true,
    });
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：技能 applyStatus 指向不存在的补正", () => {
    const world = loadJjkTemplate();
    const skill = (world.skills as Array<Record<string, unknown>>).find((s) => s.id === "sk-cursed-strike");
    (skill as { applyStatus: unknown[] }).applyStatus = [{ status: "no-such-status", chance: 0.5 }];
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：mood 档位区间重叠", () => {
    const world = loadJjkTemplate();
    const bands = (world.mood as { bands: unknown[] }).bands;
    bands.push({ id: "overlap", label: "重叠", min: 35, max: 80, attributeModifiers: {} });
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：probability 与 weight 并存", () => {
    const world = loadJjkTemplate();
    const event = (world.events as Array<Record<string, unknown>>).find((e) => e.id === "ev-rumor");
    (event as { trigger: Record<string, unknown> }).trigger.weight = 5;
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：池事件缺少 probability 与 weight", () => {
    const world = loadJjkTemplate();
    const event = (world.events as Array<Record<string, unknown>>).find((e) => e.id === "ev-rumor");
    delete (event as { trigger: Record<string, unknown> }).trigger.probability;
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：事件 nextEventId 指向不存在的事件", () => {
    const world = loadJjkTemplate();
    const event = (world.events as Array<Record<string, unknown>>).find((e) => e.id === "ev-curse-sighting");
    const options = (event as { settle: { normal: { options: unknown[] } } }).settle.normal.options;
    (options[0] as { nextEventId: string }).nextEventId = "ev-not-exist";
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：战斗事件敌人引用不存在的角色", () => {
    const world = loadJjkTemplate();
    const event = (world.events as Array<Record<string, unknown>>).find((e) => e.id === "ev-curse-find");
    ((event as { settle: { combat: { enemies: unknown[] } } }).settle.combat.enemies as Array<Record<string, unknown>>)[0].ref =
      "enemy-who";
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：跨文件重复 id", () => {
    const world = loadJjkTemplate();
    (world.items as unknown[]).push({ ...(world.items as Array<{ id: string }>)[0] });
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：链起点事件 trigger.source 不是 chain", () => {
    const world = loadJjkTemplate();
    const chains = world.chains as Array<Record<string, unknown>>;
    chains[0].startEventId = "ev-rumor";
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：角色引用未定义的性别档位", () => {
    const world = loadJjkTemplate();
    const gojo = (world.characters as Array<Record<string, unknown>>).find((c) => c.id === "npc-gojo");
    ((gojo as { identity: Record<string, unknown> }).identity).gender = "attack-helicopter-typo";
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：consumeStatus 指向不存在的补正", () => {
    const world = loadJjkTemplate();
    const uzumaki = (world.skills as Array<Record<string, unknown>>).find((s) => s.id === "sk-uzumaki");
    (uzumaki as { consumeStatus: Record<string, unknown> }).consumeStatus = { status: "no-such-reserve" };
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：stack-scaled 公式指向不存在的补正", () => {
    const world = loadJjkTemplate();
    const uzumaki = (world.skills as Array<Record<string, unknown>>).find((s) => s.id === "sk-uzumaki");
    ((uzumaki as { damage: Array<Record<string, unknown>> }).damage)[0] = {
      preset: "stack-scaled",
      base: 10,
      perStack: 15,
      status: "no-such-reserve",
    };
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：角色 skills 引用不存在的技能", () => {
    const world = loadJjkTemplate();
    const gojo = (world.characters as Array<Record<string, unknown>>).find((c) => c.id === "npc-gojo");
    (gojo as { skills: string[] }).skills = ["sk-not-exist"];
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：combatHints.skillWeights 引用角色未持有的技能", () => {
    const world = loadJjkTemplate();
    const larva = (world.characters as Array<Record<string, unknown>>).find((c) => c.id === "enemy-curse-larva");
    ((larva as { private: { combatHints: Record<string, unknown> } }).private.combatHints).skillWeights = {
      "sk-curse-bite": 5, // larva 未持有该技能
    };
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：转盘 weightBy 引用未定义的属性", () => {
    const world = loadJjkTemplate();
    const wheel = (world.events as Array<Record<string, unknown>>).find((e) => e.id === "ev-shrine-lottery");
    const segments = (wheel as { settle: { random: { wheel: { segments: unknown[] } } } }).settle.random.wheel.segments;
    (segments[0] as { weightBy: Record<string, number> }).weightBy = { fortune: 0.5 };
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("接受：资源公式 perAttribute 引用已定义属性", () => {
    const world = loadJjkTemplate();
    (world.resources as Record<string, unknown>).hp = { base: 75, perLevel: 10, perAttribute: { cursedEnergy: 5 } };
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(true);
  });

  it("拒绝：资源公式 perAttribute 引用未定义的属性", () => {
    const world = loadJjkTemplate();
    (world.resources as Record<string, unknown>).hp = { base: 75, perAttribute: { fortune: 5 } };
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：adjustAttribute 效果引用未定义的属性", () => {
    const world = loadJjkTemplate();
    const event = (world.events as Array<Record<string, unknown>>).find((e) => e.id === "ev-rumor");
    const options = (event as { settle: { normal: { options: Array<Record<string, unknown>> } } }).settle.normal.options;
    options[0].effects = [{ type: "adjustAttribute", attribute: "fortune", value: 1 }];
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("接受：adjustAttribute 效果引用已定义属性", () => {
    const world = loadJjkTemplate();
    const event = (world.events as Array<Record<string, unknown>>).find((e) => e.id === "ev-rumor");
    const options = (event as { settle: { normal: { options: Array<Record<string, unknown>> } } }).settle.normal.options;
    options[0].effects = [{ type: "adjustAttribute", attribute: "cursedEnergy", value: 1 }];
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(true);
  });
});
