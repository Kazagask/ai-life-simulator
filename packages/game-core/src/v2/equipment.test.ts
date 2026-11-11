import { describe, expect, it } from "vitest";
import {
  WorldTemplateV2Schema,
  type DynamicModifierSpec,
  type EquipmentInstance,
  type WorldTemplateV2,
} from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { projectSnapshotV2 } from "./projection.js";
import { createActiveWorldV2 } from "./test-utils.js";
import { createWorldV2 } from "./turn.js";
import { createBattle, performBattleAction } from "./battle.js";
import { evaluateDynamicModifier, equipItem, unequipItem, nextInstanceId } from "./equipment.js";
import { playerEffectiveAttributes } from "./engine.js";
import { createRng } from "../rng.js";

/**
 * 装备系统契约测试（协议 V2.1 §19 / R-EQ-01..06 / P8）：
 * 1) 槽位/类别/品质/动态补正的加载期校验（错误含字段路径，禁止字段给明确诊断）；
 * 2) 动态补正求值：preset 白名单语义、同状态不同结果、条件命中、不写回基础属性；
 * 3) 穿脱/替换纯函数与槽位冲突错误码；
 * 4) 同 seed 回放补正序列逐次相等。
 */

const RAW_TEMPLATE: Record<string, unknown> = {
  meta: { id: "t-equip", name: "装备测试", description: "d", startYear: 2000, engineProtocol: "v2" },
  time: { defaultStep: { value: 1, unit: "day" as const } },
  genders: [{ id: "f", label: "女" }],
  mood: {
    min: 0,
    max: 100,
    defaultValue: 60,
    bands: [{ id: "n", label: "平静", min: 0, max: 100, attributeModifiers: {} }],
  },
  statusBar: [{ id: "sb-hp", label: "生命值", source: "resource" as const, key: "hp" }],
  attributes: { order: ["power", "spirit"], defaults: { power: 10, spirit: 5 } },
  resources: { hp: { base: 100, perLevel: 0 }, mp: { base: 50, perLevel: 0 } },
  regen: { perTurn: { hp: 0, mp: 0 } },
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
  playerTemplate: {
    identity: { gender: "f", age: 16 },
    attributes: { power: 10, spirit: 5 },
    skills: ["sk-strike"],
    items: [
      { itemId: "eq-scaled", count: 1 },
      { itemId: "eq-stacked", count: 1 },
    ],
  },
  skills: [
    {
      id: "sk-strike",
      kind: "combat" as const,
      name: "斩击",
      cost: { mp: 0 },
      target: "enemy" as const,
      damage: [{ preset: "scaled" as const, base: 5, scaleBy: "power", multiplier: 1 }],
      cooldownTurns: 0,
      usableInBattle: true as const,
    },
  ],
  items: [
    {
      id: "potion",
      type: "consumable",
      name: "药剂",
      stackable: true,
      usableInBattle: false,
      usableOutsideBattle: true,
      use: [{ type: "adjustMood", value: 2 }],
    },
    {
      id: "eq-fixed",
      type: "equipment",
      name: "铁剑",
      stackable: false,
      usableInBattle: false,
      usableOutsideBattle: false,
      slot: "weapon",
      category: "blade",
      quality: "common",
      dynamicModifier: { attribute: "power", preset: "fixed", params: { value: 3 } },
    },
    {
      id: "eq-scaled",
      type: "equipment",
      name: "灵环",
      stackable: false,
      usableInBattle: false,
      usableOutsideBattle: false,
      slot: "accessory",
      category: "charm",
      quality: "uncommon",
      dynamicModifier: { attribute: "spirit", preset: "scaled", params: { base: 1, scaleBy: "spirit", multiplier: 0.2 } },
    },
    {
      id: "eq-stacked",
      type: "equipment",
      name: "回响戒",
      stackable: false,
      usableInBattle: false,
      usableOutsideBattle: false,
      slot: "accessory",
      category: "ring",
      quality: "rare",
      dynamicModifier: {
        attribute: "power",
        preset: "stack-scaled",
        params: { base: 1, perStack: 2, status: "st-echo" },
        conditions: [{ mood: { gte: 40 } }],
      },
    },
  ],
  statuses: [
    { id: "st-echo", name: "回响", duration: { turns: 5 }, stacking: "stack" as const, simulation: { attributeModifiers: {} }, visibility: "known" as const },
  ],
  equipment: {
    qualities: ["common", "uncommon", "rare"],
    slots: [
      { id: "weapon", label: "武器", allowedCategories: ["blade"], maxCount: 1 },
      { id: "accessory", label: "饰品", allowedCategories: ["charm", "ring"], maxCount: 2 },
    ],
    initialEquipment: [{ itemId: "eq-fixed" }],
  },
  events: [],
};

function makeTemplate(patch?: (raw: Record<string, unknown>) => void): WorldTemplateV2 {
  const raw = structuredClone(RAW_TEMPLATE);
  patch?.(raw);
  return WorldTemplateV2Schema.parse(raw);
}

function setup(seed = 7, patch?: (raw: Record<string, unknown>) => void) {
  const template = makeTemplate(patch);
  const lookup = createLookup(template);
  const state = createActiveWorldV2({ templateId: template.meta.id, playerName: "装备师", seed }, template, "w-equip");
  return { template, lookup, state };
}

function equipmentOf(result: ReturnType<typeof equipItem>): EquipmentInstance[] {
  if (!result.ok) throw new Error(`期望成功，实际错误：${result.code} ${result.message}`);
  return result.equipment;
}

describe("Schema 校验 · 装备定义与分域（R-EQ-01/02）", () => {
  it("两套栏位结构不同的模板均校验通过，引擎无需改动（A 组：武器+饰品）", () => {
    const t = makeTemplate();
    expect(t.equipment?.slots?.map((s) => s.id)).toEqual(["weapon", "accessory"]);
  });

  it("两套栏位结构不同的模板均校验通过（B 组：护甲分部位）", () => {    const t = makeTemplate((raw) => {
      raw.equipment = {
        qualities: ["rough", "fine"],
        slots: [
          { id: "head", label: "头部", allowedCategories: ["helm"], maxCount: 1 },
          { id: "body", label: "躯干", allowedCategories: ["armor", "robe"], maxCount: 1 },
        ],
        initialEquipment: [{ itemId: "eq-helm" }],
      };
      // B 组栏位结构下，A 组装备条目全部移除，只留非装备物品与新装备
      raw.items = (raw.items as Record<string, unknown>[]).filter((i) => i.type !== "equipment");
      (raw.items as Record<string, unknown>[]).push({
        id: "eq-helm",
        type: "equipment",
        name: "头盔",
        stackable: false,
        usableInBattle: false,
        usableOutsideBattle: false,
        slot: "head",
        category: "helm",
        quality: "fine",
      });
      (raw.playerTemplate as Record<string, unknown>).items = [];
    });
    expect(t.equipment?.slots?.map((s) => s.id)).toEqual(["head", "body"]);
  });

  it("装备缺 quality 报错且路径指向 items[i].quality", () => {
    const raw = structuredClone(RAW_TEMPLATE);
    const items = raw.items as Record<string, unknown>[];
    const noQuality = structuredClone(items[1]) as Record<string, unknown>;
    delete noQuality.quality;
    noQuality.id = "eq-noq";
    items.push(noQuality);
    expect(() => WorldTemplateV2Schema.parse(raw)).toThrow(/quality/);
  });

  it("装备引用未声明槽位被拒", () => {
    const raw = structuredClone(RAW_TEMPLATE);
    (raw.items as Record<string, unknown>[])[1].slot = "ghost-slot";
    expect(() => WorldTemplateV2Schema.parse(raw)).toThrow(/未知槽位：ghost-slot/);
  });

  it("槽位 allowedCategories 与装备 category 不匹配被拒（含提示）", () => {
    const raw = structuredClone(RAW_TEMPLATE);
    (raw.items as Record<string, unknown>[])[1].category = "bow";
    expect(() => WorldTemplateV2Schema.parse(raw)).toThrow(/不允许类别：bow/);
  });

  it("quality 不在白名单被拒", () => {
    const raw = structuredClone(RAW_TEMPLATE);
    (raw.items as Record<string, unknown>[])[1].quality = "legendary";
    expect(() => WorldTemplateV2Schema.parse(raw)).toThrow(/未知品质：legendary/);
  });

  it("modifierMode（static|dynamic 二选一）被明确拒绝，不静默忽略", () => {
    const raw = structuredClone(RAW_TEMPLATE);
    (raw.items as Record<string, unknown>[])[1].modifierMode = "static";
    expect(() => WorldTemplateV2Schema.parse(raw)).toThrow(/modifierMode/);
  });

  it("自由表达式（formula / expression）被明确拒绝", () => {
    const raw = structuredClone(RAW_TEMPLATE);
    (raw.items as Record<string, unknown>[])[1].formula = "max(1, base - def)";
    expect(() => WorldTemplateV2Schema.parse(raw)).toThrow(/自由表达式/);

    const raw2 = structuredClone(RAW_TEMPLATE);
    (raw2.items as Record<string, unknown>[])[1].expression = "power * 2";
    expect(() => WorldTemplateV2Schema.parse(raw2)).toThrow(/自由表达式/);
  });

  it("attributeModifiers.perStack（S3 #18）被明确报错并指引改用 dynamicModifier", () => {
    const raw = structuredClone(RAW_TEMPLATE);
    (raw.items as Record<string, unknown>[])[1].attributeModifiers = { perStack: { power: 2 } };
    expect(() => WorldTemplateV2Schema.parse(raw)).toThrow(/S3 #18/);
  });

  it("dynamicModifier 引用未知属性 / 未知补正 / random 条件被拒", () => {
    const badAttr = structuredClone(RAW_TEMPLATE);
    ((badAttr.items as Record<string, unknown>[])[1].dynamicModifier as Record<string, unknown>).attribute = "ghost";
    expect(() => WorldTemplateV2Schema.parse(badAttr)).toThrow(/未知属性：ghost/);

    const badScale = structuredClone(RAW_TEMPLATE);
    const dm1 = (badScale.items as Record<string, unknown>[])[2].dynamicModifier as Record<string, unknown>;
    (dm1.params as Record<string, unknown>).scaleBy = "ghost";
    expect(() => WorldTemplateV2Schema.parse(badScale)).toThrow(/未知属性：ghost/);

    const badStatus = structuredClone(RAW_TEMPLATE);
    const dm2 = (badStatus.items as Record<string, unknown>[])[3].dynamicModifier as Record<string, unknown>;
    (dm2.params as Record<string, unknown>).status = "st-ghost";
    expect(() => WorldTemplateV2Schema.parse(badStatus)).toThrow(/未知补正：st-ghost/);

    const badRandom = structuredClone(RAW_TEMPLATE);
    const dm3 = (badRandom.items as Record<string, unknown>[])[3].dynamicModifier as Record<string, unknown>;
    dm3.conditions = [{ random: 0.5 }];
    expect(() => WorldTemplateV2Schema.parse(badRandom)).toThrow(/random/);
  });

  it("initialEquipment 引用未知物品 / 非装备物品被拒", () => {
    const badRef = structuredClone(RAW_TEMPLATE);
    (badRef.equipment as Record<string, unknown>).initialEquipment = [{ itemId: "item-ghost" }];
    expect(() => WorldTemplateV2Schema.parse(badRef)).toThrow(/未知物品：item-ghost/);

    const badType = structuredClone(RAW_TEMPLATE);
    (badType.equipment as Record<string, unknown>).initialEquipment = [{ itemId: "potion" }];
    expect(() => WorldTemplateV2Schema.parse(badType)).toThrow(/type: equipment/);
  });
});

describe("动态补正求值（R-EQ-04）", () => {
  const specs: Record<string, DynamicModifierSpec> = {
    fixed: { attribute: "power", preset: "fixed", params: { value: 3 } },
    scaled: { attribute: "spirit", preset: "scaled", params: { base: 1, scaleBy: "spirit", multiplier: 0.2 } },
    stacked: { attribute: "power", preset: "stack-scaled", params: { base: 1, perStack: 2, status: "st-echo" } },
    gated: {
      attribute: "power",
      preset: "fixed",
      params: { value: 5 },
      conditions: [{ mood: { gte: 40 } }, { mood: { lte: 80 } }],
    },
  };
  const statuses = (stacks: number) => [{ statusId: "st-echo", stacks, appliedTurn: 0 }];

  it("fixed / scaled / stack-scaled 三 preset 求值正确且纯函数无副作用", () => {
    const eff = { power: 10, spirit: 5 };
    const frozen = JSON.stringify(eff);
    expect(evaluateDynamicModifier(specs.fixed, { effAttrs: eff, statuses: [] })).toEqual({ power: 3 });
    expect(evaluateDynamicModifier(specs.scaled, { effAttrs: eff, statuses: [] })).toEqual({ spirit: 2 }); // 1 + 5*0.2
    expect(evaluateDynamicModifier(specs.stacked, { effAttrs: eff, statuses: statuses(3) })).toEqual({ power: 7 }); // 1 + 3*2
    expect(JSON.stringify(eff)).toBe(frozen);
  });

  it("同一装备在两份不同状态（层数不同）下补正值不同且符合 preset 语义（R-EQ-04 验收 1）", () => {
    const low = evaluateDynamicModifier(specs.stacked, { effAttrs: {}, statuses: statuses(1) });
    const high = evaluateDynamicModifier(specs.stacked, { effAttrs: {}, statuses: statuses(4) });
    expect(low).toEqual({ power: 3 });
    expect(high).toEqual({ power: 9 });
    expect(low.power).not.toBe(high.power);
  });

  it("条件命中时生效、不命中时返回空（当次不生效）", () => {
    // 未提供 condCtx：视为无条件生效
    expect(evaluateDynamicModifier(specs.gated, { effAttrs: {}, statuses: [] })).toEqual({ power: 5 });
    // mood=90 不满足 lte 80
    expect(
      evaluateDynamicModifier(specs.gated, {
        effAttrs: {},
        statuses: [],
        condCtx: (cond) => {
          const mood = (cond as { mood?: { gte?: number; lte?: number } }).mood;
          if (!mood) return true;
          const value = 90;
          if (mood.gte !== undefined && value < mood.gte) return false;
          if (mood.lte !== undefined && value > mood.lte) return false;
          return true;
        },
      }),
    ).toEqual({});
  });
});

describe("求值链接线（R-EQ-03/05 / P8）", () => {
  it("createWorldV2 注入 initialEquipment，实例形状正确且 id 确定性", () => {
    const template = makeTemplate();
    const state = createWorldV2({ templateId: template.meta.id, playerName: "装备师", seed: 7 }, template, "w-init");
    expect(state.player.equipment).toHaveLength(1);
    const inst = state.player.equipment![0];
    expect(inst).toEqual({ instanceId: "equip-eq-fixed-1", itemId: "eq-fixed", ownerId: "player", slot: "weapon" });
    // 实例不存补正结果字段（R-EQ-02 / P8）
    expect(Object.keys(inst).sort()).toEqual(["instanceId", "itemId", "ownerId", "slot"]);
  });

  it("装备补正进入累加链且不写回基础属性：求值前后 attributes 逐字段不变（P8 验收）", () => {
    const { lookup, state } = setup();
    const baseAttrsBefore = JSON.stringify(state.player.attributes);
    const withEq = playerEffectiveAttributes(state, lookup);
    expect(withEq.power).toBe(13); // 10 + fixed 3（初始装备 eq-fixed）
    expect(withEq.spirit).toBe(5); // eq-scaled 未穿

    // 补正结果不写回基础属性
    expect(JSON.stringify(state.player.attributes)).toBe(baseAttrsBefore);
    // 实例不含补正结果字段
    for (const inst of state.player.equipment ?? []) {
      expect(Object.keys(inst).every((k) => ["instanceId", "itemId", "ownerId", "slot", "stacks", "durability"].includes(k))).toBe(true);
    }
  });

  it("穿 scaled / stack-scaled 装备后按当前状态现算；卸下后不再计入", () => {
    const { lookup, state } = setup();
    // 穿上 eq-scaled（饰品 1/2）
    state.player.equipment = equipmentOf(equipItem({ equipment: state.player.equipment ?? [], inventory: state.player.inventory }, "eq-scaled", lookup));
    expect(playerEffectiveAttributes(state, lookup).spirit).toBe(7); // 5 + (1 + 5*0.2 = 2)

    // 叠 3 层状态 + 穿上 eq-stacked：power = 10 + 3 + (1 + 3*2) = 20
    state.player.statuses.push({ statusId: "st-echo", stacks: 3, appliedTurn: 0 });
    state.player.equipment = equipmentOf(equipItem({ equipment: state.player.equipment ?? [], inventory: state.player.inventory }, "eq-stacked", lookup));
    const both = playerEffectiveAttributes(state, lookup);
    expect(both.power).toBe(20);
    expect(both.spirit).toBe(7);

    // 卸下 eq-stacked 后恢复
    const instanceId = state.player.equipment.find((e) => e.itemId === "eq-stacked")!.instanceId;
    state.player.equipment = equipmentOf(unequipItem({ equipment: state.player.equipment ?? [], inventory: state.player.inventory }, instanceId, lookup));
    const after = playerEffectiveAttributes(state, lookup);
    expect(after.power).toBe(13); // 10 + 3（eq-fixed 仍在）
    expect(after.spirit).toBe(7);
  });

  it("心情档位在装备之后生效；caps 套在链尾", () => {
    const { lookup, state } = setup(7, (raw) => {
      const mood = raw.mood as { bands: { id: string; label: string; min: number; max: number; attributeModifiers: Record<string, number> }[] };
      mood.bands = [{ id: "low", label: "低落", min: 0, max: 100, attributeModifiers: { power: -1 } }];
      (raw.attributes as Record<string, unknown>).caps = { power: 12 };
    });
    const eff = playerEffectiveAttributes(state, lookup);
    // 10 + 3（装备） - 1（心情） = 12 → cap 12
    expect(eff.power).toBe(12);
  });

  it("战斗内技能伤害吃到装备补正（同一求值链）", () => {
    const { lookup, state } = setup();
    state.battle = createBattle("ev-1", { enemies: [{ ref: "mob" }] }, state, lookup);
    const hpBefore = state.battle.enemies[0].hp;
    performBattleAction(state, { type: "skill", skillId: "sk-strike" }, lookup, createRng(1));
    // damage = 5 + effPower(10 + 3) = 18
    expect(hpBefore - state.battle.enemies[0].hp).toBe(18);

    // 卸下装备后同一技能伤害降为 15
    const inst = state.player.equipment![0];
    state.player.equipment = equipmentOf(unequipItem({ equipment: state.player.equipment ?? [], inventory: state.player.inventory }, inst.instanceId, lookup));
    state.battle = createBattle("ev-1", { enemies: [{ ref: "mob" }] }, state, lookup);
    const hpBefore2 = state.battle.enemies[0].hp;
    performBattleAction(state, { type: "skill", skillId: "sk-strike" }, lookup, createRng(1));
    expect(hpBefore2 - state.battle.enemies[0].hp).toBe(15);
  });

  it("同 seed 回放：穿装序列的补正结果逐次相等（P8 / R-NFR-01）", () => {
    const run = (): Record<string, number>[] => {
      const { lookup, state } = setup(11);
      const series: Record<string, number>[] = [];
      for (const itemId of ["eq-scaled", "eq-stacked"]) {
        state.player.equipment = equipmentOf(equipItem({ equipment: state.player.equipment ?? [], inventory: state.player.inventory }, itemId, lookup));
        state.player.statuses.push({ statusId: "st-echo", stacks: series.length + 1, appliedTurn: 0 });
        series.push(playerEffectiveAttributes(state, lookup));
      }
      return series;
    };
    expect(run()).toEqual(run());
  });

  it("旧存档兼容：state.player.equipment 为 undefined 时求值正常（4 参兼容路径）", () => {
    const { lookup, state } = setup();
    delete state.player.equipment;
    const eff = playerEffectiveAttributes(state, lookup);
    expect(eff.power).toBe(10);
    expect(eff.spirit).toBe(5);
  });
});

describe("穿脱 / 替换纯函数与槽位校验（R-EQ-05）", () => {
  it("成功装备返回新数组；饰品槽 maxCount=2 允许两件；原数组不被修改", () => {
    const { lookup, state } = setup();
    const before = state.player.equipment ?? [];
    const r1 = equipItem({ equipment: before, inventory: state.player.inventory }, "eq-scaled", lookup);
    expect(r1.ok).toBe(true);
    expect(equipmentOf(r1)).toHaveLength(2);
    expect(before).toHaveLength(1); // 纯函数：输入数组不变
    const r2 = equipItem(
      { equipment: equipmentOf(r1), inventory: r1.ok ? r1.inventory : {} },
      "eq-stacked",
      lookup,
    );
    expect(r2.ok).toBe(true);
    expect(equipmentOf(r2)).toHaveLength(3);
  });

  it("穿脱在背包与装备栏之间移动物品（ADR-0008 / R-EQ-11）", () => {
    const { lookup, state } = setup();
    const r1 = equipItem({ equipment: state.player.equipment ?? [], inventory: state.player.inventory }, "eq-scaled", lookup);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.inventory["eq-scaled"]).toBeUndefined(); // 穿上后背包不再保留同名条目

    const r2 = unequipItem({ equipment: r1.equipment, inventory: r1.inventory }, "equip-eq-scaled-1", lookup);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.inventory["eq-scaled"]).toBe(1); // 卸下后回流背包
    expect(r2.equipment.map((e) => e.itemId)).toEqual(["eq-fixed"]);
  });

  it("初始装备不在背包，卸下后仍能在背包中找到（不遗失）", () => {
    const { lookup, state } = setup();
    const instanceId = state.player.equipment![0].instanceId; // eq-fixed：initialEquipment 授予
    expect(state.player.inventory["eq-fixed"]).toBeUndefined();
    const res = unequipItem({ equipment: state.player.equipment ?? [], inventory: state.player.inventory }, instanceId, lookup);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.inventory["eq-fixed"]).toBe(1);
  });

  it("错误码：item_not_equipment / not_owned / slot_not_found / slot_category_mismatch / slot_full / instance_not_found", () => {
    const { lookup, state } = setup();
    const ctx = { equipment: state.player.equipment ?? [], inventory: state.player.inventory };

    // 非装备物品
    expect(equipItem({ ...ctx, inventory: { potion: 1 } }, "potion", lookup)).toMatchObject({ ok: false, code: "item_not_equipment" });
    // 未持有
    expect(equipItem({ ...ctx, inventory: {} }, "eq-scaled", lookup)).toMatchObject({ ok: false, code: "not_owned" });

    // 未知槽位：绕过 Schema 校验直接删除槽位声明（引擎侧仍须可诊断）
    const slotless = makeTemplate();
    slotless.equipment = { ...slotless.equipment!, slots: slotless.equipment!.slots!.filter((s) => s.id !== "accessory") };
    expect(equipItem({ equipment: [], inventory: { "eq-scaled": 1 } }, "eq-scaled", createLookup(slotless))).toMatchObject({
      ok: false,
      code: "slot_not_found",
    });

    // 类别不匹配：绕过 Schema 校验把装备类别改成槽位不允许的值
    const mismatched = makeTemplate();
    const scaled = mismatched.items.find((i) => i.id === "eq-scaled")!;
    scaled.category = "amulet";
    expect(equipItem({ equipment: [], inventory: { "eq-scaled": 1 } }, "eq-scaled", createLookup(mismatched))).toMatchObject({
      ok: false,
      code: "slot_category_mismatch",
    });

    // 槽位已满（weapon maxCount=1，追加第二件武器模板条目合法）
    const twoWeapons = makeTemplate((raw) => {
      (raw.items as Record<string, unknown>[]).push({
        id: "eq-axe",
        type: "equipment",
        name: "战斧",
        stackable: false,
        usableInBattle: false,
        usableOutsideBattle: false,
        slot: "weapon",
        category: "blade",
        quality: "common",
      });
    });
    expect(
      equipItem(
        {
          equipment: [{ instanceId: "equip-eq-fixed-1", itemId: "eq-fixed", ownerId: "player", slot: "weapon" }],
          inventory: { "eq-axe": 1 },
        },
        "eq-axe",
        createLookup(twoWeapons),
      ),
    ).toMatchObject({ ok: false, code: "slot_full" });

    // 卸下不存在的实例
    expect(unequipItem({ equipment: [], inventory: {} }, "equip-none-9", lookup)).toMatchObject({ ok: false, code: "instance_not_found" });
  });

  it("失败时状态不变：函数本身不改输入数组，调用方不写回即无副作用", () => {
    const { lookup, state } = setup();
    const equipment = state.player.equipment ?? [];
    const snapshot = JSON.stringify(equipment);
    equipItem({ equipment, inventory: {} }, "eq-scaled", lookup);
    unequipItem({ equipment, inventory: state.player.inventory }, "equip-eq-fixed-1", lookup);
    expect(JSON.stringify(equipment)).toBe(snapshot);
    expect(equipment).toHaveLength(1);
  });

  it("nextInstanceId 确定性且避开已用序号", () => {
    const base: EquipmentInstance[] = [
      { instanceId: "equip-x-1", itemId: "x", ownerId: "player", slot: "weapon" },
      { instanceId: "equip-x-2", itemId: "x", ownerId: "player", slot: "weapon" },
    ];
    expect(nextInstanceId(base, "x")).toBe("equip-x-3");
    expect(nextInstanceId([], "y")).toBe("equip-y-1");
  });
});

describe("装备投影（前端装备栏数据源）", () => {
  it("投影下发实例展示字段，且不含任何补正结果", () => {
    const { template, lookup, state } = setup();
    const snapshot = projectSnapshotV2(state, template, lookup);
    const equipment = snapshot.player.equipment ?? [];
    expect(equipment).toHaveLength(1);
    const first = equipment[0];
    expect(first.itemId).toBe("eq-fixed");
    expect(first.slot).toBe("weapon");
    expect(first.name).toBe("铁剑");
    expect(first.slotLabel).toBe("武器");
    expect(first.quality).toBe("common");
    // 只允许展示字段：出现补正数值即为泄漏（R-EQ-04 / P8）
    expect(Object.keys(first).sort()).toEqual(
      ["instanceId", "itemId", "name", "slot", "slotLabel", "description", "category", "quality"].sort(),
    );
  });

  it("投影下发槽位定义（前端渲染固定格子数，不猜槽位）（R-EQ-11/15）", () => {
    const { template, lookup, state } = setup();
    const snapshot = projectSnapshotV2(state, template, lookup);
    expect(snapshot.equipmentSlots).toEqual([
      { id: "weapon", label: "武器", maxCount: 1, allowedCategories: ["blade"], panelSide: "bottom" },
      { id: "accessory", label: "饰品", maxCount: 2, allowedCategories: ["charm", "ring"], panelSide: "bottom" },
    ]);
    // 未声明 panelSide 时缺省 bottom：老模板摆位不变（ADR-0009）
  });

  it("模板声明 panelSide 时按声明下发（人物面板左右列由模板决定）", () => {
    const withSides = makeTemplate((raw) => {
      const slots = (raw.equipment as { slots: Array<Record<string, unknown>> }).slots;
      slots[0].panelSide = "left";
      slots[1].panelSide = "right";
    });
    expect(withSides.equipment?.slots?.map((s) => s.panelSide)).toEqual(["left", "right"]);
    const snapshot = projectSnapshotV2(
      createActiveWorldV2({ templateId: withSides.meta.id, playerName: "摆位", seed: 3 }, withSides, "w-side"),
      withSides,
      createLookup(withSides),
    );
    expect(snapshot.equipmentSlots?.map((s) => s.panelSide)).toEqual(["left", "right"]);
  });

  it("panelSide 非法取值在加载期被拒（不静默降级）", () => {
    const raw = structuredClone(RAW_TEMPLATE);
    (raw.equipment as { slots: Array<Record<string, unknown>> }).slots[0].panelSide = "top";
    expect(() => WorldTemplateV2Schema.parse(raw)).toThrow(/panelSide/);
  });

  it("背包与装备栏互斥：穿戴中的物品不出现在 inventory 投影（ADR-0008）", () => {
    const { template, lookup, state } = setup();
    const equipped = projectSnapshotV2(state, template, lookup);
    expect(equipped.player.inventory.some((i) => i.itemId === "eq-fixed")).toBe(false);
    expect(equipped.player.equipment?.map((e) => e.itemId)).toEqual(["eq-fixed"]);
  });

  it("未装备时投影为空数组而非缺失字段", () => {
    const { template, lookup, state } = setup();
    const stripped = { ...state, player: { ...state.player, equipment: [] } };
    const snapshot = projectSnapshotV2(stripped, template, lookup);
    expect(snapshot.player.equipment).toEqual([]);
  });
});

// ---------- 穿脱编排（T5-01 / R-EQ-07 / R-EQ-08 / design §5.1） ----------

import { equipV2, unequipV2, equipErrorCodeOf } from "./equipment-turn.js";
import { markTerminated, EndingGuardError } from "./ending.js";
import { markArchived } from "./archive.js";

describe("穿脱编排 equipV2 / unequipV2（R-EQ-07 / R-EQ-08）", () => {
  it("成功装备：写回实例 + 新增 1 条 public 历史 + worldTime/turnIndex 不变", () => {
    const { template, lookup, state } = setup();
    const before = JSON.parse(JSON.stringify({ worldTime: state.worldTime, turnIndex: state.turnIndex, history: state.history.length }));
    const res = equipV2(state, { itemId: "eq-scaled" }, template, lookup);
    expect(res.state.player.equipment?.map((e) => e.itemId)).toContain("eq-scaled");
    expect(res.state.player.inventory["eq-scaled"]).toBeUndefined(); // 背包 -1（ADR-0008）
    expect(res.state.worldTime).toBe(before.worldTime); // 不推进时间（R-EQ-08）
    expect(res.state.turnIndex).toBe(before.turnIndex);
    expect(res.state.history.length).toBe(before.history + 1);
    const entry = res.state.history[res.state.history.length - 1];
    expect(entry.type).toBe("player_action");
    expect(entry.visibility).toBe("public");
    expect(entry.summary).toContain("灵环");
  });

  it("成功卸下：实例移除 + 新增 public 历史 + 时间不变", () => {
    const { template, lookup, state } = setup();
    const instanceId = state.player.equipment![0].instanceId; // 初始装备 eq-fixed
    const res = unequipV2(state, { instanceId }, template, lookup);
    expect(res.state.player.equipment).toHaveLength(0);
    expect(res.state.player.inventory["eq-fixed"]).toBe(1); // 卸下回流背包（ADR-0008）
    expect(res.state.worldTime).toBe(state.worldTime);
    const entry = res.state.history[res.state.history.length - 1];
    expect(entry.visibility).toBe("public");
    expect(entry.summary).toContain("铁剑");
  });

  it("卸下 → 背包可见 → 再装备 闭环（初始装备不遗失）", () => {
    const { template, lookup, state } = setup();
    const instanceId = state.player.equipment![0].instanceId;

    const off = unequipV2(state, { instanceId }, template, lookup);
    const bag = off.snapshot.player.inventory.find((i) => i.itemId === "eq-fixed");
    expect(bag?.count).toBe(1); // 卸下后出现在背包投影
    expect(off.snapshot.player.equipment).toEqual([]);

    const on = equipV2(off.state, { itemId: "eq-fixed" }, template, lookup);
    expect(on.snapshot.player.inventory.some((i) => i.itemId === "eq-fixed")).toBe(false); // 穿回后离开背包
    expect(on.snapshot.player.equipment?.map((e) => e.itemId)).toEqual(["eq-fixed"]);
    expect(on.state.player.inventory["eq-fixed"]).toBeUndefined();
  });

  it("七种错误码逐一抛 [equip]/[unequip] 且状态不变（equipErrorCodeOf 可解析）", () => {
    const { template, lookup, state } = setup();
    const expectCode = (fn: () => unknown, code: string, op: string) => {
      try {
        fn();
        expect.unreachable(`应抛 ${op} ${code}`);
      } catch (e) {
        expect(e instanceof Error && e.message).toBe(`[${op}] ${code}`);
        expect(equipErrorCodeOf(e)).toBe(code);
      }
    };
    expectCode(() => equipV2(state, { itemId: "nope" }, template, lookup), "item_not_found", "equip");
    // potion 未在玩家背包 → 先给背包再测 item_not_equipment
    const withPotion = makeTemplate((raw) => {
      (raw.playerTemplate as Record<string, unknown>).items = [
        ...(raw.playerTemplate as Record<string, unknown>).items as unknown[],
        { itemId: "potion", count: 1 },
      ];
    });
    expectCode(() => equipV2(state, { itemId: "potion" }, withPotion, createLookup(withPotion)), "item_not_equipment", "equip");
    expectCode(() => equipV2(state, { itemId: "eq-fixed" }, template, lookup), "not_owned", "equip"); // 仅初始装备，不在背包
    const slotless = makeTemplate();
    slotless.equipment = { ...slotless.equipment!, slots: slotless.equipment!.slots!.filter((s) => s.id !== "accessory") };
    expectCode(() => equipV2(state, { itemId: "eq-scaled" }, slotless, createLookup(slotless)), "slot_not_found", "equip");
    const mismatched = makeTemplate();
    const scaled = mismatched.items.find((i) => i.id === "eq-scaled")!;
    scaled.category = "amulet";
    expectCode(() => equipV2(state, { itemId: "eq-scaled" }, mismatched, createLookup(mismatched)), "slot_category_mismatch", "equip");
    const twoWeapons = makeTemplate((raw) => {
      (raw.items as Record<string, unknown>[]).push({
        id: "eq-axe", type: "equipment", name: "战斧", stackable: false,
        usableInBattle: false, usableOutsideBattle: false, slot: "weapon", category: "blade", quality: "common",
      });
    });
    state.player.inventory["eq-axe"] = 1; // 测试前置：背包塞第二把武器（weapon maxCount=1，已有一件）
    const frozen = JSON.stringify(state); // 前置变更之后拍快照：后续失败调用不得改状态
    expectCode(() => equipV2(state, { itemId: "eq-axe" }, twoWeapons, createLookup(twoWeapons)), "slot_full", "equip");
    expectCode(() => unequipV2(state, { instanceId: "equip-none-9" }, template, lookup), "instance_not_found", "unequip");
    expect(JSON.stringify(state)).toBe(frozen); // 失败不写状态
  });

  it("已终止 / 已归档世界拒绝穿脱（assertActive 门禁）", () => {
    const { template, lookup, state } = setup();
    const terminated = markTerminated(state, { reason: "r", worldTime: 0, turnIndex: 0, source: "condition" });
    expect(() => equipV2(terminated, { itemId: "eq-scaled" }, template, lookup)).toThrow(EndingGuardError);
    expect(() => unequipV2(terminated, { instanceId: "equip-eq-fixed-1" }, template, lookup)).toThrow(EndingGuardError);
    const archived = markArchived(terminated);
    expect(() => equipV2(archived, { itemId: "eq-scaled" }, template, lookup)).toThrow(EndingGuardError);
  });
});

describe("属性逐字段不变（R-EQ-10 / P8）", () => {
  it("穿 / 脱前后 player.attributes 逐字段相等；effectiveAttributes 差值等于补正值", () => {
    const { template, lookup, state } = setup();
    const attrsBefore = { ...state.player.attributes };
    const effBefore = playerEffectiveAttributes(state, lookup);

    // eq-scaled（spirit scaled：base 1 + 0.2×spirit）
    const res = equipV2(state, { itemId: "eq-scaled" }, template, lookup);
    expect(res.state.player.attributes).toEqual(attrsBefore); // 基础属性逐字段不变
    const effAfter = playerEffectiveAttributes(res.state, lookup);
    expect(effAfter.spirit - effBefore.spirit).toBeCloseTo(1 + 0.2 * attrsBefore.spirit, 10); // 补正只进有效值
    expect(effAfter.power).toBeCloseTo(effBefore.power, 10);

    const unequipped = unequipV2(res.state, { instanceId: "equip-eq-scaled-1" }, template, lookup);
    expect(unequipped.state.player.attributes).toEqual(attrsBefore);
    expect(playerEffectiveAttributes(unequipped.state, lookup)).toEqual(effBefore);
  });

  it("装备实例键集合不含补正字段（R-EQ-04 / P8）", () => {
    const { template, lookup, state } = setup();
    const res = equipV2(state, { itemId: "eq-stacked" }, template, lookup);
    const instance = res.state.player.equipment!.find((e) => e.itemId === "eq-stacked")!;
    expect(Object.keys(instance).sort()).toEqual(["instanceId", "itemId", "ownerId", "slot"].sort());
  });
});
