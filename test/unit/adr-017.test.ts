import { describe, expect, it } from "vitest";
import { createWorldV2 } from "@life-sim/game-core";
import { BranchEffectSchema, OpeningNpcSetupSchema, WorldTemplateV2Schema } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function jjk() {
  const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");
  return entry;
}

/**
 * ADR-017 · 关系协议收敛。
 *
 * 三条各自都是一个「写了两份、只用一份」的形态：
 *  - D1 强度有两个家（`npc.relationship` 标量 / 边 `value`）；
 *  - D2 玩家侧关系边没有声明点（只有 `characters[].relations`，from 恒为那个角色）；
 *  - D3 开局往 `flags` 里写了两组没有任何读者的描述性事实。
 */
describe("ADR-017 D1 · 强度单一真源（端点是 self 就只住标量）", () => {
  it("模板给 to: player 的边写 value ⇒ 加载期拒载（不是静默丢弃）", () => {
    const entry = jjk();
    const template = structuredClone(entry.template);
    const yaga = template.characters.find((c) => c.id === "npc-yaga");
    if (yaga === undefined) throw new Error("缺 npc-yaga");
    yaga.relations = [...(yaga.relations ?? []), { to: "player", kind: "friend", scope: "public", value: 70 }];

    const parsed = WorldTemplateV2Schema.safeParse(template);
    expect(parsed.success).toBe(false);
    const messages = parsed.success ? [] : parsed.error.issues.map((i) => i.message);
    expect(messages.some((m) => m.includes("不要写 value"))).toBe(true);
  });

  it("指向 self 的声明边不带 value 时照常建边（kind 是事实）", () => {
    const entry = jjk();
    const state = createWorldV2(
      { templateId: "jjk-2006", playerName: "无名氏", seed: 7, self: { kind: "default" } },
      entry.template,
      "w-adr017-d1",
    );

    const toSelf = state.relations.filter((e) => e.to === "player");
    expect(toSelf.length).toBeGreaterThan(0);
    expect(toSelf.every((e) => e.value === undefined)).toBe(true);
    // 强度住在标量上
    const geto = state.npcs.find((n) => n.id === "npc-geto");
    expect(typeof geto?.relationship).toBe("number");
  });
});

describe("ADR-017 D2 · 玩家侧关系边（playerTemplate.relations）", () => {
  it("`from` 恒为 self，落到 state.relations，并出现在投影的关系行里", () => {
    const entry = jjk();
    const template = structuredClone(entry.template);
    if (template.playerTemplate === undefined) throw new Error("夹具模板没有 playerTemplate");
    template.playerTemplate.relations = [{ to: "npc-geto", kind: "friend", scope: "public" }];

    const state = createWorldV2(
      { templateId: "jjk-2006", playerName: "无名氏", seed: 11, self: { kind: "default" } },
      template,
      "w-adr017-d2",
    );

    const out = state.relations.filter((e) => e.from === "player" && e.to === "npc-geto");
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("friend");
    expect(out[0]?.scope).toBe("public");
  });

  it("指向未知角色 ⇒ 加载期拒载", () => {
    const entry = jjk();
    const template = structuredClone(entry.template);
    if (template.playerTemplate === undefined) throw new Error("夹具模板没有 playerTemplate");
    template.playerTemplate.relations = [{ to: "npc-nobody", kind: "friend" }];

    const parsed = WorldTemplateV2Schema.safeParse(template);
    expect(parsed.success).toBe(false);
  });

  it("玩家侧边不许带 value（自己的观感不预设数字）", () => {
    const entry = jjk();
    const template = structuredClone(entry.template);
    if (template.playerTemplate === undefined) throw new Error("夹具模板没有 playerTemplate");
    template.playerTemplate.relations = [{ to: "npc-geto", kind: "friend", value: 40 }];

    const parsed = WorldTemplateV2Schema.safeParse(template);
    expect(parsed.success).toBe(false);
    const messages = parsed.success ? [] : parsed.error.issues.map((i) => i.message);
    expect(messages.some((m) => m.includes("观感由行为养成"))).toBe(true);
  });
});

describe("ADR-017 D3 · 情报档位不再写死旗标", () => {
  it("npcSetup.visibility 已废弃 ⇒ 加载期拒载，且报错说清楚替代品", () => {
    const parsed = OpeningNpcSetupSchema.safeParse({ relations: [], visibility: { "npc-x": "known" } });
    expect(parsed.success).toBe(false);
    const messages = parsed.success ? [] : parsed.error.issues.map((i) => i.message);
    expect(messages.some((m) => m.includes("已废弃"))).toBe(true);
  });

  it("合法形态（只有 relations）照常通过", () => {
    expect(OpeningNpcSetupSchema.safeParse({ relations: [] }).success).toBe(true);
  });
});

describe("ADR-017 D1 附带 · 契约层的 relationEdge 用 scope", () => {
  it("scope: limited 必须给 knownBy（否则这条关系谁都看不到）", () => {
    const parsed = BranchEffectSchema.safeParse({
      relationEdge: { from: "a", to: "b", kind: "friend", scope: "limited" },
    });
    expect(parsed.success).toBe(false);
  });

  it("scope + knownBy 通过；旧的 visibility 仍被接受（兼容）", () => {
    expect(
      BranchEffectSchema.safeParse({
        relationEdge: { from: "a", to: "b", kind: "friend", scope: "limited", knownBy: ["c"] },
      }).success,
    ).toBe(true);
    expect(
      BranchEffectSchema.safeParse({
        relationEdge: { from: "a", to: "b", kind: "friend", visibility: "known" },
      }).success,
    ).toBe(true);
  });
});
