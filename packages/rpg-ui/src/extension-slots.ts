import type { ComponentType } from "react";
import type { ViewModel } from "@life-sim/shared";

/**
 * 扩展前端挂载点（`docs/EXTENSIONS.md` §7）：**宿主给槽，扩展挂载**。
 *
 * 和内核对称：内核把 `state.extensions` 当不透明切片搬运、由扩展解释；这里也一样 ——
 * 宿主只提供槽位与渲染时机，**不认识任何具体扩展**（没有 `pedigree` / `clan` 这种字段）。
 *
 * 三条硬规则：
 * 1. 加载是**编译期**的：`apps/web/src/extensions.ts` 静态 `registerExtensionUi(familyUi)`，
 *    不做热加载；加扩展 = 加一行注册 + 重新构建。
 * 2. 槽名由宿主定义（`world.subview` 是本轮唯一一个）。扩展只能往**已有槽**里挂。
 * 3. `visible` 只允许看公共字段与自己的切片 —— 不许窥探别的扩展的切片。槽为空 ⇒
 *    宿主不渲染这一块（不画空页签）。
 *
 * **宿主持有的只有三样东西**（`docs/EXTENSIONS.md` §7）：
 * 1. 三个不透明命名空间：世界状态、引擎快照（V2 快照）、视图模型各有一个 `extensions`；
 * 2. 两个注册表：`ExtensionRuntime`（内核侧）/ `ExtensionUiRuntime`（前端侧，本文件）；
 * 3. 一张槽表：本文件。
 * 除此之外 `packages/**` 里不该出现任何 `clan` / `pedigree` / `family` 的**类型或字段名**
 * （注释里提到可以，用来解释这些玩法搬去哪了）。
 */

/**
 * 宿主可提供给扩展视图的**导航能力**（可选）。
 *
 * 槽契约只保证 `{ vm }`；需要「点人开卡」这类宿主交互的扩展可以读这个可选对象，
 * 读不到就当没有（不报错）。宿主不因此认识任何具体扩展。
 */
export interface ExtensionViewHost {
  /** 打开某位 NPC 的卡片（具体导航由宿主决定）。 */
  openNpc(id: string): void;
  /** 打开玩家自己的面板。 */
  openSelf(): void;
}

export interface ExtensionView {
  /** 视图 id（同一槽内唯一，同时用作页签 key）。 */
  id: string;
  /** 宿主定义的槽名，例如 `world.subview`。 */
  slot: string;
  /** 页签显示名（扩展自己给，宿主不翻译）。 */
  label: string;
  /** 同槽内的顺序（升序；缺省 0，相同则按 id 升序，保证确定性）。 */
  order?: number;
  /** 宿主调它决定这一格出不出（拿得到 ViewModel，但只该看自己的切片 + 公共字段）。 */
  visible?: (vm: ViewModel) => boolean;
  /** 视图本体。宿主渲染 `<Component vm={vm} host={host} />`。 */
  Component: ComponentType<{ vm: ViewModel; host?: ExtensionViewHost }>;
}

export interface ExtensionUiRuntime {
  id: string;
  views: ReadonlyArray<ExtensionView>;
}

/** 按运行时 id 注册：同 id 重复注册以最后一次为准（HMR / 测试重置友好）。 */
const RUNTIMES = new Map<string, ExtensionUiRuntime>();

export function registerExtensionUi(rt: ExtensionUiRuntime): void {
  RUNTIMES.set(rt.id, rt);
}

/** 仅测试：清空注册表。生产代码不应调用。 */
export function resetExtensionUi(): void {
  RUNTIMES.clear();
}

/**
 * 某槽内**当前可见**的视图：过滤 `slot` → 过滤 `visible` → 按 `order` 排序。
 *
 * 排序键是 `(order ?? 0, id)`：同 order 时也确定，不依赖注册顺序（跨构建稳定）。
 */
export function extensionViewsFor(slot: string, vm: ViewModel): ExtensionView[] {
  const views: ExtensionView[] = [];
  for (const rt of RUNTIMES.values()) {
    for (const view of rt.views) {
      if (view.slot !== slot) continue;
      if (view.visible !== undefined && !view.visible(vm)) continue;
      views.push(view);
    }
  }
  return views.sort(
    (a, b) =>
      (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
