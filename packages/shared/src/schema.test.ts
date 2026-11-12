import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { EndingConfigSchema, OpeningTemplateSchema, WorldTemplateV2Schema, type WorldTemplateV2 } from "./schema/index.js";

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
    // 模板以「命数转盘」开局链为核心：13 步创建 + 五章主线链
    const wheelEntry = world.events.find((e) => e.id === "ev-opening-wheel");
    expect(wheelEntry?.kind).toBe("normal");
    expect(wheelEntry?.trigger.source).toBe("chain");
    const creationChain = world.chains?.find((c) => c.id === "chain-creation");
    expect(creationChain?.steps).toHaveLength(13);
    expect(world.chains?.map((c) => c.id)).toEqual([
      "chain-creation",
      "chain-sp",
      "chain-geto",
      "chain-night",
      "chain-shibuya",
      "chain-finale",
    ]);
    // 五章章节机：chapter 1..5 各有一个概率 1 的池触发器
    for (let ch = 1; ch <= 5; ch++) {
      expect(
        world.events.some((e) => e.trigger.source === "pool" && e.trigger.conditions?.some((c) => "flag" in c && c.flag === "chapter" && c.eq === ch)),
      ).toBe(true);
    }
    expect(world.attributes.order).toContain("luck");

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
    const event = (world.events as Array<Record<string, unknown>>).find((e) => e.id === "ev-w01");
    (event as { trigger: Record<string, unknown> }).trigger = { source: "pool", probability: 0.5, weight: 5 };
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：池事件缺少 probability 与 weight", () => {
    const world = loadJjkTemplate();
    const event = (world.events as Array<Record<string, unknown>>).find((e) => e.id === "ev-w01");
    (event as { trigger: Record<string, unknown> }).trigger = { source: "pool" };
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：事件 nextEventId 指向不存在的事件", () => {
    const world = loadJjkTemplate();
    const event = (world.events as Array<Record<string, unknown>>).find((e) => e.id === "ev-w01");
    const options = (event as { settle: { normal: { options: unknown[] } } }).settle.normal.options;
    (options[0] as { nextEventId: string }).nextEventId = "ev-not-exist";
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：战斗事件敌人引用不存在的角色", () => {
    const world = loadJjkTemplate();
    (world.events as unknown[]).push({
      id: "ev-combat-test",
      title: "测试战",
      narrative: "引用完整性用合成战斗事件。",
      trigger: { source: "chain" },
      kind: "combat",
      settle: { combat: { enemies: [{ ref: "enemy-who" }], canFlee: false } },
    });
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：跨文件重复 id", () => {
    const world = loadJjkTemplate();
    (world.items as unknown[]).push({ ...(world.items as Array<{ id: string }>)[0] });
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("拒绝：链起点事件 trigger.source 不是 chain", () => {
    const world = loadJjkTemplate();
    const nonChain = (world.events as Array<Record<string, unknown>>).find((e) => e.id === "ev-w05");
    (nonChain as { trigger: Record<string, unknown> }).trigger = { source: "pool", probability: 0.5 };
    const chains = world.chains as Array<Record<string, unknown>>;
    chains[0].startEventId = "ev-w05";
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
    (world.events as unknown[]).push({
      id: "ev-wheel-test",
      title: "测试转盘",
      narrative: "weightBy 引用完整性用合成转盘事件。",
      trigger: { source: "pool", probability: 1 },
      kind: "random",
      settle: {
        random: {
          wheel: { segments: [{ weight: 1, label: "吉", weightBy: { fortune: 0.5 }, effects: [] }] },
        },
      },
    });
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
    const event = (world.events as Array<Record<string, unknown>>).find((e) => e.id === "ev-w01");
    const options = (event as { settle: { normal: { options: Array<Record<string, unknown>> } } }).settle.normal.options;
    options[0].effects = [{ type: "adjustAttribute", attribute: "fortune", value: 1 }];
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(false);
  });

  it("接受：adjustAttribute 效果引用已定义属性", () => {
    const world = loadJjkTemplate();
    const event = (world.events as Array<Record<string, unknown>>).find((e) => e.id === "ev-w01");
    const options = (event as { settle: { normal: { options: Array<Record<string, unknown>> } } }).settle.normal.options;
    options[0].effects = [{ type: "adjustAttribute", attribute: "cursedEnergy", value: 1 }];
    expect(WorldTemplateV2Schema.safeParse(world).success).toBe(true);
  });
});

/**
 * D-17：属性键必须已在 `attributes.order` 中声明。
 *
 * 既有 superRefine 已强制 `attributes.labels` 的键 ⊆ order，也已校验 `characters[].attributes`；
 * 漏的是 `attributes.defaults` 与 `playerTemplate.attributes` —— 这个**不对称**才是缺口本质：
 * 引擎会把这两处直接写进 player.attributes，而 labels 只可能给 order 内的键配名字，
 * ⇒ 玩家端多出一行英文机器名（不报错、不空白，静默退化、极难归因）。故在加载期 fail-fast。
 */
describe("D-17 加载期校验 · 属性键必须已在 attributes.order 中声明", () => {
  function issuesOf(input: unknown): Array<{ path: string; message: string }> {
    const res = WorldTemplateV2Schema.safeParse(input);
    expect(res.success, "应被拒载").toBe(false);
    if (res.success) return [];
    return res.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  }

  it("拒绝：attributes.defaults 出现 order 外键，错误定位到该键本身", () => {
    const world = loadJjkTemplate();
    const attributes = world.attributes as { defaults: Record<string, number> };
    attributes.defaults = { ...attributes.defaults, fortune: 3 };
    const issues = issuesOf(world);
    const hit = issues.find((i) => i.path === "attributes.defaults.fortune");
    expect(hit, `issue 路径不对：${JSON.stringify(issues)}`).toBeDefined();
    expect(hit!.message).toContain("未知属性：fortune");
    expect(hit!.message).toContain("attributes.order");
  });

  it("拒绝：playerTemplate.attributes 出现 order 外键", () => {
    const world = loadJjkTemplate();
    const pt = world.playerTemplate as { attributes: Record<string, number> };
    pt.attributes = { ...pt.attributes, stealth: 3 };
    const issues = issuesOf(world);
    expect(issues.some((i) => i.path === "playerTemplate.attributes.stealth")).toBe(true);
  });

  it("回归：characters[].attributes 越界由**既有**校验拦下，且只报一条（新实现不得重复）", () => {
    const world = loadJjkTemplate();
    const characters = world.characters as Array<{ id: string; attributes: Record<string, number> }>;
    characters[2].attributes = { ...characters[2].attributes, stealth: 3 };
    const issues = issuesOf(world);
    // 既有校验的 path 指向 attributes 对象（不含键名），保持原样以兼容既有消费方
    const hits = issues.filter((i) => i.path === "characters.2.attributes");
    expect(hits.length, `同一问题只应报一次：${JSON.stringify(issues)}`).toBe(1);
    expect(hits[0].message).toContain("未知属性：stealth");
  });

  it("接受：现网 jjk-2006 的全部属性键（defaults / playerTemplate / 16 个角色）都在 order 内", () => {
    const world = WorldTemplateV2Schema.parse(loadJjkTemplate());
    const order = new Set(world.attributes.order);
    const keys = [
      ...Object.keys(world.attributes.defaults),
      ...Object.keys(world.playerTemplate?.attributes ?? {}),
      ...world.characters.flatMap((c) => Object.keys(c.attributes)),
    ];
    expect(keys.filter((k) => !order.has(k))).toEqual([]);
  });
});


/**
 * 阶段 4 遗留接线后的分域验收：jjk-2006 现在真的提供 endings.yaml / opening.yaml，
 * 因此这两个文件必须像六个主文件一样有加载期校验与引用完整性保护。
 */
describe("结局 / 开局分域（jjk-2006 真实文件）", () => {
  const readRaw = (file: string): unknown => YAML.parse(readFileSync(path.join(TEMPLATE_DIR, file), "utf-8"));

  it("endings.yaml 通过 EndingConfigSchema", () => {
    const parsed = EndingConfigSchema.safeParse(readRaw("endings.yaml"));
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
    }
    expect(parsed.data.terminationConditions.length).toBeGreaterThan(0);
    expect(parsed.data.endings.some((e) => e.fallback)).toBe(true);
    expect(parsed.data.fallback).toBe("end-ordinary");
    expect(parsed.data.deathRoute?.deathMode).toBe("direct");
    // ADR-0006：隐藏结局 = narrativeConfig.masked 存在；模板不再有 visibility 字段
    const secret = parsed.data.endings.find((e) => e.endingId === "end-secret-savior");
    expect(secret?.narrativeConfig.masked).toBeDefined();
    expect(secret?.triggerConditions.length).toBeGreaterThan(0);
    // 五章主线 flag 都能兑现成结局：结局与玩法闭环（不出现「写了但拿不到」的结局）
    const flags = parsed.data.endings.flatMap((e) =>
      e.triggerConditions.flatMap((c) => ("flag" in c ? [c.flag] : [])),
    );
    for (const flag of ["rikoSaved", "getoSaved", "joinedCurse", "shibuyaSurvived", "specialGrade", "leaveJujutsu"]) {
      expect(flags).toContain(flag);
    }
    const raw = readRaw("endings.yaml") as { endings: Array<Record<string, unknown>> };
    expect(raw.endings.every((e) => !("visibility" in e))).toBe(true);
  });

  it("拒绝：以 HP 数值作终止判据（R-EN-07 / P9）", () => {
    const cfg = readRaw("endings.yaml") as { terminationConditions: Array<{ params: { conditions: unknown[] } }> };
    cfg.terminationConditions[0].params.conditions = [{ attribute: "hp", lte: 0 }];
    expect(EndingConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it("拒绝：fallback 指向未定义的结局", () => {
    const cfg = readRaw("endings.yaml") as { fallback: string };
    cfg.fallback = "end-not-exist";
    expect(EndingConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it("opening.yaml 通过 OpeningTemplateSchema，两个开局 id 唯一", () => {
    const parsed = OpeningTemplateSchema.array().safeParse(readRaw("opening.yaml"));
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
    }
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data.map((o) => o.openingId)).toEqual(["op-2006-tokyo", "op-2006-kyoto"]);
  });

  it("opening.yaml 的待决事件与排程均指向 events.yaml 已定义事件", () => {
    const world = loadJjkTemplate();
    const eventIds = new Set((world.events as Array<{ id: string }>).map((e) => e.id));
    const openings = OpeningTemplateSchema.array().parse(readRaw("opening.yaml"));
    for (const op of openings) {
      for (const id of op.handoff.pendingEvents) expect(eventIds.has(id), `${op.openingId} -> ${id}`).toBe(true);
      for (const s of op.handoff.schedule) expect(eventIds.has(s.eventId), `${op.openingId} -> ${s.eventId}`).toBe(true);
    }
  });

  it("opening.yaml 待决事件都是 kind: normal（否则首轮卡在 event_not_normal）", () => {
    const world = loadJjkTemplate();
    const byId = new Map((world.events as Array<{ id: string; kind: string }>).map((e) => [e.id, e]));
    const openings = OpeningTemplateSchema.array().parse(readRaw("opening.yaml"));
    for (const op of openings) {
      for (const id of op.handoff.pendingEvents) expect(byId.get(id)?.kind).toBe("normal");
    }
  });
});
