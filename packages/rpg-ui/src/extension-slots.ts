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
 * 宿主可提供给扩展视图的**最小导航能力**（可选）。
 *
 * 槽契约只保证 `{ vm }`；需要「点人开卡」这类宿主交互的扩展可以读这个可选对象，
 * 读不到就当没有（不报错）。导航是**宿主能力**，不是某个玩法的知识：宿主不知道谁在调它，
 * 扩展也不知道宿主怎么实现（切页签 / 弹层 / 深链都行）。
 *
 * ⚠ 这**不是**「宿主 API 大礼包」的入口：只放"离开本视图、去宿主某个已有落点"的动作，
 * 不放数据读取、不发请求、不暴露 store / router。要加东西先问：这是导航还是宿主内部状态？
 * 后者一律不进。
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

/**
 * 宿主内置 UI 的**覆盖槽**。与 `ExtensionView` 的「往槽里追加一个视图」不同，
 * 覆盖槽的语义是「替换宿主的默认实现」：没有扩展注册时用宿主组件，有则用扩展组件。
 *
 * 三个约束：
 * 1. 槽 id 由宿主定义并导出，扩展只能覆盖**已存在的**槽（拼错的 id 静默无效）；
 * 2. 同一槽多个扩展同时声明覆盖时按 `(order, extensionId)` 取唯一一个，不叠加；
 * 3. props 由宿主定义（`P` 泛型），扩展拿到的就是宿主原本给默认组件的 props —— 这是
 *    替换而不是另起炉灶，宿主不需要认识扩展的字段。
 */
export const HOST_UI_SLOTS = {
  /** NPC 人物卡整体（世界页「人物/NPC」子页签里的每张卡）。 */
  npcCard: "host.npcCard",
  /** 人物卡内可折叠的详情展开区（关系 / 状态 / 属性 / 生命周期）。 */
  npcDetails: "host.npcDetails",
} as const;

export type HostUiSlot = (typeof HOST_UI_SLOTS)[keyof typeof HOST_UI_SLOTS];

/** 扩展对某个宿主默认实现的覆盖声明。 */
export interface UiOverride<P extends object = { vm: ViewModel; host?: ExtensionViewHost }> {
  /** 要替换的宿主槽 id（取 `HOST_UI_SLOTS` 里的值）。 */
  target: string;
  /** 替换组件：收到宿主原本传给默认组件的 props。 */
  Component: ComponentType<P>;
  /** 可选：按 ViewModel 决定是否生效；不生效时回退宿主默认。 */
  visible?: (vm: ViewModel) => boolean;
  /** 同槽多扩展时的优先级（升序；缺省 0，相同按扩展 id 升序）。 */
  order?: number;
}

interface RegisteredOverride {
  extensionId: string;
  target: string;
  // 注册表内部擦除 props 类型；对外由 resolveUiOverride 的 P 泛型保证类型安全。
  Component: ComponentType<any>;
  visible?: (vm: ViewModel) => boolean;
  order?: number;
}

export interface ExtensionUiRuntime {
  id: string;
  views: ReadonlyArray<ExtensionView>;
  /** 可选：本扩展要覆盖的宿主默认实现（与 views 一次注册）。 */
  overrides?: ReadonlyArray<UiOverride<any>>;
}

/** 按运行时 id 注册：同 id 重复注册以最后一次为准（HMR / 测试重置友好）。 */
const RUNTIMES = new Map<string, ExtensionUiRuntime>();
/** key = `<extensionId>:<target>`：同扩展对同槽只保留最后一次声明。 */
const UI_OVERRIDES = new Map<string, RegisteredOverride>();

export function registerExtensionUi(rt: ExtensionUiRuntime): void {
  RUNTIMES.set(rt.id, rt);
  for (const override of rt.overrides ?? []) {
    UI_OVERRIDES.set(`${rt.id}:${override.target}`, {
      ...override,
      extensionId: rt.id,
    });
  }
}

/** 仅测试：清空注册表。生产代码不应调用。 */
export function resetExtensionUi(): void {
  RUNTIMES.clear();
  UI_OVERRIDES.clear();
}

/**
 * 解析某个宿主槽最终使用的组件。
 *
 * 没有可见的覆盖 ⇒ 原样返回 `fallback`（宿主默认实现）；这是零回归路径。
 * 覆盖组件不做任何包装：props 由宿主直接传，签名不对是编译期错误（`P` 泛型保证）。
 */
export function resolveUiOverride<P extends object>(
  target: string,
  vm: ViewModel,
  fallback: ComponentType<P>,
): ComponentType<P> {
  const candidates = [...UI_OVERRIDES.values()]
    .filter(
      (candidate) =>
        candidate.target === target && (candidate.visible?.(vm) ?? true),
    )
    .sort(
      (a, b) =>
        (a.order ?? 0) - (b.order ?? 0) ||
        (a.extensionId < b.extensionId ? -1 : a.extensionId > b.extensionId ? 1 : 0),
    );
  return (candidates[0]?.Component ?? fallback) as ComponentType<P>;
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
