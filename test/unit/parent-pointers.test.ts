import { describe, expect, it } from "vitest";
import { createWorldV2 } from "@life-sim/game-core";
import { WorldTemplateV2Schema, type WorldTemplateV2 } from "@life-sim/shared";
import { fixtureEntry } from "../helpers/world.ts";

/**
 * 父/母指针入契约与实例（`docs/FAMILY-GRAPH.md` §3.1，阶段三第 1 段）。
 *
 * 本段只做两件事：**字段进契约、值传进实例**。
 * 亲缘推导仍由 `extensions/family` 从关系边算（模式一），指针**没有任何消费者**，
 * 所以这里只锁「铺路」本身：
 *
 * 1. 建局后实例带上 `fatherId` / `motherId`，没写的人**不产生该字段**（旧形状不变）；
 * 2. 指针指向不存在的 id / 指向自己 ⇒ 加载期拒载。
 */

/** 在已解析的夹具模板上克隆一个角色，避免改动 fixture 文件本身。 */
function withExtraCharacter(template: WorldTemplateV2, id: string, name: string): WorldTemplateV2 {
  const base = template.characters.find((c) => !c.isEnemy);
  if (!base) throw new Error("fixture 模板缺少可克隆的非敌人角色");
  const twin = structuredClone(base);
  twin.id = id;
  twin.identity.name = name;
  template.characters.push(twin);
  return template;
}

describe("父/母指针：建局时复制进实例", () => {
  it("模板写了 fatherId/motherId ⇒ 实例逐字段带上；没写 ⇒ 实例不产生该键", () => {
    const template = structuredClone(fixtureEntry().template);
    withExtraCharacter(template, "npc-father", "父亲");
    withExtraCharacter(template, "npc-mother", "母亲");
    const child = template.characters.find((c) => c.id === "npc-friend")!;
    child.fatherId = "npc-father";
    child.motherId = "npc-mother";

    const state = createWorldV2(
      { templateId: template.meta.id, playerName: "测试玩家", seed: 11 },
      template,
      "w-parent-pointers",
    );

    const childNpc = state.npcs.find((n) => n.id === "npc-friend")!;
    expect(childNpc.fatherId).toBe("npc-father");
    expect(childNpc.motherId).toBe("npc-mother");

    // 缺省不写：指针前的实例形状逐字节不变（存档 strict 校验也依赖这一点）。
    const untouched = state.npcs.find((n) => n.id === "npc-father")!;
    expect("fatherId" in untouched).toBe(false);
    expect("motherId" in untouched).toBe(false);
  });
});

describe("父/母指针：加载期引用完整性", () => {
  it("fatherId 指向不存在的角色 ⇒ 模板不可载", () => {
    const template = structuredClone(fixtureEntry().template);
    template.characters[0]!.fatherId = "npc-ghost";

    const parsed = WorldTemplateV2Schema.safeParse(template);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issue = parsed.error.issues.find((i) => i.path.join(".") === "characters.0.fatherId");
    expect(issue?.message).toContain("未知角色：npc-ghost");
  });

  it("fatherId 指向自己 ⇒ 模板不可载", () => {
    const template = structuredClone(fixtureEntry().template);
    const self = template.characters[1]!;
    self.motherId = self.id;

    const parsed = WorldTemplateV2Schema.safeParse(template);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issue = parsed.error.issues.find((i) => i.path.join(".") === "characters.1.motherId");
    expect(issue?.message).toContain("不能指向自己");
  });
});
