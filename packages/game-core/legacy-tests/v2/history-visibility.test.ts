import { describe, expect, it } from "vitest";
import {
  EndingConfigSchema,
  type EndingConfig,
  type HistoryEntryV2,
  type WorldStateV2,
  type WorldTemplateV2,
} from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { createBattle } from "./battle.js";
import { createActiveWorldV2 } from "./test-utils.js";
import { advanceTurnV2, battleActionV2, type TurnPipelineConfig } from "./turn.js";
import { assembleArchive } from "./archive.js";
import { playerVisibleEntries, playerVisibleHistory, projectArchiveForPlayer } from "./history.js";
import { isPlayerVisible } from "@life-sim/shared";

/**
 * 历史可见性渗透测试（R-VS-05 / design §2.5）。
 *
 * 构造含 hidden 结局（narrativeConfig.masked，ADR-0006）的世界，
 * 对玩家端出口（snapshot / turnResult.playerVisibleHistory / history 列表 / 归档投影）
 * 做**递归扫描**：命中 hidden 条目的 id 或 summary 片段即失败。
 * 这条测试是 R-NFR-04 的常驻回归防线——去掉过滤实现时它必须失败。
 */

// ---------- 夹具 ----------

const timeCond = { time: { gte: { value: 1, unit: "day" } } } as const;

function makeBase(): WorldTemplateV2 {
  return {
    meta: { id: "t", name: "可见性渗透", description: "d", startYear: 2000, engineProtocol: "v2" },
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

/** 一击必杀战斗模板 + 死亡事件 ev-death（normal，等待选项）。 */
function makeBattleTemplate(): WorldTemplateV2 {
  const base = makeBase();
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
      {
        id: "ev-death",
        title: "终焉之门",
        narrative: "死亡结局事件。",
        trigger: { source: "pool", probability: 0 },
        kind: "normal",
        settle: {
          normal: { options: [{ id: "opt-1", text: "接受", effects: [] }] },
        },
      },
    ],
  } as unknown as WorldTemplateV2;
}

/** 战败 → 死亡事件路径；结局是否掩码由 maskEnding 控制。 */
function deathEventConfig(maskEnding: boolean): EndingConfig {
  return EndingConfigSchema.parse({
    terminationConditions: [],
    deathRoute: { deathMode: "event", deathEventId: "ev-death", conditions: [{ flag: "doomed", eq: true }] },
    endings: [
      {
        endingId: "end-secret",
        name: "秘密结局名",
        description: "秘密结局描述",
        triggerConditions: [{ flag: "doomed", eq: true }],
        priority: 50,
        endingType: "secret",
        narrativeConfig: maskEnding
          ? { source: "template", title: "秘密标题", summary: "秘密摘要", masked: {} }
          : { source: "template", title: "公开标题", summary: "公开摘要" },
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

function makeActive(template: WorldTemplateV2, seed = 1): WorldStateV2 {
  return createActiveWorldV2({ templateId: "t", playerName: "测试者", seed }, template, `w-${seed}`);
}

const pipeline = (cfg: EndingConfig): TurnPipelineConfig => ({ endingConfig: cfg });

/** 进入战斗并在本次行动中被打死（over=defeat → deathRoute）。 */
function fightToDefeat(state: WorldStateV2, template: WorldTemplateV2, cfg: EndingConfig) {
  const lookup = createLookup(template);
  state.player.hp = 1;
  state.battle = createBattle("ev-ambush", { enemies: [{ ref: "enemy-x", levelScale: 1 }], canFlee: false }, state, lookup);
  return battleActionV2(state, { type: "skill", skillId: "sk-strike" }, template, lookup, pipeline(cfg));
}

// ---------- 递归扫描 ----------

/** hidden 条目的泄漏指纹：id 与 summary 的独特片段。 */
const HIDDEN_FRAGMENTS = ["death-ev-death", "死亡结局事件", "秘密标题", "秘密摘要", "秘密结局名"];

function collectStrings(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return out;
}

function assertNoHiddenLeak(payload: unknown): void {
  const strings = collectStrings(payload);
  for (const frag of HIDDEN_FRAGMENTS) {
    expect(strings.filter((s) => s.includes(frag))).toEqual([]);
  }
}

function makeHiddenEntry(turn: number, id: string): HistoryEntryV2 {
  return {
    id,
    turnIndex: turn,
    worldTime: turn * 360,
    formattedTime: `第${turn}天`,
    type: "event",
    summary: "死亡结局事件：death-ev-death",
    visibility: "hidden",
  };
}

// ---------- 用例 ----------

describe("写入侧：死亡事件条目按结局掩码继承", () => {
  it("掩码结局（masked）→ 死亡事件条目 visibility = hidden", () => {
    const template = makeBattleTemplate();
    const state = makeActive(template);
    state.flags.doomed = true;
    const res = fightToDefeat(state, template, deathEventConfig(true));
    expect(res.state.termination?.endingId).toBe("end-secret");
    const entry = res.state.history.find((h) => h.id.includes("death-ev-death"));
    expect(entry).toBeDefined();
    expect(entry?.visibility).toBe("hidden");
  });

  it("公开结局（无 masked）→ 同一流程的死亡事件条目 visibility = public", () => {
    const template = makeBattleTemplate();
    const state = makeActive(template);
    state.flags.doomed = true;
    const res = fightToDefeat(state, template, deathEventConfig(false));
    expect(res.state.termination?.endingId).toBe("end-secret");
    const entry = res.state.history.find((h) => h.id.includes("death-ev-death"));
    expect(entry?.visibility).toBe("public");
  });

  it("事件/行动/战斗来源恒为 public（#33：事件无隐藏语义）", () => {
    const template = makeBattleTemplate();
    const state = makeActive(template);
    state.flags.doomed = true;
    const res = fightToDefeat(state, template, deathEventConfig(true));
    const nonDeath = res.state.history.filter((h) => !h.id.includes("death-ev-death"));
    expect(nonDeath.length).toBeGreaterThan(0);
    for (const h of nonDeath) expect(h.visibility).toBe("public");
  });
});

describe("读取侧：先过滤再截断", () => {
  it("末 20 条全是 hidden 时，窗口回填更早的 public 条目（先过滤后 slice）", () => {
    const template = makeBase();
    const state = makeActive(template);
    const base = state.history;
    for (let i = 0; i < 25; i++) {
      base.push({
        id: `e-${i}`,
        turnIndex: i,
        worldTime: i,
        formattedTime: `第${i}天`,
        type: "event",
        summary: `事件 ${i}`,
        visibility: i >= 20 ? "hidden" : "public",
      });
    }
    const visible = playerVisibleHistory(state, 20);
    expect(visible).toHaveLength(20);
    expect(visible.every((h) => isPlayerVisible(h))).toBe(true);
    expect(visible.some((h) => h.id === "e-0")).toBe(true); // 窗口越过 hidden 段取到更早的 public
    expect(visible.some((h) => h.id === "e-24")).toBe(false); // hidden 段不在窗口内
  });

  it("全是 hidden 时玩家端为空列表", () => {
    const template = makeBase();
    const state = makeActive(template);
    state.history.push(makeHiddenEntry(0, "death-ev-death"));
    expect(playerVisibleHistory(state, 20)).toEqual([]);
    expect(playerVisibleEntries(state.history)).toEqual([]);
  });

  it("缺 visibility 字段的旧数据视为 public（兼容策略，非语义主张）", () => {
    const legacy: HistoryEntryV2 = {
      id: "old-1",
      turnIndex: 0,
      worldTime: 0,
      formattedTime: "旧",
      type: "event",
      summary: "R2.2 旧条目",
    };
    expect(isPlayerVisible(legacy)).toBe(true);
    expect(playerVisibleEntries([legacy, makeHiddenEntry(1, "death-ev-death")])).toEqual([legacy]);
  });

  it("unknown 可见性不进玩家端", () => {
    const unknown: HistoryEntryV2 = {
      ...makeHiddenEntry(0, "u-1"),
      id: "u-1",
      summary: "未定级条目",
      visibility: "unknown",
    };
    expect(isPlayerVisible(unknown)).toBe(false);
  });
});

describe("渗透扫描：四个玩家端出口", () => {
  it("出口① snapshot：终局投影无 hidden 泄漏", () => {
    const template = makeBattleTemplate();
    const state = makeActive(template);
    state.flags.doomed = true;
    const res = fightToDefeat(state, template, deathEventConfig(true));
    assertNoHiddenLeak(res.snapshot);
  });

  it("出口② turnResult.playerVisibleHistory：无 hidden 泄漏", () => {
    const template = makeBattleTemplate();
    const state = makeActive(template);
    state.flags.doomed = true;
    const res = fightToDefeat(state, template, deathEventConfig(true));
    expect(res.playerVisibleHistory.every((h) => isPlayerVisible(h))).toBe(true);
    assertNoHiddenLeak(res.playerVisibleHistory);
  });

  it("出口③ history 列表（/history 路由同函数）：无 hidden 泄漏", () => {
    const template = makeBattleTemplate();
    const state = makeActive(template);
    state.flags.doomed = true;
    const res = fightToDefeat(state, template, deathEventConfig(true));
    const served = playerVisibleEntries(res.state.history);
    expect(served.length).toBeLessThan(res.state.history.length); // 确有 hidden 被滤掉
    assertNoHiddenLeak(served);
  });

  it("出口④ 归档投影：public + hiddenHistoryCount；存档事实保留全量", () => {
    const template = makeBattleTemplate();
    const state = makeActive(template);
    state.flags.doomed = true;
    const res = fightToDefeat(state, template, deathEventConfig(true));
      expect(res.state.termination).not.toBeNull();
      const cfg = deathEventConfig(true);
    const { record } = assembleArchive(res.state, template, createLookup(template), {
      endingId: "end-secret",
      evidenceIds: [],
      title: "x",
      summary: "y",
      narrativeSource: "template",
    }, {
      dimensions: [],
      summary: "",
      summarySource: "template",
    }, cfg.endings); // 与 server 归档路径一致：传入结局模板集，掩码投影生效
    const projected = projectArchiveForPlayer(record);
    expect(projected.hiddenHistoryCount).toBe(1);
    expect(projected.history.length).toBe(record.history.length - 1);
    assertNoHiddenLeak(projected);
    // 存档事实不受过滤约束：完整记录仍保留 hidden 条目
    expect(record.history.some((h) => h.id.includes("death-ev-death"))).toBe(true);
  });
});

describe("寿终路径的出口（公开结局）", () => {
  it("timeReached 终止 → 各出口条目全 public，无过滤损耗", () => {
    const template = makeBase();
    const cfg = EndingConfigSchema.parse({
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
      ],
      fallback: "end-long",
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
    expect(res.state.termination?.endingId).toBe("end-long");
    expect(res.playerVisibleHistory.length).toBe(res.state.history.length); // 无隐藏 → 无损耗
    assertNoHiddenLeak(res.playerVisibleHistory);
  });
});
