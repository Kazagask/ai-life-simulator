import {
  TAG_TONES,
  DEFAULT_POLARITY_STYLES,
  DEFAULT_TAGS,
  STYLE_PRESET_IDS,
  isQualityTier,
  TAG_PRESET_IDS,
  resolveColorToken,
  type Polarity,
  type ResolvedStyle,
  type ResolvedTag,
  type StyleSpec,
  type TagDefinition,
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
 * 同一个状态在个人页、收获卡、事件区、战斗面板是**同一份**结果。多端各解析必然漂移。
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
 *
 * 顺序（ADR-002 D2b）：
 *   实体 `style` > **命中样式的第一个 tag** > `qualityStyles[quality]` > `polarityStyles[polarity]`
 *
 * 为什么标签排在 quality 之前：标签是**模板给玩家看的词**（神话 / 增益），本身带颜色；
 * `quality` / `polarity` 只是早期「按枚举映射」的简写。两者同时存在时，玩家看到的那一行字
 * 必须和他看到的标签同色，否则同一张卡上会出现「神话是彩虹、名字是白的」。
 *
 * `tags` 的顺序即优先级：先写品级、再写增益减益，品级就会盖过正负色（神话 > 增益）。
 */
export function resolveStyle(
  styleId: string | undefined,
  quality: string | undefined,
  ui: UiConfig | undefined,
  polarity?: Polarity,
  tags?: readonly string[],
): ResolvedStyle | undefined {
  if (styleId !== undefined) {
    const spec = styleSpecFor(styleId, ui);
    if (spec !== undefined) return toResolved(spec);
  }
  for (const tagId of tags ?? []) {
    const spec = tagDefinitionOf(tagId, ui)?.style;
    if (spec !== undefined) return toResolved(spec);
  }
  if (quality !== undefined) {
    const mapped = ui?.qualityStyles?.[quality];
    if (mapped !== undefined) {
      const spec = styleSpecFor(mapped, ui);
      if (spec !== undefined) return toResolved(spec);
    }
  }
  // 正负零与品级**独立**：没写 quality 的状态也能靠 polarity 拿到绿 / 红 / 灰。
  if (polarity !== undefined) {
    const mapped = ui?.polarityStyles?.[polarity] ?? DEFAULT_POLARITY_STYLES[polarity];
    const spec = styleSpecFor(mapped, ui);
    if (spec !== undefined) return toResolved(spec);
  }
  return undefined;
}

/**
 * 实体的标签 id：写了 `tags` 就用它；否则把 `quality` 当**品级阶梯 id** 生成一个。
 *
 * 这是「装备品级」与「品级标签」的联动（用户 2026-11-19）：装备此前同时要写
 * `quality: cursed`（一个什么也不做的旧字段）和 `tags: [legend, buff]`（真正生效的那行），
 * 两套词汇各说各话。现在 `quality` 直接写阶梯 id（`legend` / `epic` / …），
 * 名字与配色自动来自预置标签，**不必再写 tags**。
 *
 * 非阶梯的自定义 quality 词不生成标签（那时颜色仍走 `ui.qualityStyles` 的旧通道）。
 */
export function tagIdsOf(def: { tags?: readonly string[]; quality?: string } | undefined): string[] {
  if (def === undefined) return [];
  if (def.tags !== undefined && def.tags.length > 0) return [...def.tags];
  return isQualityTier(def.quality) ? [def.quality] : [];
}

/** 只读实体（状态 / 物品 / 装备 / 技能）的样式来源字段。 */
export interface StyledEntity {
  style?: string;
  quality?: string;
  tags?: readonly string[];
  polarity?: Parameters<typeof resolveStyle>[3];
}

/**
 * 实体的最终样式（含 `quality` → 品级标签的联动）。
 *
 * ⚠ 技能**不参与正负零**（用户 2026-11-18 裁决），技能样式请直接调
 * `resolveStyle(def.style, def.quality, ui, undefined, tagIdsOf(def))`，不要走这里。
 */
export function resolveEntityStyle(
  def: StyledEntity | undefined,
  ui: UiConfig | undefined,
): ResolvedStyle | undefined {
  if (def === undefined) return undefined;
  /**
   * 有 `polarity` 就不再让 tags 参与配色（2026-11-20 用户裁决）：
   * 状态的正负是一等字段，标签只负责「它叫什么、什么品级」。
   * 没有 polarity 的实体（物品 / 装备）仍走标签，行为不变。
   */
  /**
   * 有 `polarity` 时，**语义标签被剔除**（2026-11-20 用户裁决）：
   * `buff` / `abnormal` / `neutral` 不再参与配色，正负只由字段决定。
   * 品级标签（`mythic-unique` 这类）保留 —— 它们是身份色（如唯一档的流动彩虹），
   * 与「战斗中绿/红/灰」是两套口径：后者由 UI 直接读 `polarity`，不经由此处。
   */
  const tags = def.polarity === undefined
    ? tagIdsOf(def)
    : tagIdsOf(def).filter((id) => TAG_TONES[id] === undefined);
  return resolveStyle(def.style, def.quality, ui, def.polarity, tags);
}

/** 实体的展示标签（`quality` 为品级阶梯 id 时自动生成一条）。 */
export function resolveEntityTags(
  def: { tags?: readonly string[]; quality?: string } | undefined,
  ui: UiConfig | undefined,
): ResolvedTag[] {
  return resolveTags(tagIdsOf(def), ui);
}

/**
 * 标签定义查询（ADR-002 D2c）：**模板声明的同名 id 覆盖引擎预置**。
 *
 * 预置只提供「默认词表」，不是硬编码的 UI 文案——模板写 `ui.tags.mythic: { name: ... }`
 * 就能改名换色，其余品级继续继承。
 */
export function tagDefinitionOf(id: string, ui: UiConfig | undefined): TagDefinition | undefined {
  return ui?.tags?.[id] ?? DEFAULT_TAGS[id];
}

/**
 * 解析实体的展示标签（ADR-002 D2b）。
 *
 * 标签是**模板的展示词**（神话 / 增益），不是引擎的样式名（rainbow / green）——
 * 后者只活在 CSS 类名里，玩家不该看到。同一个实体可挂多个标签，顺序即声明顺序。
 *
 * `ui` 缺省 ⇒ 空数组（等价「模板没写标签」）。未知 id 在加载期已拒载，
 * 这里再做一次防御：查不到就跳过，不编造名字。
 */
export function resolveTags(ids: readonly string[] | undefined, ui: UiConfig | undefined): ResolvedTag[] {
  if (ids === undefined || ids.length === 0) return [];
  const out: ResolvedTag[] = [];
  for (const id of ids) {
    const def = tagDefinitionOf(id, ui);
    if (def === undefined) continue;
    const style = def.style === undefined ? undefined : toResolved(def.style);
    out.push({ id, name: def.name, ...(style !== undefined ? { style } : {}) });
  }
  return out;
}

export interface StyleIssue {
  path: string;
  message: string;
}

/**
 * 加载期校验（R-STYLE-02 / R-STYLE-04）：**未知样式 id 一律拒载**，不静默回退。
 *
 * 覆盖三处引用：`ui.styles` 的键自身（不必校验）、`ui.qualityStyles` 的值、
 * 以及所有实体上的 `style` 字段（状态 / 技能 / 物品）。
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

  // ADR-003：enum 选项 / ladder 档位 / composite 称号都能带样式，未知 id 同样拒载。
  for (const [id, def] of Object.entries(template.attributes.defs ?? {})) {
    if (def.kind === "enum") {
      def.values.forEach((v, i) => check(v.style, `attributes.defs.${id}.values[${i}].style`));
    } else if (def.kind === "ladder") {
      def.tiers.forEach((t, i) => check(t.style, `attributes.defs.${id}.tiers[${i}].style`));
    } else if (def.kind === "composite") {
      def.cases.forEach((c, i) => check(c.style, `attributes.defs.${id}.cases[${i}].style`));
      check(def.fallback.style, `attributes.defs.${id}.fallback.style`);
    }
  }

  // 标签引用（ADR-002 D2b）：未知 tag id 同样拒载——静默丢弃会让「我明明写了品级标签」变成查不出原因的空白。
  const checkTags = (ids: readonly string[] | undefined, path: string): void => {
    for (const id of ids ?? []) {
      if (tagDefinitionOf(id, ui) === undefined) {
        issues.push({
          path,
          message: `未知标签 id：${id}（既不是引擎预置 ${TAG_PRESET_IDS.join("/")}，也没在 ui.tags 声明）`,
        });
      }
    }
  };
  template.statuses.forEach((s, i) => checkTags(s.tags, `statuses[${i}].tags`));
  template.items.forEach((s, i) => checkTags(s.tags, `items[${i}].tags`));

  return issues;
}
