import { afterEach, describe, expect, it } from "vitest";
import {
  createLookup,
  createWorldV2,
  makeTestTemplate,
  projectSnapshotV2,
  registerExtensionRuntime,
  resetExtensionRuntimes,
  type RelationEdgeSourceContext,
  type SnapshotActor,
} from "@life-sim/game-core";
import type { WorldTemplateV2, WorldStateV2 } from "@life-sim/shared";
import { familyExtension } from "@life-sim/ext-family";

/**
 * 指针模式的**行级**回归（`extensions/family/doc/FAMILY-GRAPH.md` §7.1 第 1 条）。
 *
 * 指针模式下 `state.relations` 里没有亲属边 ⇒ NPC 卡的关系行会整块消失。
 * 3b 的解法是「投影期把指针合成的边加回去」：扩展贡献边 → 内核按
 * `(from,to,kind)` 并入唯一那份边集 → 行装配与称谓装饰照旧走原路。
 *
 * 这里锁五件事：
 * 1. 子女卡上有「爸爸 / 妈妈」行（含 `kinshipTerm`）；
 * 2. 父/母卡上有「儿子」行 —— 指针图只有 子女→父母 方向，反向边必须补，
 *    否则人物卡（只渲染出边）看不到子女；
 * 3. 婚配表（`state.extensions.family.spouses`）也能变成「妻子 / 丈夫」行；
 * 4. 同一对父子既有声明边又有合成边 ⇒ **只出一条**，且**声明边赢**（用它自己的 `visibility` 验出来）；
 * 5. 边模式 / 未声明扩展 ⇒ 一条贡献边都没有（零回归）。
 */

function character(
  base: WorldTemplateV2["characters"][number],
  id: string,
  name: string,
  gender: string,
  age: number,
): WorldTemplateV2["characters"][number] {
  const copy = structuredClone(base);
  copy.id = id;
  copy.isEnemy = false;
  copy.visibility = "public";
  copy.identity = { ...copy.identity, name, gender, age };
  copy.skills = [];
  copy.private = {};
  return copy;
}

/** 一家三口（父 / 母 / 子），亲缘只靠父/母指针表达。 */
function pointerFamilyTemplate(declareExtension = true): WorldTemplateV2 {
  const base = makeTestTemplate();
  const seed = base.characters[0]!;
  const child = character(seed, "npc-child", "小明", "male", 12);
  child.fatherId = "npc-father";
  child.motherId = "npc-mother";
  return {
    ...base,
    genders: [
      { id: "male", label: "男" },
      { id: "female", label: "女" },
    ],
    characters: [
      character(seed, "npc-father", "父亲", "male", 40),
      character(seed, "npc-mother", "母亲", "female", 38),
      child,
    ],
    ...(declareExtension ? { extensions: { family: true } } : {}),
  };
}

function makeWorld(template: WorldTemplateV2): WorldStateV2 {
  return createWorldV2({ templateId: "test", playerName: "我", seed: 7 }, template, "w-rows");
}

function card(snapshot: ReturnType<typeof projectSnapshotV2>, id: string) {
  const npc = snapshot.npcs.find((n) => n.id === id);
  if (npc === undefined) throw new Error(`没有这张卡：${id}`);
  return npc;
}

afterEach(() => resetExtensionRuntimes());

describe("指针模式：把亲属边加回投影，人物卡照旧出行", () => {
  it("子女卡：父亲 / 母亲行带正确称谓", () => {
    registerExtensionRuntime(familyExtension);
    const template = pointerFamilyTemplate();
    const state = makeWorld(template);
    const snapshot = projectSnapshotV2(state, template, createLookup(template));

    const rows = card(snapshot, "npc-child").relations;
    expect(rows.find((r) => r.withId === "npc-father")).toMatchObject({
      kind: "father",
      direction: "out",
      kinshipTerm: "爸爸",
    });
    expect(rows.find((r) => r.withId === "npc-mother")).toMatchObject({
      kind: "mother",
      direction: "out",
      kinshipTerm: "妈妈",
    });
  });

  it("父/母卡：子女行也在（反向边由扩展补出）", () => {
    registerExtensionRuntime(familyExtension);
    const template = pointerFamilyTemplate();
    const state = makeWorld(template);
    const snapshot = projectSnapshotV2(state, template, createLookup(template));

    for (const parent of ["npc-father", "npc-mother"]) {
      // 只取出边：人物卡只渲染出边（`packages/rpg-ui` 的 `RelationList`），入边是同一事实的另一半。
      const row = card(snapshot, parent).relations.find(
        (r) => r.withId === "npc-child" && r.direction === "out",
      );
      expect(row, `${parent} 的子女行`).toMatchObject({
        kind: "son",
        direction: "out",
        kinshipTerm: "儿子",
      });
    }
  });

  it("婚配表 → 妻子 / 丈夫行（两端各一条，不是只有一端）", () => {
    registerExtensionRuntime(familyExtension);
    const template = pointerFamilyTemplate();
    const state = makeWorld(template);
    state.extensions = {
      family: {
        clans: [],
        members: [],
        spouses: [{ a: "npc-father", b: "npc-mother", since: 0 }],
      },
    };

    const snapshot = projectSnapshotV2(state, template, createLookup(template));
    const outgoing = (viewer: string, withId: string) =>
      card(snapshot, viewer).relations.find((r) => r.withId === withId && r.direction === "out");
    expect(outgoing("npc-father", "npc-mother")).toMatchObject({
      kind: "wife",
      kinshipTerm: "老婆",
    });
    expect(outgoing("npc-mother", "npc-father")).toMatchObject({
      kind: "husband",
      kinshipTerm: "老公",
    });
  });

  it("合成边不写回 state.relations（只活在投影里）", () => {
    registerExtensionRuntime(familyExtension);
    const template = pointerFamilyTemplate();
    const state = makeWorld(template);
    expect(state.relations).toHaveLength(0);

    projectSnapshotV2(state, template, createLookup(template));
    expect(state.relations).toHaveLength(0);
  });
});

describe("合并规则：声明边赢、不重复出两行", () => {
  it("声明边 + 指针合成边撞同一对父子 ⇒ 只出一行，且保留声明边的 visibility", () => {
    registerExtensionRuntime(familyExtension);
    const template = pointerFamilyTemplate();
    const state = makeWorld(template);
    // 声明边故意标 inferred（合成边是 known）：谁赢可以**从行上看出来**。
    state.relations.push({
      from: "npc-child",
      to: "npc-father",
      kind: "father",
      source: "template",
      visibility: "inferred",
    });

    const snapshot = projectSnapshotV2(state, template, createLookup(template));
    const rows = card(snapshot, "npc-child").relations.filter(
      (r) => r.withId === "npc-father" && r.direction === "out",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "father", visibility: "inferred", kinshipTerm: "爸爸" });
    // 同一对父子在**整张卡**上也只该有一条 father 边（反向的「儿子」行是另一条事实，不算重复）。
    expect(
      card(snapshot, "npc-child").relations.filter((r) => r.withId === "npc-father" && r.kind === "father"),
    ).toHaveLength(1);
  });
});

describe("零回归：不该贡献的时候一条都不贡献", () => {
  const actorsWithPointers = (): Map<string, SnapshotActor> =>
    new Map<string, SnapshotActor>([
      [
        "dad",
        { id: "dad", name: "父", visible: true, alive: true, age: 40, genderId: "male", lifeState: "alive" },
      ],
      [
        "kid",
        {
          id: "kid",
          name: "子",
          visible: true,
          alive: true,
          age: 10,
          genderId: "male",
          lifeState: "alive",
          fatherId: "dad",
        },
      ],
    ]);

  it("边模式（演员没有指针）⇒ 贡献 []", () => {
    const context: RelationEdgeSourceContext = {
      selfId: "player",
      actors: new Map<string, SnapshotActor>([
        ["dad", { id: "dad", name: "父", visible: true, alive: true, age: 40, lifeState: "alive" }],
      ]),
      hiddenNodeIds: new Set<string>(),
      config: true,
    };
    expect(familyExtension.contributeRelationEdges!(context)).toEqual([]);
  });

  it("指针模式贡献的边一律标 source = extension（绝不伪装成 template）", () => {
    const context: RelationEdgeSourceContext = {
      selfId: "player",
      actors: actorsWithPointers(),
      hiddenNodeIds: new Set<string>(),
      config: true,
    };
    const edges = familyExtension.contributeRelationEdges!(context);
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((edge) => edge.source === "extension")).toBe(true);
  });

  it("模板没声明 family ⇒ 有指针也不出行（未声明即不跑）", () => {
    registerExtensionRuntime(familyExtension);
    const template = pointerFamilyTemplate(false);
    expect(template.extensions).toBeUndefined();
    const state = makeWorld(template);
    const snapshot = projectSnapshotV2(state, template, createLookup(template));

    expect(snapshot.npcs.flatMap((n) => n.relations)).toHaveLength(0);
  });
});
