import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createBattle, createLookup, createWorldV2, performBattleAction, projectSnapshotV2, resolveBattleFx } from "@life-sim/game-core";
import { UiConfigSchema, type FxPresentation, type WorldStateV2, type WorldTemplateV2 } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function loadEntry() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

function battleOf(opts: { talent?: boolean; enemy?: string } = {}): {
  state: WorldStateV2;
  template: WorldTemplateV2;
  lookup: ReturnType<typeof createLookup>;
} {
  const entry = loadEntry();
  const template = structuredClone(entry.template);
  template.combat = { ...(template.combat ?? {}), crit: { chance: 1, multiplier: 1.5 } };
  // 黑闪是**世界规则**（world.combat.hooks），不再是天赋上的钩子
  const bfHook = template.combat?.hooks?.find((h) => h.id === "black-flash");
  if (bfHook === undefined) throw new Error("world.combat.hooks 缺 black-flash");
  if (opts.talent === true) {
    // 要验黑闪：把资质骰固定掉
    bfHook.when = [{ crit: true }];
  } else {
    // 不要黑闪：摘掉这条**世界**钩子，否则任何暴击都会被放大成 critTier 2
    template.combat!.hooks = (template.combat?.hooks ?? []).filter((h) => h.id !== "black-flash");
  }

  const lookup = createLookup(template);
  const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed: 21 }, template, "w-fx-resolve");
  if (!state.player.skills.includes("sk-basic-strike")) state.player.skills.push("sk-basic-strike");
  if (opts.talent === true) {
    state.player.statuses.push({ statusId: "t-black-flash", stacks: 1, appliedTurn: 0, appliedAt: 0 });
  }
  state.battle = createBattle("ev:fx", { enemies: [{ ref: opts.enemy ?? "enemy-grade2-curse" }] }, state, lookup);
  return { state, template, lookup };
}

/** 只取玩家这一招的段：敌方在回合末尾也会还手，`casts.at(-1)` 往往是敌人的。 */
const hitOf = (state: WorldStateV2, skillId = "sk-basic-strike") => {
  const fx = resolveBattleFx(state.battle!, undefined);
  const cast = fx.casts.findLast((c) => c.skillId === skillId)!;
  return { fx, cast, hit: cast.hits.at(-1)! };
};

describe("ADR-076 §1/§4/§5/§6 resolveBattleFx", () => {
  it("级联：技能定宽度、钩子只改颜色，写了的字段才覆盖", () => {
    const { state, lookup } = battleOf({ talent: true });
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);

    const ui: FxPresentation = {
      skills: { "sk-basic-strike": { trace: { preset: "arrow", color: "#123456", width: 5 }, impact: { preset: "burst" } } },
      hooks: { "black-flash": { trace: { color: "#FF0000" }, result: { label: { text: "BF", latin: "BLACK FLASH" } } } },
    };
    const { fx, cast, hit } = (() => {
      const view = resolveBattleFx(state.battle!, ui);
      const c = view.casts.findLast((x) => x.skillId === "sk-basic-strike")!;
      return { fx: view, cast: c, hit: c.hits.at(-1)! };
    })();

    expect(cast.trace.preset).toBe("arrow"); // 技能层
    expect(cast.trace.color).toBe("#FF0000"); // 钩子层覆盖
    expect(cast.trace.width).toBe(5); // 钩子没写，继承技能层
    expect(hit.impact).toBe("burst"); // 技能层（受击是逐目标的）
    expect(hit.text).toBe(`-${hit.amount}!!`); // 数值来自结算，后缀来自阶梯
    expect(hit.labels.map((l) => l.text)).toContain("BF");
    expect(hit.labels.find((l) => l.text === "BF")?.latin).toBe("BLACK FLASH");
    expect(fx.seq).toBeGreaterThan(0);
  });

  it("后缀阶梯：普通暴击一个叹号，被钩子放大两个；未暴击没有", () => {
    const { state, lookup } = battleOf({});
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);
    const crit = hitOf(state).hit;
    expect(crit.critTier).toBe(1);
    expect(crit.text).toMatch(/^-\d+!$/);

    const plain = battleOf({});
    // 暴击率拉回 0：这一条只验「没有暴击就没有后缀」
    plain.template.combat = { ...(plain.template.combat ?? {}), crit: { chance: 0, multiplier: 1.5 } };
    plain.lookup = createLookup(plain.template);
    plain.state.battle = createBattle("ev:fx", { enemies: [{ ref: "enemy-grade2-curse" }] }, plain.state, plain.lookup);
    performBattleAction(plain.state, { type: "skill", skillId: "sk-basic-strike" }, plain.lookup, () => 0.5);
    const noCrit = hitOf(plain.state).hit;
    expect(noCrit.critTier).toBeUndefined();
    expect(noCrit.text).toMatch(/^-\d+$/);
  });

  it("未命中：不产生数字，也没有受击段", () => {
    const entry = loadEntry();
    const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed: 5 }, entry.template, "w-fx-miss");
    if (!state.player.skills.includes("sk-basic-strike")) state.player.skills.push("sk-basic-strike");
    state.battle = createBattle("ev:fx", { enemies: [{ ref: "npc-gojo" }] }, state, entry.lookup);
    state.battle.enemies[0]?.statuses.push({ statusId: "infinity", stacks: 1, appliedTurn: state.turnIndex, appliedAt: state.worldTime });

    let call = 0;
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, entry.lookup, () => {
      call += 1;
      return call === 1 ? 0.01 : 0.5;
    });

    const { hit } = hitOf(state);
    expect(hit.kind).toBe("miss");
    expect(hit.outcome).toBe("miss");
    expect(hit.text).toBeUndefined();
    expect(hit.impact).toBeNull();
  });

  it("快照里带得出来（漏映射就会整段消失）", () => {
    const { state, template, lookup } = battleOf({});
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);
    const fx = projectSnapshotV2(state, template, lookup).battle?.fx;
    expect(fx).toBeDefined();
    expect(fx?.casts.some((c) => c.skillId === "sk-basic-strike")).toBe(true);
    expect(fx?.seq).toBeGreaterThan(0);
  });

  it("自身治疗：轨迹是 updraft（上升），颜色是治疗绿", () => {
    const { state, lookup } = battleOf({});
    state.player.skills.push("sk-reverse-heal");
    // 战斗里花的是 `battle.player` 这份镜像，主状态上的 mp 不影响扣费
    state.player.mp = 200;
    state.battle!.player.mp = 200;
    state.battle!.player.hp = Math.max(1, (state.battle!.player.maxHp ?? 200) - 60);

    performBattleAction(state, { type: "skill", skillId: "sk-reverse-heal" }, lookup, () => 0.1);

    const cast = resolveBattleFx(state.battle!, undefined).casts.findLast((c) => c.skillId === "sk-reverse-heal")!;
    const hit = cast.hits.at(-1)!;
    expect(hit.kind).toBe("heal");
    expect(hit.targetId).toBe(state.player.id);
    expect(hit.trace?.preset).toBe("updraft");
    expect(hit.trace?.color).toBe("#58E3A7");
  });

  it("自身增益：纯状态技能也发事件，走 updraft + 红", () => {
    const { state, lookup } = battleOf({});
    state.player.skills.push("sk-limitless");
    state.player.mp = 200;
    state.battle!.player.mp = 200;

    performBattleAction(state, { type: "skill", skillId: "sk-limitless" }, lookup, () => 0.1);

    const buffs = (state.battle!.events ?? []).filter((e) => e.kind === "buff");
    expect(buffs.length).toBeGreaterThan(0);

    const cast = resolveBattleFx(state.battle!, undefined).casts.findLast((c) => c.skillId === "sk-limitless")!;
    const hit = cast.hits.at(-1)!;
    expect(hit.kind).toBe("buff");
    expect(hit.text).toBeUndefined(); // 增益没有数字
    expect(hit.impact).toBeNull(); // 也没有受击段
    expect(hit.trace?.preset).toBe("updraft");
    expect(hit.color).toBe("#FF6B7F"); // 增益红
  });

  it("敌方减益：目标是别人 ⇒ arrow + 紫", () => {
    const { state, lookup } = battleOf({});
    state.player.skills.push("sk-speech-command");
    state.player.mp = 200;
    state.battle!.player.mp = 200;

    performBattleAction(state, { type: "skill", skillId: "sk-speech-command" }, lookup, () => 0.1);

    const cast = resolveBattleFx(state.battle!, undefined).casts.findLast((c) => c.skillId === "sk-speech-command")!;
    const hit = cast.hits.at(-1)!;
    expect(hit.kind).toBe("buff");
    expect(hit.targetId).not.toBe(state.player.id);
    expect(hit.trace?.preset).toBe("arrow");
    expect(hit.color).toBe("#B387FF"); // 减益紫
  });

  it("连续两轮用同一招：两段，不是一段（木桩不回击时 seq 也是连的）", () => {
    const { state, lookup } = battleOf({});
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);

    const casts = resolveBattleFx(state.battle!, undefined).casts.filter((c) => c.skillId === "sk-basic-strike");
    expect(casts).toHaveLength(2);
    expect(casts.every((c) => c.hits.length === 1)).toBe(true);
  });

  it("确定性：同一状态解析两次结果完全一致（不消耗 rng）", () => {
    const { state, lookup } = battleOf({});
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);
    const a = resolveBattleFx(state.battle!, undefined);
    const b = resolveBattleFx(state.battle!, undefined);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("ADR-076 §12 T5：jjk-2006 的表现层数据", () => {
  const jjkUi = () => {
    const raw = readFileSync("specs/data/templates/jjk-2006/3.0.0/ui.yaml", "utf8");
    return UiConfigSchema.parse(parse(raw)).presentation;
  };

  it("苍：converge 起手 + 蓝色 beam 轨迹", () => {
    const entry = loadEntry();
    const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed: 31 }, entry.template, "w-fx-jjk");
    for (const id of ["sk-gojo-blue"]) if (!state.player.skills.includes(id)) state.player.skills.push(id);
    state.player.mp = 300;
    state.battle = createBattle("ev:fx", { enemies: [{ ref: "enemy-grade2-curse" }] }, state, entry.lookup);

    performBattleAction(state, { type: "skill", skillId: "sk-gojo-blue" }, entry.lookup, () => 0.5);

    const cast = resolveBattleFx(state.battle!, jjkUi()).casts.findLast((c) => c.skillId === "sk-gojo-blue")!;
    expect(cast.cast.preset).toBe("converge");
    expect(cast.trace.preset).toBe("beam");
    expect(cast.trace.color).toBe("#7C8CFF");
  });

  it("收灵：蓝色反向箭头 + 铁栅栏（不是伤害红，也不是“没有轨迹”）", () => {
    const entry = loadEntry();
    const state = createWorldV2(
      { templateId: "jjk-2006", seed: 11, self: { kind: "reuse", characterId: "npc-geto" } },
      entry.template,
      "w-fx-recall",
    );
    state.openingCompleted = true;
    state.battle = createBattle("ev:recall", { enemies: [{ ref: "enemy-grade2-curse" }] }, state, entry.lookup);
    performBattleAction(state, { type: "skill", skillId: "sk-summon-curse" }, entry.lookup, () => 0.5);
    performBattleAction(state, { type: "skill", skillId: "sk-recall" }, entry.lookup, () => 0.5);

    const cast = resolveBattleFx(state.battle!, jjkUi()).casts.findLast((c) => c.skillId === "sk-recall")!;
    const hit = cast.hits.at(-1)!;
    // 收灵既不是治疗也不是增益：走**兜底蓝**
    expect(cast.trace.color).toBe("#6FA8FF");
    expect(hit.color).toBe("#6FA8FF");
    // 有箭头（以前 depart 被归到 none，收灵看起来是「凭空消失」）
    expect(cast.trace.preset).toBe("arrow");
    // 方向反过来：目标 → 自己
    expect(hit.reverse).toBe(true);
    expect(hit.impact).toBe("cage");
  });

  it("黑闪：aim 起手 + slash 轨迹 + lightning 受击 + 双语标签", () => {
    const { state, lookup } = battleOf({ talent: true });
    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0.5);

    const cast = resolveBattleFx(state.battle!, jjkUi()).casts.findLast((c) => c.skillId === "sk-basic-strike")!;
    const hit = cast.hits.at(-1)!;
    // 起手（手上蓄星芒）→ 刃 → 命中点炸开，三段各占一处
    expect(cast.cast.preset).toBe("aim");
    expect(cast.trace.preset).toBe("slash");
    expect(cast.trace.color).toBe("#FF2F45");
    expect(hit.impact).toBe("lightning");
    const label = hit.labels.find((l) => l.id === "black-flash");
    expect(label?.text).toBe("黒閃");
    expect(label?.latin).toBe("BLACK FLASH");
    expect(hit.text.endsWith("!!")).toBe(true);
    // 黑闪的标签**取代** CRITICAL，不是叠在它上面（两个标签会压在一起）
    expect(hit.labels.some((l) => l.id === "crit")).toBe(false);
  });
});
