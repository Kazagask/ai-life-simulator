import {
  uiPlacementOf,
  type UiConfig,
  type UiPlacement,
} from "@life-sim/shared";

/**
 * `ui.yaml` 的前端落位解析（`specs/SPEC.md` §1.5 形状 B）。
 *
 * 服务端已保证 capability id 合法（宿主内建 ∪ 扩展声明）；这里负责两件渲染侧的事：
 * 1. **落位分发**：每个能力最终落在 `tab` / `overlay` / `off` / `slot:<host>` 哪一处；
 * 2. **降级口径**：宿主不认识某个槽 ⇒ 退化为 `tab`（"宁可多一页，不要一个空槽"）。
 *
 * 硬约束：**展示声明不能把玩家卡死**。被 `off` 的能力一旦成为当轮唯一推进路径
 * （`slotEvent.kind` 为 random/combat/normal），呈现方必须补一个最小推进形态。
 * 这件事由 UI 层按 `requiresMinimalForm()` 的返回值处理，不在本模块渲染任何东西。
 */

/** 宿主当前认识的槽 id。`world.subview` / `host.npcCard` / `host.npcDetails` 是扩展槽。 */
export const KNOWN_HOST_SLOTS = new Set([
  "life",
  "world",
  "personal",
  "npcList",
  "world.subview",
  "host.npcCard",
  "host.npcDetails",
]);

export type ResolvedPlacement = Exclude<UiPlacement, `slot:${string}`> | "embedded";

/** 事件区占位者：它们没有常驻页签形态，落位只有 off / overlay（事件区）有意义。 */
const EVENT_OCCUPANTS = new Set(["wheel", "battle", "event"]);

/** 解析最终落位：未知槽一律退化为 tab，不报错、不留黑洞。 */
export function resolvePlacement(ui: UiConfig | undefined, capability: string): ResolvedPlacement {
  const place = uiPlacementOf(ui, capability);
  if (EVENT_OCCUPANTS.has(capability)) {
    // 引擎的 pending_event_required 决定这些面板何时出现；前端不能造一个"永远空着的页签"。
    return place === "off" ? "off" : "overlay";
  }
  if (typeof place === "string" && place.startsWith("slot:")) {
    return KNOWN_HOST_SLOTS.has(place.slice(5)) ? "embedded" : "tab";
  }
  return place;
}

/** 这个能力是否还占常驻页签入口（off / overlay 都不占）。 */
export function hasTabEntry(ui: UiConfig | undefined, capability: string): boolean {
  return resolvePlacement(ui, capability) === "tab";
}

/**
 * 宿主内部的子页签是否可见。
 *
 * 与 `hasTabEntry` 的区别：`slot:<host>` 表示"嵌进那个宿主"，对本宿主来说它**就是**一个
 * 子页签（个人页的 角色/背包/技能、世界页的 族谱/宗族 都属此类），不能按顶层页签规则
 * 当成 off 过滤掉。只有 `off`（和事件区能力的 overlay）才真正隐藏。
 */
export function hasSubtabEntry(ui: UiConfig | undefined, capability: string): boolean {
  const place = resolvePlacement(ui, capability);
  return place === "tab" || place === "embedded";
}

/**
 * 被关掉的能力是否正在充当唯一推进路径 ⇒ 必须渲染最小形态。
 * 只认服务端投影的 `slotEvent.kind`，前端不猜引擎状态。
 */
export function requiresMinimalForm(
  ui: UiConfig | undefined,
  capability: "wheel" | "battle" | "event",
  slotKind: "normal" | "random" | "combat" | null,
): boolean {
  if (resolvePlacement(ui, capability) !== "off") return false;
  if (slotKind === null) return false;
  return (
    (capability === "wheel" && slotKind === "random") ||
    (capability === "battle" && slotKind === "combat") ||
    (capability === "event" && slotKind === "normal")
  );
}
