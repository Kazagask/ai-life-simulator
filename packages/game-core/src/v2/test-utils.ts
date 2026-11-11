import type { OpeningTemplate, WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { createDefaultOpeningTemplate, handoff, runOpening, type OpeningRunnerContext } from "./opening.js";
import { createRunnerContext } from "./runner-context.js";
import { createWorldV2 } from "./turn.js";

/**
 * 测试夹具：创建并交接一个「已激活」世界（openingCompleted=true）。
 * 复用 runOpening + handoff 的最小默认开局，让门禁接入后的轮次测试统一从这里取状态；
 * createWorldV2 本身保持未激活语义（ending.test.ts 依赖其 false/null/false 初值）。
 * 可选传入自定义开局，用于验证交接事件的消费。
 */
export function createActiveWorldV2(
  input: { templateId: string; playerName: string; seed?: number },
  template: WorldTemplateV2,
  worldId: string,
  opening: OpeningTemplate = createDefaultOpeningTemplate(),
): WorldStateV2 {
  const base = createWorldV2(input, template, worldId);
  const lookup = createLookup(template);
  const openingCtx: OpeningRunnerContext = {
    ...createRunnerContext(base.seed),
    lookup,
  };
  const { state: opened, run } = runOpening(base, opening, openingCtx);
  return handoff(opened, run, lookup);
}

// ---------- 受控行为的最小测试模板（供多处测试复用） ----------

export function makeTestTemplate(): WorldTemplateV2 {
  return {
    meta: { id: "test", name: "测试世界", description: "d", startYear: 2000, engineProtocol: "v2" },
    time: { defaultStep: { value: 1, unit: "hour" } },
    genders: [{ id: "f", label: "女" }],
    mood: {
      min: 0,
      max: 100,
      defaultValue: 60,
      bands: [
        { id: "low", label: "消沉", min: 0, max: 39, attributeModifiers: { cursedEnergy: -1 } },
        { id: "normal", label: "平静", min: 40, max: 100, attributeModifiers: {} },
      ],
    },
    statusBar: [{ id: "sb1", label: "基本", source: "identity" }],
    attributes: {
      order: ["cursedEnergy", "agility", "luck", "willpower"],
      defaults: { cursedEnergy: 5, agility: 5, luck: 5, willpower: 3 },
    },
    resources: {
      hp: { base: 100, perLevel: 0, perAttribute: { cursedEnergy: 4 } },
      mp: { base: 50, perLevel: 0, perAttribute: { cursedEnergy: 2 } },
    },
    regen: { perTurn: { hp: 2, mp: 1 } },
    characters: [
      {
        id: "enemy-x",
        isEnemy: true,
        visibility: "public",
        identity: { name: "测试敌人", age: 0, gender: "f" },
        mood: { value: 50 },
        attributes: { cursedEnergy: 5, agility: 1, luck: 0 },
        skills: ["sk-nuke"],
        public: { personality: "测试用" },
        private: { combatHints: { skillWeights: { "sk-nuke": 1 } } },
        relationship: -100,
      },
    ],
    playerTemplate: {
      identity: { age: 16, gender: "f" },
      mood: 60,
      attributes: { cursedEnergy: 5, agility: 5, luck: 5 },
      skills: ["sk-strike"],
    },
    actions: [
      { id: "patrol", label: "巡逻", duration: { value: 1, unit: "hour" } },
      { id: "rest", label: "休息", duration: { value: 1, unit: "hour" } },
    ],
    skills: [
      {
        id: "sk-strike",
        kind: "combat",
        name: "强击",
        cost: { mp: 0 },
        target: "enemy",
        damage: [{ preset: "fixed", value: 100 }],
        cooldownTurns: 0,
        usableInBattle: true,
      },
      {
        id: "sk-nuke",
        kind: "combat",
        name: "湮灭",
        cost: { mp: 0 },
        target: "enemy",
        damage: [{ preset: "fixed", value: 500 }],
        cooldownTurns: 0,
        usableInBattle: true,
      },
      {
        id: "sk-uzumaki",
        kind: "combat",
        name: "旋涡",
        cost: { mp: 0 },
        target: "enemy",
        hitCheck: { preset: "opposed", attacker: "cursedEnergy", defender: "agility", baseChance: 1 },
        damage: [{ preset: "stack-scaled", base: 10, perStack: 15, status: "absorbed-curses" }],
        consumeStatus: { status: "absorbed-curses" },
        cooldownTurns: 0,
        usableInBattle: true,
      },
    ],
    items: [],
    statuses: [
      {
        id: "absorbed-curses",
        name: "收集弹",
        duration: { turns: 5 },
        stacking: "stack",
        combat: {},
        visibility: "known",
      },
      {
        id: "inj",
        name: "轻伤",
        duration: { turns: 2 },
        stacking: "refresh",
        simulation: { attributeModifiers: { agility: -2 }, moodDeltaPerTurn: -2 },
        cureConditions: [{ restTurns: 2 }],
        visibility: "known",
      },
    ],
    events: [
      {
        id: "ev-normal",
        title: "抉择",
        narrative: "一个待决事件。",
        trigger: { source: "pool", probability: 1 },
        kind: "normal",
        settle: {
          normal: {
            options: [
              {
                id: "opt-secret",
                text: "秘密选项",
                visibleWhen: [{ requiresSkill: "sk-none" }],
                effects: [{ type: "setFlag", id: "choseSecret", value: true }],
              },
              {
                id: "opt-plain",
                text: "普通选项",
                effects: [{ type: "setFlag", id: "chosePlain", value: true }],
              },
            ],
          },
        },
      },
      {
        id: "ev-wheel",
        title: "抽签",
        narrative: "命运转盘。",
        // R2.5：事件触发冷却改为时间维度（天）；技能/NPC 行动的 cooldownTurns 保持不变
        trigger: { source: "pool", probability: 1, cooldown: { value: 99, unit: "day" } },
        kind: "random",
        settle: {
          random: {
            wheel: {
              segments: [
                { weight: 1, weightBy: { luck: 0.4 }, label: "大吉", effects: [{ type: "adjustMood", value: 10 }] },
                { weight: 3, label: "凶", effects: [{ type: "adjustMood", value: -5 }] },
              ],
            },
          },
        },
      },
      {
        id: "ev-ambush",
        title: "遇袭",
        narrative: "敌人出现！",
        trigger: { source: "action-hook", onActionId: "patrol", probability: 1 },
        kind: "combat",
        settle: {
          combat: {
            enemies: [{ ref: "enemy-x", levelScale: 1 }],
            onVictory: { effects: [{ type: "setFlag", id: "won", value: true }] },
            onDefeat: { effects: [{ type: "applyStatus", status: "inj" }] },
          },
        },
      },
    ],
  } as unknown as WorldTemplateV2;
}
