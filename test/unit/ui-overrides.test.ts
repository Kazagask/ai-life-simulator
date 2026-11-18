import { beforeEach, describe, expect, it } from "vitest";
import {
  HOST_UI_SLOTS,
  registerExtensionUi,
  resetExtensionUi,
  resolveUiOverride,
} from "@life-sim/rpg-ui";
import type { ExtensionUiRuntime, UiOverride, ViewModel } from "@life-sim/rpg-ui";

/**
 * 宿主默认实现的覆盖槽（`docs/EXTENSIONS.md` §7.5）。
 *
 * 只测机制：默认回退、覆盖生效、visible 过滤、冲突时的确定性选择、重置。
 * props 形状不在这里测（那属于具体组件自己的契约）；这里用 `() => null` 当组件令牌。
 */
const vm = { turnIndex: 0 } as unknown as ViewModel;

const Default = () => null;
const First = () => null;
const Second = () => null;
const DetailsOverride = () => null;

function runtime(id: string, overrides: ReadonlyArray<UiOverride<any>>): ExtensionUiRuntime {
  return { id, views: [], overrides };
}

describe("宿主 UI 覆盖槽：默认实现可被扩展替换", () => {
  beforeEach(() => resetExtensionUi());

  it("没有扩展注册时原样返回宿主默认组件（零回归路径）", () => {
    expect(
      resolveUiOverride(HOST_UI_SLOTS.npcCard, vm, Default),
    ).toBe(Default);
  });

  it("扩展声明覆盖后返回扩展组件", () => {
    registerExtensionUi(
      runtime("a", [{ target: HOST_UI_SLOTS.npcCard, Component: First }]),
    );
    expect(resolveUiOverride(HOST_UI_SLOTS.npcCard, vm, Default)).toBe(First);
  });

  it("visible 为假时回退宿主默认", () => {
    registerExtensionUi(
      runtime("a", [
        {
          target: HOST_UI_SLOTS.npcCard,
          Component: First,
          visible: (candidate) => candidate === vm,
        },
      ]),
    );
    expect(resolveUiOverride(HOST_UI_SLOTS.npcCard, vm, Default)).toBe(First);
    expect(resolveUiOverride(HOST_UI_SLOTS.npcCard, {} as ViewModel, Default)).toBe(Default);
  });

  it("多个扩展覆盖同一槽：按 order 升序取一个，不叠加", () => {
    registerExtensionUi(
      runtime("a", [
        { target: HOST_UI_SLOTS.npcCard, Component: First, order: 20 },
      ]),
    );
    registerExtensionUi(
      runtime("b", [
        { target: HOST_UI_SLOTS.npcCard, Component: Second, order: 10 },
      ]),
    );
    expect(resolveUiOverride(HOST_UI_SLOTS.npcCard, vm, Default)).toBe(Second);
  });

  it("同 order 按扩展 id 升序（不依赖注册顺序）", () => {
    registerExtensionUi(
      runtime("z", [{ target: HOST_UI_SLOTS.npcCard, Component: First }]),
    );
    registerExtensionUi(
      runtime("a", [{ target: HOST_UI_SLOTS.npcCard, Component: Second }]),
    );
    expect(resolveUiOverride(HOST_UI_SLOTS.npcCard, vm, Default)).toBe(Second);
  });

  it("不同槽互不干扰：覆盖详情区不影响整张卡", () => {
    registerExtensionUi(
      runtime("a", [
        { target: HOST_UI_SLOTS.npcDetails, Component: DetailsOverride },
      ]),
    );
    expect(resolveUiOverride(HOST_UI_SLOTS.npcCard, vm, Default)).toBe(Default);
    expect(resolveUiOverride(HOST_UI_SLOTS.npcDetails, vm, Default)).toBe(DetailsOverride);
  });

  it("同一扩展对同一槽重复声明以最后一次为准；reset 清空覆盖", () => {
    registerExtensionUi(
      runtime("a", [{ target: HOST_UI_SLOTS.npcCard, Component: First }]),
    );
    registerExtensionUi(
      runtime("a", [{ target: HOST_UI_SLOTS.npcCard, Component: Second }]),
    );
    expect(resolveUiOverride(HOST_UI_SLOTS.npcCard, vm, Default)).toBe(Second);

    resetExtensionUi();
    expect(resolveUiOverride(HOST_UI_SLOTS.npcCard, vm, Default)).toBe(Default);
  });
});
