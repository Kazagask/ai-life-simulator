import type {
  AttributeDef,
  AttributeSourceView,
  AttributeValue,
  AttributeView,
  UiConfig,
  WorldTemplateV2,
} from "@life-sim/shared";
import { numericAttr } from "@life-sim/shared";
import { resolveStyle } from "./style.js";
import { ladderTierState } from "../attribute-rules.js";

/**
 * 属性视图解析（ADR-003 D2/D7）。
 *
 * 规则一次性在这里收口：
 * - 展示顺序 = `attributes.order`；
 * - `hidden` 属性不进视图（但仍存在于 raw 记录）；
 * - enum 的展示 = 选项 label + 选项样式；
 * - ladder 的展示 = 当前档 label + 本档进度；
 * - composite 的展示 = 优先序命中的称号 + 来源轴。
 *
 * 前端只消费 `AttributeView`，不查模板、不认识 `kind` 之外的语义。
 */

function labelOf(template: WorldTemplateV2, id: string): string {
  return template.attributes.labels?.[id] ?? id;
}

function styleOf(styleId: string | undefined, ui: UiConfig | undefined) {
  return resolveStyle(styleId, undefined, ui);
}

/**
 * enum 的当前选项 id：只认 raw 里的合法选项。
 *
 * **不回落模板 default**：玩家的 default 在建世界时已经合并进 attributes；
 * NPC / 旧档没有这个键就是「没写」，显示 `—` 比假装成 default 更诚实
 * （否则所有未声明等级的 NPC 都会显示成「四级」）。
 */
function enumValueOf(
  template: WorldTemplateV2,
  id: string,
  raw: Record<string, AttributeValue>,
): string | undefined {
  const def = template.attributes.defs?.[id];
  if (def?.kind !== "enum") return undefined;
  const value = raw[id];
  return typeof value === "string" && def.values.some((v) => v.id === value) ? value : undefined;
}

/** 单个属性的展示文本（composite 的来源行复用同一口径）。 */
function displayOf(
  template: WorldTemplateV2,
  id: string,
  raw: Record<string, AttributeValue>,
  tiers: Record<string, string> | undefined,
  ui: UiConfig | undefined,
): { display: string; style?: ReturnType<typeof resolveStyle> } {
  const def = template.attributes.defs?.[id];
  if (def?.kind === "enum") {
    const optionId = enumValueOf(template, id, raw);
    const option = def.values.find((v) => v.id === optionId);
    return { display: option?.label ?? "—", style: styleOf(option?.style, ui) };
  }
  if (def?.kind === "ladder") {
    const value = numericAttr(raw[id]);
    const state = ladderTierState(def, value, tiers?.[id], template.attributes.caps?.[id]);
    return { display: state.label, style: styleOf(state.style, ui) };
  }
  const value = numericAttr(raw[id]);
  return { display: String(value) };
}

function sourceView(
  template: WorldTemplateV2,
  id: string,
  raw: Record<string, AttributeValue>,
  tiers: Record<string, string> | undefined,
  ui: UiConfig | undefined,
): AttributeSourceView {
  const shown = displayOf(template, id, raw, tiers, ui);
  return {
    id,
    label: labelOf(template, id),
    display: shown.display,
    ...(shown.style !== undefined ? { style: shown.style } : {}),
  };
}

/** 复合规则表的单条匹配：全部条件 AND。 */
function caseMatches(
  when: Record<string, { eq?: number | string; ne?: number | string; gte?: number; lte?: number }>,
  raw: Record<string, AttributeValue>,
): boolean {
  for (const [src, cond] of Object.entries(when)) {
    // 来源可能是 ladder：数值比较用「本档内进度」还是原始值？复合的语义是「恶名 ++」，
    // 对应原始数值 2；reset 阶梯本身是经验池，不适合做复合来源，故统一用原始值。
    const rawValue = raw[src];
    if (cond.eq !== undefined && rawValue !== cond.eq) return false;
    if (cond.ne !== undefined && rawValue === cond.ne) return false;
    if (cond.gte !== undefined || cond.lte !== undefined) {
      // 复合规则始终比较**原始数值**（恶名/善名是 0..2 的轴；reset 阶梯不适合做复合来源）。
      const num = numericAttr(rawValue);
      if (cond.gte !== undefined && num < cond.gte) return false;
      if (cond.lte !== undefined && num > cond.lte) return false;
    }
  }
  return true;
}

export function resolveAttributeView(
  id: string,
  raw: Record<string, AttributeValue>,
  template: WorldTemplateV2,
  ui: UiConfig | undefined,
  tiers?: Record<string, string>,
): AttributeView | undefined {
  const def: AttributeDef | undefined = template.attributes.defs?.[id];
  if (def?.hidden) return undefined;
  const label = labelOf(template, id);

  if (def?.kind === "enum") {
    const optionId = enumValueOf(template, id, raw);
    const option = def.values.find((v) => v.id === optionId);
    return {
      id,
      label,
      kind: "enum",
      value: optionId,
      display: option?.label ?? "—",
      ...(option?.style !== undefined ? { style: styleOf(option.style, ui) } : {}),
    };
  }

  if (def?.kind === "ladder") {
    const value = numericAttr(raw[id]);
    const state = ladderTierState(def, value, tiers?.[id], template.attributes.caps?.[id]);
    const style = styleOf(state.style, ui);
    return {
      id,
      label,
      kind: "ladder",
      value,
      display: state.label,
      ...(style !== undefined ? { style } : {}),
      tier: {
        id: state.id,
        label: state.label,
        ...(style !== undefined ? { style } : {}),
      },
      ...(state.progressMax !== undefined
        ? { progress: { value: state.progressValue, max: state.progressMax } }
        : {}),
    };
  }

  if (def?.kind === "composite") {
    const sources = def.sources.map((src) => sourceView(template, src, raw, tiers, ui));
    const hit =
      def.cases.find((c) => caseMatches(c.when, raw)) ?? def.fallback;
    const style = styleOf(hit.style, ui);
    return {
      id,
      label,
      kind: "composite",
      display: hit.label,
      ...(style !== undefined ? { style } : {}),
      sources,
    };
  }

  const value = numericAttr(raw[id]);
  return { id, label, kind: "number", value, display: String(value) };
}

/** 全部可见属性视图（按 order；hidden 跳过）。 */
export function resolveAttributeViews(
  raw: Record<string, AttributeValue>,
  template: WorldTemplateV2,
  ui: UiConfig | undefined,
  tiers?: Record<string, string>,
): AttributeView[] {
  const out: AttributeView[] = [];
  for (const id of template.attributes.order) {
    const view = resolveAttributeView(id, raw, template, ui, tiers);
    if (view !== undefined) out.push(view);
  }
  return out;
}
