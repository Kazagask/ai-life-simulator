import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  EndingConfigSchema,
  EvaluationConfigSchema,
  OpeningTemplateSchema,
  WorldTemplateV2Schema,
  type WorldTemplateV2,
} from "@life-sim/shared";
import { createLookup } from "./lookup.js";
import { createRunnerContext } from "./runner-context.js";
import { handoff, runOpening } from "./opening.js";
import { advanceTurnV2, battleActionV2, chooseOptionV2, createWorldV2, type TurnPipelineConfig } from "./turn.js";
import { checkAllConditions, maxHp } from "./engine.js";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../specs/data/templates/jjk-2006");

function load(): WorldTemplateV2 {
  const merged: Record<string, unknown> = {};
  for (const f of ["world.yaml", "characters.yaml", "skills.yaml", "items.yaml", "statuses.yaml", "events.yaml"]) {
    const doc = parse(readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
    for (const [k, v] of Object.entries(doc)) {
      if (k === "meta") merged.meta = v;
      else if (merged[k] === undefined) merged[k] = v;
      else if (Array.isArray(merged[k]) && Array.isArray(v)) merged[k] = [...(merged[k] as unknown[]), ...v];
    }
  }
  return WorldTemplateV2Schema.parse(merged);
}

const template = load();
const openings = OpeningTemplateSchema.array().parse(parse(readFileSync(path.join(dir, "opening.yaml"), "utf8")));
const endings = EndingConfigSchema.parse(parse(readFileSync(path.join(dir, "endings.yaml"), "utf8")));
const evaluation = EvaluationConfigSchema.parse(parse(readFileSync(path.join(dir, "evaluation.yaml"), "utf8")));
const pipeline: TurnPipelineConfig = { endingConfig: endings, evaluationConfig: evaluation };

function play(seed: number, openingIdx: number) {
  const lookup = createLookup(template);
  const base = createWorldV2({ templateId: "jjk-2006", playerName: `探针${seed}`, seed }, template, `probe-${seed}`);
  const { state: opened, run } = runOpening(base, openings[openingIdx], { ...createRunnerContext(seed), lookup });
  const state = handoff(opened, run, lookup);
  const acts = ["train", "socialize", "patrol", "explore", "study", "rest"];
  let guard = 0;
  let chapters: unknown[] = [];
  let picks = 0;
  const log: string[] = [];
  while (guard++ < 900 && state.termination === null) {
    if (chapters[chapters.length - 1] !== state.flags.chapter) { chapters.push(state.flags.chapter); log.push(`ch${String(state.flags.chapter)}@t${state.turnIndex}/d${Math.round(state.worldTime / 1440)}`); }
    if (state.battle && !state.battle.over) {
      const cap = maxHp(state.player, template);
      const heal = state.player.inventory["item-first-aid"] ?? 0;
      if (state.player.hp < cap * 0.45 && heal > 0) {
        battleActionV2(state, { type: "item", itemId: "item-first-aid" }, template, lookup, pipeline);
      } else {
        const cds = state.battle.player.skillCooldowns;
        const mp = state.battle.player.mp;
        const usable = template.skills
          .filter((s) => s.kind === "combat" && state.player.skills.includes(s.id) && s.cost.mp <= mp && (cds[s.id] ?? 0) <= 0)
          .sort((a, b) => (b.kind === "combat" ? b.cost.mp : 0) - (a.kind === "combat" ? a.cost.mp : 0));
        const pick = usable[0] ?? template.skills.find((s) => s.id === "sk-basic-strike" && s.kind === "combat");
        if (pick) battleActionV2(state, { type: "skill", skillId: pick.id }, template, lookup, pipeline);
        else battleActionV2(state, { type: "flee" }, template, lookup, pipeline);
      }
      continue;
    }
    const pend = state.pendingEvents[0];
    if (pend) {
      const ev = lookup.event(pend.eventId);
      if (!ev || ev.kind !== "normal") throw new Error(`stuck: ${pend.eventId}`);
      const ctx = { state, lookup, rng: () => 0.5 };
      const opts = ev.settle.normal.options.filter((o) => checkAllConditions(o.visibleWhen, ctx));
      // 有「牵起她的手」这类剧情选项时偏向选择（覆盖 secret 线），否则按 seed 轮换
      const story = opts.find((o) => /牵起她的手|拦下他|跟上去/.test(o.text));
      const chosen = story ?? opts[(seed + picks++) % opts.length];
      chooseOptionV2(state, { optionId: chosen.id }, template, lookup, pipeline);
      continue;
    }
    const act = acts[(seed + guard) % acts.length];
    advanceTurnV2(state, { action: { type: act, description: "" } }, template, lookup, undefined, pipeline);
  }
  return {
    seed,
    log: log.join("→"),
    day: Math.round(state.worldTime / 1440),
    turns: state.turnIndex,
    chapters: chapters.join("→"),
    /**
     * 章节/尾声事件的实际触发次数（事实层 `eventFires` 是 append-only）。
     * `chapters` 只记录**变化**，看不出「同一章被抽中多次」，故单列计数。
     */
    chapterFires: state.eventFires.reduce<Record<string, number>>((acc, f) => {
      if (/^ev-ch\d-/.test(f.eventId) || f.eventId === "ev-epilogue") {
        acc[f.eventId] = (acc[f.eventId] ?? 0) + 1;
      }
      return acc;
    }, {}),
    ending: state.termination?.endingId ?? "(none)",
    source: state.termination?.source ?? "-",
    wins: state.flags.battleWins ?? 0,
    ce: state.player.attributes.cursedEnergy,
    rep: state.player.attributes.reputation,
    skills: state.player.skills.length,
    keys: ["rikoSaved", "getoSaved", "joinedCurse", "shibuyaSurvived", "specialGrade", "leaveJujutsu", "storyDone"]
      .filter((k) => state.flags[k] !== undefined)
      .join(","),
  };
}



describe("咒术转盘 · 整局回归（固定种子的自动通关）", () => {
  const KNOWN_ENDINGS = new Set([
    "end-death",
    "end-secret-savior",
    "end-geto-saved",
    "end-riko-saved",
    "end-shibuya-hero",
    "end-curse-lord",
    "end-special-grade",
    "end-guardian",
    "end-leave",
    "end-long-life",
    "end-retire",
    "end-ordinary",
  ]);

  it("6 个种子 × 2 个开局都能收束，章节推进到至少第 3 章，结局在模板声明集合内", () => {
    const rows = [];
    for (let seed = 1; seed <= 6; seed++) rows.push(play(seed, seed % 2));
    // 可读的对局摘要（回归失败时便于判断是哪条线走崩了）
    console.log(
      "playthrough:",
      rows.map((r) => `s${r.seed} ${r.ending} day${r.day} t${r.turns} [${r.chapters}]`).join(" | "),
    );

    for (const r of rows) {
      expect(r.ending, `seed ${r.seed} 应收束为结局`).not.toBe("(none)");
      expect(KNOWN_ENDINGS.has(r.ending), `seed ${r.seed} 结局未在模板声明：${r.ending}`).toBe(true);
      expect(r.chapters.split("→").length, `seed ${r.seed} 章节推进不足：${r.chapters}`).toBeGreaterThanOrEqual(3);
      expect(r.turns, `seed ${r.seed} 回合数异常`).toBeLessThan(600);
      expect(r.day, `seed ${r.seed} 结束时间异常`).toBeGreaterThanOrEqual(60);
      // 章节触发器必须一局一次：`once` 挡掉「待决期间每轮 drain 重复入队」
      // （QA D-01：曾出现 ch5×4 / epilogue×4，而 chapter 数值变化看不出来）
      const dup = Object.entries(r.chapterFires).filter(([, n]) => n > 1);
      expect(dup, `seed ${r.seed} 章节事件重复触发：${JSON.stringify(dup)}（全量 ${JSON.stringify(r.chapterFires)}）`).toEqual([]);
      expect(r.chapterFires["ev-ch1-call"], `seed ${r.seed} 第一章未触发`).toBe(1);
    }
    // 终局内容可达：至少一个种子活到涩谷并走完学年
    expect(rows.some((r) => r.keys.includes("shibuyaSurvived") || r.keys.includes("storyDone"))).toBe(true);
  });
});
