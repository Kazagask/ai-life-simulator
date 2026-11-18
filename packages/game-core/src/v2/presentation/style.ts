import {
  DEFAULT_POLARITY_STYLES,
  STYLE_PRESET_IDS,
  resolveColorToken,
  type Polarity,
  type ResolvedStyle,
  type StyleSpec,
  type UiConfig,
  type WorldTemplateV2,
} from "@life-sim/shared";

/**
 * 样式解析（ADR-002 D2）——**唯一实现**。
 *
 * 解析顺序：
 *   实体 `style`（先查模板 `ui.styles` 别名，再查引擎预设 id）
 *   > `ui.qualityStyles[quality]`（同样先别名后预设）
 *   > `undefined`（展示层回退默认样式）
 *
 * 为什么在引擎投影期解析而不是各前端自己解析：
 * 用户的原话是「后续所有品质是这个级别的特质/技能都按这个颜色渲染」——这要求
 * 「六眼」在个人页、收获卡、事件区、战斗面板是**同一份**结果。多端各解析必然漂移。
 */

const PRESETS = new Set<string>(STYLE_PRESET_IDS);

export function isPresetStyleId(id: string): boolean {
  return PRESETS.has(id);
}

/** 样式 id → spec：先查模板别名，再查预设。未知名返回 undefined（加载期应已拒载）。 */
export function styleSpecFor(id: string, ui: UiConfig | undefined): StyleSpec | undefined {
  const custom = ui?.styles?.[id];
  if (custom !== undefined) return custom;
  if (PRESETS.has(id)) return { preset: id as NonNullable<StyleSpec["preset"]> };
  return undefined;
}

function toResolved(spec: StyleSpec): ResolvedStyle {
  return {
    ...(spec.preset !== undefined ? { preset: spec.preset } : {}),
    ...(spec.color !== undefined ? { color: resolveColorToken(spec.color) } : {}),
    ...(spec.background !== undefined ? { background: resolveColorToken(spec.background) } : {}),
    ...(spec.bold !== undefined ? { bold: spec.bold } : {}),
    ...(spec.animation !== undefined ? { animation: spec.animation } : {}),
  };
}

/**
 * 解析一个实体的最终样式。`ui` 缺省（无 `ui.yaml` / 自定义前端不传）时返回 `undefined`，
 * 与「没写样式」完全等价 —— 零回归。
 */
export function resolveStyle(
  styleId: string | undefined,
  quality: string | undefined,
  ui: UiConfig | undefined,
  polarity?: Polarity,
): ResolvedStyle | undefined {
  if (styleId !== undefined) {
    const spec = styleSpecFor(styleId, ui);
    if (spec !== undefined) return toResolved(spec);
  }
  if (quality !== undefined) {
    const mapped = ui?.qualityStyles?.[quality];
    if (mapped !== undefined) {
      const spec = styleSpecFor(mapped, ui);
      if (spec !== undefined) return toResolved(spec);
    }
  }
  // 正负零与品级**独立**：没写 quality 的补正也能靠 polarity 拿到绿 / 红 / 灰。
  if (polarity !== undefined) {
    const mapped = ui?.polarityStyles?.[polarity] ?? DEFAULT_POLARITY_STYLES[polarity];
    const spec = styleSpecFor(mapped, ui);
    if (spec !== undefined) return toResolved(spec);
  }
  return undefined;
}

export interface StyleIssue {
  path: string;
  message: string;
}

/**
 * 加载期校验（R-STYLE-02 / R-STYLE-04）：**未知样式 id 一律拒载**，不静默回退。
 *
 * 覆盖三处引用：`ui.styles` 的键自身（不必校验）、`ui.qualityStyles` 的值、
 * 以及所有实体上的 `style` 字段（补正 / 技能 / 物品）。
 * 静默回退的代价是「模板作者以为改了颜色，线上却没变」——比加载失败更难查。
 */
export function validateStyleRefs(template: WorldTemplateV2, ui: UiConfig | undefined): StyleIssue[] {
  const issues: StyleIssue[] = [];
  const known = (id: string): boolean => styleSpecFor(id, ui) !== undefined;

  for (const [polarity, styleId] of Object.entries(ui?.polarityStyles ?? {})) {
    if (!known(styleId)) {
      issues.push({
        path: `ui.polarityStyles.${polarity}`,
        message: `未知样式 id：${styleId}（既不在 ui.styles，也不是预设 ${STYLE_PRESET_IDS.join("/")}）`,
      });
    }
  }

  for (const [quality, styleId] of Object.entries(ui?.qualityStyles ?? {})) {
    if (!known(styleId)) {
      issues.push({
        path: `ui.qualityStyles.${quality}`,
        message: `未知样式 id：${styleId}（既不在 ui.styles，也不是预设 ${STYLE_PRESET_IDS.join("/")}）`,
      });
    }
  }

  const check = (styleId: string | undefined, path: string): void => {
    if (styleId === undefined) return;
    if (!known(styleId)) {
      issues.push({
        path,
        message: `未知样式 id：${styleId}（既不在 ui.styles，也不是预设 ${STYLE_PRESET_IDS.join("/")}）`,
      });
    }
  };

  template.statuses.forEach((s, i) => check(s.style, `statuses[${i}].style`));
  template.skills.forEach((s, i) => check(s.style, `skills[${i}].style`));
  template.items.forEach((s, i) => check(s.style, `items[${i}].style`));

  return issues;
}
