import { afterEach, describe, expect, it } from "vitest";
import { projectSnapshotV2, registerExtensionRuntime, resetExtensionRuntimes } from "@life-sim/game-core";
import { familyExtension } from "@life-sim/ext-family";
import { makeWorld } from "../helpers/world.ts";

/**
 * 扩展接缝的零回归门槛（`docs/EXTENSIONS.md` §5 验收 1 / 3）：
 *
 * **模板不声明 `extensions` ⇒ 扩展一次都不跑**，投影里没有任何 `kinshipTerm`
 * —— 哪怕扩展包已经装好、runtime 也已经注册。这是「卸载全部扩展，内核照跑」的可执行判据：
 * 少了几列展示字段，事实与可见性一个都不变。
 */
describe("extensions: 未声明即不跑", () => {
  afterEach(() => resetExtensionRuntimes());

  it("注册了 family、但模板没声明 ⇒ 投影里没有任何 kinshipTerm / derived 行", () => {
    registerExtensionRuntime(familyExtension);
    const { state, entry } = makeWorld();
    expect(entry.template.extensions).toBeUndefined();

    const npc = state.npcs[0]!;
    state.relations.push({
      from: npc.id,
      to: "player",
      kind: "father",
      source: "template",
      visibility: "known",
    });

    const snapshot = projectSnapshotV2(state, entry.template, entry.lookup);
    const rows = snapshot.npcs.flatMap((n) => n.relations);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.kinshipTerm !== undefined)).toBe(false);
    expect(rows.some((r) => r.kinshipTerms !== undefined)).toBe(false);
    expect(rows.some((r) => r.derived === true)).toBe(false);
  });

  it("模板声明 extensions.family 后，同一条边就带上称谓（接缝本身可用）", () => {
    registerExtensionRuntime(familyExtension);
    const { state, entry } = makeWorld();
    const npc = state.npcs[0]!;
    state.relations.push({
      from: npc.id,
      to: "player",
      kind: "father",
      source: "template",
      visibility: "known",
    });

    const template = { ...entry.template, extensions: { family: true } };
    const snapshot = projectSnapshotV2(state, template, entry.lookup);
    const row = snapshot.npcs
      .flatMap((n) => n.relations)
      .find((r) => r.withId === "player" && r.direction === "out");
    expect(row?.kind).toBe("father");
    expect(row?.kinshipTerm).toBe("爸爸");
  });
});
