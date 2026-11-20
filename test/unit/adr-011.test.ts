import { describe, expect, it } from "vitest";
import {
  applyStatusToPlayer,
  createBattle,
  createLookup,
  createWorldV2,
  effectiveAttributes,
  maxHp,
  maxMp,
  performBattleAction,
} from "@life-sim/game-core";
import { WorldTemplateV2Schema, type StatusInstance } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * ADR-011：状态层数收敛 + 资源上限只由属性决定 + 属性不许为负。
 *
 * 这三条是同一件事的三个面：状态的时长移到施加点之后，`refresh` 那一档就没有独立语义了；
 * 咒力上限去掉 base 之后，「没有咒力」终于是 0 而不是 40；而「-8 咒力」这种写法
 * 会真的算进命中骰，所以属性得在 0 停住。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };
const DAY = 1440;

function loadEntry() {
  const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

function newWorld(seed = 21) {
  const entry = loadEntry();
  const state = createWorldV2({ templateId: "jjk-2006", playerName: "测试", seed }, entry.template, `w-adr011-${seed}`);
  state.openingCompleted = true;
  return { state, entry };
}

const find = (state: ReturnType<typeof newWorld>["state"], id: string) =>
  state.player.statuses.find((s) => s.statusId === id);

describe("ADR-011 D1 · 再施加 = 层数按语义、时钟只往后推", () => {
  it("unique：层数不动，到期点延长", () => {
    const { state, entry } = newWorld();
    applyStatusToPlayer(state, "injured-sim", 2, entry.lookup, { value: 1, unit: "day" });
    expect(find(state, "injured-sim")?.expiresAt).toBe(state.worldTime + DAY);

    applyStatusToPlayer(state, "injured-sim", 1, entry.lookup, { value: 5, unit: "day" });
    const inst = find(state, "injured-sim");
    expect(inst?.stacks).toBe(2);
    expect(inst?.expiresAt).toBe(state.worldTime + 5 * DAY);
  });

  it("unique：短的一次不许把长的一次砍短（重算会，取 max 不会）", () => {
    const { state, entry } = newWorld();
    applyStatusToPlayer(state, "injured-sim", 1, entry.lookup, { value: 5, unit: "day" });
    applyStatusToPlayer(state, "injured-sim", 1, entry.lookup, { value: 1, unit: "day" });
    expect(find(state, "injured-sim")?.expiresAt).toBe(state.worldTime + 5 * DAY);
    expect(find(state, "injured-sim")?.stacks).toBe(1);
  });

  it("stack：层数相加，时钟同样只增不减", () => {
    const { state, entry } = newWorld();
    // 用 `grief`（丧失）：`absorbed-curses` 已随 ADR-012 的专属资源池删除。
    applyStatusToPlayer(state, "grief", 1, entry.lookup, { value: 5, unit: "day" });
    applyStatusToPlayer(state, "grief", 2, entry.lookup, { value: 1, unit: "day" });
    const inst = find(state, "grief");
    expect(inst?.stacks).toBe(3);
    expect(inst?.expiresAt).toBe(state.worldTime + 5 * DAY);
  });

  it("不给时长的再施加 ⇒ 变永久（挂载压过有期）", () => {
    const { state, entry } = newWorld();
    applyStatusToPlayer(state, "injured-sim", 1, entry.lookup, { value: 2, unit: "day" });
    applyStatusToPlayer(state, "injured-sim", 1, entry.lookup);
    expect(find(state, "injured-sim")?.expiresAt).toBeUndefined();
  });

  it("已经永久的（挂载）不会被一次有期施加降级", () => {
    const { state, entry } = newWorld();
    applyStatusToPlayer(state, "injured-sim", 1, entry.lookup);
    applyStatusToPlayer(state, "injured-sim", 1, entry.lookup, { value: 2, unit: "day" });
    expect(find(state, "injured-sim")?.expiresAt).toBeUndefined();
  });
});

/**
 * 战斗域的再施加：`roundsLeft` 是回合时钟，规则与模拟域同构（只增不减），
 * 而 `unique` 的层数口径必须与模拟域一致——同一个「重伤 ×2」不该在两个域里层数不同。
 */
describe("ADR-011 D1 · 战斗域再施加", () => {
  function patchedBattle(seed = 3) {
    const entry = loadEntry();
    const raw = JSON.parse(JSON.stringify(entry.template)) as { skills: Array<Record<string, unknown>> };
    const basic = raw.skills.find((s) => s.id === "sk-basic-strike")!;
    basic.applyStatus = [{ status: "battle-curse-poison", target: "all_enemies", duration: { rounds: 5 } }];
    const curtain = raw.skills.find((s) => s.id === "sk-curtain")!;
    (curtain.applyStatus as unknown[]).push({
      status: "battle-curse-poison",
      stacks: 2,
      target: "all_enemies",
      duration: { rounds: 1 },
    });

    const template = WorldTemplateV2Schema.parse(raw);
    const lookup = createLookup(template);
    const state = createWorldV2(
      { templateId: "jjk-2006", playerName: "测试", seed },
      template,
      `w-adr011-battle-${seed}`,
    );
    state.openingCompleted = true;
    if (!state.player.skills.includes("sk-curtain")) state.player.skills.push("sk-curtain");
    state.player.mp = 200;
    state.battle = createBattle("ev:test", { enemies: [{ ref: "enemy-grade2-curse" }] }, state, lookup);
    return { state, lookup };
  }

  it("unique 不叠层：先 ×1 再 ×2 仍是 1 层，且 5 回合的钟不被 1 回合砍短", () => {
    const { state, lookup } = patchedBattle();
    const enemy = () => state.battle!.enemies[0];
    const poison = () => enemy().statuses.find((s) => s.statusId === "battle-curse-poison");

    performBattleAction(state, { type: "skill", skillId: "sk-basic-strike" }, lookup, () => 0);
    expect(poison()?.stacks).toBe(1);

    performBattleAction(state, { type: "skill", skillId: "sk-curtain" }, lookup, () => 0);
    expect(poison()?.stacks).toBe(1);
    // 5 回合的钟已经走过两轮末结算；旧实现会被第二次的 1 回合直接覆盖成 1 然后归零。
    expect(poison()?.roundsLeft ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("ADR-011 D2 · 数值属性不为负", () => {
  it("天与咒缚的 -8 落到 0：基础 5 的人被拿走咒力后是「没有」，不是「欠 3 点」", () => {
    const { lookup } = loadEntry();
    const heavenly: StatusInstance = { statusId: "heavenly-restriction", stacks: 1, appliedTurn: 0, appliedAt: 0 };
    const eff = effectiveAttributes({ cursedEnergy: 5, physique: 16, agility: 15 }, [heavenly], 50, lookup);
    expect(eff.cursedEnergy).toBe(0);
    expect(eff.physique).toBe(36);
    expect(eff.agility).toBe(27);
  });
});

describe("ADR-011 D3 · 咒力上限只由咒力属性决定", () => {
  it("五条 240（六眼算进有效值前的基础 120），甚尔 0", () => {
    const entry = loadEntry();
    const gojo = createWorldV2(
      { templateId: "jjk-2006", seed: 1, self: { kind: "reuse", characterId: "npc-gojo" } },
      entry.template,
      "w-mp-gojo",
    );
    expect(maxMp(gojo.player, entry.template)).toBe(240);

    const toji = createWorldV2(
      { templateId: "jjk-2006", seed: 2, self: { kind: "reuse", characterId: "npc-toji" } },
      entry.template,
      "w-mp-toji",
    );
    // 没有咒力 ⇒ 没有咒力池；血量仍走 HP 公式（75 + 5×0）
    expect(maxMp(toji.player, entry.template)).toBe(0);
    expect(maxHp(toji.player, entry.template)).toBe(75);
  });
});
