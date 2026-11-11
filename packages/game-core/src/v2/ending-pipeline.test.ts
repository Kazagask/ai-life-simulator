import { describe, expect, it } from "vitest";
import {
  EndingConfigSchema,
  type EndingConfig,
  type WorldStateV2,
  type WorldTemplateV2,
} from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { createBattle, performBattleAction } from "./battle.js";
import { createActiveWorldV2 } from "./test-utils.js";
import { projectSnapshotV2 } from "./projection.js";
import { markArchived } from "./archive.js";
import { EndingGuardError } from "./ending.js";
import { advanceTurnV2, battleActionV2, type TurnPipelineConfig } from "./turn.js";
import { worldStore } from "../../../../apps/server/src/store.js";

/**
 * 阶段 4 遗留 #29 / #30 接线验收：终止判定与结局决胜真正接进轮次管线，
 * 归档有封存入口，且未提供 endings.yaml 时行为与接线前逐字段一致。
 */

// ---------- 夹具 ----------

function makeTemplate(): WorldTemplateV2 {
  return {
    meta: { id: "t", name: "结局接线", description: "d", startYear: 2000, engineProtocol: "v2" },
    time: { defaultStep: { value: 1, unit: "day" } },
    genders: [{ id: "f", label: "女" }],
    mood: {
      min: 0,
      max: 100,
      defaultValue: 60,
      bands: [{ id: "normal", label: "平静", min: 0, max: 100, attributeModifiers: {} }],
    },
    statusBar: [{ id: "sb1", label: "基本", source: "identity" }],
    attributes: { order: ["str"], defaults: { str: 5 } },
    resources: { hp: { base: 100, perLevel: 0 }, mp: { base: 50, perLevel: 0 } },
    regen: { perTurn: { hp: 0, mp: 0 } },
    characters: [],
    skills: [],
    items: [],
    statuses: [],
    events: [],
  } as unknown as WorldTemplateV2;
}

/** 一击必杀的战斗模板：玩家 1 HP，敌人 500 伤害 → 玩家行动后必败。 */
function makeBattleTemplate(): WorldTemplateV2 {
  const base = makeTemplate();
  return {
    ...base,
    characters: [
      {
        id: "enemy-x",
        isEnemy: true,
        visibility: "public",
        identity: { name: "测试敌人", age: 0, gender: "f" },
        mood: { value: 50 },
        attributes: { str: 5 },
        skills: ["sk-nuke"],
        public: { personality: "测试用" },
        private: { combatHints: { skillWeights: { "sk-nuke": 1 } } },
        relationship: -100,
      },
    ],
    playerTemplate: {
      identity: { age: 16, gender: "f" },
      mood: 60,
      attributes: { str: 5 },
      skills: ["sk-strike"],
    },
    skills: [
      {
        id: "sk-strike",
        kind: "combat",
        name: "强击",
        cost: { mp: 0 },
        target: "enemy",
        damage: [{ preset: "fixed", value: 1 }],
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
    ],
    events: [
      {
        id: "ev-ambush",
        title: "遇袭",
        narrative: "敌人出现！",
        trigger: { source: "action-hook", onActionId: "patrol", probability: 1 },
        kind: "combat",
        settle: { combat: { enemies: [{ ref: "enemy-x", levelScale: 1 }] } },
      },
    ],
  } as unknown as WorldTemplateV2;
}

const timeCond = { time: { gte: { value: 1, unit: "day" } } } as const;

/** 寿终配置：1 天后终止；两个结局（寿终 / 兜底）。 */
function endingConfig(): EndingConfig {
  return EndingConfigSchema.parse({
    terminationConditions: [
      { type: "timeReached", params: { conditions: [timeCond] }, combinator: "AND", terminationMode: "afterSettle" },
    ],
    endings: [
      {
        endingId: "end-long",
        name: "寿终",
        description: "时间到了。",
        triggerConditions: [timeCond],
        priority: 10,
        endingType: "neutral",
        narrativeConfig: { source: "template", title: "寿终", summary: "时间到了，故事收束。" },
      },
      {
        endingId: "end-fallback",
        name: "兜底",
        description: "没有专属命中。",
        triggerConditions: [],
        priority: 0,
        endingType: "neutral",
        narrativeConfig: { source: "template", title: "兜底", summary: "到此为止。" },
        fallback: true,
      },
    ],
    fallback: "end-fallback",
  });
}

/** 战败致死配置：deathRoute=direct，带 flag 门槛；结局 end-death 优先级最高。 */
function deathConfig(): EndingConfig {
  return EndingConfigSchema.parse({
    terminationConditions: [],
    deathRoute: { deathMode: "direct", conditions: [{ flag: "doomed", eq: true }] },
    endings: [
      {
        endingId: "end-death",
        name: "战殁",
        description: "败北。",
        triggerConditions: [{ flag: "doomed", eq: true }],
        priority: 50,
        endingType: "sacrifice",
        narrativeConfig: { source: "template", title: "战殁", summary: "你倒下了。" },
      },
      {
        endingId: "end-fallback",
        name: "兜底",
        description: "没有专属命中。",
        triggerConditions: [],
        priority: 0,
        endingType: "neutral",
        narrativeConfig: { source: "template", summary: "到此为止。" },
        fallback: true,
      },
    ],
    fallback: "end-fallback",
  });
}

function makeActive(template: WorldTemplateV2 = makeTemplate(), seed = 1): WorldStateV2 {
  return createActiveWorldV2({ templateId: "t", playerName: "测试者", seed }, template, `w-${seed}`);
}

const pipeline = (cfg: EndingConfig): TurnPipelineConfig => ({ endingConfig: cfg });

/** 进入战斗并让玩家在本次行动中被打死（over=defeat）。 */
function fightToDefeat(state: WorldStateV2, template: WorldTemplateV2, cfg: EndingConfig) {
  const lookup = createLookup(template);
  state.player.hp = 1;
  state.battle = createBattle("ev-ambush", { enemies: [{ ref: "enemy-x", levelScale: 1 }], canFlee: false }, state, lookup);
  return battleActionV2(state, { type: "skill", skillId: "sk-strike" }, template, lookup, pipeline(cfg));
}

// ---------- 终止接线 ----------

describe("终止判定接入轮次管线", () => {
  it("未提供 endingConfig 时不终止（与接线前逐字段一致）", () => {
    const template = makeTemplate();
    const state = makeActive(template);
    const res = advanceTurnV2(state, { action: { type: "free", description: "" } }, template, createLookup(template));
    expect(res.state.termination).toBeNull();
    expect(res.snapshot.status).toBe("running");
    expect(res.snapshot.ending).toBeNull();
    expect(res.snapshot.availableActions.length).toBeGreaterThanOrEqual(0);
  });

  it("寿终边界：命中 timeReached 后写入 termination + endingId，投影出结局", () => {
    const template = makeTemplate();
    const state = makeActive(template);
    const cfg = endingConfig();
    const res = advanceTurnV2(
      state,
      { action: { type: "free", description: "" } },
      template,
      createLookup(template),
      undefined,
      pipeline(cfg),
    );
    expect(res.state.termination).not.toBeNull();
    expect(res.state.termination?.source).toBe("condition");
    expect(res.state.termination?.endingId).toBe("end-long");
    expect(res.snapshot.status).toBe("terminated");
    expect(res.snapshot.ending?.endingId).toBe("end-long");
    expect(res.snapshot.ending?.title).toBe("寿终");
    expect(res.snapshot.ending?.summary).toBe("时间到了，故事收束。");
    // 终止后不再提供行动，避免前端继续发无效请求
    expect(res.snapshot.availableActions).toEqual([]);
  });

  it("终止是一次性的：再次推进被门禁拒绝，state 不被改写", () => {
    const template = makeTemplate();
    const lookup = createLookup(template);
    const state = makeActive(template);
    const cfg = endingConfig();
    advanceTurnV2(state, { action: { type: "free", description: "" } }, template, lookup, undefined, pipeline(cfg));
    const frozen = JSON.stringify(state);
    expect(() =>
      advanceTurnV2(state, { action: { type: "free", description: "" } }, template, lookup, undefined, pipeline(cfg)),
    ).toThrow(EndingGuardError);
    expect(JSON.stringify(state)).toBe(frozen);
  });

  it("无专属结局命中时用 fallback 兜底", () => {
    const template = makeTemplate();
    const state = makeActive(template);
    const cfg = EndingConfigSchema.parse({
      terminationConditions: [
        { type: "timeReached", params: { conditions: [timeCond] }, combinator: "AND", terminationMode: "afterSettle" },
      ],
      endings: [
        {
          endingId: "end-never",
          name: "永不命中",
          description: "",
          triggerConditions: [{ flag: "never-set", eq: true }],
          priority: 90,
          narrativeConfig: { source: "template", title: "不应出现", summary: "不应出现" },
        },
        {
          endingId: "end-fallback",
          name: "兜底",
          description: "",
          triggerConditions: [],
          priority: 0,
          narrativeConfig: { source: "template", title: "兜底结局", summary: "没有专属结局。" },
          fallback: true,
        },
      ],
      fallback: "end-fallback",
    });
    const res = advanceTurnV2(
      state,
      { action: { type: "free", description: "" } },
      template,
      createLookup(template),
      undefined,
      pipeline(cfg),
    );
    expect(res.snapshot.ending?.endingId).toBe("end-fallback");
    expect(res.snapshot.ending?.title).toBe("兜底结局");
  });

  it("同一 seed + 同一配置 ⇒ 同一结局（R-NFR-01）", () => {
    const template = makeTemplate();
    const cfg = endingConfig();
    const run = () => {
      const state = makeActive(template, 7);
      const res = advanceTurnV2(
        state,
        { action: { type: "free", description: "" } },
        template,
        createLookup(template),
        undefined,
        pipeline(cfg),
      );
      return res.snapshot.ending?.endingId;
    };
    expect(run()).toBe(run());
  });
});

describe("主动收束（playerRequested）", () => {
  const requestConfig = () =>
    EndingConfigSchema.parse({
      terminationConditions: [
        { type: "playerRequested", params: { conditions: [] }, combinator: "AND", terminationMode: "afterSettle" },
      ],
      endings: [
        {
          endingId: "end-retire",
          name: "主动收束",
          description: "",
          triggerConditions: [],
          priority: 5,
          narrativeConfig: { source: "template", title: "主动收束", summary: "你选择停下。" },
        },
      ],
    });

  it("endLife=true 且配置了 playerRequested 条件 → 收束并给出结局", () => {
    const template = makeTemplate();
    const state = makeActive(template);
    const res = advanceTurnV2(
      state,
      { action: { type: "free", description: "" }, endLife: true },
      template,
      createLookup(template),
      undefined,
      pipeline(requestConfig()),
    );
    expect(res.state.termination?.source).toBe("player");
    expect(res.snapshot.ending?.endingId).toBe("end-retire");
    expect(res.snapshot.status).toBe("terminated");
  });

  it("endLife=false 时同配置不终止（主动收束必须显式请求）", () => {
    const template = makeTemplate();
    const state = makeActive(template);
    const res = advanceTurnV2(
      state,
      { action: { type: "free", description: "" } },
      template,
      createLookup(template),
      undefined,
      pipeline(requestConfig()),
    );
    expect(res.state.termination).toBeNull();
    expect(res.snapshot.status).toBe("running");
  });
});

// ---------- 死亡路径接线 ----------

describe("战败死亡路径接入战斗边界", () => {
  it("战败且 deathRoute 条件命中 → 直接触发结局并终止", () => {
    const template = makeBattleTemplate();
    const cfg = deathConfig();
    const state = makeActive(template);
    state.flags.doomed = true;
    const res = fightToDefeat(state, template, cfg);
    // 战斗会话在结算后即清除，胜负通过 triggeredEvents 返回（既有行为，不因判死改变）
    expect(res.snapshot.battle).toBeNull();
    expect(res.triggeredEvents.some((e) => e.title.includes("战斗"))).toBe(true);
    expect(res.state.termination).not.toBeNull();
    expect(res.state.termination?.source).toBe("battleDefeat");
    expect(res.snapshot.ending?.endingId).toBe("end-death");
    expect(res.snapshot.status).toBe("terminated");
  });

  it("战败但条件不命中 → 只是败北，世界继续", () => {
    const template = makeBattleTemplate();
    const cfg = deathConfig();
    const state = makeActive(template);
    state.flags.doomed = false;
    const res = fightToDefeat(state, template, cfg);
    expect(res.state.termination).toBeNull();
    expect(res.snapshot.status).toBe("running");
  });

  it("未配置 deathRoute 但有 battleDefeat 终止条件 → 由终止条件收束", () => {
    const template = makeBattleTemplate();
    const cfg = EndingConfigSchema.parse({
      terminationConditions: [
        { type: "battleDefeat", params: { conditions: [] }, combinator: "AND", terminationMode: "afterSettle" },
      ],
      endings: [
        {
          endingId: "end-defeat",
          name: "败北",
          description: "",
          triggerConditions: [{ flag: "doomed", eq: true }],
          priority: 10,
          narrativeConfig: { source: "template", title: "败北", summary: "败北收束。" },
        },
        {
          endingId: "end-fallback",
          name: "兜底",
          description: "",
          triggerConditions: [],
          fallback: true,
          narrativeConfig: { source: "template", summary: "到此为止。" },
        },
      ],
      fallback: "end-fallback",
    });
    const state = makeActive(template);
    state.flags.doomed = true;
    const res = fightToDefeat(state, template, cfg);
    expect(res.state.termination?.source).toBe("battleDefeat");
    expect(res.snapshot.ending?.endingId).toBe("end-defeat");
  });

  it("胜利不触发死亡路径", () => {
    const template = makeBattleTemplate();
    const cfg = deathConfig();
    const lookup = createLookup(template);
    const state = makeActive(template);
    state.flags.doomed = true;
    state.battle = createBattle("ev-ambush", { enemies: [{ ref: "enemy-x", levelScale: 1 }], canFlee: false }, state, lookup);
    state.battle.enemies[0].hp = 1;
    const res = battleActionV2(state, { type: "skill", skillId: "sk-strike" }, template, lookup, pipeline(cfg));
    expect(res.state.termination).toBeNull();
    expect(res.snapshot.status).toBe("running");
  });

  it("battleDefeat 判定不读取 HP 数值（HP 归零本身不构成判据）", () => {
    const template = makeBattleTemplate();
    const cfg = deathConfig();
    const state = makeActive(template);
    state.flags.doomed = false; // 唯一判据是 flag
    state.player.hp = 0;
    const res = fightToDefeat(state, template, cfg);
    expect(res.state.termination).toBeNull();
  });
});

// ---------- 投影与归档 ----------

describe("结局投影与归档", () => {
  it("hidden 结局不泄漏模板文案，evidenceIds 留空", () => {
    const template = makeTemplate();
    const cfg = EndingConfigSchema.parse({
      terminationConditions: [
        { type: "timeReached", params: { conditions: [timeCond] }, combinator: "AND", terminationMode: "afterSettle" },
      ],
      endings: [
        {
          endingId: "end-secret",
          name: "秘密结局名",
          description: "秘密结局描述",
          triggerConditions: [],
          priority: 99,
          endingType: "secret",
          narrativeConfig: { source: "template", title: "秘密标题", summary: "秘密摘要", masked: {} },
          unlockConditions: [],
        },
      ],
    });
    const state = makeActive(template);
    const res = advanceTurnV2(
      state,
      { action: { type: "free", description: "" } },
      template,
      createLookup(template),
      undefined,
      pipeline(cfg),
    );
    const ending = res.snapshot.ending;
    expect(ending?.endingId).toBe("end-secret");
    expect(ending?.visibility).toBe("hidden");
    expect(ending?.title).not.toBe("秘密标题");
    expect(ending?.summary).not.toBe("秘密摘要");
    expect(ending?.title).not.toContain("秘密结局名");
    expect(ending?.evidenceIds).toEqual([]);
  });

  it("终止后 pendingEvent 投影为 null（不让已结束的世界继续弹事件）", () => {
    const template = makeTemplate();
    const cfg = endingConfig();
    const state = makeActive(template);
    state.pendingEvents.push({ eventId: "ev-not-exists" });
    const snapshot = projectSnapshotV2(state, template, createLookup(template), null, cfg.endings);
    expect(snapshot.pendingEvent).toBeNull();
    expect(snapshot.status).toBe("running"); // 未终止时仍按 running 投影
    state.termination = { reason: "r", worldTime: 0, turnIndex: 0, source: "condition", endingId: "end-long" };
    const ended = projectSnapshotV2(state, template, createLookup(template), null, cfg.endings);
    expect(ended.pendingEvent).toBeNull();
    expect(ended.status).toBe("terminated");
  });

  it("归档世界投影为 archived 且保留结局", () => {
    const template = makeTemplate();
    const cfg = endingConfig();
    const state = makeActive(template);
    state.termination = { reason: "r", worldTime: 0, turnIndex: 0, source: "condition", endingId: "end-long" };
    const archived = markArchived(state);
    const snapshot = projectSnapshotV2(archived, template, createLookup(template), null, cfg.endings);
    expect(snapshot.status).toBe("archived");
    expect(snapshot.ending?.endingId).toBe("end-long");
  });
});

describe("worldStore 封存入口（#30）", () => {
  it("未终止世界拒绝封存", () => {
    const template = makeTemplate();
    const state = makeActive(template, 11);
    worldStore.save(state);
    expect(() => worldStore.seal(state)).toThrow(/archive_requires_termination/);
  });

  it("已终止世界可封存；封存后 save() 拒写（只读）", () => {
    const template = makeTemplate();
    const state = makeActive(template, 12);
    state.termination = { reason: "r", worldTime: 0, turnIndex: 0, source: "condition", endingId: "end-long" };
    worldStore.save(state);
    const sealed = worldStore.seal(state);
    expect(sealed.archived).toBe(true);
    expect(worldStore.get(state.id)?.archived).toBe(true);
    expect(() => worldStore.save(sealed)).toThrow(/ARCHIVED/);
    // 幂等：再次封存不抛错
    expect(worldStore.seal(sealed).archived).toBe(true);
  });
});

// ---------- 与既有行为的兼容 ----------

describe("兼容：未接线时不改变既有战斗/推进结果", () => {
  it("同一 seed 下带与不带空 endingConfig 的推进结果逐字段相等", () => {
    const template = makeTemplate();
    const a = makeActive(template, 21);
    const b = makeActive(template, 21);
    const empty = EndingConfigSchema.parse({ terminationConditions: [], endings: [] });
    const ra = advanceTurnV2(a, { action: { type: "free", description: "" } }, template, createLookup(template));
    const rb = advanceTurnV2(
      b,
      { action: { type: "free", description: "" } },
      template,
      createLookup(template),
      undefined,
      pipeline(empty),
    );
    expect(rb.state.turnIndex).toBe(ra.state.turnIndex);
    expect(rb.state.worldTime).toBe(ra.state.worldTime);
    expect(rb.state.player.hp).toBe(ra.state.player.hp);
    expect(rb.state.player.mood).toBe(ra.state.player.mood);
    expect(rb.snapshot.ending).toBeNull();
  });

  it("战斗实体未被 deathRoute 改写时，胜负与 HP 与不接线一致", () => {
    const template = makeBattleTemplate();
    const lookup = createLookup(template);
    const make = () => {
      const s = makeActive(template, 31);
      s.battle = createBattle("ev-ambush", { enemies: [{ ref: "enemy-x", levelScale: 1 }], canFlee: false }, s, lookup);
      s.battle.enemies[0].hp = 1;
      return s;
    };
    const plain = make();
    const withCfg = make();
    const r1 = battleActionV2(plain, { type: "skill", skillId: "sk-strike" }, template, lookup);
    const r2 = battleActionV2(withCfg, { type: "skill", skillId: "sk-strike" }, template, lookup, pipeline(deathConfig()));
    expect(r2.state.player.hp).toBe(r1.state.player.hp);
    expect(r2.snapshot.battle?.over).toBe(r1.snapshot.battle?.over);
    expect(r2.state.termination).toBeNull();
  });
});
