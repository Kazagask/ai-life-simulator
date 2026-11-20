import { describe, expect, it } from "vitest";
import { isKinshipKind, normalizeRelationEndpoint, projectVisibleRelations } from "@life-sim/game-core";
import { kinshipTerm } from "@life-sim/ext-family";
import { RelationEdgeSchema, WorldTemplateV2Schema, relationScopeOf, relationVisibleTo, type RelationEdge } from "@life-sim/shared";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * 关系边的可见性判定（ADR-007 D2 / D3）。
 *
 * 这一层只有一个入口 `relationVisibleTo`：`projectVisibleRelations` 是它的批量版，
 * 投影、扩展、条件求值都走它。所以这里不测「投影函数做了什么」，只测**判据**本身。
 */

const scopeEdge = (from: string, to: string, extra: Partial<RelationEdge> = {}): RelationEdge => ({
  from,
  to,
  kind: "mother",
  source: "template",
  scope: "public",
  ...extra,
});

/** 旧写法边：只有 `visibility`，没有 `scope`（旧档 / 2.0.0 的存档形状）。 */
const legacyEdge = (
  from: string,
  to: string,
  visibility: RelationEdge["visibility"],
  kind: RelationEdge["kind"] = "mother",
): RelationEdge => ({ from, to, kind, source: "template", visibility });

describe("relations: scope 三档（ADR-007 D2）", () => {
  it("public：谁都能看见", () => {
    const e = scopeEdge("a", "b");
    expect(relationVisibleTo(e, "player")).toBe(true);
    expect(relationVisibleTo(e, "npc-stranger")).toBe(true);
  });

  it("limited：只有 knownBy 里的人看得见（当事人恒可见）", () => {
    const e = scopeEdge("a", "b", { scope: "limited", knownBy: ["npc-c"] });
    expect(relationVisibleTo(e, "npc-c")).toBe(true);
    expect(relationVisibleTo(e, "player")).toBe(false);
    // 端点不靠 knownBy 也看得见自己的关系
    expect(relationVisibleTo(e, "a")).toBe(true);
    expect(relationVisibleTo(e, "b")).toBe(true);
  });

  it("private：只有当事人，别人一概不知道", () => {
    const e = scopeEdge("a", "b", { scope: "private" });
    expect(relationVisibleTo(e, "a")).toBe(true);
    expect(relationVisibleTo(e, "player")).toBe(false);
  });

  it("缺 scope 时按旧 visibility 折算：known/inferred → public，unknown/hidden → private", () => {
    // 旧档与 2.0.0 的写法必须继续按原样生效（不升 schemaVersion 的前提）
    expect(relationScopeOf(legacyEdge("a", "b", "known"))).toBe("public");
    expect(relationScopeOf(legacyEdge("a", "b", "inferred"))).toBe("public");
    expect(relationScopeOf(legacyEdge("a", "b", "unknown"))).toBe("private");
    expect(relationScopeOf(legacyEdge("a", "b", "hidden"))).toBe("private");

    const visible = projectVisibleRelations(
      [
        legacyEdge("a", "b", "known"),
        legacyEdge("c", "d", "inferred"),
        legacyEdge("e", "f", "unknown"),
        legacyEdge("g", "h", "hidden"),
      ],
      "player",
    );
    expect(visible.map((e) => `${e.from}->${e.to}`)).toEqual(["a->b", "c->d"]);
  });

  it("投影只喂一个观察者：同一批边换个 viewer 结果不同（不做逐卡视角）", () => {
    const edges = [scopeEdge("a", "b", { scope: "limited", knownBy: ["npc-c"] })];
    expect(projectVisibleRelations(edges, "npc-c")).toHaveLength(1);
    expect(projectVisibleRelations(edges, "npc-d")).toHaveLength(0);
  });
});

describe("relations: limited 必须在两处都带名单", () => {
  it("存档层：RelationEdgeSchema 拒收 limited 却没有 knownBy", () => {
    const parsed = RelationEdgeSchema.safeParse({
      from: "a",
      to: "b",
      kind: "friend",
      source: "effect",
      scope: "limited",
    });
    expect(parsed.success).toBe(false);
  });

  it("模板层：效果里写 scope: limited 却没有 knownBy ⇒ 加载期报错（不留到存档才知道）", () => {
    const registry = loadTemplates({ warn: () => {}, error: () => {}, info: () => {} });
    const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
    if (entry?.status !== "ready") throw new Error("jjk-2006/3.0.0 未就绪");

    const raw = JSON.parse(JSON.stringify(entry.template)) as Record<string, unknown>;
    const facts = raw.scheduledFacts as Array<Record<string, unknown>>;
    const first = facts[0];
    if (first === undefined) throw new Error("模板没有 scheduledFacts，换个注入点");
    first.effects = [
      { type: "addRelationEdge", fromId: "npc-gojo", toId: "npc-megumi", kind: "disciple", scope: "limited" },
    ];

    const bad = WorldTemplateV2Schema.safeParse(raw);
    expect(bad.success).toBe(false);
    const messages = bad.success ? [] : bad.error.issues.map((i) => i.message);
    expect(messages.some((m) => m.includes("scope: limited 必须声明 knownBy"))).toBe(true);

    // 带上名单就合法
    first.effects = [
      {
        type: "addRelationEdge",
        fromId: "npc-gojo",
        toId: "npc-megumi",
        kind: "disciple",
        scope: "limited",
        knownBy: ["npc-geto"],
      },
    ];
    expect(WorldTemplateV2Schema.safeParse(raw).success).toBe(true);
  });
});

describe("relations: 端点归一（ADR-001 D4 收尾）", () => {
  it("写 player 就是写 self：selfId 指向角色时归一成那个角色", () => {
    expect(normalizeRelationEndpoint("player", "player")).toBe("player");
    expect(normalizeRelationEndpoint("player", "npc-gojo")).toBe("npc-gojo");
    // 具体角色 id 不受影响（不是「所有端点都换掉」）
    expect(normalizeRelationEndpoint("npc-megumi", "npc-gojo")).toBe("npc-megumi");
  });
});

describe("relations: kinshipTerm 只看边", () => {
  it("不要求端点在 state.npcs 里有实例", () => {
    const term = kinshipTerm([scopeEdge("parent-x", "child-y")], "parent-x", "child-y");
    expect(term).not.toBeNull();
    expect(term?.term).toBe("妈妈");
  });
});

describe("relations: lover 是对称社会边（不是亲属）", () => {
  it("RelationEdgeSchema 接受 lover，强度走 value", () => {
    const parsed = RelationEdgeSchema.safeParse({
      from: "npc-gojo",
      to: "player",
      kind: "lover",
      source: "effect",
      scope: "public",
      value: 35,
    });
    expect(parsed.success).toBe(true);
  });

  it("lover 不进 kinship 分支：isKinshipKind 为 false，也不推称谓", () => {
    expect(isKinshipKind("lover")).toBe(false);
    expect(kinshipTerm([scopeEdge("a", "b", { kind: "lover" })], "a", "b")).toBeNull();
  });

  it("visible 投影不因 lover 特殊化：仍只看 scope", () => {
    const visible = projectVisibleRelations(
      [
        scopeEdge("a", "b", { kind: "lover" }),
        scopeEdge("c", "d", { kind: "lover", scope: "private" }),
      ],
      "player",
    );
    expect(visible.map((e) => `${e.from}->${e.to}`)).toEqual(["a->b"]);
  });
});
