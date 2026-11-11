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
