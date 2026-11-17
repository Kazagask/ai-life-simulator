import { beforeEach, describe, expect, it } from "vitest";
import {
  extensionViewsFor,
  registerExtensionUi,
  resetExtensionUi,
} from "@life-sim/rpg-ui";
import type { ExtensionUiRuntime, ExtensionView, ViewModel } from "@life-sim/rpg-ui";

/**
 * 扩展前端槽（`docs/EXTENSIONS.md` §7.2）。
 *
 * 只测**机制**：注册 → 按槽过滤 → 过滤 `visible` → 按 `order` 排序；不测任何具体扩展的
 * 渲染（那是扩展自己的事，见 `extensions/family`）。`vm` 在这些用例里只当作透传的令牌，
 * 不做形状校验 —— 槽不知道 ViewModel 内容，也不该知道。
 */

const vm = { turnIndex: 0 } as unknown as ViewModel;

function view(
  id: string,
  slot: string,
  extra: Partial<Pick<ExtensionView, "order" | "visible" | "label">> = {},
): ExtensionView {
  return { id, slot, label: extra.label ?? id, ...extra, Component: () => null };
}

function runtime(id: string, views: ExtensionView[]): ExtensionUiRuntime {
  return { id, views };
}

describe("扩展前端槽：注册与过滤", () => {
  beforeEach(() => resetExtensionUi());

  it("只返回挂在该槽里的视图", () => {
    registerExtensionUi(
      runtime("a", [view("x", "world.subview"), view("y", "other.slot")]),
    );
    registerExtensionUi(runtime("b", [view("z", "world.subview")]));

    expect(extensionViewsFor("world.subview", vm).map((v) => v.id)).toEqual(["x", "z"]);
    expect(extensionViewsFor("other.slot", vm).map((v) => v.id)).toEqual(["y"]);
  });

  it("未注册任何扩展 / 槽没人挂 ⇒ 空数组（宿主据此不画空页签）", () => {
    expect(extensionViewsFor("world.subview", vm)).toEqual([]);
    registerExtensionUi(runtime("a", [view("x", "other.slot")]));
    expect(extensionViewsFor("world.subview", vm)).toEqual([]);
  });

  it("visible 为假的视图不出现；缺省 visible 视为可见", () => {
    registerExtensionUi(
      runtime("a", [
        view("shown", "world.subview"),
        view("hidden", "world.subview", { visible: () => false }),
        view("depends", "world.subview", { visible: (candidate) => candidate === vm }),
      ]),
    );
    expect(extensionViewsFor("world.subview", vm).map((v) => v.id)).toEqual(["depends", "shown"]);
    // 换了 vm ⇒ 依赖该 vm 的视图自行隐藏；不依赖 visible 的照常出。
    expect(extensionViewsFor("world.subview", {} as ViewModel).map((v) => v.id)).toEqual(["shown"]);
  });

  it("按 order 升序；同 order 按 id 升序（与注册顺序无关）", () => {
    registerExtensionUi(
      runtime("a", [
        view("second", "world.subview", { order: 20 }),
        view("b-first", "world.subview", { order: 10 }),
        view("a-first", "world.subview", { order: 10 }),
      ]),
    );
    expect(extensionViewsFor("world.subview", vm).map((v) => v.id)).toEqual([
      "a-first",
      "b-first",
      "second",
    ]);
  });

  it("同一运行时 id 重复注册以最后一次为准（HMR / 重载友好）", () => {
    registerExtensionUi(runtime("a", [view("old", "world.subview")]));
    registerExtensionUi(runtime("a", [view("new", "world.subview")]));
    expect(extensionViewsFor("world.subview", vm).map((v) => v.id)).toEqual(["new"]);
  });

  it("resetExtensionUi 之后注册表为空（仅测试用）", () => {
    registerExtensionUi(runtime("a", [view("x", "world.subview")]));
    resetExtensionUi();
    expect(extensionViewsFor("world.subview", vm)).toEqual([]);
  });
});
