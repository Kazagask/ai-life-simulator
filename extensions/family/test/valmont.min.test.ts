import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { EndingConfig, EvaluationConfig, OpeningTemplate, Rules, WorldTemplateV2, WorldStateV2 } from "@life-sim/shared";
import {
  EndingConfigSchema,
  EvaluationConfigSchema,
  OpeningTemplateSchema,
  RulesSchema,
  WorldTemplateV2Schema,
} from "@life-sim/shared";
import {
  advanceTurnV2,
  checkCondition,
  chooseOptionV2,
  createActiveWorldV2,
  createLookup,
  createRunnerContext,
  projectSnapshotV2,
  registerExtensionRuntime,
  resetExtensionRuntimes,
  slotEventView,
  type TemplateLookup,
  type TurnPipelineConfig,
} from "@life-sim/game-core";
import { familyExtension, type FamilyView } from "../src/index.js";
import { toViewModel } from "@life-sim/rpg-ui";

/**
 * 集成回归：**直接拿可玩的 `valmont` 模板当夹具**，不另造测试专用剧本。
 *
 * 这样做的好处是断言永不与「只有测试才存在的世界」脱节 —— 模板一改，这里立刻红，
 * 而它红了就说明玩家看到的那个剧本真的变了。代价是断言受剧本内容约束，
 * 所以这里只钉三类东西：**投影算得对不对、开册后果有没有落地、同 seed 是否可复现**。
 *
 * 精确的算法边界（半血亲、姻亲合成、系数门槛）留在 `kinship-readings.min.test.ts` 的合成夹具里，
 * 那是单元层；这一层只回答「玩家看到的东西对不对」。
 */

// 称谓推导现在住在扩展里：模板声明 + 启动期注册，二者缺一不跑（docs/EXTENSIONS.md §2 保证 4）。
beforeAll(() => registerExtensionRuntime(familyExtension));
afterAll(() => resetExtensionRuntimes());

const DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../specs/data/templates/valmont/1.0.0",
);

const MERGE_FILES = [
  "world.yaml",
  "characters.yaml",
  "skills.yaml",
  "items.yaml",
  "statuses.yaml",
  "events.yaml",
] as const;

function readYaml(file: string): unknown {
  const abs = path.join(DIR, file);
  if (!existsSync(abs)) return null;
  return parse(readFileSync(abs, "utf8"));
}

interface Loaded {
  template: WorldTemplateV2;
  opening: OpeningTemplate;
  rules: Rules;
  endings: EndingConfig;
  evaluation: EvaluationConfig;
}

function load(): Loaded {
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
  if (openings.length === 0) throw new Error("valmont 必须有至少一个开局");
  return {
    template: WorldTemplateV2Schema.parse(merged),
    opening: openings[0]!,
    rules: RulesSchema.parse(readYaml("rules.yaml")),
    endings: EndingConfigSchema.parse(readYaml("endings.yaml")),
    evaluation: EvaluationConfigSchema.parse(readYaml("evaluation.yaml")),
  };
}

const loaded = load();
const lookup: TemplateLookup = createLookup(loaded.template);
const pipeline: TurnPipelineConfig = {
  endingConfig: loaded.endings,
  evaluationConfig: loaded.evaluation,
};

function newWorld(seed: number): WorldStateV2 {
  return createActiveWorldV2(
    { templateId: loaded.template.meta.id, playerName: `罗兰${seed}`, seed },
    loaded.template,
    `valmont-${seed}`,
    loaded.opening,
  );
}

const snapshot = (state: WorldStateV2) =>
  projectSnapshotV2(state, loaded.template, lookup, null);

/** 走一步：事件槽优先结算，否则推进一步自由行动。 */
function stepOnce(cur: WorldStateV2, i: number): WorldStateV2 {
  const view = slotEventView(cur, lookup);
  if (view !== null) {
    const option = view.options?.[0];
    if (!option) return cur;
    return chooseOptionV2(cur, { optionId: option.id }, loaded.template, lookup, pipeline).state;
  }
  return advanceTurnV2(
    cur,
    { action: { type: "act-read", description: "翻一页" } },
    loaded.template,
    lookup,
    createRunnerContext(cur.seed + i),
    pipeline,
  ).state;
}

/** 走到结局或步数用尽。 */
function drive(state: WorldStateV2, maxSteps = 120): WorldStateV2 {
  let cur = state;
  for (let i = 0; i < maxSteps; i++) {
    if (cur.termination !== null || cur.archived === true) return cur;
    cur = stepOnce(cur, i);
  }
  return cur;
}

function relationRow(state: WorldStateV2, npcName: string, otherName: string) {
  const snap = snapshot(state);
  const npc = snap.npcs.find((n) => n.name === npcName);
  if (!npc) throw new Error(`没有这个角色卡：${npcName}`);
  return npc.relations.filter((r) => r.withName === otherName);
}

describe("valmont · 加载", () => {
  it("十二人全部在册，事件链与四结局完整", () => {
    expect(loaded.template.meta.id).toBe("valmont");
    expect(loaded.template.characters).toHaveLength(12);
    expect(loaded.template.events.length).toBeGreaterThanOrEqual(10);
    expect(loaded.endings.endings.length).toBeGreaterThanOrEqual(4);
  });

  it("模板声明了 family 扩展：并排展示多读法，maxHops 保持 3", () => {
    const family = loaded.template.extensions?.family as
      | { showAllRoles?: boolean; maxHops?: number }
      | undefined;
    expect(family?.showAllRoles).toBe(true);
    expect(family?.maxHops).toBe(3);
  });
});

describe("valmont · 开册的后果落在状态上", () => {
  it("第一幕结算后六位先辈记为已故，其余在册", () => {
    // 六个人的退场写在 `evt:open` 的选项效果里，不在开局模板上 —— 所以要先把这一幕走完。
    // 幕是推进后才落槽的，开局那一刻槽是空的（这也是「开册」要玩家先读一页的原因）。
    let state = newWorld(3);
    for (let i = 0; i < 8 && state.flags.ledgerOpened !== true; i++) state = stepOnce(state, i);
    expect(state.flags.ledgerOpened).toBe(true);

    const dead = state.npcs.filter((n) => n.lifecycle.state === "inactive").map((n) => n.id).sort();
    expect(dead).toEqual(
      ["npc-aldric", "npc-bardo", "npc-hilda", "npc-irma", "npc-konrad", "npc-mathilde"].sort(),
    );
    const alive = state.npcs.filter((n) => n.lifecycle.state === "alive").map((n) => n.id).sort();
    expect(alive).toContain("npc-blanche");
    expect(alive).toContain("npc-cecily");
    // 玩家出边也在这一幕补上（playerTemplate 没有 relations 字段的已知缺口）
    expect(state.relations.some((e) => e.from === "player" && e.kind === "father")).toBe(true);
  });
});

describe("valmont · 关系投影（玩家真正看到的那一行）", () => {
  it("布兰奇看玛蒂尔达是「外婆」，不是「妈妈」；姻亲读法不再作为附加身份并列", () => {
    const rows = relationRow(newWorld(3), "布兰奇", "玛蒂尔达");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kinshipTerm).toBe("外婆");
    expect(row.kinshipTerm).not.toBe("妈妈");
    // 行首已经写了「外婆」，再并排一个「继母」是自相矛盾的读法混层。
    expect(row.kinshipTerms ?? []).not.toContain("继母");
  });

  it("直系血亲行的 extras 只并列血亲读法（不含任何姻亲/拟制称谓）", () => {
    const snap = snapshot(newWorld(12));
    const BLOOD_KINDS = new Set([
      "father",
      "mother",
      "son",
      "daughter",
      "elder-brother",
      "younger-brother",
      "elder-sister",
      "younger-sister",
    ]);
    /**
     * 姻亲/拟制词表（测试自己的口径，不从实现里 import：
     * 这条断言要钉的是**玩家看到的词**，不是某份常量表本身）。
     */
    const AFFINAL = new Set([
      "公公",
      "婆婆",
      "岳父",
      "岳母",
      "继父",
      "继母",
      "继子",
      "继女",
      "继兄弟",
      "继姐妹",
      "儿媳",
      "女婿",
      "嫂子",
      "弟媳",
      "姐夫",
      "妹夫",
      "小姑子",
      "小叔子",
      "大伯子",
      "小舅子",
      "大姨子",
      "小姨子",
      "连襟",
      "妯娌",
    ]);
    const offenders: string[] = [];
    for (const npc of snap.npcs) {
      for (const row of npc.relations) {
        if (row.direction !== "out" || !BLOOD_KINDS.has(row.kind)) continue;
        for (const term of row.kinshipTerms ?? []) {
          if (AFFINAL.has(term)) offenders.push(`${npc.name} ${row.kind} ${row.withName}: ${term}`);
        }
      }
    }
    expect(offenders).toEqual([]);

    // 血亲范围内的多读法必须保留：布兰奇既是奥德里克的女儿，又是他的外孙女。
    const row = relationRow(newWorld(12), "奥德里克", "布兰奇").find((r) => r.kind === "daughter");
    expect(row?.kinshipTerm).toBe("女儿");
    expect(row?.kinshipTerms).toContain("外孙女");
  });

  it("戈弗雷看罗莎（零血缘）不会写成「妹妹」", () => {
    const rows = relationRow(newWorld(3), "戈弗雷", "罗莎");
    expect(rows.length).toBeGreaterThan(0);
    const terms = rows.flatMap((r) => [r.kinshipTerm, ...(r.kinshipTerms ?? [])]);
    expect(terms).not.toContain("妹妹");
    // 这层是事实边（妻子），主称谓就是「老婆」；姻亲读法不再作为附加身份并列。
    expect(rows.find((r) => r.kind === "wife")?.kinshipTerm).toBe("老婆");
  });

  it("半血亲带前缀：玛蒂尔达看戈弗雷是「同父异母的弟弟」", () => {
    const rows = relationRow(newWorld(3), "玛蒂尔达", "戈弗雷");
    const terms = rows.flatMap((r) => [r.kinshipTerm, ...(r.kinshipTerms ?? [])]);
    expect(terms).toContain("同父异母的弟弟");
  });

  it("同一对端点的多行各自成立：奥德里克同时是父亲与丈夫", () => {
    const rows = relationRow(newWorld(3), "布兰奇", "奥德里克").filter((r) => r.direction === "out");
    const kinds = rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(["father", "husband"]);
    expect(rows.find((r) => r.kind === "father")?.kinshipTerm).toBe("爸爸");
    expect(rows.find((r) => r.kind === "husband")?.kinshipTerm).toBe("老公");
  });
});

describe("valmont · 派生行只是投影，不是事实边", () => {
  const rng = (): number => 0.5;

  /**
   * 这是**确认性**断言，不是给引擎加护栏：derived 行只由投影现造，从未写进
   * `state.relations`，所以按 kind 匹配的关系条件天然看不到它。
   * 若哪天有人把派生行写回权威状态，这条会红 —— 那时要修的是写入侧，不是条件侧。
   */
  it("派生的「亲戚」行不在 state.relations 里，关系条件看不到它", () => {
    const state = newWorld(12);
    const snap = snapshot(state);
    const aldric = snap.npcs.find((n) => n.id === "npc-aldric")!;
    const derived = aldric.relations.find((r) => r.derived === true && r.withId === "npc-irma");
    // 派生行确实存在（奥德里克 → 伊尔玛 是继母，没有直接事实边）。
    expect(derived?.kind).toBe("relative");
    expect(derived?.kinshipTerm).toBe("继母");
    // 但权威关系表里没有这一对端点：它只是显示层的解释。
    expect(
      state.relations.some(
        (e) =>
          (e.from === "npc-aldric" && e.to === "npc-irma") ||
          (e.from === "npc-irma" && e.to === "npc-aldric"),
      ),
    ).toBe(false);

    const ctx = { state, lookup, rng };
    // `gte: 1` = 「这条边存在且强度为正」。缺边时引擎读到 value = 0，自然不满足。
    for (const kind of ["father", "mother", "son", "daughter", "husband", "wife", "relative"] as const) {
      expect(checkCondition({ relation: "npc-aldric", to: "npc-irma", kind, gte: 1 }, ctx)).toBe(false);
    }
    // 对照：真实事实边能命中 —— 上面的 false 不是「条件恒假」。
    expect(checkCondition({ relation: "npc-aldric", to: "npc-bardo", kind: "father", gte: 1 }, ctx)).toBe(true);
  });
});

describe("valmont · 关系行显示标签", () => {
  it("派生行以推出来的称谓为主标签（外公），不是占位的「亲戚」", () => {
    const snap = snapshot(newWorld(12));
    const vm = toViewModel({ snapshot: snap, content: [], media: [] });
    const hugh = vm.npcs.find((n) => n.id === "npc-hugh")!;

    const maternal = hugh.relations.find((r) => r.withId === "npc-bardo");
    expect(maternal?.kind).toBe("relative");
    expect(maternal?.kindLabel).toBe("外公");

    // 一级事实行不替换：kind 本身就是准的（父亲），标签照 kind 翻。
    const father = hugh.relations.find((r) => r.kind === "father");
    expect(father?.kindLabel).toBe("父亲");
    expect(father?.kinshipTerm).toBe("爸爸");
  });
});

describe("valmont · 族谱边没有重影", () => {
  it("pedigree.edges 里不存在重复的 (from,to,kind) 三元组", () => {
    const snap = snapshot(newWorld(11));
    // 宿主只搬运 `unknown`：这里用扩展自己的契约类型收窄（与 UI 同一种读法）。
    const family = snap.extensions?.family as FamilyView | undefined;
    const edges = family?.pedigree?.edges ?? [];
    expect(edges.length).toBeGreaterThan(0);

    const triples = edges.map((e) => `${e.from}\u0000${e.to}\u0000${e.kind}`);
    expect(new Set(triples).size).toBe(triples.length);
  });

  it("模板同时写 son 与 father 的那一对（奥德里克→布兰奇）只出一条边，parentRole 是 father", () => {
    const snap = snapshot(newWorld(11));
    const edges = (snap.extensions?.family as FamilyView | undefined)?.pedigree?.edges ?? [];
    const pair = edges.filter(
      (e) => e.kind === "parent" && e.from === "npc-aldric" && e.to === "npc-blanche",
    );
    expect(pair).toHaveLength(1);
    expect(pair[0]!.parentRole).toBe("father");
  });
});

describe("valmont · 事件链能走到结局", () => {
  it("推到底会终止并给出结局，不是无限空转", () => {
    const state = drive(newWorld(7));
    expect(state.termination).not.toBeNull();
    const snap = snapshot(state);
    expect(snap.ending?.endingId ?? snap.ending).toBeTruthy();
  });
});

describe("valmont · 确定性", () => {
  it("同 seed 跑完整条链，投影逐字段相同", () => {
    const a = drive(newWorld(11));
    const b = drive(newWorld(11));
    expect(JSON.stringify(snapshot(a))).toBe(JSON.stringify(snapshot(b)));
  });
});
