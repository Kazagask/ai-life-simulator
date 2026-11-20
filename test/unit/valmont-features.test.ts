import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyEffectsV2,
  createBattle,
  createWorldV2,
  finishBattle,
  performBattleAction,
  projectSnapshotV2,
  registerExtensionRuntime,
  resetExtensionRuntimes,
  type WorldStateV2,
} from "@life-sim/game-core";
import { familyExtension } from "@life-sim/ext-family";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * 瓦勒蒙测试链（2026-11-20）：这个剧本是**专门用来踩没被引用过的能力**的。
 *
 * 这里钉四条，每条都对应一个「设计过、但此前全模板零引用」的机制：
 * 1. 战斗内加点（道具的 `adjustAttribute` 以前在战斗分支里静默消失）；
 * 2. 敌方战斗态 → 修正（`toModifier`）+ NPC 战后回写；
 * 3. `inheritActor`（`transplantActor` 第一次有模板入口）；
 * 4. 显式胜负条件（`survive_rounds` / `unit_down` / `player_down`）。
 */

// valmont 声明了 `requires.extensions.family`：不注册就被加载期拒载（不是测试环境问题）。
beforeAll(() => registerExtensionRuntime(familyExtension));
afterAll(() => resetExtensionRuntimes());

const silent = { warn: () => {}, error: () => {}, info: () => {} };
const DAY = 24 * 60;

function loadEntry() {
  const entry = loadTemplates(silent).resolve({ id: "valmont", version: "1.0.0" });
  if (entry?.status !== "ready") throw new Error("valmont/1.0.0 未就绪");
  return entry;
}

function newWorld(seed: number): { state: WorldStateV2; entry: ReturnType<typeof loadEntry> } {
  const entry = loadEntry();
  const state = createWorldV2({ templateId: "valmont", playerName: "罗兰", seed }, entry.template, `w-valmont-${seed}`);
  return { state, entry };
}

describe("valmont · 战斗内不改属性", () => {
  /**
   * 2026-11-20 用户裁决：**战斗内调属性会牵动伤害 / 命中 / 血量上限一大串结算**，
   * 不是一个「+1 就完事」的写入。战斗道具白名单里因此没有 `adjustAttribute`，
   * 淬体药在战斗里必须被可诊断地拒绝，而不是静默喝掉。
   */
  it("战斗里喝淬体药：诊断拒绝，属性与背包都不变", () => {
    const { state, entry } = newWorld(1);
    state.player.inventory["item-tonic"] = 1;
    state.battle = createBattle("ev:tonic", { enemies: [{ ref: "npc-godfrey" }] }, state, entry.lookup);
    const before = state.player.attributes.body;

    expect(() =>
      performBattleAction(state, { type: "item", itemId: "item-tonic" }, entry.lookup, () => 0.5),
    ).toThrow(/item_effect_unsupported_in_battle|item_not_usable_in_battle/);
    expect(state.player.attributes.body).toBe(before);
    expect(state.player.inventory["item-tonic"]).toBe(1);
  });
});

describe("valmont · 敌方战斗态转修正 + NPC 回写", () => {
  it("对手活着离场：见红按回合折算成旧伤，留在他的 NPC 实例上", () => {
    const { state, entry } = newWorld(2);
    state.player.mp = 50;
    state.battle = createBattle("ev:spar", { enemies: [{ ref: "npc-godfrey" }] }, state, entry.lookup);

    performBattleAction(state, { type: "skill", skillId: "sk-duel-cut-deep" }, entry.lookup, () => 0.5);
    const unit = state.battle!.enemies[0]!;
    expect(unit.statuses.some((s) => s.statusId === "st-bloodied")).toBe(true);

    // 技能动作本身就结束了这一回合：回合末已经跑过一次，roundsHeld 应为 1。
    const held = state.battle!.enemies[0]!.statuses.find((s) => s.statusId === "st-bloodied")?.roundsHeld ?? 0;
    expect(held).toBe(1);

    state.battle!.over = "victory";
    finishBattle(state, entry.lookup);

    const npc = state.npcs.find((n) => n.id === "npc-godfrey")!;
    const wound = npc.statuses.find((s) => s.statusId === "st-wound");
    expect(wound).toBeDefined();
    // 每回合 1 天 × roundsHeld —— 不是固定值、不是永久
    expect(wound?.expiresAt).toBe(state.worldTime + held * DAY);
  });

  it("对手被打死：不折算（死人不再带着旧伤离开）", () => {
    const { state, entry } = newWorld(3);
    state.player.mp = 50;
    state.battle = createBattle("ev:kill", { enemies: [{ ref: "npc-godfrey" }] }, state, entry.lookup);
    const unit = state.battle!.enemies[0]!;
    unit.statuses.push({ statusId: "st-bloodied", stacks: 1, appliedTurn: 0, appliedAt: state.worldTime, roundsHeld: 2 });
    unit.hp = 0;
    unit.alive = false;
    state.battle!.over = "victory";
    finishBattle(state, entry.lookup);

    const npc = state.npcs.find((n) => n.id === "npc-godfrey")!;
    expect(npc.statuses.some((s) => s.statusId === "st-wound")).toBe(false);
  });
});

describe("valmont · 继承（inheritActor）", () => {
  it("只搬 mind：本事过到侧院孩子身上，名字与血缘不动", () => {
    const { state, entry } = newWorld(4);
    const reynard = state.npcs.find((n) => n.id === "npc-reynard")!;
    expect(reynard.skills).toContain("sk-duel-strike");

    // 侧院的孩子由刷新规则管辖 ⇒ 建局时是 unspawned（不能往一个"还没出生"的人身上搬东西）。
    applyEffectsV2({ state, lookup: entry.lookup, rng: () => 0.5 }, [{ type: "spawnNpc", ruleId: "sp-bastard" }]);
    const bastard = state.npcs.find((n) => n.id === "npc-bastard")!;
    expect(bastard.lifecycle.state).toBe("alive");
    const beforeName = bastard.name;

    applyEffectsV2({ state, lookup: entry.lookup, rng: () => 0.5 }, [
      { type: "inheritActor", from: "npc-reynard", to: "npc-bastard", groups: ["mind"] },
    ]);

    expect(bastard.skills).toContain("sk-duel-strike");
    // identity 没搬：名字还是他自己的
    expect(bastard.name).toBe(beforeName);
  });
});

describe("valmont · 零消耗文案", () => {
  it("没有咒力的世界不印「消耗 0 咒力」，写「无消耗」", () => {
    const { state, entry } = newWorld(8);
    const skill = state.player.skills.includes("sk-duel-strike")
      ? projectSnapshotV2(state, entry.template, entry.lookup, null, undefined, entry.ui).player.skills.find(
          (s) => s.id === "sk-duel-strike",
        )
      : undefined;
    const costLine = skill?.effects?.find((e) => e.kind === "cost" && /消耗/.test(e.text));
    expect(costLine?.text).toBe("无消耗");
  });
});

describe("valmont · 生育的关系边方向", () => {
  /**
   * 边语义：**`to` 是 `from` 的 kind**（与 characters.yaml 同一口径）。
   * 写成 `player → heir father` 读出来是「小罗兰是罗兰的父亲」——2026-11-20 的实测事故。
   */
  const edgesOf = (eventId: string) => {
    const entry = loadEntry();
    const event = entry.template.events.find((e) => e.id === eventId);
    if (event === undefined) throw new Error(`事件不存在：${eventId}`);
    const options = (event.settle as { normal?: { options?: Array<{ effects?: unknown[] }> } }).normal?.options ?? [];
    const effects = options.flatMap((opt) => opt.effects ?? []);
    return effects.filter(
      (eff): eff is { type: "addRelationEdge"; fromId: string; toId: string; kind: string } =>
        typeof eff === "object" && eff !== null && (eff as { type?: string }).type === "addRelationEdge",
    );
  };

  it("出生：孩子那一侧写 father/mother，父母这一侧写 son", () => {
    const edges = edgesOf("evt:birth");
    expect(edges).toContainEqual(expect.objectContaining({ fromId: "npc-heir", toId: "player", kind: "father" }));
    expect(edges).toContainEqual(expect.objectContaining({ fromId: "player", toId: "npc-heir", kind: "son" }));
    expect(edges).toContainEqual(expect.objectContaining({ fromId: "npc-heir", toId: "npc-wife", kind: "mother" }));
    expect(edges).toContainEqual(expect.objectContaining({ fromId: "npc-wife", toId: "npc-heir", kind: "son" }));
    // 反写：玩家这侧写成 father/mother 就是「孩子是爹」
    expect(
      edges.some((e) => e.fromId === "player" && e.toId === "npc-heir" && (e.kind === "father" || e.kind === "mother")),
    ).toBe(false);
  });

  it("认领：私生子两个方向都是 private（这层关系不外传）", () => {
    const entry = loadEntry();
    const event = entry.template.events.find((e) => e.id === "evt:bastard");
    const options = (event?.settle as { normal?: { options?: Array<{ effects?: Array<Record<string, unknown>> }> } })
      .normal?.options ?? [];
    const ack = options.find((opt) => (opt.effects ?? []).some((e) => e.type === "spawnNpc"));
    const edges = (ack?.effects ?? []).filter((e) => e.type === "addRelationEdge");
    expect(edges).toContainEqual(expect.objectContaining({ fromId: "npc-bastard", toId: "player", kind: "father", scope: "private" }));
    expect(edges).toContainEqual(expect.objectContaining({ fromId: "player", toId: "npc-bastard", kind: "son", scope: "private" }));
  });

  it("投影：出生后玩家这一侧看到「小罗兰 · 儿子」（出边），不是「父亲」", () => {
    const { state, entry } = newWorld(11);
    applyEffectsV2({ state, lookup: entry.lookup, rng: () => 0.5 }, [
      { type: "spawnNpc", ruleId: "sp-heir" },
      { type: "addRelationEdge", fromId: "npc-heir", toId: "player", kind: "father", scope: "public" },
      { type: "addRelationEdge", fromId: "player", toId: "npc-heir", kind: "son", scope: "public", value: 40 },
    ]);
    const snapshot = projectSnapshotV2(state, entry.template, entry.lookup, null, undefined, entry.ui);
    const toHeir = snapshot.player.relations.filter((r) => r.withId === "npc-heir");
    expect(toHeir).toContainEqual(expect.objectContaining({ kind: "son", direction: "out" }));
    expect(toHeir.some((r) => r.kind === "father" && r.direction === "out")).toBe(false);
  });
});

describe("valmont · 婚姻不吞掉血缘", () => {
  /**
   * 2026-11-20 现场事故：娶了塞西莉之后「外婆」那条边消失。
   *
   * 根因不是少写反向边（那只是她卡上看不到「她视你为丈夫」），而是判重按
   * 「这个人有没有事实边」一刀切 —— 事实行只说「妻子」，多跳推出来的「外婆」
   * 被当成重复整条丢掉。现在按读法判重：**婚姻事实不吞血缘读法**。
   */
  it("妻子一行 + 外婆一行；已是具体血亲的人不再推变体", () => {
    const { state, entry } = newWorld(12);
    applyEffectsV2({ state, lookup: entry.lookup, rng: () => 0.5 }, [
      { type: "addRelationEdge", fromId: "player", toId: "npc-cecily", kind: "wife", scope: "public", value: 30 },
      { type: "addRelationEdge", fromId: "npc-cecily", toId: "player", kind: "husband", scope: "public", value: 30 },
      { type: "addSpouse", a: "player", b: "npc-cecily" },
    ]);
    const snapshot = projectSnapshotV2(state, entry.template, entry.lookup, null, undefined, entry.ui);
    const out = (id: string) => snapshot.player.relations.filter((r) => r.withId === id && r.direction === "out");

    const cecily = out("npc-cecily");
    expect(cecily.map((r) => r.kind).sort()).toEqual(["relative", "wife"]);
    expect(cecily.find((r) => r.kind === "relative")?.kinshipTerm).toBe("外婆");
    expect(cecily.find((r) => r.kind === "relative")?.derived).toBe(true);

    // 婚姻是双向的：她那边也有一条「视你为丈夫」
    const hers = snapshot.npcs.find((n) => n.id === "npc-cecily")?.relations ?? [];
    expect(hers).toContainEqual(expect.objectContaining({ withId: "player", kind: "husband", direction: "out" }));

    // 已经是父亲的人不该再长出一条「表兄弟」（绕路读法是变体，不是新信息）
    expect(out("npc-reynard").map((r) => r.kind)).toEqual(["father"]);
  });
});

describe("valmont · 观察者切换（observeActor）", () => {
  it("只换眼睛不换人：viewerId 跟着变，self 段不动，收回后回到自己", () => {
    const { state, entry } = newWorld(6);
    const project = () => projectSnapshotV2(state, entry.template, entry.lookup, null, undefined, entry.ui);
    // 快照只在观察者 ≠ self 时下发该字段（缺省即「你自己」）
    expect(project().viewerId ?? "player").toBe("player");
    const selfName = project().player.name;

    applyEffectsV2({ state, lookup: entry.lookup, rng: () => 0.5 }, [
      { type: "observeActor", actorId: "npc-godfrey" },
    ]);
    const observed = project();
    expect(observed.viewerId).toBe("npc-godfrey");
    // 换的是视角，不是人：主角还是主角
    expect(observed.player.name).toBe(selfName);
    expect(state.player.id).toBe("player");

    applyEffectsV2({ state, lookup: entry.lookup, rng: () => 0.5 }, [{ type: "observeActor", actorId: null }]);
    expect(project().viewerId ?? "player").toBe("player");
  });
});

describe("valmont · 运行时成婚（addSpouse）", () => {
  it("写进权威配偶表，下一帧投影就能看到（不是只认建局快照）", () => {
    const { state, entry } = newWorld(7);
    const spousesOf = (): Array<{ a: string; b: string }> =>
      ((state.extensions?.family as { spouses?: Array<{ a: string; b: string }> } | undefined)?.spouses ?? []);

    const before = spousesOf().length;
    expect(spousesOf().some((s) => s.a === "npc-wife" || s.b === "npc-wife")).toBe(false);
    applyEffectsV2({ state, lookup: entry.lookup, rng: () => 0.5 }, [
      { type: "addSpouse", a: "player", b: "npc-wife" },
    ]);
    expect(spousesOf().some((s) => s.a === "player" && s.b === "npc-wife")).toBe(true);

    // 幂等：同一对写两次不重复（无向）
    applyEffectsV2({ state, lookup: entry.lookup, rng: () => 0.5 }, [
      { type: "addSpouse", a: "npc-wife", b: "player" },
    ]);
    expect(spousesOf()).toHaveLength(before + 1);
  });
});

describe("valmont · 显式胜负条件", () => {
  it("撑过两回合即胜（survive_rounds），不是把对手打空才算赢", () => {
    const { state, entry } = newWorld(5);
    state.battle = createBattle(
      "ev:spar",
      {
        enemies: [{ ref: "npc-godfrey" }],
        victory: [{ kind: "survive_rounds", rounds: 2 }],
        defeat: [{ kind: "player_down" }],
      },
      state,
      entry.lookup,
    );

    performBattleAction(state, { type: "pass" }, entry.lookup, () => 0.5);
    expect(state.battle!.over).toBeNull();
    performBattleAction(state, { type: "pass" }, entry.lookup, () => 0.5);
    expect(state.battle!.over).toBe("victory");
    // 对手还活着 —— 这一场本来就不该死人
    expect(state.battle!.enemies[0]!.alive).toBe(true);
  });
});
