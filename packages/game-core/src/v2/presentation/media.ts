import type { AssetManifest, CharacterMedia, Skin, UiConfig, WorldTemplateV2 } from "@life-sim/shared";

/**
 * 角色媒体（2026-11-24 · 迭代 character-media）。
 *
 * 这一层只做**校验**与**解析**，不存图、不认识任何角色名。
 * V1.0 先落校验（P0 / T-04）；解析器（`resolveSkin` / `resolveCharacterMedia`）在 P2 补齐。
 */

export interface MediaIssue {
  path: string;
  message: string;
}

/**
 * 自动换皮肤允许的条件类别。
 *
 * V1 **只放行全局子集**：`time`（世界时间）与 `flag`（全局旗标）。
 * 「全局事件事实」在协议里没有独立条件 —— 项目惯例就是让事件写旗标，所以 `flag` 已经覆盖它。
 *
 * 人物自身状态 / 属性 / 关系**暂缓**：按人物上下文求值需要 `ActorContext`，V1 不做，
 * 也**禁止**用「临时替换 state.player / selfId」的办法绕过（会污染关系图与观察者）。
 */
export const SKIN_RULE_CONDITION_KEYS: readonly string[] = ["time", "flag"];

const SKIN_ASSET_SLOTS = ["avatar", "bust", "full", "cutIn"] as const;

function skinAssetIds(media: CharacterMedia): Array<{ path: string; assetId: string }> {
  const out: Array<{ path: string; assetId: string }> = [];
  for (const [skinId, skin] of Object.entries(media.skins)) {
    for (const slot of SKIN_ASSET_SLOTS) {
      const assetId = skin[slot];
      if (assetId !== undefined) out.push({ path: `${skinId}.${slot}`, assetId });
    }
    for (const [skillId, assetId] of Object.entries(skin.skillCutIns ?? {})) {
      out.push({ path: `${skinId}.skillCutIns.${skillId}`, assetId });
    }
  }
  return out;
}

/**
 * 跨文件校验：`ui.characterMedia` 必须指向**已声明的角色**与**已登记的资源**。
 *
 * **配置错误 vs 运行时缺失**（2026-11-24 评审核定）：
 * - 模板**声明了媒体却没有 manifest**、或引用了**未登记**的 assetId ⇒ **加载期报错**（作者写错了）；
 * - 历史存档里的资源失效、网络失败、文件被删 ⇒ 运行时降级成占位符（玩家不该看到红字）；
 * - **没有** `characterMedia` 的老模板 ⇒ 一条校验都不做（保持兼容）。
 */
export function validateCharacterMedia(
  template: WorldTemplateV2,
  ui: UiConfig | undefined,
  assetManifest: AssetManifest | undefined,
): MediaIssue[] {
  const media = ui?.characterMedia;
  if (media === undefined) return [];
  const issues: MediaIssue[] = [];
  /**
   * 声明了媒体却没登记清单 ⇒ 作者漏了一步，加载期就拒。
   * 这条**不能**降级成运行时占位符：那样「配了但没生效」会一直没人发现。
   */
  if (assetManifest === undefined) {
    return [
      {
        path: "characterMedia",
        message: "声明了 characterMedia，但模板没有 assets/manifest.yaml（媒体必须先登记资源）",
      },
    ];
  }
  const characters = new Set(template.characters.map((c) => c.id));
  const assets = assetManifest === undefined ? undefined : new Set(assetManifest.assets.map((a) => a.assetId));

  for (const [characterId, config] of Object.entries(media)) {
    if (!characters.has(characterId)) {
      issues.push({ path: characterId, message: `characterMedia 指向未知角色「${characterId}」` });
      continue;
    }
    for (const { path, assetId } of skinAssetIds(config)) {
      if (assets !== undefined && !assets.has(assetId)) {
        issues.push({ path: `${characterId}.${path}`, message: `未登记的资源「${assetId}」` });
      }
    }
    for (const [i, rule] of (config.skinRules ?? []).entries()) {
      for (const condition of rule.when) {
        const key = Object.keys(condition as Record<string, unknown>)[0];
        if (key !== undefined && !SKIN_RULE_CONDITION_KEYS.includes(key)) {
          issues.push({
            path: `${characterId}.skinRules[${i}].when`,
            message: `条件「${key}」不在 V1 允许的子集（${SKIN_RULE_CONDITION_KEYS.join(" / ")}）内`,
          });
        }
      }
    }
  }
  return issues;
}

// ══════════════════════════════════════════════════════════════════
// 解析器（P1 只实现「身份 → defaultSkin → assetId」这一段）
// ══════════════════════════════════════════════════════════════════

/** 解析层的人物引用。**不是**人物实例体系的一部分，只是入参。 */
export interface ActorMediaRef {
  /** 世界里的实例 id（玩家 = selfId；战斗单位 = 单位 id）。 */
  actorId: string;
  /** 模板人物 id：敌人 / 召唤物没有 NPC 实例时用它查皮肤集合。 */
  characterId?: string;
  /** 实例上的显式皮肤（P2 消费）。 */
  skinId?: string;
  /** 实例独有皮肤（预留，P2 之后）。 */
  customSkin?: Skin;
}

export type MediaSlot = "avatar" | "bust" | "full";

export interface SkinResolution {
  characterId: string;
  skinId: string;
  skin: Skin;
}

/** 槽位回退链：**只在同一皮肤内**回退，不跨皮肤混用素材。 */
const SLOT_FALLBACK: Record<MediaSlot, readonly (keyof Skin)[]> = {
  avatar: ["avatar", "bust", "full"],
  bust: ["bust", "full", "avatar"],
  full: ["full", "bust", "avatar"],
};

/**
 * 解析当前皮肤（P1 段）：`characterId → characterMedia[characterId] → defaultSkin`。
 *
 * P2 会在这个函数**内部**补三段前置分支（`skinId` → `skinRules` → `customSkin`），
 * 调用方与签名都不变 —— 所以 UI 层**不需要**也不允许写临时映射。
 */
export function resolveSkin(
  ref: ActorMediaRef,
  media: Record<string, CharacterMedia> | undefined,
): SkinResolution | undefined {
  if (media === undefined) return undefined;
  const characterId = ref.characterId ?? ref.actorId;
  const config = media[characterId];
  if (config === undefined) return undefined;
  const skinId = config.defaultSkin;
  const skin = config.skins[skinId];
  if (skin === undefined) return undefined;
  return { characterId, skinId, skin };
}

/** 解析某个槽位的 assetId：命中返回 id，缺全部素材返回 undefined（由调用方走占位符）。 */
export function resolveCharacterMedia(
  ref: ActorMediaRef,
  slot: MediaSlot,
  media: Record<string, CharacterMedia> | undefined,
): string | undefined {
  const resolved = resolveSkin(ref, media);
  if (resolved === undefined) return undefined;
  for (const key of SLOT_FALLBACK[slot]) {
    const assetId = resolved.skin[key];
    if (typeof assetId === "string" && assetId !== "") return assetId;
  }
  return undefined;
}

/**
 * 派生「在场人物」的媒体槽（P1）。
 *
 * 只产出**解析得到**的槽：没有皮肤、没有素材、角色没配 → 一条都不产出，
 * 前端自然退到文字头像（`design.md §4.5`）。
 *
 * 槽名约定（`packages/rpg-ui/src/slots.ts` 已认）：`avatar.<id>` / `portrait.<id>`。
 */
export function derivedActorMedia(
  actors: ReadonlyArray<{ ref: ActorMediaRef; visible: boolean }>,
  media: Record<string, CharacterMedia> | undefined,
): Array<{ slot: string; assetId: string }> {
  if (media === undefined) return [];
  const out: Array<{ slot: string; assetId: string }> = [];
  for (const { ref, visible } of actors) {
    if (!visible) continue;
    const avatar = resolveCharacterMedia(ref, "avatar", media);
    if (avatar !== undefined) out.push({ slot: `avatar.${ref.actorId}`, assetId: avatar });
    const bust = resolveCharacterMedia(ref, "bust", media);
    if (bust !== undefined) out.push({ slot: `portrait.${ref.actorId}`, assetId: bust });
  }
  return out;
}
