import { describe, expect, it } from "vitest";
import { WorldTemplateV2Schema, type WorldTemplateV2 } from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { createActiveWorldV2 } from "./test-utils.js";
import { createBattle, performBattleAction } from "./battle.js";
import { projectSnapshotV2 } from "./projection.js";
import { createRng } from "../rng.js";

/**
 * 战斗展示层与控制语义的契约测试（协议 §4.5 / §6.3 / §10.4）：
 * 1) 资源/属性显示名必须来自模板，引擎与投影不得写死世界观用词；
 * 2) cannot_attack / forced_target_self 必须真正生效（此前仅声明未消费）；
 * 3) 记录「技能省略 hitCheck」与「fixed 公式 ±1 浮动」的当前行为，供规格裁决。
 */

const RAW_TEMPLATE: Record<string, unknown> = {
  meta: { id: "t-battle", name: "战斗语义测试", description: "d", startYear: 2000, engineProtocol: "v2" },
  time: { defaultStep: { value: 1, unit: "day" as const } },
  genders: [{ id: "f", label: "女" }],
  mood: {
    min: 0,
    max: 100,
    defaultValue: 60,
    bands: [{ id: "n", label: "平静", min: 0, max: 100, attributeModifiers: {} }],
  },
  statusBar: [
    { id: "sb-hp", label: "生命值", source: "resource" as const, key: "hp" },
    { id: "sb-mp", label: "法力值", source: "resource" as const, key: "mp" },
    { id: "sb-attrs", label: "属性", source: "attribute" as const, keys: ["power"] },
    { id: "sb-mood", label: "心境", source: "mood" as const },
  ],
  attributes: { order: ["power"], defaults: { power: 10 }, labels: { power: "战力" } },
  resources: { hp: { base: 100, perLevel: 0 }, mp: { base: 50, perLevel: 0 } },
  regen: { perTurn: { hp: 0, mp: 0 } },
  checks: {},
  characters: [
    {
      id: "mob",
      isEnemy: true,
      identity: { name: "木桩", age: 20, gender: "f" },
      visibility: "public" as const,
      mood: { value: 60 },
      attributes: { power: 5 },
      skills: ["sk-strike"],
      public: {},
      private: {},
      relationship: 0,
    },
  ],
  playerTemplate: { identity: { gender: "f", age: 16 }, attributes: { power: 10 }, skills: ["sk-strike", "sk-mend"] },
  skills: [
    {
      id: "sk-strike",
      kind: "combat" as const,
      name: "斩击",
      cost: { mp: 0 },
      target: "enemy" as const,
      damage: [{ preset: "fixed" as const, value: 10 }],
      cooldownTurns: 0,
      usableInBattle: true as const,
    },
    {
      id: "sk-mend",
      kind: "combat" as const,
      name: "疗愈",
      cost: { mp: 0 },
      target: "self" as const,
      heal: [{ preset: "fixed" as const, value: 5 }],
      cooldownTurns: 0,
      usableInBattle: true as const,
    },
  ],
  items: [
    {
      id: "item-charm",
      type: "consumable",
      name: "护符",
      stackable: true,
      usableInBattle: true,
      usableOutsideBattle: true,
      // adjustAttribute 不在战斗内白名单：必须可诊断地拒绝，而不是静默无效
      use: [{ type: "adjustAttribute", attribute: "power", value: 1 }],
    },
  ],
  statuses: [
    { id: "st-mute", name: "禁攻", duration: { turns: 1 }, stacking: "refresh" as const, combat: { control: ["cannot_attack" as const] }, visibility: "known" as const },
    { id: "st-confuse", name: "混乱", duration: { turns: 1 }, stacking: "refresh" as const, combat: { control: ["forced_target_self" as const] }, visibility: "known" as const },
  ],
  events: [],
};

function makeTemplate(): WorldTemplateV2 {
  return WorldTemplateV2Schema.parse(structuredClone(RAW_TEMPLATE));
}

/** 在合法模板基础上打补丁，用于构造非法样例（避免使用 any）。 */
function rawWith(patch: { statusBar?: unknown[]; labels?: Record<string, string> }): unknown {
  const raw = structuredClone(RAW_TEMPLATE) as Record<string, unknown>;
  if (patch.statusBar) raw.statusBar = patch.statusBar;
  if (patch.labels) {
    const attributes = raw.attributes as { labels?: Record<string, string> };
    attributes.labels = patch.labels;
  }
  return raw;
}

function setup(seed = 1) {
  const template = makeTemplate();
  const lookup = createLookup(template);
  const state = createActiveWorldV2({ templateId: template.meta.id, playerName: "测试者", seed }, template, "w-battle");
  state.battle = createBattle("ev-1", { enemies: [{ ref: "mob" }], canFlee: false }, state, lookup);
  return { template, lookup, state };
}

describe("战斗展示层 · 显示名来自模板", () => {
  it("投影下发 labels（资源/属性/心情），与 statusBar、attributes.labels 一致", () => {
    const { template, lookup, state } = setup();
    const snap = projectSnapshotV2(state, template, lookup);
    expect(snap.labels.resources).toEqual({ hp: "生命值", mp: "法力值" });
    expect(snap.labels.attributes).toEqual({ power: "战力" });
    expect(snap.labels.mood).toBe("心境");
  });

  it("治疗日志使用模板资源名，不再写死「生命」", () => {
    const { lookup, state } = setup();
    state.battle!.player.hp = 50;
    performBattleAction(state, { type: "skill", skillId: "sk-mend" }, lookup, createRng(3));
    const log = state.battle!.log.join("\n");
    expect(log).toContain("生命值");
    expect(log).not.toContain("点生命。");
  });

  it("模板未声明 statusBar 资源区块时回退资源键，不报错也不猜世界观用词", () => {
    const template = WorldTemplateV2Schema.parse(
      rawWith({ statusBar: [{ id: "sb-identity", label: "基本", source: "identity" }] }),
    );
    const lookup = createLookup(template);
    expect(lookup.resourceLabel("hp")).toBe("hp");
    expect(lookup.attributeLabel("power")).toBe("战力");
    expect(lookup.moodLabel()).toBe("mood");
  });
});

describe("控制语义 · cannot_attack（协议 §6.3）", () => {
  it("玩家被禁攻时攻击技能被拒绝（可诊断错误码），治疗技能仍可施放", () => {
    const { lookup, state } = setup();
    state.battle!.player.statuses.push({ statusId: "st-mute", stacks: 1, appliedTurn: 0 });
    expect(() => performBattleAction(state, { type: "skill", skillId: "sk-strike" }, lookup, createRng(5))).toThrow(
      "cannot_attack",
    );
    expect(() => performBattleAction(state, { type: "skill", skillId: "sk-mend" }, lookup, createRng(5))).not.toThrow();
  });

  it("敌方被禁攻时跳过回合，不会对玩家出手", () => {
    const { lookup, state } = setup();
    state.battle!.enemies[0].statuses.push({ statusId: "st-mute", stacks: 1, appliedTurn: 0 });
    performBattleAction(state, { type: "skill", skillId: "sk-mend" }, lookup, createRng(7));
    const log = state.battle!.log.join("\n");
    expect(log).toContain("无法攻击，跳过了回合");
    expect(log).not.toContain("木桩的「斩击」");
  });
});

describe("控制语义 · forced_target_self（协议 §6.3）", () => {
  it("行动目标强制为自身：攻击技能打到自己，敌人不掉血", () => {
    const { lookup, state } = setup();
    state.battle!.player.statuses.push({ statusId: "st-confuse", stacks: 1, appliedTurn: 0 });
    const enemyHpBefore = state.battle!.enemies[0].hp;
    const playerHpBefore = state.battle!.player.hp;
    performBattleAction(state, { type: "skill", skillId: "sk-strike" }, lookup, createRng(11));
    expect(state.battle!.enemies[0].hp).toBe(enemyHpBefore);
    expect(state.battle!.player.hp).toBeLessThan(playerHpBefore);
  });
});

describe("YAML 命中/伤害缺省行为（协议 §10.4）", () => {
  it("技能省略 hitCheck = 必中：多次结算都不会出现闪避", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { lookup, state } = setup(seed);
      performBattleAction(state, { type: "skill", skillId: "sk-strike" }, lookup, createRng(seed));
      const log = state.battle!.log.join("\n");
      expect(log).not.toContain("闪开");
      expect(state.battle!.enemies[0].hp).toBeLessThan(state.battle!.enemies[0].maxHp);
    }
  });

  it("记录现状：fixed=10 实际打出 9..11 点，引擎额外叠加 ±1 浮动（规格未定义）", () => {
    const dealt: number[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const { lookup, state } = setup(seed);
      const before = state.battle!.enemies[0].hp;
      performBattleAction(state, { type: "skill", skillId: "sk-strike" }, lookup, createRng(seed));
      dealt.push(before - state.battle!.enemies[0].hp);
    }
    expect(Math.min(...dealt)).toBeGreaterThanOrEqual(9);
    expect(Math.max(...dealt)).toBeLessThanOrEqual(11);
    // 若某天按 §10.4 去掉浮动，这里会收窄为全 10，届时同步改断言
    expect(new Set(dealt).size).toBeGreaterThan(1);
  });
});

describe("战斗内物品 · 不支持的效果必须可诊断", () => {
  it("战斗内使用含非白名单效果的物品：报错且不扣库存", () => {
    const { lookup, state } = setup();
    state.player.inventory["item-charm"] = 1;
    expect(() => performBattleAction(state, { type: "item", itemId: "item-charm" }, lookup, createRng(9))).toThrow(
      "item_effect_unsupported_in_battle",
    );
    expect(state.player.inventory["item-charm"]).toBe(1);
  });
});

describe("Schema 校验 · 显示名与状态栏引用完整性", () => {
  it("attributes.labels 引用未声明属性被拒绝", () => {
    expect(() => WorldTemplateV2Schema.parse(rawWith({ labels: { power: "战力", ghost: "幽灵属性" } }))).toThrow(/未知属性/);
  });

  it("statusBar 的 resource.key 只能是 hp/mp，attribute.keys 必须已声明", () => {
    const badResource = rawWith({ statusBar: [{ id: "sb-x", label: "X", source: "resource", key: "stamina" }] });
    expect(() => WorldTemplateV2Schema.parse(badResource)).toThrow(/未知资源/);

    const badAttr = rawWith({ statusBar: [{ id: "sb-y", label: "Y", source: "attribute", keys: ["ghost"] }] });
    expect(() => WorldTemplateV2Schema.parse(badAttr)).toThrow(/未知属性/);
  });

  it("hitCheck 的攻防槽位写错属性名，加载期直接拒绝（不再静默取 0）", () => {
    const raw = structuredClone(RAW_TEMPLATE) as Record<string, unknown>;
    const skills = raw.skills as Array<Record<string, unknown>>;
    skills[0].hitCheck = { preset: "opposed", attacker: "agility", defender: "power", baseChance: 0.5 };
    expect(() => WorldTemplateV2Schema.parse(raw)).toThrow(/未知属性：agility/);
  });

  it("fleeCheck 与 checks.opposedDefault 的属性引用同样在加载期校验", () => {
    const raw = structuredClone(RAW_TEMPLATE) as Record<string, unknown>;
    raw.checks = { opposedDefault: { attacker: "ghost", defender: "power", baseChance: 0.5 } };
    expect(() => WorldTemplateV2Schema.parse(raw)).toThrow(/未知属性：ghost/);

    const withFlee = structuredClone(RAW_TEMPLATE) as Record<string, unknown>;
    withFlee.events = [
      {
        id: "ev-x",
        title: "t",
        narrative: "n",
        trigger: { source: "pool", probability: 1 },
        kind: "combat",
        settle: {
          combat: {
            enemies: [{ ref: "mob" }],
            canFlee: true,
            fleeCheck: { preset: "opposed", attacker: "agility", defender: "power", baseChance: 0.5 },
          },
        },
      },
    ];
    expect(() => WorldTemplateV2Schema.parse(withFlee)).toThrow(/fleeCheck/);
  });
});
