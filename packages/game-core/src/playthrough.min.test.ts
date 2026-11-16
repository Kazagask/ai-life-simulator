import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  EndingConfigSchema,
  EvaluationConfigSchema,
  OpeningTemplateSchema,
  RulesSchema,
  WorldTemplateV2Schema,
  type EndingConfig,
  type EvaluationConfig,
  type OpeningTemplate,
  type Rules,
  type WorldTemplateV2,
} from "@life-sim/shared";

import { createLookup } from "./v2/lookup.js";
import { createActiveWorldV2 } from "./v2/test-utils.js";
import { advanceTurnV2, battleActionV2, chooseOptionV2, type TurnPipelineConfig } from "./v2/turn.js";
import { checkAllConditions } from "./v2/engine.js";
import { projectSnapshotV2 } from "./v2/projection.js";

/**
 * **整局回归**（CI 的 L2b 门禁）。
 *
 * 为什么要有这一条：它曾经存在（旧 `v2/playthrough.test.ts`，6 种子 × 2 开局打到 day4755），
 * 「推倒重来」时随旧测试整体迁进 `legacy-tests/`，于是**全仓没有任何一条用例证明
 * "同一局能从头跑到结局"**。CI 里那条 `vitest run src/v2/playthrough.test.ts` 因此变成
 * 指向空文件（No test files found ⇒ exit 1）。本文件是它的**替代品**，不是复活：
 *
 * - 打的是新验收基线 `demo-agentic`（F1 的最小骨架模板），不是旧内容模板 jjk-2006；
 * - 判据只保留"能跑通"的结构性质（收束 / 上限 / 确定性 / 无裸 id），不做内容断言
 *   （章节名、具体结局、评分区间都属于内容，改模板就会红，那不是门禁该管的事）。
 *
 * 驱动策略：不写死任何模板专属 id。战斗用"玩家当前可用的第一个战斗技能，没有就 pass"，
 * 事件一律选**第一个可见选项**，其余按模板第一个行动推进 —— 保证换模板后仍然跑得动。
 */

const DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../specs/data/templates/demo-agentic/1.0.0",
);

/** 合并进 `WorldTemplateV2` 的 8 个声明式文件（与 `apps/server/src/templates.ts` 的 merge 集同口径）。 */
const MERGE_FILES = [
  "world.yaml",
  "characters.yaml",
  "skills.yaml",
  "items.yaml",
  "statuses.yaml",
  "events.yaml",
  "equipment.yaml",
  "combat-ai.yaml",
] as const;

function readYaml(file: string): unknown {
  const abs = path.join(DIR, file);
  if (!existsSync(abs)) return null;
  return parse(readFileSync(abs, "utf8"));
}

interface LoadedDemo {
  template: WorldTemplateV2;
  opening: OpeningTemplate;
  rules: Rules;
  endings: EndingConfig;
  evaluation: EvaluationConfig;
}

function loadDemo(): LoadedDemo {
  const merged: Record<string, unknown> = {};
  for (const file of MERGE_FILES) {
    const doc = readYaml(file) as Record<string, unknown> | null;
    if (doc === null || typeof doc !== "object") continue;
    for (const [key, value] of Object.entries(doc)) {
      if (key === "meta") merged.meta = value;
      else if (merged[key] === undefined) merged[key] = value;
      else if (Array.isArray(merged[key]) && Array.isArray(value)) {
        merged[key] = [...(merged[key] as unknown[]), ...value];
      }
    }
  }
  const openings = OpeningTemplateSchema.array().parse(readYaml("opening.yaml"));
  if (openings.length === 0) throw new Error("demo-agentic 必须有至少一个开局");
  return {
    template: WorldTemplateV2Schema.parse(merged),
    opening: openings[0]!,
    rules: RulesSchema.parse(readYaml("rules.yaml")),
    endings: EndingConfigSchema.parse(readYaml("endings.yaml")),
    evaluation: EvaluationConfigSchema.parse(readYaml("evaluation.yaml")),
  };
}

/** 一次推进的上限：demo 30 天 / 默认 1 天一步，400 轮足够；超了说明卡死在某个循环里。 */
const MAX_TURNS = 400;

interface PlayResult {
  ending: string;
  source: string;
  turns: number;
  day: number;
  /** 事实层触发次数：证明这一局真的"发生过事"，不是空转 30 天后直接收束 */
  fires: number;
  /** 历史条目数：证明选项/行动结算确实落了账 */
  history: number;
  /** 投影的可比较快照（确定性判据只比它） */
  snapshot: string;
}

function play(seed: number, loaded: LoadedDemo): PlayResult {
  const { template, opening, rules, endings, evaluation } = loaded;
  const lookup = createLookup(template);
  const pipeline: TurnPipelineConfig = { endingConfig: endings, evaluationConfig: evaluation };
  const state = createActiveWorldV2(
    { templateId: template.meta.id, playerName: `回归${seed}`, seed },
    template,
    // worldId 固定为 seed 派生，便于"同 seed 两次"逐字段比较
    `playthrough-${seed}`,
    opening,
    rules,
  );

  const actionId = template.actions?.[0]?.id;
  if (!actionId) throw new Error("模板没有声明任何行动，无法驱动整局回归");
  const rest = { action: { type: actionId, description: "" } };

  let guard = 0;
  while (state.termination === null && guard++ < MAX_TURNS) {
    // 序 1：战斗未结束 ⇒ 玩家必须先提交战斗命令（不提交就永远停在战斗里）
    if (state.battle !== null && !state.battle.over) {
      const cooldowns = state.battle.player.skillCooldowns;
      const mp = state.battle.player.mp;
      const usable = template.skills.find(
        (s) =>
          s.kind === "combat" &&
          state.player.skills.includes(s.id) &&
          s.cost.mp <= mp &&
          (cooldowns[s.id] ?? 0) <= 0,
      );
      battleActionV2(
        state,
        usable ? { type: "skill", skillId: usable.id } : { type: "pass" },
        template,
        lookup,
        pipeline,
      );
      continue;
    }

    // 序 2：槽里有待决场景 ⇒ 按 kind 分流
    const slot = state.slot;
    if (slot !== null) {
      const def = lookup.event(slot.eventId);
      if (!def) throw new Error(`槽内事件在模板里不存在：${slot.eventId}`);
      if (def.kind === "random") {
        // ADR-0034 §8-⑩：random 槽的"确认"= 推进一轮（不消耗行动，只结算那一格）
        advanceTurnV2(state, rest, template, lookup, undefined, pipeline);
        continue;
      }
      if (def.kind === "normal") {
        const ctx = { state, lookup, rng: () => 0.5 };
        const options = def.settle.normal.options.filter((o) => checkAllConditions(o.visibleWhen, ctx));
        const chosen = options[0];
        if (!chosen) throw new Error(`事件 ${def.id} 没有任何可见选项（零选项死锁）`);
        chooseOptionV2(state, { optionId: chosen.id }, template, lookup, pipeline);
        continue;
      }
      // combat 槽：战斗已结束但槽未清 ⇒ 走一次推进把它结算掉
      advanceTurnV2(state, rest, template, lookup, undefined, pipeline);
      continue;
    }

    // 序 3：空槽 ⇒ 自由行动
    advanceTurnV2(state, rest, template, lookup, undefined, pipeline);
  }

  const snapshot = projectSnapshotV2(state, template, lookup, null, endings.endings);
  return {
    ending: state.termination?.endingId ?? "(none)",
    source: state.termination?.source ?? "-",
    turns: state.turnIndex,
    day: Math.round(state.worldTime / 1440),
    fires: state.eventFires.length,
    history: state.history.length,
    snapshot: JSON.stringify(snapshot),
  };
}

describe("整局回归 · demo-agentic（CI L2b 门禁）", () => {
  const loaded = loadDemo();
  const declaredEndings = new Set(loaded.endings.endings.map((e) => e.endingId));

  it("6 个种子都能从开局跑到结局（不卡死、结局在声明集合内）", { timeout: 180000 }, () => {
    const rows = [1, 2, 3, 4, 5, 6].map((seed) => ({ seed, ...play(seed, loaded) }));
    // 失败时能直接看出是哪个种子走崩了
    console.log(
      "playthrough:",
      rows.map((r) => `s${r.seed} ${r.ending}(${r.source}) t${r.turns} d${r.day} fires${r.fires}`).join(" | "),
    );

    for (const r of rows) {
      expect(r.ending, `seed ${r.seed} 未收束（turns=${r.turns}, guard 用尽）`).not.toBe("(none)");
      expect(declaredEndings.has(r.ending), `seed ${r.seed} 结局未在 endings.yaml 声明：${r.ending}`).toBe(true);
      expect(r.turns, `seed ${r.seed} 轮次异常`).toBeLessThan(MAX_TURNS);
      // terminationConditions 是 `timeReached >= 30 day` + afterSettle ⇒ 收束时世界时间必然已过 30 天
      expect(r.day, `seed ${r.seed} 结束时间早于模板门槛`).toBeGreaterThanOrEqual(30);
      /**
       * **非空转**判据：只有"跑到结局"是不够的 —— 一条把事件全部错失、只推进时间的管线
       * 同样会收束。所以必须同时断言这一局真的触发过事件、真的落过历史。
       */
      expect(r.fires, `seed ${r.seed} 一次事件都没触发（管线空转）`).toBeGreaterThan(0);
      expect(r.history, `seed ${r.seed} 历史为空（结算没有落账）`).toBeGreaterThan(0);
    }
  });

  it("同 seed 两次跑出逐字段相同的投影（确定性硬约束）", { timeout: 180000 }, () => {
    const a = play(7, loaded);
    const b = play(7, loaded);
    expect(b.turns).toBe(a.turns);
    expect(b.ending).toBe(a.ending);
    expect(b.snapshot).toBe(a.snapshot);
  });

  it("投影自洽：关系行不出现裸 id，且不含任何角色的 private.secrets", { timeout: 180000 }, () => {
    const r = play(3, loaded);
    const snapshot = JSON.parse(r.snapshot) as {
      npcs: Array<{ id: string; relations: Array<{ withId: string; withName?: string }> }>;
    };
    for (const npc of snapshot.npcs) {
      for (const rel of npc.relations) {
        expect(rel.withName, `关系行缺名字：${npc.id} → ${rel.withId}`).toBeTruthy();
        expect(rel.withName).not.toBe(rel.withId);
      }
    }
    // demo-agentic 当前没有 secrets；将来加了也不得进玩家投影
    const secrets = (loaded.template.characters ?? []).flatMap((c) => c.private.secrets ?? []);
    for (const secret of secrets) {
      expect(r.snapshot.includes(secret), `私密信息泄漏进投影：${secret}`).toBe(false);
    }
  });
});
