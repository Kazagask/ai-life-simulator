import { afterEach, describe, expect, it } from "vitest";
import { projectSnapshotV2, registerExtensionRuntime, resetExtensionRuntimes } from "@life-sim/game-core";
import { familyExtension } from "@life-sim/ext-family";
import type { FamilyView } from "@life-sim/ext-family";
import { makeWorld } from "../helpers/world.ts";

/**
 * 族谱的接缝门槛（`extensions/family/doc/CLAN-DESIGN.md` §5 验收 3 / `docs/EXTENSIONS.md` §5 验收 1）：
 *
 * **模板不声明 `extensions.family` ⇒ 快照里没有 `extensions`**，哪怕扩展已注册。
 * 这是「扩展全部卸载，内核照跑」的可执行判据 —— 族谱是纯派生，不是新事实。
 *
 * 纯派生算法本身的单元用例在 `extensions/family/test/pedigree.test.ts`。
 */
describe("族谱：未声明即不跑", () => {
  afterEach(() => resetExtensionRuntimes());

  it("注册了 family、但模板没声明 extensions ⇒ snapshot.extensions 是 undefined", () => {
    registerExtensionRuntime(familyExtension);
    const { state, entry } = makeWorld();
    expect(entry.template.extensions).toBeUndefined();

    const snapshot = projectSnapshotV2(state, entry.template, entry.lookup);
    expect(snapshot.extensions).toBeUndefined();
  });

  it("模板声明 extensions.family 后，快照带上 pedigree（自己 + 一位亲属）", () => {
    registerExtensionRuntime(familyExtension);
    const { state, entry } = makeWorld();
    const other = state.npcs[0]!;
    // `{from: 玩家, to: 对方, kind: "father"}`：对方是玩家的父亲。
    state.relations.push({
      from: state.selfId ?? "player",
      to: other.id,
      kind: "father",
      source: "template",
      visibility: "known",
    });

    const template = { ...entry.template, extensions: { family: true } };
    const snapshot = projectSnapshotV2(state, template, entry.lookup);
    // 宿主侧只有不透明的 `unknown`：断言口径靠扩展自己的契约类型收窄。
    const family = snapshot.extensions?.family as FamilyView | undefined;
    const pedigree = family?.pedigree;
    expect(pedigree).toBeDefined();
    const self = pedigree!.nodes.find((n) => n.isSelf);
    expect(self?.id).toBe(state.selfId ?? "player");
    expect(self?.generation).toBe(1);
    expect(pedigree!.nodes.find((n) => n.id === other.id)?.generation).toBe(0);
    expect(pedigree!.nodes.find((n) => n.id === other.id)?.name).toBe(other.name);
  });
});
