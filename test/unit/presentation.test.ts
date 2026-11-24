import { describe, expect, it } from "vitest";
import {
  EffectSummarySchema,
  OpeningBranchDagSchema,
  StyleSpecSchema,
  UiConfigSchema,
  QUALITY_TIER_IDS,
  isQualityTier,
  type EffectSummary,
  type Item,
  type StatusEffect,
} from "@life-sim/shared";
import {
  applyStatusToPlayer,
  diffGains,
  captureGainBaseline,
  equipmentEffectSummaries,
  itemEffectSummaries,
  resolveEntityStyle,
  resolveEntityTags,
  resolveStyle,
  tagIdsOf,
  resolveTags,
  skillEffectSummaries,
  statusEffectSummaries,
  validateStyleRefs,
} from "@life-sim/game-core";
import { makeWorld } from "../helpers/world.ts";

const ui = UiConfigSchema.parse({
  styles: {
    rainbow: { preset: "rainbow", animation: "rainbow-flow" },
    custom: { color: "#ff00aa", bold: true },
  },
  qualityStyles: { mythic: "rainbow", odd: "custom" },
});

describe("样式协议（ADR-002 D2）", () => {
  it("未知 preset / 非法颜色 / 任意 CSS 在 schema 层就被拒", () => {
    expect(StyleSpecSchema.safeParse({ preset: "rainbow" }).success).toBe(true);
    expect(StyleSpecSchema.safeParse({ color: "#abc" }).success).toBe(true);
    expect(StyleSpecSchema.safeParse({ color: "gold" }).success).toBe(true);
    expect(StyleSpecSchema.safeParse({ preset: "platinum" }).success).toBe(false);
    expect(StyleSpecSchema.safeParse({ color: "red" }).success).toBe(false);
    expect(StyleSpecSchema.safeParse({ color: "red;background:url(x)" }).success).toBe(false);
    expect(StyleSpecSchema.safeParse({ animation: "spin" }).success).toBe(false);
    expect(StyleSpecSchema.safeParse({ unknown: 1 }).success).toBe(false);
  });

  it("解析顺序：自身 style > quality 映射 > 默认", () => {
    // 自身 style 优先
    expect(resolveStyle("custom", "mythic", ui)).toEqual({ color: "#ff00aa", bold: true });
    // 自身没有 ⇒ 按 quality 查
    expect(resolveStyle(undefined, "mythic", ui)).toEqual({ preset: "rainbow", animation: "rainbow-flow" });
    // 都没有 ⇒ undefined（默认样式）
    expect(resolveStyle(undefined, "common", ui)).toBeUndefined();
    // 没有 ui.yaml ⇒ 不解析（零回归）
    expect(resolveStyle(undefined, "mythic", undefined)).toBeUndefined();
  });

  it("正负零与品级独立：只写 polarity 也能拿到绿 / 红 / 灰", () => {
    expect(resolveStyle(undefined, undefined, ui, "negative")?.preset).toBe("red");
    expect(resolveStyle(undefined, undefined, ui, "positive")?.preset).toBe("green");
    expect(resolveStyle(undefined, undefined, ui, "neutral")?.preset).toBe("gray");
    // 模板覆盖正负映射时以模板为准
    const custom = UiConfigSchema.parse({ polarityStyles: { negative: "purple" } });
    expect(resolveStyle(undefined, undefined, custom, "negative")?.preset).toBe("purple");
    // 品级优先于正负零（fixture 的 qualityStyles 里 mythic → rainbow）
    expect(resolveStyle(undefined, "mythic", ui, "negative")?.preset).toBe("rainbow");
  });

  it("颜色 token 解析成 CSS 变量，十六进制原样", () => {
    const style = resolveStyle("gold-tone", undefined, UiConfigSchema.parse({ styles: { "gold-tone": { color: "gold" } } }));
    expect(style?.color).toContain("var(--");
  });

  it("未知样式 id 在加载期被拒（不静默回退）", () => {
    const { entry } = makeWorld();
    const issues = validateStyleRefs(
      { ...entry.template, statuses: [{ ...entry.template.statuses[0]!, style: "nope" }] },
      ui,
    );
    expect(issues.map((i) => i.path)).toContain("statuses[0].style");
    expect(validateStyleRefs(entry.template, ui)).toEqual([]);
  });
});

describe("效果摘要（ADR-002 D3）", () => {
  const { entry } = makeWorld();
  const lookup = entry.lookup;

  it("状态：属性 / 控制 / 战斗面分别出条目，控制类 kind=control", () => {
    const def: StatusEffect = {
      id: "stun",
      name: "眩晕",
      kind: "battle",
      stacking: "unique",
      polarity: "negative",
      visibility: "known",
      attributeModifiers: { energy: -2 },
      combat: { control: ["cannot_act"], hitChance: -0.1 },
    };
    const out = statusEffectSummaries(def, lookup);
    // 底层效果只描述战斗能力限制，**不带回合数**（回合数属于状态的 duration）
    const control = out.find((e) => e.kind === "control");
    expect(control?.text).toBe("战斗中无法行动");
    expect(control?.text).not.toContain("回合");
    expect(control?.note).not.toContain("回合");
    expect(out.some((e) => e.kind === "attr" && e.tone === "debuff")).toBe(true);
    expect(out.some((e) => e.text.includes("命中"))).toBe(true);
  });

  it("技能：消耗 / 目标齐全；冷却按需出现（0 = 什么都不展示）", () => {
    const skill = entry.template.skills.find((s) => s.kind === "combat");
    if (skill === undefined) return;
    const out = skillEffectSummaries(skill, lookup);
    // 零消耗写「无消耗」（2026-11-20）；冷却同理，`cooldownTurns` 为 0 时整行不出现。
    expect(out.some((e) => e.kind === "cost" && /^(消耗|无消耗)/.test(e.text))).toBe(true);
    expect(out.filter((e) => e.text.startsWith("冷却"))).toHaveLength(skill.cooldownTurns > 0 ? 1 : 0);
  });

  it("物品：消耗品效果翻译成「恢复 30 生命」这类句子", () => {
    const item: Item = {
      id: "potion",
      type: "consumable",
      name: "回复药",
      stackable: true,
      usableInBattle: true,
      usableOutsideBattle: true,
      use: [{ type: "adjustResource", resource: "hp", value: 30 }],
    };
    const out = itemEffectSummaries(item, lookup);
    expect(out[0]?.text).toContain("恢复");
    expect(out[0]?.tone).toBe("buff");
  });

  it("装备动态状态只描述规则，不算值", () => {
    const eq: Item = {
      id: "blade",
      type: "equipment",
      name: "咒具",
      stackable: false,
      usableInBattle: false,
      usableOutsideBattle: false,
      slot: "weapon",
      category: "blade",
      quality: "rare",
      dynamicModifiers: [
        { attribute: "energy", preset: "scaled", params: { base: 3, scaleBy: "energy", multiplier: 0.2 } },
      ],
    };
    const out = equipmentEffectSummaries(eq, lookup);
    expect(out[0]?.text).toContain("随成长");
    expect(out[0]?.text).not.toMatch(/^\D*\d+\.\d+/);
  });

  it("施加状态类条目带被引用实体的样式（浮层里「施加 力竭」也要有色）", () => {
    const { entry } = makeWorld();
    const def: StatusEffect = {
      id: "carrier",
      name: "载体",
      duration: { turns: 1 },
      stacking: "unique",
      visibility: "known",
      simulation: { attributeModifiers: { energy: 1 } },
      combat: { control: ["cannot_act"] },
    };
    const out = statusEffectSummaries(def, entry.lookup);
    const control = out.find((e) => e.kind === "control");
    expect(control?.note).toBeDefined();
  });

  it("效果摘要 schema 是闭集（未知 kind 拒收）", () => {
    expect(EffectSummarySchema.safeParse({ text: "x", kind: "attr" }).success).toBe(true);
    expect(EffectSummarySchema.safeParse({ text: "x", kind: "magic" }).success).toBe(false);
    expect(EffectSummarySchema.safeParse({ text: "x", kind: "control", unclear: 1 }).success).toBe(false);
  });
});

describe("回合增量（ADR-002 D4）", () => {
  it("五类变化各出条目，顺序稳定", () => {
    const { state, entry } = makeWorld(7);
    const before = captureGainBaseline(state);
    const after = structuredClone(state);
    after.player.attributes.energy = (after.player.attributes.energy ?? 0) + 2;
    after.player.statuses = [...after.player.statuses, { statusId: entry.template.statuses[0]!.id, stacks: 2, sinceTurn: 0 }];
    after.player.inventory["item-first-aid"] = 1;
    const gains = diffGains(before, after, entry.lookup);
    const cats = gains.map((g) => g.category);
    expect(cats).toContain("attribute");
    expect(cats).toContain("status");
    expect(cats).toContain("item");
    // 顺序固定：属性 → 状态 → 技能 → 物品 → 装备
    const rank = ["attribute", "status", "skill", "item", "equipment"];
    expect(cats).toEqual([...cats].sort((a, b) => rank.indexOf(a) - rank.indexOf(b)));
    const attr = gains.find((g) => g.category === "attribute");
    expect(attr?.amount).toBe(2);
    expect(attr?.action).toBe("up");
  });

  it("没有变化 ⇒ 空数组（同输入同输出）", () => {
    const { state, entry } = makeWorld(7);
    const before = captureGainBaseline(state);
    expect(diffGains(before, structuredClone(state), entry.lookup)).toEqual([]);
  });
});

describe("开局 DAG 与样式解耦（回归）", () => {
  it("没有 ui 时 opening DAG 仍可加载（样式不是开局参数）", () => {
    const dag = OpeningBranchDagSchema.safeParse({
      openingId: "op",
      name: "n",
      entry: "a",
      params: [],
      nodes: [{ node: "a", title: "t", mode: "roll", options: [{ id: "o", text: "x", set: {} }] }],
    });
    expect(dag.success).toBe(true);
  });
});

// 让未使用的类型导入不报 lint（EffectSummary 用于上面的 schema 断言）
const _typecheck: EffectSummary = { text: "x", kind: "attr" };
void _typecheck;

describe("开局所得（ADR-002 D4 的开局版本）", () => {
  it("每步与 commit 用同一份 collectOpeningGains：技能/物品/状态/属性都出现", async () => {
    const { loadTemplates } = await import("../../apps/server/src/templates.ts");
    const { createOpeningSession, resolveStep, collectOpeningGains, describeNode } = await import(
      "../../packages/game-core/src/v2/opening-dag.ts"
    );
    const entry = loadTemplates({ warn: () => {}, error: () => {}, info: () => {} }).resolve({
      id: "jjk-2006",
      version: "3.0.0",
    });
    if (entry?.status !== "ready" || entry.openingDag === undefined) throw new Error("not ready");

    const walk = (seed: number) => {
    let session = createOpeningSession(entry.openingDag, seed);
    for (let guard = 0; !session.done && guard < 40; guard += 1) {
      const node = entry.openingDag.nodes.find((n) => n.node === session.nodeId);
      if (node === undefined) break;
      if (node.mode === "roll") {
        session = resolveStep(entry.openingDag, session, { kind: "roll" }).session;
        continue;
      }
      if (node.mode === "input") {
        session = resolveStep(entry.openingDag, session, { kind: "input", value: "测试名字" }).session;
        continue;
      }
      if (node.mode === "allocate") {
        // ADR-004：这条用例只关心「各类条目都出现」，加点按第一项吃满走个过场。
        const view = describeNode(entry.openingDag, session, { template: entry.template });
        const allocation: Record<string, number> = {};
        let left = view?.allocation?.budget ?? 0;
        for (const target of view?.allocation?.targets ?? []) {
          const take = Math.min(left, target.max ?? left);
          allocation[target.attribute] = take;
          left -= take;
        }
        session = resolveStep(entry.openingDag, session, { kind: "allocate", allocation }).session;
        continue;
      }
      session = resolveStep(entry.openingDag, session, {
        kind: "choose",
        optionId: node.options![0]!.id,
      }).session;
    }

      return session;
    };

    // 池子的落点随 seed 变（2026-11-23 术式池拆成三格后，4242 不再落到带状态的格子）。
    // 这条用例只关心「各类条目能同时出现」，所以扫几个 seed 找一个齐全的。
    let gains: ReturnType<typeof collectOpeningGains> = [];
    for (let seed = 4242; seed <= 4262; seed += 1) {
      const candidate = collectOpeningGains(entry.openingDag, walk(seed), entry.template, entry.ui);
      const seen = new Set(candidate.map((g) => g.category));
      if (seen.has("status") && seen.has("skill")) {
        gains = candidate;
        break;
      }
    }
    expect(gains.length).toBeGreaterThan(0);
    const categories = new Set(gains.map((g) => g.category));
    expect(categories.has("status")).toBe(true);
    expect(categories.has("skill")).toBe(true);
    // 属性增减（出身/天赋/体质都是 add；`set` 的形态由下一条用例覆盖）
    expect(gains.some((g) => g.category === "attribute" && (g.action === "up" || g.action === "down"))).toBe(true);
    // 条目自带详情快照（否则开局面板点开详情会「没反应」）
    const status = gains.find((g) => g.category === "status");
    expect(status?.effects?.length ?? 0).toBeGreaterThan(0);

    // 2026-11-19 的 v3 开局不白送物品（旧开局「第六格咒具」已随转盘下线），
    // item 分支改用夹具：物品条目仍要带数量与效果摘要。
    const itemDag = OpeningBranchDagSchema.parse({
      openingId: "op-item",
      name: "物品所得",
      entry: "a",
      params: [{ id: "it", kind: "item" }],
      nodes: [
        {
          node: "a",
          title: "战利品",
          mode: "choose",
          options: [{ id: "x", text: "收下", set: { it: { itemId: "item-first-aid", count: 2 } } }],
        },
      ],
    });
    const itemSession = resolveStep(itemDag, createOpeningSession(itemDag, 1), {
      kind: "choose",
      optionId: "x",
    }).session;
    const itemGains = collectOpeningGains(itemDag, itemSession, entry.template, entry.ui);
    const itemGain = itemGains.find((g) => g.category === "item");
    expect(itemGain?.amount).toBe(2);
    expect(itemGain?.name).toBe("急救包");
  });
});

describe("开局所得：初始值形态（action=set）", () => {
  it("mode:set 的属性记成 set，展示为绝对值而不是 +N", async () => {
    const { createOpeningSession, resolveStep, collectOpeningGains } = await import(
      "../../packages/game-core/src/v2/opening-dag.ts"
    );
    const { entry } = makeWorld();
    const dag = OpeningBranchDagSchema.parse({
      openingId: "op-attr",
      name: "属性测验",
      entry: "a",
      params: [{ id: "attr", kind: "attribute" }],
      nodes: [
        {
          node: "a",
          title: "t",
          mode: "choose",
          options: [{ id: "o", text: "x", set: { attr: { id: "luck", value: 12, mode: "set" } } }],
        },
      ],
    });
    let session = createOpeningSession(dag, 1);
    session = resolveStep(dag, session, { kind: "choose", optionId: "o" }).session;
    const gains = collectOpeningGains(dag, session, entry.template);
    expect(gains).toHaveLength(1);
    expect(gains[0]).toMatchObject({ category: "attribute", action: "set", amount: 12 });
  });
});

describe("标签（ADR-002 D2b）", () => {
  it("标签自带样式，且名字颜色由它决定（品质不再是展示字段）", () => {
    const ui = UiConfigSchema.parse({
      tags: {
        mythic: { name: "神话", style: { preset: "rainbow", animation: "rainbow-flow" } },
        buff: { name: "增益", style: { preset: "green" } },
      },
    });
    const tags = resolveTags(["mythic", "buff"], ui);
    expect(tags.map((t) => t.name)).toEqual(["神话", "增益"]);
    expect(tags[0]?.style?.preset).toBe("rainbow");
    // 靠前的标签优先：神话压过增益
    expect(resolveStyle(undefined, undefined, ui, undefined, ["mythic", "buff"])?.preset).toBe("rainbow");
    expect(resolveStyle(undefined, undefined, ui, undefined, ["buff"])?.preset).toBe("green");
    // 未声明的 id ⇒ 丢弃（不编造名字），空输入 ⇒ 空数组
    expect(resolveTags(["nope"], ui)).toEqual([]);
    expect(resolveTags(undefined, ui)).toEqual([]);
  });

  it("引擎预置标签：模板不写也能用，写同名 id 则覆盖单条", () => {
    // 不传 ui ⇒ 用预置词表
    expect(resolveTags(["mythic-unique", "buff"], undefined).map((t) => t.name)).toEqual(["唯一·神话", "增益"]);
    expect(resolveTags(["poor"], undefined)[0]?.style?.preset).toBe("gray");
    expect(resolveTags(["rare"], undefined)[0]?.style?.preset).toBe("cyan");
    // 名字颜色同样走预置：唯一·神话 = 动态彩，优先于增益
    expect(resolveStyle(undefined, undefined, undefined, undefined, ["mythic-unique", "buff"])?.preset).toBe("rainbow");
    // 模板覆盖同名 id，其余继续继承预置
    const custom = UiConfigSchema.parse({ tags: { legendary: { name: "传说·改", style: { preset: "gold" } } } });
    expect(resolveTags(["legendary"], custom)[0]?.name).toBe("传说·改");
    expect(resolveTags(["mythic"], custom)[0]?.name).toBe("一品·神话");
  });

  it("状态正负是一等字段：配色读 polarity，不再从 tags 推断", () => {
    const ui = undefined;
    expect(resolveEntityStyle({ polarity: "positive" }, ui)?.preset).toBe("green");
    // 即便挂了 `buff` 标签，正负仍以 polarity 为准（语义标签不再参与状态配色）
    expect(resolveEntityStyle({ tags: ["buff"], polarity: "negative" }, ui)?.preset).toBe("red");
    expect(resolveEntityStyle({ tags: ["abnormal"], polarity: "neutral" }, ui)?.preset).toBe("gray");
    // 品级是**身份色**（个人面板），优先于正负；战斗面由 UI 直接读 polarity，两套口径互不干扰
    expect(resolveEntityStyle({ quality: "epic", polarity: "positive" }, ui)?.preset).toBe("orange");
  });

  it("施加点决定时长：给多久就多久，不给就是永久（ADR-009）", () => {
    const { state, entry } = makeWorld();
    const DAY = 24 * 60;
    // 时长只由施加点说（ADR-009）：给一天就到明天这个时候，定义里没有可继承的默认值。
    applyStatusToPlayer(state, "inj", 1, entry.lookup, { value: 1, unit: "day" });
    expect(state.player.statuses.find((s) => s.statusId === "inj")?.expiresAt).toBe(state.worldTime + DAY);
    // 再施加一次（ADR-011 D1）：时长按**这一次**重算，不给上一次的留缝；层数仍按 unique 不动
    applyStatusToPlayer(state, "inj", 1, entry.lookup, { value: 3, unit: "day" });
    expect(state.player.statuses.find((s) => s.statusId === "inj")?.expiresAt).toBe(state.worldTime + 3 * DAY);
    // 不给时长 = 永久（只有「挂载身份」会这么调用）
    applyStatusToPlayer(state, "inj", 1, entry.lookup);
    expect(state.player.statuses.find((s) => s.statusId === "inj")?.expiresAt).toBeUndefined();
  });

  it("quality 写品级阶梯 id 会自动生成标签（装备不必再写 tags）", () => {
    expect(isQualityTier("legend")).toBe(true);
    expect(isQualityTier("cursed")).toBe(false);

    // 只写 quality ⇒ 自动一条品级标签
    expect(tagIdsOf({ quality: "legend" })).toEqual(["legend"]);
    expect(resolveEntityTags({ quality: "legend" }, undefined).map((t) => t.name)).toEqual(["二品·传说"]);
    expect(resolveEntityStyle({ quality: "legend" }, undefined)?.preset).toBe("gold");

    // 写了 tags ⇒ tags 优先（品级 + 增益这种多标签场景仍然可用）
    expect(tagIdsOf({ quality: "legend", tags: ["epic", "buff"] })).toEqual(["epic", "buff"]);

    // 自定义 quality 词不生成标签（仍可走 ui.qualityStyles 的旧通道）
    expect(tagIdsOf({ quality: "cursed" })).toEqual([]);
    expect(tagIdsOf(undefined)).toEqual([]);
  });

  it("十四档平铺：四档光谱是阶梯里的一档，写 quality 即可", () => {
    // 名字与光谱一一对应（2026-11-19 用户裁决的四档）
    const expected: ReadonlyArray<[string, string, string]> = [
      ["ancient", "旷古·传说", "aurum"],
      ["sublime", "绝世·史诗", "ember"],
      ["precious", "稀世·珍宝", "magenta"],
      ["superb", "超凡·卓越", "indigo"],
    ];
    for (const [id, name, preset] of expected) {
      const tag = resolveTags([id], undefined)[0];
      expect(tag?.name).toBe(name);
      expect(tag?.style?.preset).toBe(preset);
      // 写进 quality 与写进 tags 等价
      expect(tagIdsOf({ quality: id })).toEqual([id]);
      // 它们**就是**阶梯里的一档（用户 2026-11-19：十四档平铺）
      expect(isQualityTier(id)).toBe(true);
    }

    // 阶梯是十四档，且四档光谱紧挨同色那一档、排在它前面（顺序 = 由高到低）
    expect(QUALITY_TIER_IDS).toHaveLength(14);
    expect(QUALITY_TIER_IDS).toEqual([
      "mythic-unique",
      "mythic",
      "ancient",
      "legend",
      "sublime",
      "epic",
      "precious",
      "treasure",
      "superb",
      "excellent",
      "rare",
      "fine",
      "common",
      "poor",
    ]);
    expect(isQualityTier("cursed")).toBe(false);
  });

  it("加载期校验：未知标签 id 拒载", () => {
    const { entry } = makeWorld();
    const ui = UiConfigSchema.parse({ tags: {} });
    const broken = {
      ...entry.template,
      statuses: [{ ...entry.template.statuses[0]!, tags: ["ghost-tag"] }, ...entry.template.statuses.slice(1)],
    };
    const issues = validateStyleRefs(broken, ui);
    expect(issues.some((i) => i.path === "statuses[0].tags" && i.message.includes("ghost-tag"))).toBe(true);
  });

});
