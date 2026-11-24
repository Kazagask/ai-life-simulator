import { describe, expect, it } from "vitest";
import { EffectSchema, UiConfigSchema } from "@life-sim/shared";
import { validateCharacterMedia } from "@life-sim/game-core";

/**
 * 角色媒体协议（2026-11-24 · 迭代 character-media · P0 / T-02）。
 *
 * 这条用例守两件事：
 * 1. `ui.yaml.characterMedia` 的**形状**：默认皮肤必须存在、规则必须指向已声明皮肤；
 * 2. `setSkin` 这个新 Effect 的**语法**：`skinId` 可为 null（清除覆盖），其余字段不接受。
 *
 * 不带作品专名 —— 这里只验协议。
 */

const skin = (name: string, extra: Record<string, string> = {}) => ({ name, ...extra });

describe("ui.characterMedia", () => {
  it("合法：默认皮肤 + 两条皮肤 + 时间规则", () => {
    const parsed = UiConfigSchema.safeParse({
      characterMedia: {
        "npc-a": {
          defaultSkin: "young",
          skins: { young: skin("少年", { avatar: "a.young.avatar", bust: "a.young.bust" }), old: skin("成年") },
          skinRules: [{ skin: "old", when: [{ time: { gte: { value: 300, unit: "day" } } }] }],
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("非法：defaultSkin 不在 skins 里", () => {
    const parsed = UiConfigSchema.safeParse({
      characterMedia: { "npc-a": { defaultSkin: "missing", skins: { young: skin("少年") } } },
    });
    expect(parsed.success).toBe(false);
  });

  it("非法：skinRules 指向未声明的皮肤", () => {
    const parsed = UiConfigSchema.safeParse({
      characterMedia: {
        "npc-a": {
          defaultSkin: "young",
          skins: { young: skin("少年") },
          skinRules: [{ skin: "ghost", when: [] }],
        },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("非法：skin 缺 name", () => {
    const parsed = UiConfigSchema.safeParse({
      characterMedia: { "npc-a": { defaultSkin: "young", skins: { young: { avatar: "x" } } } },
    });
    expect(parsed.success).toBe(false);
  });

  it("没有 characterMedia 的老模板照旧（零回归）", () => {
    expect(UiConfigSchema.safeParse({}).success).toBe(true);
  });
});

describe("setSkin Effect", () => {
  it("写皮肤", () => {
    expect(EffectSchema.safeParse({ type: "setSkin", who: "npc-a", skinId: "old" }).success).toBe(true);
  });

  it("who 缺省 = self", () => {
    expect(EffectSchema.safeParse({ type: "setSkin", skinId: "old" }).success).toBe(true);
  });

  it("skinId 可为 null（清除覆盖）", () => {
    expect(EffectSchema.safeParse({ type: "setSkin", who: "npc-a", skinId: null }).success).toBe(true);
  });

  it("非法：skinId 不能是空串 / 缺字段", () => {
    expect(EffectSchema.safeParse({ type: "setSkin", who: "npc-a", skinId: "" }).success).toBe(false);
    expect(EffectSchema.safeParse({ type: "setSkin", who: "npc-a" }).success).toBe(false);
  });

  it("非法：多余字段被 strict 拒掉", () => {
    const parsed = EffectSchema.safeParse({ type: "setSkin", skinId: "old", value: 1 });
    expect(parsed.success).toBe(false);
  });
});

describe("加载期跨文件校验（validateCharacterMedia）", () => {
  const template = {
    characters: [{ id: "npc-a", name: "A" }],
    events: [],
  } as unknown as Parameters<typeof validateCharacterMedia>[0];
  const manifest = { assets: [{ assetId: "a.young.avatar", path: "x", kind: "portrait", tags: [], visibility: "public" }] } as unknown as Parameters<typeof validateCharacterMedia>[2];
  const ui = (media: unknown) => ({ characterMedia: media }) as Parameters<typeof validateCharacterMedia>[1];

  it("合法：角色存在、资源已登记、条件在子集内", () => {
    const issues = validateCharacterMedia(
      template,
      ui({
        "npc-a": {
          defaultSkin: "young",
          skins: { young: { name: "少年", avatar: "a.young.avatar" } },
          skinRules: [{ skin: "young", when: [{ flag: "x", eq: true }] }],
        },
      }),
      manifest,
    );
    expect(issues).toEqual([]);
  });

  it("未知角色 ⇒ 一条 issue", () => {
    const issues = validateCharacterMedia(template, ui({ "npc-ghost": { defaultSkin: "s", skins: { s: { name: "s" } } } }), manifest);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("未知角色");
  });

  it("资源未登记 ⇒ 一条 issue；没有 manifest 时跳过（按占位符处理）", () => {
    const config = { "npc-a": { defaultSkin: "s", skins: { s: { name: "s", bust: "a.young.bust" } } } };
    expect(validateCharacterMedia(template, ui(config), manifest)).toHaveLength(1);
    expect(validateCharacterMedia(template, ui(config), undefined)).toHaveLength(0);
  });

  it("条件超出子集（relation / status）⇒ 拒", () => {
    const issues = validateCharacterMedia(
      template,
      ui({ "npc-a": { defaultSkin: "s", skins: { s: { name: "s" } }, skinRules: [{ skin: "s", when: [{ relation: "npc-b", gte: 10 }] }] } }),
      manifest,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("子集");
  });
});
