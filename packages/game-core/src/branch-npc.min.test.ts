import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "yaml";
import { WorldTemplateV2Schema, type WorldStateV2 } from "@life-sim/shared";

import { createActiveWorldV2 } from "./v2/test-utils.js";
import { RpgEngineAPI } from "./api/engine-api.js";
import { createConditionRegistry } from "./v2/condition-evaluator.js";

/**
 * `story.submitBranch` 里的 **NPC 生成**（2026-11-16 用户裁决）。
 *
 * 关键语义：
 * - LLM 不调任何"生成 NPC 的函数"，它只在分支 payload 里**描述**这些人；
 * - 引擎分配全局 id、校验 schema、把定义写进 `state.generatedCharacters`，
 *   实例以 `unspawned` 落 `state.npcs`（**定义了 ≠ 登场了**）；
 * - 登场由选项效果 `{spawn: <alias>}` 激活（与模板 `spawnNpc` 共用同一实例表与生命周期）；
 * - `{spawn: "<ruleId>"}` 仍可指向模板刷新规则，两条来源并存。
 */

const VERSION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../specs/data/templates/demo-agentic/1.0.0",
);
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

function loadTemplate() {
  const merged: Record<string, unknown> = {};
  for (const file of MERGE_FILES) {
    const abs = path.join(VERSION_DIR, file);
    if (!existsSync(abs)) continue;
    const doc = parse(readFileSync(abs, "utf8")) as Record<string, unknown> | null;
    if (doc === null || typeof doc !== "object") continue;
    for (const [key, value] of Object.entries(doc)) {
      if (key === "meta") merged.meta = value;
      else if (merged[key] === undefined) merged[key] = value;
      else if (Array.isArray(merged[key]) && Array.isArray(value)) {
        merged[key] = [...(merged[key] as unknown[]), ...value];
      }
    }
  }
  return WorldTemplateV2Schema.parse(merged);
}

function freshWorld(seed = 11) {
  const template = loadTemplate();
  const state = createActiveWorldV2({ templateId: "demo-agentic", playerName: "造人", seed }, template, `bn-${seed}`);
  state.worldTime = 1440;
  const api = new RpgEngineAPI({
    state,
    perspective: "world",
    targetPerspective: "player",
    conditionRegistry: createConditionRegistry(),
    lookupRefs: new Set(["evt:awaken"]),
  });
  const ctx = {
    turnIndex: state.turnIndex,
    worldTime: state.worldTime,
    invocationId: "inv-npc",
    perspective: "world" as const,
    targetPerspective: "player" as const,
  };
  const submit = (args: Record<string, unknown>) =>
    api.dispatch([{ callId: "c-1", tool: "story.submitBranch", args }], ctx);
  return { state, submit };
}

const withNpc = (effects: unknown[]) => ({
  trigger: { mode: "certain" },
  npcs: [
    {
      alias: "stranger",
      name: "穿雨衣的女人",
      age: 30,
      personality: "警惕",
      knownGoals: ["找一个失踪的人"],
      goals: ["找到弟弟"],
    },
  ],
  branch: [
    {
      node: "s1",
      title: "雨里的女人",
      text: "她站在雨里，像在等谁。",
      options: [{ text: "上前", effects }],
    },
  ],
});

describe("submitBranch 的 NPC 生成（模板里没有的人）", () => {
  it("定义落表：generatedCharacters + npcs 实例（unspawned），id 由引擎分配", () => {
    const { state, submit } = freshWorld();
    const before = state.npcs.length;
    const res = submit(withNpc([{ spawn: "stranger" }]));
    expect(res.receipts[0]!.outcome).toBe("accepted");

    expect(state.generatedCharacters).toHaveLength(1);
    const def = state.generatedCharacters![0]!;
    expect(def.id).toBe("gennpc:inv-npc:stranger");
    expect(def.identity.name).toBe("穿雨衣的女人");
    expect(def.public.personality).toBe("警惕");

    expect(state.npcs.length).toBe(before + 1);
    const inst = state.npcs.find((n) => n.id === def.id)!;
    // 定义了 ≠ 登场了
    expect(inst.lifecycle.state).toBe("unspawned");
    expect(inst.name).toBe("穿雨衣的女人");
    // 模型不能把自己造的人藏起来：展示门由引擎固定为 public，不接受入参指定
    expect(inst.visibility).toBe("public");
    expect(def.visibility).toBe("public");
  });

  it("登场：选项效果 {spawn: 别名} 编译成 setNpcLifecycle(alive)", () => {
    const { state, submit } = freshWorld();
    submit(withNpc([{ spawn: "stranger" }]));
    const event = state.generatedEvents![0]!;
    if (event.kind !== "normal") throw new Error("生成的分支事件必须是 normal");
    const effects = event.settle.normal.options[0]!.effects ?? [];
    expect(effects).toEqual([
      { type: "setNpcLifecycle", npcId: "gennpc:inv-npc:stranger", state: "alive" },
    ]);
  });

  it("两条来源并存：{spawn: 模板规则 id} 仍走 spawnNpc", () => {
    const { state, submit } = freshWorld();
    const ruleId = state.spawnRules[0]?.ruleId;
    // 模板没有刷新规则时跳过（demo-agentic 可能没配）
    if (ruleId === undefined) return;
    submit(withNpc([{ spawn: ruleId }]));
    const event = state.generatedEvents![0]!;
    if (event.kind !== "normal") throw new Error("生成的分支事件必须是 normal");
    const effects = event.settle.normal.options[0]!.effects ?? [];
    expect(effects).toEqual([{ type: "spawnNpc", ruleId }]);
  });

  it("属性不信任入参：越界值被钳到 [0,20]", () => {
    const { state, submit } = freshWorld();
    const args = withNpc([]);
    (args.npcs[0] as unknown as Record<string, unknown>).attributes = { body: 999, mind: -5 };
    submit(args);
    const attrs = state.generatedCharacters![0]!.attributes;
    expect(attrs.body).toBe(20);
    expect(attrs.mind).toBe(0);
  });

  it("关系与生命周期效果：别名被解析成全局 id", () => {
    const { state, submit } = freshWorld();
    submit(withNpc([{ relation: { with: "stranger", to: 12 } }, { lifecycle: { npc: "stranger", state: "inactive" } }]));
    const event = state.generatedEvents![0]!;
    if (event.kind !== "normal") throw new Error("生成的分支事件必须是 normal");
    const effects = event.settle.normal.options[0]!.effects ?? [];
    expect(effects).toEqual([
      { type: "adjustRelation", npcId: "gennpc:inv-npc:stranger", value: 12 },
      { type: "setNpcLifecycle", npcId: "gennpc:inv-npc:stranger", state: "inactive" },
    ]);
  });

  it("原子性：NPC 别名重复 ⇒ 整条拒绝，state 不变", () => {
    const { state, submit } = freshWorld();
    const args = withNpc([]);
    (args.npcs as unknown[]).push({ alias: "stranger", name: "另一个", age: 20 });
    const before = JSON.stringify({ n: state.npcs.length, g: state.generatedCharacters ?? [] });
    const res = submit(args);
    expect(res.receipts[0]!.outcome).toBe("rejected");
    expect(JSON.stringify({ n: state.npcs.length, g: state.generatedCharacters ?? [] })).toBe(before);
  });
});
