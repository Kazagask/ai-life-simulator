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
import { evaluateLifeV2 } from "./life-evaluation.js";

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
  const acts = ["train", "socialize", "patrol", "explore", "study", "rest", "recuperate"];
  let guard = 0;
  let chapters: unknown[] = [];
  let picks = 0;
  const log: string[] = [];
  while (guard++ < 900 && state.termination === null) {
    if (chapters[chapters.length - 1] !== state.flags.chapter) { chapters.push(state.flags.chapter); log.push(`ch${String(state.flags.chapter)}@t${state.turnIndex}/d${Math.round(state.worldTime / 1440)}`); }
    if (state.battle && !state.battle.over) {
      const cap = maxHp(state.player, template);
      const heal = state.player.inventory["item-first-aid"] ?? 0;
      const bound = state.battle.player.statuses.some((s) =>
        lookup.status(s.statusId)?.combat?.control?.includes("cannot_use_items"),
      );
      if (state.player.hp < cap * 0.45 && heal > 0 && !bound) {
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
      const preferred = [
        /跟去/, /贴身/, /通宵警戒/, /陪她说说话/, /挡在她身前/, /带她走/,
        /跟我回去/, /拦住|拦下/, /回高专/, /拆掉封印阵/, /冲进领域/, /挡在避难通道口/,
        /把手指抢过来/, /追查|查一件事|查内鬼/, /先救|把人带出去/,
      ];
      const story =
        preferred.map((re) => opts.find((o) => re.test(o.text))).find((o) => o !== undefined) ??
        opts.find((o) => /转动命数转盘/.test(o.text));
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
    /**
     * D-06 回归：满年局的五维分（真实 evaluation.yaml 配置）。
     * 旧实现长局必然被 `min(hi, raw)` 打满 100；改有界饱和后应落在可读区间。
     */
    evaluation: evaluateLifeV2(state, evaluation),
    wins: state.flags.battleWins ?? 0,
    ce: state.player.attributes.cursedEnergy,
    rep: state.player.attributes.reputation,
    skills: state.player.skills.length,
    keys: ["savedRiko", "getoStayed", "savedGojo", "shibuyaSurvived", "finalEnd", "defected", "storyDone"]
      .filter((k) => state.flags[k] !== undefined)
      .join(","),
  };
}



describe("咒术转盘 · 整局回归（固定种子的自动通关）", () => {
  const KNOWN_ENDINGS = new Set(endings.endings.map((e) => e.endingId));

  it("6 个种子 × 2 个开局都能收束，章节推进到至少第 3 章，结局在模板声明集合内", { timeout: 180000 }, () => {
    const rows = [];
    for (let seed = 1; seed <= 6; seed++) rows.push(play(seed, seed % 2));
    // 可读的对局摘要（回归失败时便于判断是哪条线走崩了）
    console.log(
      "playthrough:",
      rows.map((r) => `s${r.seed} ${r.ending} day${r.day} t${r.turns} [${r.keys}]`).join(" | "),
    );

    for (const r of rows) {
      expect(r.ending, `seed ${r.seed} 应收束为结局`).not.toBe("(none)");
      expect(KNOWN_ENDINGS.has(r.ending), `seed ${r.seed} 结局未在模板声明：${r.ending}`).toBe(true);
      expect(r.chapters.split("→").length, `seed ${r.seed} 章节推进不足：${r.chapters}`).toBeGreaterThanOrEqual(8);
      expect(r.turns, `seed ${r.seed} 回合数异常`).toBeLessThan(700);
      // 按原作时间线：2018-10 涩谷（第 4686 天）之后才可能收束
      expect(r.day, `seed ${r.seed} 结束时间异常`).toBeGreaterThanOrEqual(4300);
      // 章节触发器必须一局一次：`once` 挡掉「待决期间每轮 drain 重复入队」
      // （QA D-01：曾出现 ch5×4 / epilogue×4，而 chapter 数值变化看不出来）
      const dup = Object.entries(r.chapterFires).filter(([, n]) => n > 1);
      expect(dup, `seed ${r.seed} 章节事件重复触发：${JSON.stringify(dup)}（全量 ${JSON.stringify(r.chapterFires)}）`).toEqual([]);
      expect(r.chapterFires["ev-ch1-gate"], `seed ${r.seed} 第一章未触发`).toBe(1);
    }
    // 终局内容可达：至少一个种子活到涩谷并走完学年
    expect(rows.some((r) => r.keys.includes("shibuyaSurvived") || r.keys.includes("storyDone"))).toBe(true);
  });

  it("D-06：满年局五维不再全部打满 100（有界饱和），overall 仍有区分度", { timeout: 180000 }, () => {
    const rows = [1, 2, 3, 4, 5, 6].map((seed) => play(seed, seed % 2));
    console.log(
      "evaluation:",
      rows
        .map(
          (r) =>
            `s${r.seed} ${r.evaluation.dimensions.map((d) => `${d.id}=${d.score}`).join(",")} overall=${r.evaluation.overall}`,
        )
        .join(" | "),
    );
    // 模板声明的区间上界（evaluation.yaml：growth/bonds/deeds [−50,100]，truth/freedom [−30,100]）
    const hiById = new Map(
      [...evaluation.dimensions, ...evaluation.worldSpecificDimensions].map((d) => [d.id, d.ranges[1]]),
    );
    for (const r of rows) {
      for (const d of r.evaluation.dimensions) {
        const hi = hiById.get(d.id)!;
        // 旧缺陷：长局 `min(hi, raw)` ⇒ 五维恒等于 hi。现在必须严格小于上界。
        expect(d.score, `seed ${r.seed} 维度 ${d.id} 仍被打满 ${hi}`).toBeLessThan(hi);
        // 同时不能因为压缩过头失去「走完一生」的写实性
        expect(d.score, `seed ${r.seed} 维度 ${d.id} 分过低`).toBeGreaterThan(55);
      }
      const overall = r.evaluation.overall!;
      expect(overall).toBeLessThan(95);
      expect(overall).toBeGreaterThan(60);
    }
    // 不同种子的 overall 不再全部相等（区分度）
    expect(new Set(rows.map((r) => r.evaluation.overall)).size).toBeGreaterThan(1);
  });
});
