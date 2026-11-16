import type {
  Chain,
  Character,
  Effect,
  EventV2,
  Item,
  Skill,
  StatusEffect,
  TimeAmount,
  WorldTemplateV2,
} from "@life-sim/shared";

export interface ActionDef {
  id: string;
  label: string;
  description?: string;
  duration?: TimeAmount;
  /** 绝对推进目标（剧情节点），相对世界起始的偏移量 */
  advanceTo?: TimeAmount;
  effects?: Effect[];
}

/** 模板快速查找器：跨实体引用集中解析，O(1) 查询。 */
export class TemplateLookup {
  constructor(readonly template: WorldTemplateV2) {}

  event(id: string): EventV2 | undefined {
    return this.template.events.find((e) => e.id === id);
  }

  skill(id: string): Skill | undefined {
    return this.template.skills.find((s) => s.id === id);
  }

  item(id: string): Item | undefined {
    return this.template.items.find((i) => i.id === id);
  }

  status(id: string): StatusEffect | undefined {
    return this.template.statuses.find((s) => s.id === id);
  }

  character(id: string): Character | undefined {
    return this.template.characters.find((c) => c.id === id);
  }

  chain(id: string): Chain | undefined {
    return this.template.chains?.find((c) => c.id === id);
  }

  action(id: string): ActionDef | undefined {
    return this.template.actions?.find((a) => a.id === id);
  }

  genderLabel(genderId: string): string {
    return this.template.genders.find((g) => g.id === genderId)?.label ?? genderId;
  }

  /**
   * 资源显示名（模板驱动）：取 statusBar 中 source=resource 且 key 匹配的 label。
   * 引擎日志与投影一律经此取名，避免把具体世界的资源叫法写进通用引擎。
   */
  resourceLabel(key: string): string {
    return this.template.statusBar.find((s) => s.source === "resource" && s.key === key)?.label ?? key;
  }

  /** 心情显示名：statusBar 中 source=mood 的 label；缺省回退 "mood"。 */
  moodLabel(): string {
    return this.template.statusBar.find((s) => s.source === "mood")?.label ?? "mood";
  }

  /** 单个属性显示名：attributes.labels[id]；缺省回退属性 id。 */
  attributeLabel(id: string): string {
    return this.template.attributes.labels?.[id] ?? id;
  }

  /** 全部属性显示名（按 attributes.order 顺序，供投影直接下发前端）。 */
  attributeLabels(): Record<string, string> {
    const labels: Record<string, string> = {};
    for (const id of this.template.attributes.order) labels[id] = this.attributeLabel(id);
    return labels;
  }
}

export function createLookup(template: WorldTemplateV2): TemplateLookup {
  return new TemplateLookup(template);
}

/**
 * 模板 ref 全集：所有可被跨实体**字面引用**的 id（事件 / 技能 / 物品 / 状态 / 角色 / 链 / 动作）。
 *
 * 用途：`RpgEngineAPI` 的 `lookupRefs` —— `fact.enqueueEvent` 的模板存在性校验
 * （`unknown_reference`）与 `validateDag` 步骤 6 的 `templateRefs ⊆ lookupRefs`。
 *
 * 口径（ADR-0037 / ADR-0038）：
 * - **只取字面 id，不加前缀、不做映射**：模板 id 形态不统一（事件是 `evt:awaken`，
 *   技能是 `sk-demo-strike`，角色是 `npc-mentor`），任何"补命名空间"的推断都会把
 *   合法 id 判死、把非法 id 放行 —— 这与「从标签形状推断语义」是同一类错误。
 * - `chains` / `actions` 是可选集合，缺省按空处理。
 * - 返回只读集合；调用方缓存它（模板加载期算一次），不要每请求重算。
 */
export function collectRefs(template: WorldTemplateV2): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const item of template.events) refs.add(item.id);
  for (const item of template.skills) refs.add(item.id);
  for (const item of template.items) refs.add(item.id);
  for (const item of template.statuses) refs.add(item.id);
  for (const item of template.characters) refs.add(item.id);
  for (const item of template.chains ?? []) refs.add(item.id);
  for (const item of template.actions ?? []) refs.add(item.id);
  return refs;
}
