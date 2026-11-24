import type { AssetManifest, CharacterMedia, UiConfig, WorldTemplateV2 } from "@life-sim/shared";

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
 * 只在 `assetManifest` 存在时校验资源 id —— 没登记清单的模板等于「还没有素材」，
 * 此时一切按占位符处理，不该拒载（`design.md §3.5`：资源缺失不得中断游戏）。
 */
export function validateCharacterMedia(
  template: WorldTemplateV2,
  ui: UiConfig | undefined,
  assetManifest: AssetManifest | undefined,
): MediaIssue[] {
  const media = ui?.characterMedia;
  if (media === undefined) return [];
  const issues: MediaIssue[] = [];
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
