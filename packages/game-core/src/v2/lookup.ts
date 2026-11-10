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
}

export function createLookup(template: WorldTemplateV2): TemplateLookup {
  return new TemplateLookup(template);
}
