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
  /**
   * 模板 `actions[].effects`：内核 27 种 ∪ 开放形（扩展效果）。
   *
   * 但 `packages/shared/src/v2.ts` 的 `TemplateLookup` 仍声明成闭合 `Effect[]`，
   * 本接口要与它结构兼容（`apps/server` 把本 lookup 当 shared 的用）。两边类型对不上
   * 时由 `action()` 的收窄负责 —— 运行期 `applyEffectsV2` 按 `type` 归属分发，
   * 开放形照样走扩展，不丢效果。
   */
  effects?: Effect[];
}

/**
 * 模板快速查找器：跨实体引用集中解析，O(1) 查询。
 *
 * AGENTIC-GM 重构：`event()` 会增加一层「运行时生成事件」的 overlay。生成事件属于**某个世界**
 * 的存档，不属于模板，所以不能写进模板对象；做法是本类多带一份只读索引，由
 * `withGenerated(state.generatedEvents)` 为每个世界派生一个查找器。
 * **调度器因此零改动**：它拿到的 `EventV2` 与模板事件完全同形。
 */
export class TemplateLookup {
  private readonly generated: Map<string, EventV2> | undefined;

  constructor(
    readonly template: WorldTemplateV2,
    generatedEvents: readonly EventV2[] = [],
  ) {
    this.generated =
      generatedEvents.length > 0
        ? new Map(generatedEvents.map((event) => [event.id, event]))
        : undefined;
  }

  /** 为本世界的生成事件派生一个查找器；无生成事件时原样返回（零开销、零行为变化）。 */
  withGenerated(events: readonly EventV2[] | undefined): TemplateLookup {
    if (events === undefined || events.length === 0) return this;
    return new TemplateLookup(this.template, events);
  }

  event(id: string): EventV2 | undefined {
    return this.generated?.get(id) ?? this.template.events.find((e) => e.id === id);
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
    // 模板侧的 `effects` 已放宽到「内核 ∪ 开放形」（扩展效果）；本文件对外仍按
    // `ActionDef.effects: Effect[]` 声明，只为与 `packages/shared/src/v2.ts` 的
    // `TemplateLookup` 保持结构兼容。这里收窄是**类型层**的：执行仍走 `applyEffectsV2`，
    // 它按 `type` 归属分发，开放形（扩展效果）不会被丢掉。
    return this.template.actions?.find((a) => a.id === id) as ActionDef | undefined;
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

