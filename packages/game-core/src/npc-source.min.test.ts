import { describe, expect, it } from "vitest";
import type { Condition, WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";

import { createActiveWorldV2, makeTestTemplate } from "./v2/test-utils.js";
import { collectRefs, createLookup } from "./v2/lookup.js";
import { RpgEngineAPI, assignSlot } from "./api/engine-api.js";
import { createConditionRegistry } from "./v2/condition-evaluator.js";
import { projectVisibleRelations } from "./v2/relations.js";
import { advanceTurnV2, chooseOptionV2 } from "./v2/turn.js";

/**
 * NPC「来源」与「状态变更」四条链路（S1–S4）的验收。
 *
 * 口径：
 * - S1 事件级 `npcs`：模板 / 生成两源同形，**占槽呈现时**拉上场（alive 幂等）。
 * - S2 branch DSL：`relationEdge`（带 kind + visibility）/ `secret`（按文本去重）。
 * - S3 引擎 `addSecret` 效果落 `npc.secrets`。
 * - S4 刷新规则 `when`：每轮 tail 求值；**无 when ⇒ 永不自动**（零回归）。
 *
 * 用内联 fixture，不依赖 specs/data 的具体模板。
 */

function npc(id: string, name: string) {
  return {
    id,
    isEnemy: false,
    visibility: "public" as const,
    identity: { name, age: 30, gender: "f" },
    mood: { value: 50 },
    attributes: { cursedEnergy: 5, agility: 5 },
    public: { personality: "普通人" },
    private: {},
    relationship: 0,
  };
}

/** 基础模板：在 makeTestTemplate 上追加三个非敌人角色（friend/buddy 初始在世，late 受规则管辖）。 */
function baseTemplate(): Record<string, unknown> {
  const base = makeTestTemplate() as unknown as Record<string, unknown>;
  return {
    ...base,
    characters: [
      ...(base.characters as unknown[]),
      npc("npc-friend", "老友"),
      npc("npc-buddy", "同伴"),
      npc("npc-late", "迟到者"),
    ],
  };
}

/** S1 模板源：一条由 rest 行动钩子触发的事件，声明 `npcs: ["rule-late"]`。 */
function summonTemplate(): WorldTemplateV2 {
  const t = baseTemplate();
  t.npcSpawnRules = [{ id: "rule-late", characterRef: "npc-late" }];
  t.events = [
    {
      id: "evt-summon",
      title: "推门",
      narrative: "有人推门进来。",
      trigger: { source: "action-hook", onActionId: "rest", probability: 1 },
      kind: "normal",
      npcs: ["rule-late"],
      settle: { normal: { options: [{ id: "opt-summon", text: "应声" }] } },
    },
  ];
  return t as unknown as WorldTemplateV2;
}

/** S4 模板：无事件，仅一条可声明 `when` 的刷新规则。 */
function spawnRuleTemplate(when: Condition[] | undefined): WorldTemplateV2 {
  const t = baseTemplate();
  t.npcSpawnRules = [
    { id: "rule-late", characterRef: "npc-late", ...(when !== undefined ? { when } : {}) },
  ];
  t.events = [];
  return t as unknown as WorldTemplateV2;
}

function makeWorld(template: WorldTemplateV2, seed = 7) {
  const lookup = createLookup(template);
  const state = createActiveWorldV2(
    { templateId: "npc-source", playerName: "测试", seed },
    template,
    `al-${seed}`,
  );
  assignSlot(state, null); // 从空槽开始（opening/handoff 可能残留）
  return { template, lookup, state };
}

function restTurn(state: WorldStateV2, template: WorldTemplateV2, lookup: ReturnType<typeof createLookup>) {
  return advanceTurnV2(state, { action: { type: "rest" } }, template, lookup);
}

function lateNpc(state: WorldStateV2) {
  return state.npcs.find((n) => n.id === "npc-late")!;
}

function lateRule(state: WorldStateV2) {
  return state.spawnRules.find((r) => r.ruleId === "rule-late")!;
}

describe("S1 事件级 npcs（模板源 / 生成源同形）", () => {
  it("模板事件 npcs：占槽呈现即 alive、规则转 spawned；再次呈现不重复（幂等）", () => {
    const { template, lookup, state } = makeWorld(summonTemplate());
    expect(lateNpc(state).lifecycle.state).toBe("unspawned");
    expect(lateRule(state).status).toBe("pending");

    restTurn(state, template, lookup);
    expect(state.slot?.eventId).toBe("evt-summon");
    expect(lateNpc(state).lifecycle.state).toBe("alive");
    expect(lateRule(state).status).toBe("spawned");
    expect(state.spawnLog.length).toBe(1);
    const sinceTurn = lateNpc(state).lifecycle.sinceTurn;

    // 结算掉回到空槽，再触发同一事件：规则已 spawned ⇒ 不重复建实例 / 不刷新 sinceTurn
    chooseOptionV2(state, { optionId: "opt-summon" }, template, lookup);
    expect(state.slot).toBeNull();
    restTurn(state, template, lookup);
    expect(state.slot?.eventId).toBe("evt-summon");
    expect(lateNpc(state).lifecycle.state).toBe("alive");
    expect(state.spawnLog.length).toBe(1);
    expect(lateNpc(state).lifecycle.sinceTurn).toBe(sinceTurn);
  });

  it("生成节点 npcs：本次提交 alias ⇒ 引擎分配全局 id，占槽呈现即 alive", () => {
    const { template, lookup, state } = makeWorld(spawnRuleTemplate(undefined));
    const api = new RpgEngineAPI({
      state,
      lookup,
      perspective: "world",
      targetPerspective: "player",
      lookupRefs: collectRefs(template),
      conditionRegistry: createConditionRegistry(),
    });
    const res = api.dispatch(
      [
        {
          callId: "c-hero",
          tool: "story.submitBranch",
          args: {
            trigger: { mode: "certain" },
            npcs: [{ alias: "hero", name: "新来的" }],
            branch: [
              {
                node: "s1",
                title: "陌生人",
                text: "门口站着一个人。",
                npcs: ["hero"],
                options: [{ text: "打量" }],
              },
            ],
          },
        },
      ],
      {
        turnIndex: state.turnIndex,
        worldTime: state.worldTime,
        invocationId: "inv-hero",
        perspective: "world",
        targetPerspective: "player",
      },
    );
    expect(res.receipts[0]!.outcome).toBe("accepted");

    const genId = "gennpc:inv-hero:hero";
    expect(state.npcs.some((n) => n.id === genId)).toBe(true);
    expect(state.npcs.find((n) => n.id === genId)!.lifecycle.state).toBe("unspawned");
    // 编译期把 alias 解析成引擎分配的全局 id
    expect(state.generatedEvents?.[0]?.npcs).toEqual([genId]);

    // 推进：生成事件入队 → 占槽呈现 → 拉上场
    const lookup2 = lookup.withGenerated(state.generatedEvents);
    restTurn(state, template, lookup2);
    expect(state.npcs.find((n) => n.id === genId)!.lifecycle.state).toBe("alive");
  });

  it("生成节点 npcs：未知引用在注入 lookup 时整条拒绝（unknown_reference）", () => {
    const { template, lookup, state } = makeWorld(spawnRuleTemplate(undefined));
    const api = new RpgEngineAPI({
      state,
      lookup,
      perspective: "world",
      targetPerspective: "player",
      lookupRefs: collectRefs(template),
      conditionRegistry: createConditionRegistry(),
    });
    const res = api.dispatch(
      [
        {
          callId: "c-ghost",
          tool: "story.submitBranch",
          args: {
            trigger: { mode: "certain" },
            branch: [
              {
                node: "s1",
                title: "空位",
                text: "那里并没有人。",
                npcs: ["npc-does-not-exist"],
                options: [{ text: "看" }],
              },
            ],
          },
        },
      ],
      {
        turnIndex: state.turnIndex,
        worldTime: state.worldTime,
        invocationId: "inv-ghost",
        perspective: "world",
        targetPerspective: "player",
      },
    );
    expect(res.receipts[0]!.outcome).toBe("rejected");
    expect(res.receipts[0]!.code).toBe("unknown_reference");
  });
});

describe("S2 branch DSL：relationEdge + secret", () => {
  it("关系边进 state.relations（visibility 与提交一致），secret 按文本去重；投影只放 known/inferred", () => {
    const { template, lookup, state } = makeWorld(spawnRuleTemplate(undefined));
    const api = new RpgEngineAPI({
      state,
      lookup,
      perspective: "world",
      targetPerspective: "player",
      lookupRefs: collectRefs(template),
      conditionRegistry: createConditionRegistry(),
    });
    const res = api.dispatch(
      [
        {
          callId: "c-rel",
          tool: "story.submitBranch",
          args: {
            trigger: { mode: "certain" },
            branch: [
              {
                node: "s1",
                title: "牵线",
                text: "他把两人拉到一起。",
                options: [
                  {
                    text: "看着",
                    effects: [
                      { relationEdge: { from: "npc-friend", to: "npc-buddy", kind: "friend", visibility: "known" } },
                      { relationEdge: { from: "npc-buddy", to: "player", kind: "rival", visibility: "hidden" } },
                      { secret: { npc: "npc-friend", text: "他其实怕黑" } },
                      { secret: { npc: "npc-friend", text: "他其实怕黑" } },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
      {
        turnIndex: state.turnIndex,
        worldTime: state.worldTime,
        invocationId: "inv-rel",
        perspective: "world",
        targetPerspective: "player",
      },
    );
    expect(res.receipts[0]!.outcome).toBe("accepted");

    const lookup2 = lookup.withGenerated(state.generatedEvents);
    restTurn(state, template, lookup2);
    expect(state.slot?.eventId).toBe("gen:inv-rel:s1");
    chooseOptionV2(state, { optionId: "opt-gen-1" }, template, lookup2);

    const known = state.relations.find(
      (e) => e.from === "npc-friend" && e.to === "npc-buddy" && e.kind === "friend",
    );
    expect(known?.visibility).toBe("known");
    const hidden = state.relations.find(
      (e) => e.from === "npc-buddy" && e.to === "player" && e.kind === "rival",
    );
    expect(hidden?.visibility).toBe("hidden");

    // 投影：known 放行、hidden 拦下
    const projected = projectVisibleRelations(state.relations);
    expect(projected.some((e) => e.from === "npc-friend" && e.to === "npc-buddy")).toBe(true);
    expect(projected.some((e) => e.from === "npc-buddy" && e.kind === "rival")).toBe(false);

    // secret append-only + 文本去重：同一文本两次只留一条
    const friend = state.npcs.find((n) => n.id === "npc-friend")!;
    expect(friend.secrets.filter((s) => s === "他其实怕黑")).toHaveLength(1);
  });
});

describe("S4 刷新规则 when 自动求值", () => {
  it("when 满足 ⇒ 每轮 tail 自动 spawn（spawnLog + 规则变 spawned + 人 alive）", () => {
    const { template, lookup, state } = makeWorld(
      spawnRuleTemplate([{ flag: "gate", eq: true }]),
    );
    state.flags.gate = true;
    restTurn(state, template, lookup);
    expect(lateRule(state).status).toBe("spawned");
    expect(state.spawnLog.length).toBe(1);
    expect(state.spawnLog[0]!.ruleId).toBe("rule-late");
    expect(lateNpc(state).lifecycle.state).toBe("alive");
  });

  it("when 不满足 ⇒ 不自动 spawn", () => {
    const { template, lookup, state } = makeWorld(
      spawnRuleTemplate([{ flag: "gate", eq: true }]),
    );
    restTurn(state, template, lookup);
    expect(lateRule(state).status).toBe("pending");
    expect(state.spawnLog.length).toBe(0);
    expect(lateNpc(state).lifecycle.state).toBe("unspawned");
  });

  it("无 when ⇒ 跑 3 轮也不自动（零回归：只能显式 spawn）", () => {
    const { template, lookup, state } = makeWorld(spawnRuleTemplate(undefined));
    for (let i = 0; i < 3; i += 1) restTurn(state, template, lookup);
    expect(lateRule(state).status).toBe("pending");
    expect(state.spawnLog.length).toBe(0);
    expect(lateNpc(state).lifecycle.state).toBe("unspawned");
  });
});
