import { describe, expect, it } from "vitest";
import type { CharacterMedia } from "@life-sim/shared";
import { derivedActorMedia, resolveCharacterMedia, resolveSkin } from "@life-sim/game-core";

/**
 * 皮肤解析 · P1 段（2026-11-24 · T-09a）。
 *
 * P1 只走「人物身份 → defaultSkin → assetId」，**不看** `skinId` / `skinRules` / `customSkin`
 * 那三段（P2 在同一个函数里补，调用方与签名不变）。
 */

const media: Record<string, CharacterMedia> = {
  "npc-a": {
    defaultSkin: "young",
    skins: {
      young: { name: "少年", avatar: "a.avatar", bust: "a.bust", full: "a.full" },
      sparse: { name: "只有半身", bust: "b.bust" },
    },
  },
  "npc-b": { defaultSkin: "only", skins: { only: { name: "纯文字" } } },
};

describe("resolveSkin（P1：defaultSkin）", () => {
  it("按 characterId 取默认皮肤", () => {
    expect(resolveSkin({ actorId: "npc-a", characterId: "npc-a" }, media)).toEqual({
      characterId: "npc-a",
      skinId: "young",
      skin: media["npc-a"]!.skins.young,
    });
  });

  it("没有 characterId 时退回 actorId（玩家 reuse 时二者相同）", () => {
    expect(resolveSkin({ actorId: "npc-a" }, media)?.skinId).toBe("young");
  });

  it("没配 / 未知角色 ⇒ undefined（由调用方走占位符）", () => {
    expect(resolveSkin({ actorId: "npc-z" }, media)).toBeUndefined();
    expect(resolveSkin({ actorId: "npc-a" }, undefined)).toBeUndefined();
  });
});

describe("resolveCharacterMedia（槽位回退，只在同一皮肤内）", () => {
  it("命中本槽", () => {
    expect(resolveCharacterMedia({ actorId: "npc-a" }, "avatar", media)).toBe("a.avatar");
  });

  it("素材缺位按 avatar → bust → full 回退", () => {
    const onlyBust: Record<string, CharacterMedia> = {
      "npc-c": { defaultSkin: "s", skins: { s: { name: "s", bust: "c.bust" } } },
    };
    expect(resolveCharacterMedia({ actorId: "npc-c" }, "avatar", onlyBust)).toBe("c.bust");
    expect(resolveCharacterMedia({ actorId: "npc-c" }, "full", onlyBust)).toBe("c.bust");
  });

  it("一个素材都没有 ⇒ undefined", () => {
    expect(resolveCharacterMedia({ actorId: "npc-b" }, "avatar", media)).toBeUndefined();
  });
});

describe("derivedActorMedia", () => {
  it("产出 avatar.<id> 与 portrait.<id>，不可见的角色跳过", () => {
    const out = derivedActorMedia(
      [
        { ref: { actorId: "npc-a" }, visible: true },
        { ref: { actorId: "npc-b" }, visible: true },
        { ref: { actorId: "npc-a" }, visible: false },
      ],
      media,
    );
    expect(out).toEqual([
      { slot: "avatar.npc-a", assetId: "a.avatar" },
      { slot: "portrait.npc-a", assetId: "a.bust" },
    ]);
  });

  it("没有 characterMedia ⇒ 空数组（老模板零变化）", () => {
    expect(derivedActorMedia([{ ref: { actorId: "npc-a" }, visible: true }], undefined)).toEqual([]);
  });
});
